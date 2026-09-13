"use strict";

const db = require("../../../db/db");
const { createId } = require("../core/id");
const { getRequestContext } = require("../../observability/requestContext");
const { notifyIntegrationQueue } = require("./workerSignal");

async function enqueueJobWithClient(client, companyId, input = {}) {
  const id = input.id || createId("ijob");
  const context = getRequestContext();
  const params = [
    id, companyId, input.accountId || null, String(input.type || "").trim(), Number(input.priority || 0),
    JSON.stringify(input.payload || {}), input.idempotencyKey || null, input.correlationId || context.requestId || null,
    input.requestId || context.requestId || null, Math.min(25, Math.max(1, Number(input.maxAttempts || 5))), input.createdBy || context.userId || null,
  ];
  if (!params[3]) {
    const error = new Error("Tipo do job e obrigatorio.");
    error.statusCode = 400;
    error.code = "INTEGRATION_JOB_TYPE_REQUIRED";
    throw error;
  }
  const result = await client.query(`
    insert into volt_core.integration_jobs (
      id,company_id,account_id,type,priority,payload,idempotency_key,correlation_id,request_id,max_attempts,created_by
    ) values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)
    on conflict (company_id,type,idempotency_key) where idempotency_key is not null
    do update set updated_at = volt_core.integration_jobs.updated_at
    returning *;
  `, params);
  return result.rows[0];
}

async function enqueueJob(companyId, input) {
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const job = await enqueueJobWithClient(client, companyId, input);
      await client.query("commit");
      notifyIntegrationQueue();
      return job;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function claimJob(workerId, jobId = null) {
  return db.withRlsBypass(() => db.withClient(async (client) => {
    await client.query("begin");
    try {
      const result = await client.query(`
        with candidate as (
          select j0.id
            from volt_core.integration_jobs j0
           where j0.status in ('queued','retrying') and j0.available_at <= now()
             and ($2::text is null or j0.id=$2)
             and (j0.account_id is null or exists (
               select 1 from volt_core.integration_accounts ia
                where ia.company_id=j0.company_id and ia.id=j0.account_id and ia.status='active'
             ))
           order by j0.priority desc, j0.available_at asc, j0.created_at asc
           for update skip locked
           limit 1
        )
        update volt_core.integration_jobs j
           set status='processing', attempts=j.attempts+1, locked_at=now(), locked_by=$1, updated_at=now()
          from candidate
         where j.id=candidate.id
        returning j.*;
      `, [workerId, jobId]);
      const job = result.rows[0] || null;
      if (job) {
        await client.query(`insert into volt_core.integration_job_attempts
          (company_id,job_id,attempt,status,worker_id) values ($1,$2,$3,'processing',$4)`,
        [job.company_id, job.id, job.attempts, workerId]);
      }
      await client.query("commit");
      return job;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }));
}

async function claimNextJob(workerId) { return claimJob(workerId, null); }
async function claimJobById(workerId, jobId) { return claimJob(workerId, String(jobId || "").trim()); }

async function finishJob(job, { status, result = null, errorCode = null, errorMessage = null, availableAt = null, durationMs = null }) {
  return db.withRlsBypass(() => db.withClient(async (client) => {
    await client.query("begin");
    try {
      const completed = status === "completed" || status === "dead_letter";
      const updated = await client.query(`
        update volt_core.integration_jobs
           set status=$3, result=$4::jsonb, last_error_code=$5, last_error_message=$6,
               available_at=coalesce($7::timestamptz,available_at), locked_at=null, locked_by=null,
               completed_at=case when $8 then now() else null end, updated_at=now()
         where company_id=$1 and id=$2
         returning *;
      `, [job.company_id, job.id, status, result == null ? null : JSON.stringify(result), errorCode, errorMessage, availableAt, completed]);
      await client.query(`
        update volt_core.integration_job_attempts
           set status=$4, duration_ms=$5, error_code=$6, error_message=$7, completed_at=now()
         where id=(select id from volt_core.integration_job_attempts where company_id=$1 and job_id=$2 and attempt=$3 order by id desc limit 1)
      `, [job.company_id, job.id, job.attempts, status === "completed" ? "completed" : status, Math.round(durationMs || 0), errorCode, errorMessage]);
      await client.query(`update volt_core.integration_webhook_events
        set status=$3,error_code=$4,error_message=$5,processed_at=case when $3 in ('processed','failed') then now() else processed_at end
        where company_id=$1 and job_id=$2`,
      [job.company_id, job.id, status === "completed" ? "processed" : (status === "dead_letter" ? "failed" : "queued"), errorCode, errorMessage]);
      await client.query("commit");
      return updated.rows[0];
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }));
}

async function retryJob(companyId, jobId, actorUserId) {
  const result = await db.query(`
    update volt_core.integration_jobs
       set status='queued', attempts=0, manual_retries=manual_retries+1, available_at=now(),
           locked_at=null, locked_by=null, last_error_code=null, last_error_message=null,
           completed_at=null, updated_at=now(), created_by=coalesce(created_by,$3)
     where company_id=$1 and id=$2 and status='dead_letter'
     returning *;
  `, [companyId, jobId, actorUserId || null]);
  if (!result.rowCount) {
    const error = new Error("Somente jobs em dead-letter podem ser reenfileirados.");
    error.statusCode = 409;
    error.code = "INTEGRATION_JOB_NOT_RETRYABLE";
    throw error;
  }
  notifyIntegrationQueue();
  return result.rows[0];
}

async function recoverStaleJobs(leaseMs) {
  return db.withRlsBypass(() => db.withClient(async (client) => {
    await client.query("begin");
    try {
      const recovered = await client.query(`
        update volt_core.integration_jobs
           set status='retrying', available_at=now(), locked_at=null, locked_by=null,
               last_error_code='WORKER_LEASE_EXPIRED', last_error_message='Job recuperado apos expirar o lease do worker.', updated_at=now()
         where status='processing' and locked_at < now() - ($1::bigint * interval '1 millisecond')
         returning company_id,id,attempts;
      `, [leaseMs]);
      for (const row of recovered.rows) {
        await client.query(`update volt_core.integration_job_attempts
          set status='retrying',error_code='WORKER_LEASE_EXPIRED',error_message='Tentativa recuperada apos expirar o lease do worker.',completed_at=now()
          where id=(select id from volt_core.integration_job_attempts
            where company_id=$1 and job_id=$2 and attempt=$3 and status='processing' order by id desc limit 1)`,
        [row.company_id, row.id, row.attempts]);
      }
      await client.query("commit");
      return recovered;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }));
}

module.exports = { claimJobById, claimNextJob, enqueueJob, enqueueJobWithClient, finishJob, recoverStaleJobs, retryJob };
