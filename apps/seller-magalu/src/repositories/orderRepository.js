"use strict";

const db = require("../config/postgres");

function text(value, max = 500) { return String(value == null ? "" : value).trim().slice(0, max); }
function int(value, min, max, fallback) { const n=Number.parseInt(String(value==null?"":value),10); return Number.isFinite(n)?Math.min(max,Math.max(min,n)):fallback; }
function json(value) { return JSON.stringify(value == null ? {} : value); }
async function replaceOrderItems(client, orderId, accountId, items) {
  await client.query(`delete from magalu.order_items where order_id=$1`, [Number(orderId)]);
  for (const item of items || []) {
    await client.query(`insert into magalu.order_items(
      order_id,account_id,item_key,sku,remote_item_id,name,brand,quantity,measure_unit,unit_price,
      amount_total,amount_currency,amount_normalizer,operational_payload
    ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`, [
      Number(orderId),Number(accountId),item.item_key,item.sku,item.remote_item_id,item.name,item.brand,item.quantity,item.measure_unit,item.unit_price,
      item.amount_total,item.amount_currency,item.amount_normalizer,json(item.operational_payload),
    ]);
  }
}
async function upsertOrder(accountId, row, { httpStatus = 200, seenAt = new Date() } = {}) {
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const result = await client.query(`insert into magalu.orders(
        account_id,code,remote_id,channel_id,status,purchased_at,remote_updated_at,amount_total,amount_currency,amount_normalizer,
        item_count,operational_payload,is_present,last_seen_at,last_synced_at,last_http_status,last_error
      ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,true,$13,now(),$14,null)
      on conflict(account_id,code) do update set
        remote_id=coalesce(excluded.remote_id,magalu.orders.remote_id),
        channel_id=coalesce(excluded.channel_id,magalu.orders.channel_id),status=coalesce(excluded.status,magalu.orders.status),
        purchased_at=coalesce(excluded.purchased_at,magalu.orders.purchased_at),remote_updated_at=coalesce(excluded.remote_updated_at,magalu.orders.remote_updated_at),
        amount_total=coalesce(excluded.amount_total,magalu.orders.amount_total),amount_currency=coalesce(excluded.amount_currency,magalu.orders.amount_currency),
        amount_normalizer=coalesce(excluded.amount_normalizer,magalu.orders.amount_normalizer),
        item_count=case when $15 then excluded.item_count else magalu.orders.item_count end,
        operational_payload=coalesce(magalu.orders.operational_payload,'{}'::jsonb)||excluded.operational_payload,
        is_present=true,last_seen_at=excluded.last_seen_at,last_synced_at=now(),last_http_status=excluded.last_http_status,last_error=null,updated_at=now()
      returning *, (xmax=0) as inserted`, [
        Number(accountId),row.code,row.remote_id,row.channel_id,row.status,row.purchased_at,row.remote_updated_at,row.amount_total,row.amount_currency,row.amount_normalizer,
        row.item_count||0,json(row.operational_payload),seenAt,row.last_http_status||httpStatus,row.items_present===true,
      ]);
      const saved=result.rows[0];
      if (row.items_present===true) await replaceOrderItems(client,saved.id,accountId,row.items||[]);
      await client.query("commit");
      return saved;
    } catch(error) { await client.query("rollback").catch(()=>{}); throw error; }
  });
}
async function replaceDeliveryItems(client, deliveryId, accountId, items) {
  await client.query(`delete from magalu.delivery_items where delivery_id=$1`, [Number(deliveryId)]);
  for (const item of items || []) {
    await client.query(`insert into magalu.delivery_items(
      delivery_id,account_id,item_key,sku,remote_item_id,name,brand,quantity,measure_unit,unit_price,
      amount_total,amount_currency,amount_normalizer,operational_payload
    ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`, [
      Number(deliveryId),Number(accountId),item.item_key,item.sku,item.remote_item_id,item.name,item.brand,item.quantity,item.measure_unit,item.unit_price,
      item.amount_total,item.amount_currency,item.amount_normalizer,json(item.operational_payload),
    ]);
  }
}
async function upsertDelivery(accountId, row, { httpStatus = 200, seenAt = new Date() } = {}) {
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const order = row.order_code ? (await client.query(`select id from magalu.orders where account_id=$1 and code=$2 limit 1`,[Number(accountId),row.order_code])).rows[0] : null;
      const result=await client.query(`insert into magalu.deliveries(
        account_id,order_id,remote_id,order_code,channel_id,status,purchased_at,handling_limit_at,delivery_limit_at,posting_at,
        provider_id,provider_name,shipping_type,shipping_name,is_mle,is_fulfillment,tracking_code,tracking_url,
        amount_total,amount_freight,amount_discount,amount_currency,amount_normalizer,item_count,operational_payload,
        is_present,last_seen_at,last_synced_at,last_http_status,last_error
      ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25::jsonb,true,$26,now(),$27,null)
      on conflict(account_id,remote_id) do update set
        order_id=coalesce(excluded.order_id,magalu.deliveries.order_id),order_code=coalesce(excluded.order_code,magalu.deliveries.order_code),
        channel_id=coalesce(excluded.channel_id,magalu.deliveries.channel_id),status=coalesce(excluded.status,magalu.deliveries.status),
        purchased_at=coalesce(excluded.purchased_at,magalu.deliveries.purchased_at),handling_limit_at=coalesce(excluded.handling_limit_at,magalu.deliveries.handling_limit_at),
        delivery_limit_at=coalesce(excluded.delivery_limit_at,magalu.deliveries.delivery_limit_at),posting_at=coalesce(excluded.posting_at,magalu.deliveries.posting_at),
        provider_id=coalesce(excluded.provider_id,magalu.deliveries.provider_id),provider_name=coalesce(excluded.provider_name,magalu.deliveries.provider_name),
        shipping_type=coalesce(excluded.shipping_type,magalu.deliveries.shipping_type),shipping_name=coalesce(excluded.shipping_name,magalu.deliveries.shipping_name),
        is_mle=coalesce(excluded.is_mle,magalu.deliveries.is_mle),is_fulfillment=coalesce(excluded.is_fulfillment,magalu.deliveries.is_fulfillment),
        tracking_code=coalesce(excluded.tracking_code,magalu.deliveries.tracking_code),tracking_url=coalesce(excluded.tracking_url,magalu.deliveries.tracking_url),
        amount_total=coalesce(excluded.amount_total,magalu.deliveries.amount_total),amount_freight=coalesce(excluded.amount_freight,magalu.deliveries.amount_freight),
        amount_discount=coalesce(excluded.amount_discount,magalu.deliveries.amount_discount),amount_currency=coalesce(excluded.amount_currency,magalu.deliveries.amount_currency),
        amount_normalizer=coalesce(excluded.amount_normalizer,magalu.deliveries.amount_normalizer),
        item_count=case when $28 then excluded.item_count else magalu.deliveries.item_count end,
        operational_payload=coalesce(magalu.deliveries.operational_payload,'{}'::jsonb)||excluded.operational_payload,
        is_present=true,last_seen_at=excluded.last_seen_at,last_synced_at=now(),last_http_status=excluded.last_http_status,last_error=null,updated_at=now()
      returning *, (xmax=0) as inserted`,[
        Number(accountId),order?.id||null,row.remote_id,row.order_code,row.channel_id,row.status,row.purchased_at,row.handling_limit_at,row.delivery_limit_at,row.posting_at,
        row.provider_id,row.provider_name,row.shipping_type,row.shipping_name,row.is_mle,row.is_fulfillment,row.tracking_code,row.tracking_url,
        row.amount_total,row.amount_freight,row.amount_discount,row.amount_currency,row.amount_normalizer,row.item_count||0,json(row.operational_payload),seenAt,httpStatus,row.items_present===true,
      ]);
      const saved=result.rows[0];
      if(row.items_present===true)await replaceDeliveryItems(client,saved.id,accountId,row.items||[]);
      if(saved.order_id){await client.query(`update magalu.orders o set delivery_count=(select count(*)::int from magalu.deliveries d where d.order_id=o.id and d.is_present),updated_at=now() where o.id=$1`,[saved.order_id]);}
      await client.query("commit");return saved;
    }catch(error){await client.query("rollback").catch(()=>{});throw error;}
  });
}
async function setSyncState(accountId,{status,error=null,syncedAt=null}={}){
  await db.query(`update magalu.accounts set orders_sync_status=coalesce($2,orders_sync_status),orders_last_error=$3,orders_last_synced_at=coalesce($4::timestamptz,orders_last_synced_at),updated_at=now() where id=$1`,[Number(accountId),status||null,error?String(error).slice(0,2000):null,syncedAt||null]);
}
function whereFor(accountId,filters={}){
  const where=["o.account_id=$1","o.is_present=true"],params=[Number(accountId)];
  const q=text(filters.q,200).toLowerCase(),status=text(filters.status,80).toLowerCase();
  if(q){params.push(`%${q}%`);where.push(`(lower(o.code) like $${params.length} or lower(coalesce(o.remote_id,'')) like $${params.length} or exists(select 1 from magalu.order_items oi where oi.order_id=o.id and (lower(coalesce(oi.sku,'')) like $${params.length} or lower(coalesce(oi.name,'')) like $${params.length})))`);}
  if(status){params.push(status);where.push(`(lower(coalesce(o.status,''))=$${params.length} or exists(select 1 from magalu.deliveries d where d.order_id=o.id and lower(coalesce(d.status,''))=$${params.length}))`);}
  if(filters.from){params.push(String(filters.from));where.push(`o.purchased_at >= $${params.length}::timestamptz`);}
  if(filters.to){params.push(String(filters.to));where.push(`o.purchased_at <= $${params.length}::timestamptz`);}
  return{where,params};
}
async function listOrders(accountId,filters={}){
  const page=int(filters.page,1,100000,1),limit=int(filters.limit,1,100,40),offset=(page-1)*limit,f=whereFor(accountId,filters);
  const total=await db.queryOne(`select count(*)::int total from magalu.orders o where ${f.where.join(" and ")}`,f.params);
  const {rows}=await db.query(`select o.id,o.code,o.remote_id,o.channel_id,o.status,o.purchased_at,o.remote_updated_at,o.amount_total,o.amount_currency,o.amount_normalizer,o.item_count,o.delivery_count,o.last_synced_at,
    coalesce(d.status,'') latest_delivery_status,d.provider_name,d.shipping_name,d.tracking_code,d.delivery_limit_at,d.handling_limit_at
    from magalu.orders o left join lateral(select status,provider_name,shipping_name,tracking_code,delivery_limit_at,handling_limit_at from magalu.deliveries d where d.order_id=o.id and d.is_present order by d.updated_at desc limit 1)d on true
    where ${f.where.join(" and ")} order by o.purchased_at desc nulls last,o.updated_at desc limit $${f.params.length+1} offset $${f.params.length+2}`,[...f.params,limit,offset]);
  return{rows,total:Number(total?.total||0),page,limit};
}
async function orderDetail(accountId,code){
  const order=await db.queryOne(`select * from magalu.orders where account_id=$1 and code=$2 limit 1`,[Number(accountId),text(code,300)]);if(!order)return null;
  const [items,deliveries]=await Promise.all([
    db.query(`select id,item_key,sku,remote_item_id,name,brand,quantity,measure_unit,unit_price,amount_total,amount_currency,amount_normalizer,operational_payload from magalu.order_items where order_id=$1 order by id`,[order.id]),
    db.query(`select id,remote_id,order_code,channel_id,status,purchased_at,handling_limit_at,delivery_limit_at,posting_at,provider_id,provider_name,shipping_type,shipping_name,is_mle,is_fulfillment,tracking_code,tracking_url,amount_total,amount_freight,amount_discount,amount_currency,amount_normalizer,item_count,operational_payload,last_synced_at from magalu.deliveries where order_id=$1 order by created_at`,[order.id]),
  ]);
  const deliveryRows=[];for(const delivery of deliveries.rows){const di=await db.query(`select id,item_key,sku,remote_item_id,name,brand,quantity,measure_unit,unit_price,amount_total,amount_currency,amount_normalizer,operational_payload from magalu.delivery_items where delivery_id=$1 order by id`,[delivery.id]);deliveryRows.push({...delivery,items:di.rows});}
  return{order,items:items.rows,deliveries:deliveryRows};
}
async function stats(accountId){
  const totals=await db.queryOne(`select count(*)::int total,count(*) filter(where purchased_at>=date_trunc('day',now()))::int today,count(*) filter(where purchased_at>=now()-interval '7 days')::int last_7d,sum(case when amount_total is not null and coalesce(amount_normalizer,0)>0 then amount_total::numeric/amount_normalizer else 0 end)::numeric as gross_value_30d from magalu.orders where account_id=$1 and is_present and purchased_at>=now()-interval '30 days'`,[Number(accountId)]);
  const {rows}=await db.query(`select coalesce(nullif(status,''),'unknown') status,count(*)::int total from magalu.deliveries where account_id=$1 and is_present group by 1 order by total desc`,[Number(accountId)]);
  return{...(totals||{}),delivery_statuses:rows};
}
async function knownChannels(accountId){const{rows}=await db.query(`select channel_id,count(*)::int uses from magalu.orders where account_id=$1 and channel_id is not null group by channel_id order by uses desc`,[Number(accountId)]);return rows;}
async function getDelivery(accountId,remoteId){return db.queryOne(`select * from magalu.deliveries where account_id=$1 and remote_id=$2 limit 1`,[Number(accountId),text(remoteId,300)]);}

async function accountSyncState(accountId){return db.queryOne(`select orders_sync_status,orders_last_synced_at,orders_last_error from magalu.accounts where id=$1`,[Number(accountId)]);}
async function runs(accountId,limit=12){const{rows}=await db.query(`select id,sync_type,status,scanned_count,created_count,updated_count,failed_count,result,error_message,started_at,finished_at from magalu.sync_runs where account_id=$1 and sync_type like 'orders_%' order by started_at desc limit $2`,[Number(accountId),int(limit,1,50,12)]);return rows;}
module.exports={upsertOrder,upsertDelivery,setSyncState,accountSyncState,listOrders,orderDetail,stats,knownChannels,getDelivery,runs,_test:{text,int,whereFor}};
