"use strict";

const db = require("../config/postgres");

const ACTIVE_OPERATION_STATES = ["queued", "running", "dispatching", "accepted", "divergent", "uncertain"];
const TABLES = Object.freeze({
  auditRetentionRules: "magalu.audit_retention_rules",
  auditMaintenanceRuns: "magalu.audit_maintenance_runs",
  skuMassPreviews: "magalu.sku_mass_previews",
  massBatches: "magalu.mass_operation_batches",
  massItems: "magalu.mass_operation_items",
  deliveryWrites: "magalu.delivery_write_operations",
});

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value == null ? "" : value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
function clean(value, max = 300) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

async function relationExists(qualifiedName) {
  const row = await db.queryOne(`select to_regclass($1)::text as relation`, [qualifiedName]);
  return Boolean(row?.relation);
}

async function columnsFor(tableName) {
  const { rows } = await db.query(
    `select column_name
       from information_schema.columns
      where table_schema='magalu' and table_name=$1`,
    [String(tableName)],
  );
  return new Set(rows.map((row) => String(row.column_name)));
}

async function schemaCapabilities() {
  const entries = await Promise.all(Object.entries(TABLES).map(async ([key, name]) => [key, await relationExists(name)]));
  const out = Object.fromEntries(entries);
  out.auditV2Retention = out.auditRetentionRules && out.auditMaintenanceRuns;
  out.massSkuOperations = out.skuMassPreviews && out.massBatches && out.massItems;
  out.deliveryWriteOperations = out.deliveryWrites;
  return out;
}

async function overview() {
  const [accounts, skus, operationsToday, syncToday, series, tenants, capabilities] = await Promise.all([
    db.queryOne(`
      select
        count(*)::int as total,
        count(*) filter (where status='active')::int as active,
        count(*) filter (where status in ('error','revoked','disabled'))::int as problem,
        count(distinct dach_tenant_id)::int as tenants,
        count(distinct magalu_tenant_id)::int as organizations
      from magalu.accounts`),
    db.queryOne(`select count(*) filter (where is_present)::int as total from magalu.skus`),
    db.queryOne(`
      select
        count(*)::int as total,
        count(*) filter (where status='succeeded')::int as success,
        count(*) filter (where status='failed')::int as failed,
        count(*) filter (where status='uncertain')::int as uncertain,
        count(*) filter (where status='divergent')::int as divergent,
        count(*) filter (where status = any($1::text[]))::int as pending
      from magalu.write_operations
      where created_at >= date_trunc('day', now())`, [ACTIVE_OPERATION_STATES]),
    db.queryOne(`
      select
        count(*)::int as total,
        count(*) filter (where status='failed')::int as failed
      from magalu.sync_runs
      where started_at >= date_trunc('day', now())`),
    db.query(`
      with days as (
        select generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') as day
      ), ops as (
        select date_trunc('day', created_at) day,
               count(*)::int operations,
               count(*) filter (where status='failed')::int failures
          from magalu.write_operations
         where created_at >= date_trunc('day', now()) - interval '13 days'
         group by 1
      ), syncs as (
        select date_trunc('day', started_at) day, count(*)::int syncs,
               count(*) filter (where status='failed')::int sync_failures
          from magalu.sync_runs
         where started_at >= date_trunc('day', now()) - interval '13 days'
         group by 1
      )
      select d.day,
             coalesce(o.operations,0)::int operations,
             coalesce(o.failures,0)::int failures,
             coalesce(s.syncs,0)::int syncs,
             coalesce(s.sync_failures,0)::int sync_failures
        from days d left join ops o using(day) left join syncs s using(day)
       order by d.day asc`),
    db.query(`
      select a.dach_tenant_id,
             count(distinct a.id)::int accounts,
             count(distinct s.id) filter (where s.is_present)::int skus,
             count(distinct w.id) filter (where w.created_at >= now() - interval '30 days')::int operations_30d
        from magalu.accounts a
        left join magalu.skus s on s.account_id=a.id
        left join magalu.write_operations w on w.account_id=a.id
       group by a.dach_tenant_id
       order by operations_30d desc, skus desc, accounts desc
       limit 12`),
    schemaCapabilities(),
  ]);

  let massOperationsToday = null;
  if (capabilities.massSkuOperations) {
    const columns = await columnsFor("mass_operation_batches");
    if (columns.has("created_at")) {
      const row = await db.queryOne(`select count(*)::int as total from magalu.mass_operation_batches where created_at >= date_trunc('day', now())`);
      massOperationsToday = Number(row?.total || 0);
    }
  }

  return {
    accounts: accounts || {},
    skus: Number(skus?.total || 0),
    operationsToday: operationsToday || {},
    syncToday: syncToday || {},
    massOperationsToday,
    series: series.rows,
    tenants: tenants.rows,
    capabilities,
  };
}

function addFilter(parts, params, expression, value) {
  if (value == null || value === "") return;
  params.push(value);
  parts.push(`${expression} $${params.length}`);
}

async function listAccounts(filters = {}) {
  const page = clampInt(filters.page, 1, 100000, 1);
  const limit = clampInt(filters.limit, 1, 100, 30);
  const offset = (page - 1) * limit;
  const where = ["1=1"];
  const filterParams = [];
  const search = clean(filters.search, 200);
  const tenant = clean(filters.tenant, 160);
  const status = clean(filters.status, 40).toLowerCase();
  if (search) {
    filterParams.push(`%${search.toLowerCase()}%`);
    where.push(`(
      lower(a.dach_tenant_id) like $${filterParams.length}
      or lower(a.magalu_tenant_id) like $${filterParams.length}
      or lower(coalesce(a.magalu_tenant_name,'')) like $${filterParams.length}
      or lower(coalesce(a.hub_resource_key,'')) like $${filterParams.length}
    )`);
  }
  addFilter(where, filterParams, "a.dach_tenant_id =", tenant);
  addFilter(where, filterParams, "a.status =", status);

  const count = await db.queryOne(
    `select count(*)::int total from magalu.accounts a where ${where.join(" and ")}`,
    filterParams,
  );
  const queryParams = [...filterParams, ACTIVE_OPERATION_STATES, limit, offset];
  const blockerIndex = filterParams.length + 1;
  const limitIndex = filterParams.length + 2;
  const offsetIndex = filterParams.length + 3;
  const result = await db.query(`
    select
      a.id, a.dach_tenant_id,
      coalesce(nullif(a.metadata->>'company_name',''), a.dach_tenant_id) as dach_tenant_label,
      a.magalu_tenant_id, a.magalu_tenant_name, a.status, a.scopes,
      a.connected_at, a.last_oauth_at,
      a.catalog_sync_status, a.catalog_last_synced_at, a.catalog_last_error,
      a.hub_resource_key, a.hub_sync_status, a.hub_synced_at, a.hub_sync_error,
      a.updated_at,
      t.access_expires_at, t.refresh_expires_at, t.last_refresh_at, t.last_refresh_attempt_at,
      t.last_refresh_error,
      coalesce(s.total_skus,0)::int total_skus,
      coalesce(w.pending_writes,0)::int pending_writes
    from magalu.accounts a
    left join magalu.tokens t on t.account_id=a.id
    left join lateral (
      select count(*) filter (where is_present)::int total_skus from magalu.skus s where s.account_id=a.id
    ) s on true
    left join lateral (
      select count(*)::int pending_writes from magalu.write_operations w
       where w.account_id=a.id and w.status = any($${blockerIndex}::text[])
    ) w on true
    where ${where.join(" and ")}
    order by case a.status when 'active' then 0 when 'error' then 1 else 2 end,
             coalesce(a.magalu_tenant_name,a.magalu_tenant_id) asc, a.id asc
    limit $${limitIndex} offset $${offsetIndex}`,
    queryParams,
  );

  return { rows: result.rows, total: Number(count?.total || 0), page, limit };
}

async function accountDetail(accountId) {
  const account = await db.queryOne(`
    select
      a.id, a.dach_tenant_id,
      coalesce(nullif(a.metadata->>'company_name',''), a.dach_tenant_id) as dach_tenant_label,
      a.dach_created_by_user_id, a.magalu_tenant_id, a.magalu_tenant_name,
      a.status, a.scopes, a.connected_at, a.last_oauth_at, a.revoked_at,
      a.catalog_sync_status, a.catalog_last_synced_at, a.catalog_last_error,
      a.hub_resource_key, a.hub_sync_status, a.hub_synced_at, a.hub_sync_error,
      a.created_at, a.updated_at,
      t.access_expires_at, t.refresh_expires_at, t.token_type, t.token_version,
      t.last_refresh_at, t.last_refresh_attempt_at, t.last_refresh_error
    from magalu.accounts a left join magalu.tokens t on t.account_id=a.id
    where a.id=$1 limit 1`, [Number(accountId)]);
  if (!account) return null;

  const [counts, webhooks, latestSync, writes] = await Promise.all([
    db.queryOne(`
      select
        (select count(*) filter (where is_present)::int from magalu.skus where account_id=$1) skus,
        (select count(*) filter (where is_present)::int from magalu.prices where account_id=$1) prices,
        (select count(*) filter (where is_present)::int from magalu.stocks where account_id=$1) stocks`, [Number(accountId)]),
    db.query(`select topic,status,last_synced_at from magalu.webhook_subscriptions where account_id=$1 order by topic`, [Number(accountId)]),
    db.queryOne(`select id,sync_type,status,scanned_count,created_count,updated_count,failed_count,error_message,started_at,finished_at from magalu.sync_runs where account_id=$1 order by started_at desc limit 1`, [Number(accountId)]),
    db.query(`select id,status,resource_type,sku,request_id,error_code,error_message,created_at,updated_at from magalu.write_operations where account_id=$1 and status = any($2::text[]) order by created_at asc`, [Number(accountId), ACTIVE_OPERATION_STATES]),
  ]);
  return { account, counts: counts || {}, webhooks: webhooks.rows, latestSync, pendingWrites: writes.rows };
}

function parseDate(value, end = false) {
  const v = clean(value, 40);
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v) && end) d.setUTCHours(23, 59, 59, 999);
  return d.toISOString();
}

function operationWhere(filters = {}, alias = "w") {
  const where = ["1=1"];
  const params = [];
  const tenant = clean(filters.tenant, 160);
  const accountId = Number.parseInt(filters.accountId, 10);
  const user = clean(filters.user, 160);
  const status = clean(filters.status, 40).toLowerCase();
  const sku = clean(filters.sku, 200);
  const batchId = clean(filters.batchId, 200);
  const from = parseDate(filters.from);
  const to = parseDate(filters.to, true);
  if (tenant) addFilter(where, params, `${alias}.dach_tenant_id =`, tenant);
  if (Number.isFinite(accountId) && accountId > 0) addFilter(where, params, `${alias}.account_id =`, accountId);
  if (user) addFilter(where, params, `${alias}.dach_user_id =`, user);
  if (status) addFilter(where, params, `${alias}.status =`, status);
  if (sku) {
    params.push(`%${sku.toLowerCase()}%`);
    where.push(`lower(${alias}.sku) like $${params.length}`);
  }
  if (batchId) {
    params.push(batchId);
    where.push(`(coalesce(${alias}.preview_id::text,'write:'||${alias}.id::text) = $${params.length})`);
  }
  if (from) { params.push(from); where.push(`${alias}.created_at >= $${params.length}::timestamptz`); }
  if (to) { params.push(to); where.push(`${alias}.created_at <= $${params.length}::timestamptz`); }
  return { where, params };
}

async function listProtectedBatchesForMaster(filters = {}, maxRows = 5000) {
  const f = operationWhere(filters);
  const params = [...f.params, ACTIVE_OPERATION_STATES, clampInt(maxRows, 1, 10000, 5000)];
  const { rows } = await db.query(`
    select
      coalesce(w.preview_id::text,'write:'||w.id::text) as batch_id,
      'protected_write'::text as source,
      min(w.created_at) as created_at,max(w.updated_at) as updated_at,
      min(w.dach_tenant_id) as dach_tenant_id,min(w.account_id)::bigint as account_id,
      min(a.magalu_tenant_name) as account_name,min(a.magalu_tenant_id) as magalu_tenant_id,
      min(w.dach_user_id) as dach_user_id,
      case when count(distinct w.resource_type)=1 then min(w.resource_type) else 'mixed' end as operation_type,
      case when count(distinct w.resource_type)=1 then min(w.resource_type) else 'mixed' end as action,
      case when count(*) filter(where w.status='uncertain')>0 then 'uncertain'
           when count(*) filter(where w.status='divergent')>0 then 'divergent'
           when count(*) filter(where w.status='failed')>0 then 'failed'
           when count(*) filter(where w.status='dispatching')>0 then 'dispatching'
           when count(*) filter(where w.status='accepted')>0 then 'accepted'
           when count(*) filter(where w.status='running')>0 then 'running'
           when count(*) filter(where w.status='queued')>0 then 'queued'
           when count(*) filter(where w.status='stale')>0 then 'stale' else 'succeeded' end as status,
      count(*)::int total,count(*) filter(where w.status='succeeded')::int success,
      count(*) filter(where w.status='failed')::int failed,count(*) filter(where w.status='stale')::int stale,
      count(*) filter(where w.status='uncertain')::int uncertain,count(*) filter(where w.status='divergent')::int divergent,
      count(*) filter(where w.status=any($${f.params.length+1}::text[]))::int pending
    from magalu.write_operations w left join magalu.accounts a on a.id=w.account_id
    where ${f.where.join(" and ")}
    group by coalesce(w.preview_id::text,'write:'||w.id::text)
    order by min(w.created_at) desc limit $${f.params.length+2}`, params);
  return rows;
}

function massBatchWhere(filters = {}) {
  const where=["1=1"],params=[];
  const tenant=clean(filters.tenant,160),accountId=Number.parseInt(filters.accountId,10),user=clean(filters.user,160),status=clean(filters.status,40).toLowerCase(),sku=clean(filters.sku,200),batchId=clean(filters.batchId,200),from=parseDate(filters.from),to=parseDate(filters.to,true);
  if(tenant)addFilter(where,params,"b.dach_tenant_id =",tenant);
  if(Number.isFinite(accountId)&&accountId>0)addFilter(where,params,"b.account_id =",accountId);
  if(user)addFilter(where,params,"b.dach_user_id =",user);
  if(status)addFilter(where,params,"b.status =",status);
  if(sku){params.push(`%${sku.toLowerCase()}%`);where.push(`exists(select 1 from magalu.mass_operation_items mi where mi.batch_id=b.id and lower(mi.sku) like $${params.length})`);}
  if(batchId){params.push(batchId.replace(/^mass:/,""));where.push(`b.id::text = $${params.length}`);}
  if(from){params.push(from);where.push(`b.created_at >= $${params.length}::timestamptz`);}
  if(to){params.push(to);where.push(`b.created_at <= $${params.length}::timestamptz`);}
  return{where,params};
}
async function listMassBatchesForMaster(filters = {}, maxRows = 5000) {
  const caps=await schemaCapabilities(); if(!caps.massSkuOperations)return[];
  const f=massBatchWhere(filters),params=[...f.params,clampInt(maxRows,1,10000,5000)];
  const {rows}=await db.query(`select 'mass:'||b.id::text batch_id,'mass_sku'::text source,b.created_at,b.updated_at,b.dach_tenant_id,b.account_id,a.magalu_tenant_name account_name,a.magalu_tenant_id,b.dach_user_id,b.operation_type,b.action,b.status,b.total_count::int total,b.success_count::int success,b.failed_count::int failed,b.stale_count::int stale,b.uncertain_count::int uncertain,b.divergent_count::int divergent,b.pending_count::int pending from magalu.mass_operation_batches b left join magalu.accounts a on a.id=b.account_id where ${f.where.join(" and ")} order by b.created_at desc limit $${params.length}`,params);
  return rows;
}
async function listDeliveryWritesForMaster(filters = {}, maxRows = 5000) {
  const caps=await schemaCapabilities(); if(!caps.deliveryWriteOperations)return[];
  const where=["1=1"],params=[]; const tenant=clean(filters.tenant,160),accountId=Number.parseInt(filters.accountId,10),user=clean(filters.user,160),status=clean(filters.status,40).toLowerCase(),batchId=clean(filters.batchId,200),from=parseDate(filters.from),to=parseDate(filters.to,true);
  if(tenant)addFilter(where,params,"o.dach_tenant_id =",tenant); if(Number.isFinite(accountId)&&accountId>0)addFilter(where,params,"o.account_id =",accountId); if(user)addFilter(where,params,"o.dach_user_id =",user); if(status)addFilter(where,params,"o.status =",status); if(batchId){params.push(batchId.replace(/^delivery:/,""));where.push(`o.id::text = $${params.length}`);} if(from){params.push(from);where.push(`o.created_at >= $${params.length}::timestamptz`);} if(to){params.push(to);where.push(`o.created_at <= $${params.length}::timestamptz`);}
  const safeLimit=clampInt(maxRows,1,10000,5000),activeIndex=params.length+1,limitIndex=params.length+2; const {rows}=await db.query(`select 'delivery:'||o.id::text batch_id,'delivery_write'::text source,o.created_at,o.updated_at,o.dach_tenant_id,o.account_id,a.magalu_tenant_name account_name,a.magalu_tenant_id,o.dach_user_id,'delivery'::text operation_type,o.action,o.status,1::int total,(o.status='succeeded')::int success,(o.status='failed')::int failed,(o.status='stale')::int stale,(o.status='uncertain')::int uncertain,(o.status='divergent')::int divergent,(o.status=any($${activeIndex}::text[]))::int pending from magalu.delivery_write_operations o left join magalu.accounts a on a.id=o.account_id where ${where.join(" and ")} order by o.created_at desc limit $${limitIndex}`,[...params,ACTIVE_OPERATION_STATES,safeLimit]); return rows;
}
async function listOperationBatches(filters = {}) {
  const page=clampInt(filters.page,1,100000,1),limit=clampInt(filters.limit,1,100,30);
  const [protectedRows,massRows,deliveryRows]=await Promise.all([listProtectedBatchesForMaster(filters,5000),listMassBatchesForMaster(filters,5000),listDeliveryWritesForMaster(filters,5000)]);
  const merged=[...protectedRows,...massRows,...deliveryRows].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  const total=merged.length,offset=(page-1)*limit;
  return{rows:merged.slice(offset,offset+limit),total,page,limit};
}
async function operationBatchDetail(batchId) {
  const id=clean(batchId,200);if(!id)return null;
  if(id.startsWith("delivery:")){const raw=Number.parseInt(id.slice(9),10);if(!Number.isFinite(raw))return null;const caps=await schemaCapabilities();if(!caps.deliveryWriteOperations)return null;const row=await db.queryOne(`select o.id,o.account_id,o.dach_tenant_id,o.dach_user_id,'delivery'::text resource_type,o.delivery_id as sku,o.delivery_id,o.order_code,o.channel_id,o.action,o.status,o.before_payload,o.requested_metadata as requested_payload,o.after_payload,o.response_status,o.request_id,o.error_code,o.error_message,o.remote_accepted_at,o.started_at,o.completed_at,o.created_at,o.updated_at,a.magalu_tenant_id,a.magalu_tenant_name from magalu.delivery_write_operations o left join magalu.accounts a on a.id=o.account_id where o.id=$1`,[raw]);if(!row)return null;return{batchId:id,source:"delivery_write",items:[row]};}
  if(id.startsWith("mass:")){
    const raw=id.slice(5);const caps=await schemaCapabilities();if(!caps.massSkuOperations)return null;
    const batch=await db.queryOne(`select b.*,a.magalu_tenant_id,a.magalu_tenant_name from magalu.mass_operation_batches b left join magalu.accounts a on a.id=b.account_id where b.id::text=$1`,[raw]);
    if(!batch)return null;
    const {rows}=await db.query(`select i.id,i.batch_id,i.account_id,i.dach_tenant_id,i.dach_user_id,'sku'::text resource_type,i.sku,i.action,i.status,i.before_payload,i.requested_payload,i.after_payload,i.response_status,i.request_id,i.error_code,i.error_message,i.remote_accepted_at,i.started_at,i.completed_at,i.created_at,i.updated_at,a.magalu_tenant_id,a.magalu_tenant_name from magalu.mass_operation_items i left join magalu.accounts a on a.id=i.account_id where i.batch_id::text=$1 order by i.id asc`,[raw]);
    return{batchId:id,source:"mass_sku",batch,items:rows};
  }
  let where,param;if(id.startsWith("write:")){const operationId=Number.parseInt(id.slice(6),10);if(!Number.isFinite(operationId))return null;where="w.id=$1";param=operationId;}else{where="w.preview_id::text=$1";param=id;}
  const {rows}=await db.query(`select w.id,w.preview_id,w.account_id,w.dach_tenant_id,w.dach_user_id,w.resource_type,w.sku,w.intended_method,w.actual_method,w.status,w.before_payload,w.requested_payload,w.after_payload,w.response_status,w.request_id,w.error_code,w.error_message,w.remote_accepted_at,w.started_at,w.completed_at,w.created_at,w.updated_at,a.magalu_tenant_id,a.magalu_tenant_name from magalu.write_operations w left join magalu.accounts a on a.id=w.account_id where ${where} order by w.created_at asc,w.id asc`,[param]);
  if(!rows.length)return null;return{batchId:id,source:"protected_write",items:rows};
}
async function getWriteOperation(operationId){return db.queryOne(`select w.*,a.magalu_tenant_id,a.magalu_tenant_name from magalu.write_operations w join magalu.accounts a on a.id=w.account_id where w.id=$1 limit 1`,[Number(operationId)]);}
async function getDeliveryWriteOperation(operationId){const caps=await schemaCapabilities();if(!caps.deliveryWriteOperations)return null;return db.queryOne(`select o.id,o.preview_id,o.account_id,o.dach_tenant_id,o.dach_user_id,o.delivery_id,o.order_code,o.channel_id,o.action,o.status,o.request_hash,o.before_payload,o.requested_metadata,o.response_payload,o.after_payload,o.response_status,o.request_id,o.error_code,o.error_message,o.remote_accepted_at,o.started_at,o.completed_at,o.created_at,o.updated_at,a.magalu_tenant_id,a.magalu_tenant_name from magalu.delivery_write_operations o join magalu.accounts a on a.id=o.account_id where o.id=$1 limit 1`,[Number(operationId)]);}
async function getMassOperationItem(itemId){const caps=await schemaCapabilities();if(!caps.massSkuOperations)return null;return db.queryOne(`select i.*,a.magalu_tenant_id,a.magalu_tenant_name from magalu.mass_operation_items i join magalu.accounts a on a.id=i.account_id where i.id=$1 limit 1`,[Number(itemId)]);}
async function exportDeliveryOperations(filters = {}, maxRows = 5000) {const caps=await schemaCapabilities();if(!caps.deliveryWriteOperations)return[];const rows=await listDeliveryWritesForMaster(filters,maxRows);if(!rows.length)return[];const ids=rows.map(r=>Number(String(r.batch_id).replace("delivery:",""))).filter(Number.isFinite);const result=await db.query(`select 'delivery_write'::text source,o.id,'delivery:'||o.id::text batch_id,o.dach_tenant_id,o.account_id,a.magalu_tenant_id,a.magalu_tenant_name,o.dach_user_id,'delivery'::text resource_type,o.action,o.delivery_id as sku,o.status,o.request_id,o.error_code,o.error_message,o.created_at,o.started_at,o.remote_accepted_at,o.completed_at,o.updated_at,o.before_payload,o.requested_metadata as requested_payload,o.after_payload from magalu.delivery_write_operations o left join magalu.accounts a on a.id=o.account_id where o.id=any($1::bigint[]) order by o.created_at desc`,[ids]);return result.rows;}
async function exportOperations(filters = {}, maxRows = 5000) {
  const [protectedRows,massRows,deliveryRows]=await Promise.all([exportWriteOperations(filters,maxRows),exportMassOperations(filters,maxRows),exportDeliveryOperations(filters,maxRows)]);
  return[...protectedRows,...massRows,...deliveryRows].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,maxRows);
}
async function exportWriteOperations(filters = {}, maxRows = 5000) {
  const f=operationWhere(filters);const params=[...f.params,clampInt(maxRows,1,10000,5000)];
  const {rows}=await db.query(`select 'protected_write'::text source,w.id,coalesce(w.preview_id::text,'write:'||w.id::text) batch_id,w.dach_tenant_id,w.account_id,a.magalu_tenant_id,a.magalu_tenant_name,w.dach_user_id,w.resource_type,w.resource_type action,w.sku,w.status,w.request_id,w.error_code,w.error_message,w.created_at,w.started_at,w.remote_accepted_at,w.completed_at,w.updated_at,w.before_payload,w.requested_payload,w.after_payload from magalu.write_operations w left join magalu.accounts a on a.id=w.account_id where ${f.where.join(" and ")} order by w.created_at desc limit $${params.length}`,params);return rows;
}
async function exportMassOperations(filters = {}, maxRows = 5000) {
  const caps=await schemaCapabilities();if(!caps.massSkuOperations)return[];
  const f=massBatchWhere(filters);const params=[...f.params,clampInt(maxRows,1,10000,5000)];
  const {rows}=await db.query(`select 'mass_sku'::text source,i.id,'mass:'||i.batch_id::text batch_id,i.dach_tenant_id,i.account_id,a.magalu_tenant_id,a.magalu_tenant_name,i.dach_user_id,'sku'::text resource_type,i.action,i.sku,i.status,i.request_id,i.error_code,i.error_message,i.created_at,i.started_at,i.remote_accepted_at,i.completed_at,i.updated_at,i.before_payload,i.requested_payload,i.after_payload from magalu.mass_operation_items i join magalu.mass_operation_batches b on b.id=i.batch_id left join magalu.accounts a on a.id=i.account_id where ${f.where.join(" and ")} order by i.created_at desc limit $${params.length}`,params);return rows;
}

async function integrationSummary() {
  const [hub, webhooks, syncs, caps] = await Promise.all([
    db.query(`select hub_sync_status as status,count(*)::int total from magalu.accounts group by hub_sync_status order by hub_sync_status`),
    db.query(`select status,count(*)::int total from magalu.webhook_subscriptions group by status order by status`),
    db.query(`select status,count(*)::int total from magalu.sync_runs where started_at>=now()-interval '7 days' group by status order by status`),
    schemaCapabilities(),
  ]);
  return { hubResources: hub.rows, webhooks: webhooks.rows, syncs7d: syncs.rows, capabilities: caps };
}

module.exports = {
  ACTIVE_OPERATION_STATES,
  TABLES,
  schemaCapabilities,
  overview,
  listAccounts,
  accountDetail,
  listOperationBatches,
  operationBatchDetail,
  getWriteOperation,
  getMassOperationItem,
  getDeliveryWriteOperation,
  exportOperations,
  exportWriteOperations,
  exportMassOperations,
  exportDeliveryOperations,
  integrationSummary,
  _test: { clampInt, clean, parseDate, operationWhere, massBatchWhere },
};
