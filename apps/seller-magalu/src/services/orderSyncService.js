"use strict";

const env = require("../config/env");
const accountRepository = require("../repositories/accountRepository");
const orderRepository = require("../repositories/orderRepository");
const syncRunRepository = require("../repositories/syncRunRepository");
const remote = require("./orderRemoteService");
const payload = require("./orderPayload");

const ORDER_SCOPE = "open:order-order-seller:read";
const DELIVERY_SCOPE = "open:order-delivery-seller:read";
function hasScope(account, scope) { return Array.isArray(account?.scopes) && account.scopes.includes(scope); }
function errorText(error) { return String(error?.payload?.message || error?.payload?.error_description || error?.message || error || "Erro desconhecido").slice(0,1800); }
function remoteMeta(error, endpoint, stage) { return { failed_stage:stage||null,failed_endpoint:endpoint||null,http_status:Number(error?.status||0)||null,request_id:error?.requestId||null,error_code:error?.code||null }; }
function cutoffIso(days=env.MAGALU_ORDER_SYNC_LOOKBACK_DAYS){return new Date(Date.now()-Math.max(1,Number(days)||90)*86400000).toISOString();}
function rowIsOlder(row,cutoff){const raw=row?.purchased_at||row?.created_at;const ms=raw?new Date(raw).getTime():NaN;return Number.isFinite(ms)&&ms<new Date(cutoff).getTime();}
function selectMarginOrderPage(rows,from,to){
  const selected=[];let reachedStart=false;
  for(const row of rows){
    const raw=row?.purchased_at||row?.created_at;
    const day=raw&&Number.isFinite(new Date(raw).getTime())?new Date(raw).toISOString().slice(0,10):null;
    if(!day)continue;
    if(day<from){reachedStart=true;continue;}
    if(day<=to)selected.push(row);
  }
  return {rows:selected,reachedStart};
}
function unwrapObject(response){const data=response?.data;if(Array.isArray(data))return data[0]||null;if(data&&typeof data==="object"){if(data.result&&typeof data.result==="object")return data.result;if(Array.isArray(data.results))return data.results[0]||null;return data;}return null;}

async function syncDeliveriesForChannel(account,channelId,{from,to,seenAt,strict=false}){
  let offset=0,pages=0,scanned=0,created=0,updated=0,failed=0,hasMore=false;
  while(pages<env.MAGALU_ORDER_SYNC_MAX_PAGES){
    const response=await remote.listDeliveries(account,{channelId,from,to,offset,limit:env.MAGALU_ORDER_SYNC_PAGE_SIZE});
    if(strict&&!Array.isArray(response?.data)&&!Array.isArray(response?.data?.results)&&!Array.isArray(response?.data?.deliveries))throw Object.assign(new Error("A API Magalu retornou uma página de entregas inválida."),{status:502});
    const rows=payload.listRows(response);pages+=1;
    for(const raw of rows){
      const normalized=payload.normalizeDelivery(raw); if(!normalized){failed+=1;continue;}
      if(!normalized.channel_id)normalized.channel_id=channelId;
      const saved=await orderRepository.upsertDelivery(account.id,normalized,{httpStatus:response.status||200,seenAt});
      scanned+=1;if(saved?.inserted===true)created+=1;else updated+=1;
    }
    const fallback=offset+rows.length,next=payload.nextOffset(response,fallback);
    hasMore=next!==null&&rows.length>0;
    if(!hasMore)break;offset=next;
  }
  if(strict&&hasMore){const e=new Error("Limite de páginas de entregas atingido; reduza o período.");e.status=422;e.code="MAGALU_MARGIN_DELIVERIES_PAGE_LIMIT";throw e;}
  return{pages,scanned,created,updated,failed};
}

async function fullOrderSync(accountId,{reason="manual",jobId=null,from=null,to=null,onProgress=null,syncDeliveries=true}={}){
  const account=await accountRepository.findAccountById(accountId);
  if(!account||String(account.status)!=="active"){const e=new Error("Conta Magalu ativa não encontrada para sincronizar pedidos.");e.code="MAGALU_ORDER_ACCOUNT_NOT_ACTIVE";e.status=404;throw e;}
  if(!hasScope(account,ORDER_SCOPE)){const e=new Error(`Scope ausente: ${ORDER_SCOPE}. Reconecte a conta para sincronizar pedidos.`);e.code="MAGALU_ORDER_SCOPE_MISSING";e.status=409;throw e;}
  const period=from&&to?{from,to}:null;
  if(period&&(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to)){const e=new Error("Período de pedidos inválido.");e.status=400;throw e;}
  const deliveryAllowed=hasScope(account,DELIVERY_SCOPE),seenAt=new Date(),cutoff=period?`${from}T00:00:00.000Z`:cutoffIso();
  if(period&&syncDeliveries&&!deliveryAllowed){const e=new Error(`Scope ausente: ${DELIVERY_SCOPE}.`);e.status=409;e.code="MAGALU_DELIVERY_SCOPE_MISSING";throw e;}
  const run=await syncRunRepository.createRun({dachTenantId:account.dach_tenant_id,accountId:account.id,syncType:syncDeliveries?"orders_full":"orders_dashboard",result:{reason,job_id:jobId||null,lookback_days:env.MAGALU_ORDER_SYNC_LOOKBACK_DAYS,delivery_scope:syncDeliveries&&deliveryAllowed}});
  if(syncDeliveries)await orderRepository.setSyncState(account.id,{status:"running",error:null});
  let scanned=0,created=0,updated=0,failed=0,orderPages=0,deliveryPages=0,offset=0,lastCursor="0",currentStage="orders_list",currentEndpoint="/seller/v1/orders",ordersHaveMore=false;
  const channels=new Set();
  try{
    while(orderPages<env.MAGALU_ORDER_SYNC_MAX_PAGES){
      currentStage="orders_list";currentEndpoint=`/seller/v1/orders?_offset=${offset}&_limit=${env.MAGALU_ORDER_SYNC_PAGE_SIZE}`;
      const response=await remote.listOrders(account,{offset,limit:env.MAGALU_ORDER_SYNC_PAGE_SIZE});
      if(period&&!Array.isArray(response?.data)&&!Array.isArray(response?.data?.results)&&!Array.isArray(response?.data?.orders))throw Object.assign(new Error("A API Magalu retornou uma página de pedidos inválida."),{status:502});
      const rawRows=payload.listRows(response),selection=period?selectMarginOrderPage(rawRows,from,to):null;
      const rows=selection?selection.rows:rawRows;orderPages+=1;let reachedCutoff=selection?.reachedStart||false;
      currentStage="orders_persist";
      for(const raw of rows){
        if(rowIsOlder(raw,cutoff))reachedCutoff=true;
        const normalized=payload.normalizeOrder(raw);if(!normalized){failed+=1;continue;}
        if(normalized.channel_id)channels.add(normalized.channel_id);
        const saved=await orderRepository.upsertOrder(account.id,normalized,{httpStatus:response.status||200,seenAt});
        scanned+=1;if(saved?.inserted===true)created+=1;else updated+=1;
      }
      const fallback=offset+rawRows.length,next=payload.nextOffset(response,fallback);lastCursor=String(fallback);
      if(typeof onProgress==="function")await onProgress({stage:"orders",pages:orderPages,scanned});
      ordersHaveMore=next!==null&&rawRows.length>0&&!reachedCutoff;
      if(!ordersHaveMore)break;offset=next;
    }
    if(period&&ordersHaveMore){const e=new Error("Limite de páginas de pedidos atingido; reduza o período.");e.status=422;e.code="MAGALU_MARGIN_ORDERS_PAGE_LIMIT";throw e;}
    if(syncDeliveries&&deliveryAllowed){
      if(!channels.size){const known=await orderRepository.knownChannels(account.id);for(const row of known)if(row.channel_id)channels.add(row.channel_id);}
      const deliveryTo=period?`${to}T23:59:59.999Z`:new Date().toISOString();
      for(const channelId of channels){
        currentStage="deliveries_list";currentEndpoint="/seller/v1/deliveries";
        try{const result=await syncDeliveriesForChannel(account,channelId,{from:cutoff,to:deliveryTo,seenAt,strict:!!period});deliveryPages+=result.pages;scanned+=result.scanned;created+=result.created;updated+=result.updated;failed+=result.failed;if(typeof onProgress==="function")await onProgress({stage:"deliveries",pages:deliveryPages,scanned});}
        catch(error){if(period)throw error;failed+=1;console.warn("[seller-magalu:orders] delivery sync failed",{accountId:account.id,channelId,status:error?.status||null,requestId:error?.requestId||null,message:errorText(error)});}
      }
    }else if(syncDeliveries)failed+=1;
    const status=failed>0?"partial":"success",finishedAt=new Date().toISOString();
    await syncRunRepository.finishRun(run.id,{status,cursorOut:lastCursor,scannedCount:scanned,createdCount:created,updatedCount:updated,failedCount:failed,result:{reason,job_id:jobId||null,order_pages:orderPages,delivery_pages:deliveryPages,channels:[...channels],lookback_days:env.MAGALU_ORDER_SYNC_LOOKBACK_DAYS,delivery_scope:deliveryAllowed}});
    if(syncDeliveries)await orderRepository.setSyncState(account.id,{status,error:deliveryAllowed?(failed?`${failed} item(ns)/consulta(s) de pedidos ou entregas tiveram aviso.`:null):`Scope ausente: ${DELIVERY_SCOPE}. Pedidos foram lidos, entregas não.`,syncedAt:finishedAt});
    return{status,scanned,created,updated,failed,orderPages,deliveryPages,channels:[...channels],deliveryScope:syncDeliveries&&deliveryAllowed};
  }catch(error){
    await syncRunRepository.finishRun(run.id,{status:"failed",cursorOut:lastCursor,scannedCount:scanned,createdCount:created,updatedCount:updated,failedCount:failed+1,result:{reason,job_id:jobId||null,order_pages:orderPages,delivery_pages:deliveryPages,...remoteMeta(error,currentEndpoint,currentStage)},errorMessage:errorText(error)}).catch(()=>{});
    if(syncDeliveries)await orderRepository.setSyncState(account.id,{status:"failed",error:errorText(error)}).catch(()=>{});throw error;
  }
}

async function reconcileOrder(accountId,code,{topic="manual"}={}){
  const account=await accountRepository.findAccountById(accountId);if(!account||String(account.status)!=="active"){const e=new Error("Conta Magalu ativa não encontrada.");e.status=404;throw e;}
  if(!hasScope(account,ORDER_SCOPE)){const e=new Error(`Scope ausente: ${ORDER_SCOPE}.`);e.status=409;e.code="MAGALU_ORDER_SCOPE_MISSING";throw e;}
  const response=await remote.getOrder(account,code);const normalized=payload.normalizeOrder(unwrapObject(response));
  if(!normalized){const e=new Error("A API Magalu retornou um pedido sem código identificável.");e.code="MAGALU_ORDER_PAYLOAD_INVALID";e.status=502;throw e;}
  const saved=await orderRepository.upsertOrder(account.id,normalized,{httpStatus:response.status||200,seenAt:new Date()});
  let deliveries=0;
  if(hasScope(account,DELIVERY_SCOPE)&&normalized.channel_id){
    const d=await remote.listDeliveries(account,{channelId:normalized.channel_id,code:normalized.code,offset:0,limit:100});
    for(const raw of payload.listRows(d)){const nd=payload.normalizeDelivery(raw);if(!nd)continue;if(!nd.channel_id)nd.channel_id=normalized.channel_id;await orderRepository.upsertDelivery(account.id,nd,{httpStatus:d.status||200,seenAt:new Date()});deliveries+=1;}
  }
  return{order_id:saved.id,code:normalized.code,topic,deliveries};
}
async function reconcileDelivery(accountId,deliveryId,{topic="orders_delivery"}={}){
  const account=await accountRepository.findAccountById(accountId);if(!account||String(account.status)!=="active")return{fallback:false,ignored:true,reason:"account_not_active"};
  if(!hasScope(account,DELIVERY_SCOPE)){const e=new Error(`Scope ausente: ${DELIVERY_SCOPE}.`);e.status=409;e.code="MAGALU_DELIVERY_SCOPE_MISSING";throw e;}
  let local=await orderRepository.getDelivery(account.id,deliveryId),channel=local?.channel_id||null;
  if(!channel){const channels=await orderRepository.knownChannels(account.id);if(channels.length===1)channel=channels[0].channel_id;}
  if(!channel)return{fallback:true,result:await fullOrderSync(account.id,{reason:`${topic}:delivery-channel-unknown`})};
  const response=await remote.getDelivery(account,deliveryId,channel);const normalized=payload.normalizeDelivery(unwrapObject(response));
  if(!normalized){const e=new Error("A API Magalu retornou uma entrega inválida.");e.code="MAGALU_DELIVERY_PAYLOAD_INVALID";e.status=502;throw e;}if(!normalized.channel_id)normalized.channel_id=channel;
  const saved=await orderRepository.upsertDelivery(account.id,normalized,{httpStatus:response.status||200,seenAt:new Date()});return{delivery_id:saved.id,remote_id:normalized.remote_id,topic,fallback:false};
}
module.exports={ORDER_SCOPE,DELIVERY_SCOPE,hasScope,fullOrderSync,reconcileOrder,reconcileDelivery,_test:{cutoffIso,rowIsOlder,selectMarginOrderPage,unwrapObject,syncDeliveriesForChannel,errorText,remoteMeta}};
