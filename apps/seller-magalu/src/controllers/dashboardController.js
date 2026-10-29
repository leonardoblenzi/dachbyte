"use strict";

const accountRepository = require("../repositories/accountRepository");
const catalogRepository = require("../repositories/catalogRepository");
const orderRepository = require("../repositories/orderRepository");
const writeRepository = require("../repositories/writeRepository");
const syncRunRepository = require("../repositories/syncRunRepository");
const webhookRepository = require("../repositories/webhookRepository");
const financialRepository = require("../repositories/financialRepository");
const { checkAccountAccess } = require("../services/hubResourceAccessService");
const { ORDER_SCOPE, hasScope } = require("../services/orderSyncService");
const { enqueueDashboardOrdersSync, getQueue, queueNames } = require("../queues/magaluQueue");

function accountId(value) { const id=Number.parseInt(String(value == null ? "" : value),10); return Number.isFinite(id) && id > 0 ? id : null; }
const PERIODS={today:{days:1,label:"Hoje"},"7d":{days:7,label:"Últimos 7 dias"},"14d":{days:14,label:"Últimos 14 dias"},"30d":{days:30,label:"Últimos 30 dias"}};
function periodFor(value){return PERIODS[String(value||"7d")]||PERIODS["7d"];}
function syncRangeFor(value, now=new Date()) {
  const days=periodFor(value).days;
  const end=new Date(now);
  const start=new Date(now);
  start.setUTCDate(start.getUTCDate()-(days*2+1));
  return {from:start.toISOString().slice(0,10),to:end.toISOString().slice(0,10)};
}
async function authorizedAccount(req) {
  const id=accountId(req.query?.account_id||req.body?.account_id);
  if(!id)throw Object.assign(new Error("Selecione uma conta Magalu."),{status:400,code:"MAGALU_ACCOUNT_ID_REQUIRED"});
  const identity=req.magaluIdentity;
  const account=await accountRepository.findAccountByIdForTenant(id,identity.dachTenantId);
  if(!account)throw Object.assign(new Error("Conta Magalu não encontrada."),{status:404,code:"MAGALU_ACCOUNT_NOT_FOUND"});
  const access=await checkAccountAccess(identity,account,{action:"READ magalu"});
  if(!access.allow)throw Object.assign(new Error("O Hub não confirmou acesso à conta Magalu."),{status:403,code:"MAGALU_HUB_ACCESS_DENIED"});
  return account;
}
function refreshError(res,error){const status=Number(error?.status)||500;return res.status(status).json({ok:false,error:error?.code||"MAGALU_DASHBOARD_REFRESH_ERROR",message:status>=500?"Não foi possível atualizar os pedidos do painel.":error.message});}
async function refresh(req,res){try{
  const account=await authorizedAccount(req);
  if(String(account.status)!=="active")return res.status(409).json({ok:false,error:"MAGALU_ACCOUNT_INACTIVE",message:"A conta Magalu não está ativa."});
  if(!hasScope(account,ORDER_SCOPE))return res.status(409).json({ok:false,error:"MAGALU_ORDER_SCOPE_MISSING",message:`Scope ausente: ${ORDER_SCOPE}. Reconecte a conta.`});
  const period=String(req.body?.period||"7d");
  if(!PERIODS[period])return res.status(400).json({ok:false,error:"MAGALU_DASHBOARD_PERIOD_INVALID",message:"Período inválido."});
  const job=await enqueueDashboardOrdersSync(account.id,{...syncRangeFor(period),dachTenantId:account.dach_tenant_id});
  return res.status(202).json({ok:true,job_id:job.id,scheduled:job.scheduled});
}catch(error){return refreshError(res,error);}}
async function refreshStatus(req,res){try{
  const account=await authorizedAccount(req);
  const job=await (await getQueue(queueNames.ordersSync)).getJob(String(req.params.jobId||""));
  if(!job||job.name!=="dashboard-sync"||Number(job.data.accountId)!==Number(account.id)||String(job.data.dachTenantId)!==String(account.dach_tenant_id))return res.status(404).json({ok:false,error:"MAGALU_DASHBOARD_JOB_NOT_FOUND",message:"Atualização do painel não encontrada."});
  const state=await job.getState();
  return res.json({ok:true,state,progress:job.progress||null,result:state==="completed"?job.returnvalue||null:null,error:state==="failed"?String(job.failedReason||"Falha na sincronização.").slice(0,300):null});
}catch(error){return refreshError(res,error);}}
function prioritiesFor(catalog){const priorities=[];if(Number(catalog?.zero_stock_count||0)>0)priorities.push({tone:"warning",title:"Estoque zerado",count:Number(catalog.zero_stock_count),href:"/magalu/estoque"});if(Number(catalog?.published_count||0)===0)priorities.push({tone:"info",title:"Catálogo precisa de sincronização",count:0,href:"/magalu/integracoes"});return priorities;}

async function status(req,res,next) {
  try {
    const id=accountId(req.query?.account_id);
    if(!id) return res.status(400).json({ok:false,error:"MAGALU_ACCOUNT_ID_REQUIRED",message:"Selecione uma conta Magalu."});
    const identity=req.magaluIdentity;
    const account=await accountRepository.findAccountByIdForTenant(id,identity.dachTenantId);
    if(!account) return res.status(404).json({ok:false,error:"MAGALU_ACCOUNT_NOT_FOUND"});
    const access=await checkAccountAccess(identity,account,{action:"READ magalu"});
    if(!access.allow) return res.status(403).json({ok:false,error:"MAGALU_HUB_ACCESS_DENIED"});
    const period=periodFor(req.query?.period);
    const [catalog,orders,previousOrders,marginCoverage,operations,latestRun,subscriptions]=await Promise.all([
      catalogRepository.stats(account.id), orderRepository.stats(account.id,period.days), orderRepository.stats(account.id,period.days,period.days), financialRepository.coverage(account.id), writeRepository.listOperations(account.id,identity.dachTenantId,10), syncRunRepository.latestRun(account.id), webhookRepository.listSubscriptionsForAccount(account.id),
    ]);
    const margin_coverage={priced_skus:Number(marginCoverage?.priced_skus||0),costed_skus:Number(marginCoverage?.costed_skus||0),percent:Number(marginCoverage?.priced_skus||0)?Math.round((Number(marginCoverage?.costed_skus||0)/Number(marginCoverage.priced_skus))*100):0};
    return res.json({ok:true,period:{key:Object.keys(PERIODS).find(key=>PERIODS[key]===period)||"7d",label:period.label},account:{id:account.id,magalu_tenant_id:account.magalu_tenant_id,magalu_tenant_name:account.magalu_tenant_name,status:account.status,scopes:Array.isArray(account.scopes)?account.scopes:[],access_expires_at:account.access_expires_at||null,catalog_sync_status:account.catalog_sync_status,catalog_last_synced_at:account.catalog_last_synced_at,catalog_last_error:account.catalog_last_error},catalog,orders,comparison:{orders_delta:Number(orders?.total||0)-Number(previousOrders?.total||0)},margin_coverage,priorities:prioritiesFor(catalog),operations,latest_run:latestRun,webhooks:{active_count:subscriptions.filter(row=>row.status==="active").length},ads:{status:"pending",message:"Integração de Ads pendente"}});
  } catch(error) { return next(error); }
}

module.exports={status,refresh,refreshStatus,_test:{accountId,periodFor,prioritiesFor,syncRangeFor,PERIODS}};
