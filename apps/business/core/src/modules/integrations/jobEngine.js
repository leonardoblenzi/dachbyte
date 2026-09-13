"use strict";

const logger = require("../../observability/logger");
const db = require("../../../db/db");
const { runWithRequestContext } = require("../../observability/requestContext");
const metrics = require("../../observability/metrics");
const { backoffMs, integrationError } = require("./helpers");
const { getJobHandler } = require("./registry");
const { claimJobById, claimNextJob, finishJob, recoverStaleJobs } = require("./jobStore");

async function processClaimedJob(job, workerId) {
  if (!job) return null;
  const started = process.hrtime.bigint();
  const handler = getJobHandler(job.type);
  try {
    if (!handler) throw integrationError(`Nenhum handler registrado para ${job.type}.`, "INTEGRATION_JOB_HANDLER_NOT_FOUND", { retryable: false });
    const result = await runWithRequestContext({
      requestId: job.request_id || job.correlation_id || job.id,
      companyId: job.company_id,
      userId: job.created_by || null,
    }, () => db.withTenantContext(job.company_id, () => handler({
      job,
      companyId: job.company_id,
      accountId: job.account_id,
      payload: job.payload || {},
      correlationId: job.correlation_id,
      requestId: job.request_id,
    })));
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const updated = await finishJob(job, { status: "completed", result: result ?? {}, durationMs });
    metrics.recordIntegration("completedJobs");
    logger.info("integration.job.completed", { requestId: job.request_id, correlationId: job.correlation_id, companyId: job.company_id, jobId: job.id, jobType: job.type, attempt: job.attempts, durationMs: Number(durationMs.toFixed(2)) });
    return updated;
  } catch (error) {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const retryable = error?.retryable !== false;
    const deadLetter = !retryable || Number(job.attempts) >= Number(job.max_attempts);
    const status = deadLetter ? "dead_letter" : "retrying";
    const availableAt = deadLetter ? null : new Date(Date.now() + backoffMs(job.attempts)).toISOString();
    const updated = await finishJob(job, {
      status,
      errorCode: error?.code || "INTEGRATION_JOB_FAILED",
      errorMessage: String(error?.message || error).slice(0, 2000),
      availableAt,
      durationMs,
    });
    if (deadLetter) metrics.recordIntegration("deadLetterJobs");
    else metrics.recordIntegration("retriedJobs");
    logger[deadLetter ? "error" : "warn"](deadLetter ? "integration.job.dead_letter" : "integration.job.retry", {
      requestId: job.request_id, correlationId: job.correlation_id, companyId: job.company_id, jobId: job.id, jobType: job.type, attempt: job.attempts,
      maxAttempts: job.max_attempts, errorCode: error?.code, errorMessage: error?.message,
      nextAttemptAt: availableAt, durationMs: Number(durationMs.toFixed(2)),
    });
    return updated;
  }
}

async function processOneJob(workerId) {
  return processClaimedJob(await claimNextJob(workerId), workerId);
}

async function processJobById(workerId, jobId) {
  return processClaimedJob(await claimJobById(workerId, jobId), workerId);
}

async function runJobBatch(workerId, batchSize = 10) {
  const processed = [];
  for (let index = 0; index < Math.max(1, Number(batchSize || 10)); index += 1) {
    const job = await processOneJob(workerId);
    if (!job) break;
    processed.push(job);
  }
  return processed;
}

module.exports = { processJobById, processOneJob, recoverStaleJobs, runJobBatch };
