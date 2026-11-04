"use strict";
const db = require("../config/postgres");
const skuMassRepository = require("./skuMassRepository");

async function list(accountId, tenantId) {
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
  ].sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
  return all.slice(0, 100);
}

async function detail(accountId, tenantId, kind, id) {
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
module.exports = { list, detail };
