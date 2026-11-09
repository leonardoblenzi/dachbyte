"use strict";
const db = require("../config/postgres");
const skuMassRepository = require("./skuMassRepository");
const syncRunRepository = require("./syncRunRepository");

const SYNC_TYPES = ["catalog_full"];
const STALE_RUN_MS = 12 * 60 * 60 * 1000;
// Sincronizações (leitura) no formato dos cards do painel: total estimado,
// processados, pendentes e falhas de leitura; "running" antigo é exibido como interrompido.
function syncRow(run, now = Date.now()) {
  const result = run.result || {};
  const interrupted = run.status === "running" && now - new Date(run.started_at).getTime() > STALE_RUN_MS;
  const status = interrupted ? "canceled" : run.status;
  const running = status === "running";
  const processed = Number(run.scanned_count) || 0;
  const expected = Math.max(Number(result.expected_total) || 0, processed);
  return {
    id: run.id, kind: "sync", action: run.sync_type, resource: "catálogo", status,
    stage: running ? result.stage || "sku_list" : result.stage || null,
    total_count: running ? Math.max(expected, 1) : processed,
    success_count: processed, failed_count: Number(run.failed_count) || 0,
    pending_count: running ? Math.max(expected - processed, 1) : 0,
    details_skipped: Number(result.details_skipped) || 0,
    error_message: ["failed", "canceled"].includes(status) ? run.error_message || "Execução interrompida antes de terminar." : null,
    created_at: run.started_at, finished_at: run.finished_at,
  };
}

async function list(accountId, tenantId) {
  const syncRuns = await syncRunRepository.recentRuns(accountId, SYNC_TYPES, 10);
  const batches = await skuMassRepository.listBatches(tenantId, { accountId, page: 1, limit: 50 });
  const { rows: groups } = await db.query(`select g.id,g.action,g.created_at,g.applied_at,g.status,g.error_message,
    g.total_count,coalesce(b.success_count,0)::int success_count,
    coalesce(b.failed_count,0)::int failed_count,coalesce(b.stale_count,0)::int stale_count,
    coalesce(b.uncertain_count,0)::int uncertain_count,coalesce(b.divergent_count,0)::int divergent_count,
    (g.total_count-coalesce(b.total_count,0)+coalesce(b.pending_count,0))::int pending_count
    from magalu.sku_bulk_groups g
    left join lateral (select sum(batch.total_count)::int total_count,sum(batch.success_count)::int success_count,
      sum(batch.failed_count)::int failed_count,sum(batch.stale_count)::int stale_count,
      sum(batch.uncertain_count)::int uncertain_count,sum(batch.divergent_count)::int divergent_count,
      sum(batch.pending_count)::int pending_count from magalu.mass_operation_batches batch where batch.group_id=g.id) b on true
    where g.account_id=$1 and g.dach_tenant_id=$2 and g.status<>'prepared' order by g.created_at desc limit 30`,[Number(accountId),String(tenantId)]);
  const { rows: writes } = await db.query(`with recent as (
    select preview_id from magalu.write_operations
    where account_id=$1 and dach_tenant_id=$2 and preview_id is not null
    group by preview_id order by max(created_at) desc limit 50
  ) select w.preview_id as id, w.resource_type as resource,
    count(*)::int as total_count,
    count(*) filter (where w.status='succeeded')::int as success_count,
    count(*) filter (where w.status='failed')::int as failed_count,
    count(*) filter (where w.status='stale')::int as stale_count,
    count(*) filter (where w.status='uncertain')::int as uncertain_count,
    count(*) filter (where w.status='divergent')::int as divergent_count,
    count(*) filter (where w.status in ('queued','running','dispatching','accepted'))::int as pending_count,
    min(w.created_at) as created_at, max(w.updated_at) as updated_at
  from magalu.write_operations w join recent r on r.preview_id=w.preview_id
  where w.account_id=$1 and w.dach_tenant_id=$2
  group by w.preview_id,w.resource_type order by max(w.created_at) desc`, [Number(accountId), String(tenantId)]);
  const all = [
    ...groups.map(row => ({ ...row, kind: "group", resource: "sku" })),
    ...batches.rows.filter(row=>!row.group_id).map(row => ({ ...row, kind: "catalog", resource: "sku" })),
    ...writes.map(row => ({ ...row, kind: "write" })),
    // Só a sincronização mais recente tem relatório fiel: a seguinte sobrescreve o estado dos SKUs.
    ...syncRuns.map((run, index) => ({ ...syncRow(run), report_available: index === 0 })),
  ].sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
  return all.slice(0, 100);
}

async function detail(accountId, tenantId, kind, id) {
  if (kind === "sync") {
    if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) return null;
    const run = await syncRunRepository.getRun(accountId, id);
    if (!run || !SYNC_TYPES.includes(run.sync_type)) return null;
    const row = syncRow(run), result = run.result || {};
    return [{ ...row, pages: Number(result.pages) || 0, known_processed: Number(result.known_processed) || 0,
      known_missing: Number(result.known_missing) || 0, discovery_partial_statuses: result.discovery_partial_statuses || [] }];
  }
  if(kind==="group"){
    const group=await db.queryOne(`select id from magalu.sku_bulk_groups where id=$1 and account_id=$2 and dach_tenant_id=$3`,[id,Number(accountId),String(tenantId)]);
    if(!group)return null;
    const {rows}=await db.query(`select id,action,status,total_count,success_count,failed_count,stale_count,uncertain_count,divergent_count,pending_count,created_at from magalu.mass_operation_batches where group_id=$1 and account_id=$2 and dach_tenant_id=$3 order by created_at,id`,[id,Number(accountId),String(tenantId)]);
    return rows;
  }
  if (kind === "catalog") {
    const data = await skuMassRepository.batchDetail(id, tenantId);
    return data?.batch && Number(data.batch.account_id) === Number(accountId) ? data.items : null;
  }
  if (kind !== "write") return null;
  const { rows } = await db.query(`select id,sku,status,resource_type,error_code,error_message,request_id,response_status,created_at,updated_at
    from magalu.write_operations where preview_id=$1 and account_id=$2 and dach_tenant_id=$3 order by id asc limit 5001`,
    [id, Number(accountId), String(tenantId)]);
  return rows.length ? rows : null;
}
// Relatório por SKU (página por id crescente), sempre restrito à conta e ao tenant.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPORT_KINDS = { group: "sku", catalog: "sku", write: "write" };
async function reportExists(accountId, tenantId, kind, id) {
  if (!REPORT_KINDS[kind] || !UUID_RE.test(String(id))) return false;
  const params = [String(id), Number(accountId), String(tenantId)];
  const sql = kind === "group"
    ? "select 1 from magalu.sku_bulk_groups where id=$1 and account_id=$2 and dach_tenant_id=$3"
    : kind === "catalog"
      ? "select 1 from magalu.mass_operation_batches where id=$1 and account_id=$2 and dach_tenant_id=$3"
      : "select 1 from magalu.write_operations where preview_id=$1 and account_id=$2 and dach_tenant_id=$3 limit 1";
  return Boolean(await db.queryOne(sql, params));
}
async function reportPage(accountId, tenantId, kind, id, afterId = 0, limit = 2000) {
  const params = [String(id), Number(accountId), String(tenantId), Number(afterId) || 0, Math.min(5000, Math.max(1, Number(limit) || 2000))];
  if (kind === "write") {
    const { rows } = await db.query(`select w.id,w.sku,w.resource_type,w.status,w.before_payload,w.requested_payload,w.after_payload,
      w.response_status,w.request_id,w.error_code,w.error_message,w.completed_at,s.title,'' as batch_label
      from magalu.write_operations w left join magalu.skus s on s.account_id=w.account_id and s.sku=w.sku
      where w.preview_id=$1 and w.account_id=$2 and w.dach_tenant_id=$3 and w.id>$4 order by w.id limit $5`, params);
    return rows;
  }
  const batchFilter = kind === "group" ? "b.group_id=$1" : "b.id=$1";
  const { rows } = await db.query(`with batches as (
      select b.id,row_number() over(order by b.created_at,b.id) as n from magalu.mass_operation_batches b
      where ${batchFilter} and b.account_id=$2 and b.dach_tenant_id=$3)
    select i.id,i.sku,i.action,i.status,i.before_payload,i.requested_payload,i.after_payload,i.response_status,i.request_id,
      i.error_code,i.error_message,i.completed_at,s.title,'Lote '||b.n as batch_label
    from magalu.mass_operation_items i join batches b on b.id=i.batch_id
    left join magalu.skus s on s.account_id=i.account_id and s.sku=i.sku
    where i.account_id=$2 and i.dach_tenant_id=$3 and i.id>$4 order by i.id limit $5`, params);
  return rows;
}
// Relatório da sincronização do catálogo: estado de cada SKU (presentes ou removidos nesta execução).
async function latestSyncRun(accountId, id) {
  const run = await syncRunRepository.getRun(accountId, id);
  if (!run || !SYNC_TYPES.includes(run.sync_type)) return null;
  const [latest] = await syncRunRepository.recentRuns(accountId, SYNC_TYPES, 1);
  return latest && String(latest.id) === String(run.id) ? run : { ...run, not_latest: true };
}
async function syncReportPage(accountId, run, afterId = 0, limit = 2000) {
  const { rows } = await db.query(`select s.id,s.sku,s.title,s.status,s.active,s.is_present,s.last_synced_at,
      p.price,p.list_price,p.last_error as price_error,p.last_synced_at as price_synced_at,
      st.quantity,st.last_error as stock_error,st.last_synced_at as stock_synced_at
    from magalu.skus s
    left join magalu.prices p on p.account_id=s.account_id and p.sku=s.sku
    left join magalu.stocks st on st.account_id=s.account_id and st.sku=s.sku
    where s.account_id=$1 and s.id>$2 and (s.is_present=true or s.last_synced_at>=$3::timestamptz)
    order by s.id limit $4`, [Number(accountId), Number(afterId) || 0, run.started_at, Math.min(5000, Math.max(1, Number(limit) || 2000))]);
  return rows;
}
// Prévia de preços promocionais: só o dono da prévia (mesma conta, tenant e usuário).
async function previewReportPage(identity, previewId, afterSku = "", limit = 2000) {
  if (!UUID_RE.test(String(previewId))) return [];
  const { rows } = await db.query(`select r.sku,r.source,r.result,r.price_override
    from magalu.promo_pricing_preview_rows r join magalu.promo_pricing_previews p on p.id=r.preview_id
    where r.preview_id=$1 and p.account_id=$2 and p.dach_tenant_id=$3 and p.dach_user_id=$4 and r.sku>$5
    order by r.sku limit $6`, [String(previewId), Number(identity.accountId), String(identity.tenantId), String(identity.userId), String(afterSku || ""), Math.min(5000, Math.max(1, Number(limit) || 2000))]);
  return rows;
}
async function previewExists(identity, previewId) {
  if (!UUID_RE.test(String(previewId))) return false;
  return Boolean(await db.queryOne(`select 1 from magalu.promo_pricing_previews where id=$1 and account_id=$2 and dach_tenant_id=$3 and dach_user_id=$4`,
    [String(previewId), Number(identity.accountId), String(identity.tenantId), String(identity.userId)]));
}
module.exports = { list, detail, reportExists, reportPage, latestSyncRun, syncReportPage, previewReportPage, previewExists, REPORT_KINDS, _test: { syncRow } };
