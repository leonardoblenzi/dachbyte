"use strict";
const db = require("../config/postgres");
const { text, payloadObject, skuFields, priceFields, stockQuantity } = require("../services/catalogPayload");

async function upsertSku(accountId, payload, { seenAt = new Date(), httpStatus = 200, error = null } = {}) {
  const fields = skuFields(payload);
  if (!fields.sku) throw new Error("SKU Magalu ausente no payload de catálogo.");
  const { rows } = await db.query(
    `insert into magalu.skus
       (account_id, sku, title, status, active, brand, group_id, category_id, fulfillment, payload,
        magalu_created_at, magalu_updated_at, is_present, last_seen_at, last_synced_at, last_http_status, last_error)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,true,$13,now(),$14,$15)
     on conflict (account_id, sku) do update
       set title=excluded.title, status=excluded.status, active=excluded.active, brand=excluded.brand,
           group_id=excluded.group_id, category_id=excluded.category_id, fulfillment=excluded.fulfillment,
           payload=excluded.payload,
           magalu_created_at=coalesce(excluded.magalu_created_at,magalu.skus.magalu_created_at),
           magalu_updated_at=coalesce(excluded.magalu_updated_at,magalu.skus.magalu_updated_at),
           is_present=true, last_seen_at=excluded.last_seen_at, last_synced_at=now(),
           last_http_status=excluded.last_http_status, last_error=excluded.last_error, updated_at=now()
     returning id, sku, (xmax = 0) as inserted`,
    [Number(accountId), fields.sku, fields.title, fields.status, fields.active, fields.brand, fields.groupId,
     fields.categoryId, fields.fulfillment, JSON.stringify(payloadObject(payload)), fields.createdAt, fields.updatedAt,
     seenAt, Number(httpStatus) || null, error ? String(error).slice(0,2000) : null]);
  return rows[0] || null;
}
async function markSkuMissing(accountId, sku, { httpStatus=404, error=null }={}) {
  await db.query(`update magalu.skus set is_present=false,last_synced_at=now(),last_http_status=$3,last_error=$4,updated_at=now()
    where account_id=$1 and sku=$2`, [Number(accountId),String(sku),Number(httpStatus)||null,error?String(error).slice(0,2000):null]);
}
async function markUnseenSkusMissing(accountId, syncStartedAt) {
  const result=await db.query(`update magalu.skus set is_present=false,updated_at=now() where account_id=$1 and is_present=true
    and (last_seen_at is null or last_seen_at < $2::timestamptz)`,[Number(accountId),syncStartedAt]);
  return result.rowCount||0;
}
async function upsertPrice(accountId, sku, payload, { httpStatus=200,error=null,present=true }={}) {
  const fields=priceFields(payload);
  const {rows}=await db.query(`insert into magalu.prices
    (account_id,sku,price,list_price,payload,is_present,last_http_status,last_error,last_synced_at)
    values($1,$2,$3,$4,$5::jsonb,$6,$7,$8,now())
    on conflict(account_id,sku) do update set price=excluded.price,list_price=excluded.list_price,payload=excluded.payload,
    is_present=excluded.is_present,last_http_status=excluded.last_http_status,last_error=excluded.last_error,last_synced_at=now(),updated_at=now()
    returning *`,[Number(accountId),String(sku),fields.price,fields.listPrice,JSON.stringify(payloadObject(payload)),Boolean(present),Number(httpStatus)||null,error?String(error).slice(0,2000):null]);
  return rows[0]||null;
}
async function upsertStock(accountId, sku, payload, { httpStatus=200,error=null,present=true }={}) {
  const quantity=stockQuantity(payload);
  const {rows}=await db.query(`insert into magalu.stocks
    (account_id,sku,quantity,payload,is_present,last_http_status,last_error,last_synced_at)
    values($1,$2,$3,$4::jsonb,$5,$6,$7,now())
    on conflict(account_id,sku) do update set quantity=excluded.quantity,payload=excluded.payload,is_present=excluded.is_present,
    last_http_status=excluded.last_http_status,last_error=excluded.last_error,last_synced_at=now(),updated_at=now()
    returning *`,[Number(accountId),String(sku),quantity,JSON.stringify(payloadObject(payload)),Boolean(present),Number(httpStatus)||null,error?String(error).slice(0,2000):null]);
  return rows[0]||null;
}
async function markPriceMissing(accountId,sku,{httpStatus=404,error=null}={}) { return upsertPrice(accountId,sku,{}, {httpStatus,error,present:false}); }
async function markStockMissing(accountId,sku,{httpStatus=404,error=null}={}) { return upsertStock(accountId,sku,{}, {httpStatus,error,present:false}); }
async function recordPriceError(accountId,sku,{httpStatus=null,error=null}={}) {
  await db.query(`insert into magalu.prices(account_id,sku,payload,is_present,last_http_status,last_error,last_synced_at)
    values($1,$2,'{}'::jsonb,true,$3,$4,now()) on conflict(account_id,sku) do update set last_http_status=excluded.last_http_status,
    last_error=excluded.last_error,last_synced_at=now(),updated_at=now()`,[Number(accountId),String(sku),Number(httpStatus)||null,error?String(error).slice(0,2000):null]);
}
async function recordStockError(accountId,sku,{httpStatus=null,error=null}={}) {
  await db.query(`insert into magalu.stocks(account_id,sku,payload,is_present,last_http_status,last_error,last_synced_at)
    values($1,$2,'{}'::jsonb,true,$3,$4,now()) on conflict(account_id,sku) do update set last_http_status=excluded.last_http_status,
    last_error=excluded.last_error,last_synced_at=now(),updated_at=now()`,[Number(accountId),String(sku),Number(httpStatus)||null,error?String(error).slice(0,2000):null]);
}
async function listCatalog(accountId,{query="",status="",offset=0,limit=50,onlyPresent=true}={}) {
  const safeLimit=Math.min(100,Math.max(1,Number(limit)||50)); const safeOffset=Math.max(0,Number(offset)||0);
  const params=[Number(accountId)]; const where=["s.account_id = $1"];
  if(onlyPresent) where.push("s.is_present = true");
  if(text(query)){params.push(`%${text(query).toLowerCase()}%`);where.push(`(lower(s.sku) like $${params.length} or lower(coalesce(s.title,'')) like $${params.length})`);}
  if(text(status)){params.push(text(status));where.push(`s.status = $${params.length}`);}
  params.push(safeLimit); const li=params.length; params.push(safeOffset); const oi=params.length;
  const {rows}=await db.query(`select s.id,s.sku,s.title,s.status,s.active,s.brand,s.group_id,s.category_id,s.fulfillment,s.is_present,
    s.magalu_updated_at,s.last_synced_at,s.last_error,p.price,p.list_price,p.is_present as price_present,
    p.last_synced_at as price_synced_at,p.last_error as price_error,st.quantity,st.is_present as stock_present,
    st.last_synced_at as stock_synced_at,st.last_error as stock_error,count(*) over()::int as total_count
    from magalu.skus s left join magalu.prices p on p.account_id=s.account_id and p.sku=s.sku
    left join magalu.stocks st on st.account_id=s.account_id and st.sku=s.sku where ${where.join(" and ")}
    order by coalesce(s.magalu_updated_at,s.updated_at) desc,s.sku asc limit $${li} offset $${oi}`,params);
  return {rows,total:rows.length?Number(rows[0].total_count||0):0,offset:safeOffset,limit:safeLimit};
}
async function getCatalogItem(accountId,sku) { return db.queryOne(`select s.*,p.price,p.list_price,p.payload as price_payload,p.is_present as price_present,
  p.last_error as price_error,st.quantity,st.payload as stock_payload,st.is_present as stock_present,st.last_error as stock_error
  from magalu.skus s left join magalu.prices p on p.account_id=s.account_id and p.sku=s.sku
  left join magalu.stocks st on st.account_id=s.account_id and st.sku=s.sku where s.account_id=$1 and s.sku=$2 limit 1`,[Number(accountId),String(sku)]); }
async function stats(accountId) {
  const row=await db.queryOne(`select count(*) filter(where s.is_present)::int as sku_count,
    count(*) filter(where s.is_present and s.status='PUBLISHED')::int as published_count,
    count(*) filter(where s.is_present and coalesce(st.quantity,0)<=0)::int as zero_stock_count,
    count(*) filter(where s.is_present and p.price is not null)::int as priced_count,
    max(s.last_synced_at) as last_sku_sync_at,max(p.last_synced_at) as last_price_sync_at,max(st.last_synced_at) as last_stock_sync_at
    from magalu.skus s left join magalu.prices p on p.account_id=s.account_id and p.sku=s.sku
    left join magalu.stocks st on st.account_id=s.account_id and st.sku=s.sku where s.account_id=$1`,[Number(accountId)]);
  return row||{sku_count:0,published_count:0,zero_stock_count:0,priced_count:0};
}
module.exports={upsertSku,markSkuMissing,markUnseenSkusMissing,upsertPrice,upsertStock,markPriceMissing,markStockMissing,
  recordPriceError,recordStockError,listCatalog,getCatalogItem,stats};
