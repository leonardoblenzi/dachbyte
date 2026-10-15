"use strict";
const accountRepository=require("../repositories/accountRepository");
const analytics=require("../repositories/uxAnalyticsRepository");
const marginFresh=require("../services/marginFreshSyncService");
const {enqueueMarginRangeSync,getQueue,queueNames}=require("../queues/magaluQueue");
const orderRepository=require("../repositories/orderRepository");
const {reconcileOrder,reconcileDelivery}=require("../services/orderSyncService");
const {identifyVisibleOrders}=require("../services/marginOrderIdentityService");
const {checkAccountAccess}=require("../services/hubResourceAccessService");
function int(v){const n=Number.parseInt(String(v==null?"":v),10);return Number.isFinite(n)&&n>0?n:null;}
async function accountFor(req){const id=int(req.query?.account_id);if(!id){const e=new Error("account_id obrigatório.");e.status=400;e.code="MAGALU_ACCOUNT_ID_REQUIRED";throw e;}const account=await accountRepository.findAccountByIdForTenant(id,req.magaluIdentity.dachTenantId);if(!account){const e=new Error("Conta Magalu não encontrada.");e.status=404;e.code="MAGALU_ACCOUNT_NOT_FOUND";throw e;}const access=await checkAccountAccess(req.magaluIdentity,account,{action:"READ magalu"});if(!access.allow){const e=new Error("O Hub não confirmou acesso a esta conta Magalu.");e.status=403;e.code="MAGALU_HUB_ACCESS_DENIED";throw e;}return account;}
function fail(res,e){const status=Number(e?.status)||500;return res.status(status).json({ok:false,error:e?.code||"MAGALU_UX_ANALYTICS_ERROR",message:status>=500?"Não foi possível carregar a análise Magalu.":e.message});}
async function stock(req,res){try{const a=await accountFor(req);return res.json({ok:true,...await analytics.stockAnalysis(a.id,req.query)});}catch(e){return fail(res,e);}}
async function costs(req,res){try{const a=await accountFor(req);return res.json({ok:true,...await analytics.costOverview(a.id)});}catch(e){return fail(res,e);}}
async function margins(req,res){try{const a=await accountFor(req);return res.json({ok:true,...await analytics.marginOverview(a.id,req.query)});}catch(e){return fail(res,e);}}
async function syncMargins(req,res){try{
  const a=await accountFor(req),from=req.body?.from,to=req.body?.to;
  marginFresh.validate(a,from,to);
  const job=await enqueueMarginRangeSync(a.id,{from,to,dachTenantId:a.dach_tenant_id});
  return res.status(202).json({ok:true,job_id:job.id,scheduled:job.scheduled});
}catch(e){return fail(res,e);}}
async function marginSyncStatus(req,res){try{
  const a=await accountFor(req);
  const job=await (await getQueue(queueNames.ordersSync)).getJob(String(req.params.jobId||""));
  if(!job||job.name!=="margin-range-sync"||Number(job.data.accountId)!==Number(a.id)||String(job.data.dachTenantId)!==String(a.dach_tenant_id)){
    return res.status(404).json({ok:false,error:"MAGALU_MARGIN_JOB_NOT_FOUND",message:"Consulta de margem não encontrada para esta conta."});
  }
  const state=await job.getState();
  return res.json({ok:true,state,progress:job.progress||null,fresh_since:state==="completed"&&job.processedOn?new Date(job.processedOn).toISOString():null,result:state==="completed"?job.returnvalue||null:null,
    error:state==="failed"?String(job.failedReason||"Falha na consulta.").slice(0,300):null});
}catch(e){return fail(res,e);}}
async function identifyMarginOrders(req,res){try{
  const a=await accountFor(req);
  const codes=req.body?.codes;
  if(!Array.isArray(codes)||codes.length<1||codes.length>20||codes.some(code=>typeof code!=="string"||!code.trim()||code.length>300)){
    const e=new Error("Informe de 1 a 20 códigos de pedidos válidos.");e.status=400;e.code="MAGALU_MARGIN_ORDER_CODES_INVALID";throw e;
  }
  const unique=[...new Set(codes.map(code=>code.trim()))];
  const rows=await identifyVisibleOrders({accountId:a.id,codes:unique,
    eligible:async(accountId,codes)=>{
      const owned=await orderRepository.ownedCodes(accountId,codes);
      if(owned.length!==codes.length){const e=new Error("Pedido não encontrado para esta conta.");e.status=404;e.code="MAGALU_MARGIN_ORDER_NOT_FOUND";throw e;}
      return owned;
    },
    reconcile:async(accountId,code)=>{
      await reconcileOrder(accountId,code,{topic:"margin_identity"});
      let detail=await orderRepository.orderDetail(accountId,code);
      if(!detail?.items?.some(item=>item.sku)){
        for(const delivery of (detail?.deliveries||[]).filter(row=>row.channel_id&&!row.items?.length).slice(0,5)){
          await reconcileDelivery(accountId,delivery.remote_id,{topic:"margin_identity"}).catch(()=>{});
        }
        detail=await orderRepository.orderDetail(accountId,code);
      }
      const hasSku=detail?.items?.some(item=>item.sku);
      const deliverySku=detail?.deliveries?.some(delivery=>delivery.items?.some(item=>item.sku));
      return {code,state:hasSku?"identified":deliverySku?"delivery_only":"unavailable"};
    }
  });
  return res.json({ok:true,rows});
}catch(e){return fail(res,e);}}
async function equilibrium(req,res){try{const a=await accountFor(req);return res.json({ok:true,...await analytics.equilibrium(a.id,req.query)});}catch(e){return fail(res,e);}}
module.exports={stock,costs,margins,syncMargins,marginSyncStatus,identifyMarginOrders,equilibrium,_test:{int}};
