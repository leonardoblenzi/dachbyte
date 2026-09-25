"use strict";

const db = require("../config/postgres");
const { appendAuditEvent } = require("../repositories/auditRepository");
const { sanitizeAuditDetails } = require("./auditSanitizer");

const DEFAULT_PAGE_SIZE = 40;
const MAX_EXPORT_ROWS = 20000;
const DEFAULT_CLEANUP_BATCH = 5000;
const DEFAULT_CLEANUP_MAX_ROWS = 50000;

function clean(value, max = 500) { return String(value == null ? "" : value).trim().slice(0, max); }
function int(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value == null ? "" : value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
function date(value, end = false) {
  const raw = clean(value, 40);
  if (!raw) return null;
  const parsed = new Date(end && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59.999Z` : raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
function retentionMatchSql(alias = "e") {
  return `left join lateral (
    select r.rule_key,r.retention_days,r.min_days,r.max_days,r.description
      from magalu.audit_retention_rules r
     where r.enabled=true
       and (r.event_key is null or r.event_key=${alias}.event_key)
       and (r.category is null or r.category=${alias}.category)
       and (r.severity is null or r.severity=${alias}.severity)
       and (r.outcome is null or r.outcome=${alias}.outcome)
     order by r.priority desc,
              ((r.event_key is not null)::int*16 + (r.severity is not null)::int*8 + (r.outcome is not null)::int*4 + (r.category is not null)::int*2) desc,
              r.rule_key asc
     limit 1
  ) rr on true`;
}

function buildEventWhere(filters = {}) {
  const where = ["1=1"];
  const params = [];
  const eq = (expr, value) => { const v=clean(value,300); if(v){params.push(v);where.push(`${expr}=$${params.length}`);} };
  eq("e.event_key", filters.eventKey || filters.event_key);
  eq("e.category", filters.category);
  eq("e.severity", filters.severity);
  eq("e.outcome", filters.outcome);
  eq("e.dach_tenant_id", filters.tenant);
  eq("e.dach_user_id", filters.user);
  eq("e.sku", filters.sku);
  eq("e.batch_id", filters.batchId || filters.batch_id);
  eq("e.request_id", filters.requestId || filters.request_id);
  eq("e.source", filters.source);
  const accountId = Number.parseInt(String(filters.accountId || filters.account_id || ""), 10);
  if (Number.isFinite(accountId) && accountId > 0) { params.push(accountId); where.push(`e.account_id=$${params.length}`); }
  const from = date(filters.from); if (from) { params.push(from); where.push(`e.created_at >= $${params.length}::timestamptz`); }
  const to = date(filters.to, true); if (to) { params.push(to); where.push(`e.created_at <= $${params.length}::timestamptz`); }
  const search = clean(filters.search, 200).toLowerCase();
  if (search) {
    params.push(`%${search}%`);
    where.push(`(lower(e.action) like $${params.length} or lower(e.event_key) like $${params.length} or lower(coalesce(e.dach_tenant_id,'')) like $${params.length} or lower(coalesce(e.dach_user_id,'')) like $${params.length} or lower(coalesce(e.magalu_tenant_id,'')) like $${params.length} or lower(coalesce(e.sku,'')) like $${params.length} or lower(coalesce(e.request_id,'')) like $${params.length} or lower(coalesce(e.batch_id,'')) like $${params.length} or lower(coalesce(e.source,'')) like $${params.length})`);
  }
  return { where, params };
}

async function listEvents(filters = {}) {
  const page = int(filters.page, 1, 100000, 1);
  const limit = int(filters.limit, 1, 100, DEFAULT_PAGE_SIZE);
  const f = buildEventWhere(filters);
  const count = await db.queryOne(`select count(*)::int total from magalu.audit_events e where ${f.where.join(" and ")}`, f.params);
  const params = [...f.params, limit, (page - 1) * limit];
  const { rows } = await db.query(`
    select e.id,e.created_at,e.event_key,e.action,e.category,e.severity,e.outcome,
           e.dach_tenant_id,e.dach_user_id,e.account_id,e.magalu_tenant_id,e.operation_id,
           e.resource_type,e.sku,e.batch_id,e.request_id,e.source,
           rr.rule_key as retention_rule,rr.retention_days,
           (e.created_at < now() - make_interval(days => coalesce(rr.retention_days,30))) as retention_expired
      from magalu.audit_events e
      ${retentionMatchSql("e")}
     where ${f.where.join(" and ")}
     order by e.created_at desc,e.id desc
     limit $${params.length-1} offset $${params.length}`, params);
  return { rows, total:Number(count?.total||0), page, limit };
}

async function eventDetail(eventId) {
  const row = await db.queryOne(`
    select e.id,e.created_at,e.event_key,e.action,e.category,e.severity,e.outcome,
           e.dach_tenant_id,e.dach_user_id,e.account_id,e.magalu_tenant_id,e.operation_id,
           e.resource_type,e.sku,e.batch_id,e.request_id,e.source,e.details,
           rr.rule_key as retention_rule,rr.retention_days,rr.description as retention_description,
           e.created_at + make_interval(days => coalesce(rr.retention_days,30)) as expires_at
      from magalu.audit_events e ${retentionMatchSql("e")}
     where e.id=$1 limit 1`, [Number(eventId)]);
  return row ? { ...row, details: sanitizeAuditDetails(row.details || {}) } : null;
}

async function exportEvents(filters = {}, maxRows = MAX_EXPORT_ROWS) {
  const f = buildEventWhere(filters);
  const params = [...f.params, int(maxRows,1,MAX_EXPORT_ROWS,MAX_EXPORT_ROWS)];
  const { rows } = await db.query(`
    select e.id,e.created_at,e.event_key,e.action,e.category,e.severity,e.outcome,
           e.dach_tenant_id,e.dach_user_id,e.account_id,e.magalu_tenant_id,e.operation_id,
           e.resource_type,e.sku,e.batch_id,e.request_id,e.source,e.details,
           rr.rule_key as retention_rule,rr.retention_days
      from magalu.audit_events e ${retentionMatchSql("e")}
     where ${f.where.join(" and ")}
     order by e.created_at desc,e.id desc limit $${params.length}`, params);
  return rows.map((row) => ({ ...row, details: sanitizeAuditDetails(row.details || {}) }));
}

async function listRules() {
  const { rows } = await db.query(`select rule_key,category,severity,outcome,event_key,retention_days,min_days,max_days,priority,enabled,description,updated_by,updated_at from magalu.audit_retention_rules order by priority desc,rule_key asc`);
  return rows;
}

async function updateRules(updates, actorUserId) {
  if (!Array.isArray(updates) || updates.length === 0) {
    const error = new Error("Informe ao menos uma regra de retenção."); error.status=400; error.code="MAGALU_AUDIT_RETENTION_EMPTY"; throw error;
  }
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const saved = [];
      for (const item of updates) {
        const key = clean(item?.rule_key, 120);
        const days = Number.parseInt(String(item?.retention_days ?? ""), 10);
        const current = (await client.query(`select * from magalu.audit_retention_rules where rule_key=$1 for update`, [key])).rows[0];
        if (!current) { const e=new Error(`Regra desconhecida: ${key||"(vazia)"}.`);e.status=400;e.code="MAGALU_AUDIT_RETENTION_RULE_UNKNOWN";throw e; }
        if (!Number.isFinite(days) || days < Number(current.min_days) || days > Number(current.max_days) || days > 90) {
          const e=new Error(`A regra ${key} aceita ${current.min_days}–${current.max_days} dias.`);e.status=400;e.code="MAGALU_AUDIT_RETENTION_OUT_OF_BOUNDS";throw e;
        }
        const row = (await client.query(`update magalu.audit_retention_rules set retention_days=$2,updated_by=$3,updated_at=now() where rule_key=$1 returning rule_key,retention_days,min_days,max_days,updated_by,updated_at`, [key,days,clean(actorUserId,200)||null])).rows[0];
        saved.push(row);
      }
      await appendAuditEvent({ action:"MASTER_AUDIT_RETENTION_UPDATED", category:"admin", severity:"info", outcome:"success", dachUserId:actorUserId, source:"magalu-master", details:{ rules:saved.map(r=>({rule_key:r.rule_key,retention_days:r.retention_days})) } }, { client });
      await client.query("commit");
      return saved;
    } catch (error) { await client.query("rollback").catch(()=>{}); throw error; }
  });
}

async function createRun(mode, actorUserId) {
  return db.queryOne(`insert into magalu.audit_maintenance_runs(run_mode,status,actor_user_id) values($1,'running',$2) returning *`, [mode,clean(actorUserId,200)||null]);
}
async function finishRun(id, payload) {
  return db.queryOne(`update magalu.audit_maintenance_runs set status=$2,scanned_count=$3,eligible_count=$4,deleted_count=$5,summary=$6::jsonb,error_message=$7,finished_at=now() where id=$1 returning *`, [Number(id),payload.status,Number(payload.scannedCount||0),Number(payload.eligibleCount||0),Number(payload.deletedCount||0),JSON.stringify(payload.summary||{}),payload.errorMessage?clean(payload.errorMessage,2000):null]);
}

async function retentionPreview() {
  const { rows } = await db.query(`
    select coalesce(rr.rule_key,'default') rule_key,coalesce(rr.retention_days,30)::int retention_days,
           count(*)::int total,
           count(*) filter (where e.created_at < now() - make_interval(days => coalesce(rr.retention_days,30)))::int eligible,
           min(e.created_at) as oldest_event,max(e.created_at) as newest_event
      from magalu.audit_events e ${retentionMatchSql("e")}
     group by coalesce(rr.rule_key,'default'),coalesce(rr.retention_days,30)
     order by eligible desc,total desc,rule_key asc`);
  const totals = rows.reduce((acc,row)=>({ total:acc.total+Number(row.total||0), eligible:acc.eligible+Number(row.eligible||0) }),{total:0,eligible:0});
  return { groups:rows, ...totals };
}

async function dryRun(actorUserId) {
  const run = await createRun("dry_run", actorUserId);
  try {
    const preview = await retentionPreview();
    const saved = await finishRun(run.id,{status:"success",scannedCount:preview.total,eligibleCount:preview.eligible,deletedCount:0,summary:{groups:preview.groups}});
    await appendAuditEvent({ action:"MASTER_AUDIT_RETENTION_DRY_RUN", category:"admin", outcome:"success", dachUserId:actorUserId, source:"magalu-master", details:{ maintenance_run_id:saved.id,scanned:preview.total,eligible:preview.eligible } }).catch(()=>{});
    return { run:saved, preview };
  } catch (error) { await finishRun(run.id,{status:"failed",errorMessage:error.message}).catch(()=>{}); throw error; }
}

async function cleanup({ mode="scheduled", actorUserId=null, batchSize=DEFAULT_CLEANUP_BATCH, maxRows=DEFAULT_CLEANUP_MAX_ROWS } = {}) {
  if (!new Set(["scheduled","manual"]).has(mode)) mode="scheduled";
  const run = await createRun(mode, actorUserId);
  let deleted = 0;
  try {
    const preview = await retentionPreview();
    const safeBatch = int(batchSize,100,10000,DEFAULT_CLEANUP_BATCH);
    const safeMax = int(maxRows,safeBatch,200000,DEFAULT_CLEANUP_MAX_ROWS);
    while (deleted < safeMax) {
      const limit = Math.min(safeBatch, safeMax-deleted);
      const result = await db.query(`
        with expired as (
          select e.id from magalu.audit_events e ${retentionMatchSql("e")}
           where e.created_at < now() - make_interval(days => coalesce(rr.retention_days,30))
           order by e.created_at asc,e.id asc limit $1
        )
        delete from magalu.audit_events e using expired x where e.id=x.id returning e.id`, [limit]);
      deleted += Number(result.rowCount||0);
      if (Number(result.rowCount||0) < limit) break;
    }
    await db.query(`delete from magalu.audit_maintenance_runs where created_at < now() - interval '90 days' and id<>$1`, [Number(run.id)]).catch(()=>{});
    const saved = await finishRun(run.id,{status:"success",scannedCount:preview.total,eligibleCount:preview.eligible,deletedCount:deleted,summary:{groups:preview.groups,truncated:deleted>=safeMax,max_rows:safeMax}});
    await appendAuditEvent({ action:"MASTER_AUDIT_RETENTION_CLEANUP", category: mode==="manual"?"admin":"system", severity:"info", outcome:"success", dachUserId:actorUserId, source:mode==="manual"?"magalu-master":"seller-magalu-worker", details:{ maintenance_run_id:saved.id,eligible_before:preview.eligible,deleted,truncated:deleted>=safeMax } }).catch(()=>{});
    return saved;
  } catch (error) {
    await finishRun(run.id,{status:"failed",deletedCount:deleted,errorMessage:error.message}).catch(()=>{});
    throw error;
  }
}

async function listRuns(limit=30) {
  const { rows } = await db.query(`select id,run_mode,status,actor_user_id,scanned_count,eligible_count,deleted_count,summary,error_message,started_at,finished_at,created_at from magalu.audit_maintenance_runs order by created_at desc limit $1`, [int(limit,1,100,30)]);
  return rows;
}

module.exports = {
  listEvents,eventDetail,exportEvents,listRules,updateRules,retentionPreview,dryRun,cleanup,listRuns,
  _test:{clean,int,date,buildEventWhere,retentionMatchSql,DEFAULT_CLEANUP_BATCH,DEFAULT_CLEANUP_MAX_ROWS},
};
