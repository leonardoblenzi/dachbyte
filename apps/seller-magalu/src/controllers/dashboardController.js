"use strict";

const accountRepository = require("../repositories/accountRepository");
const catalogRepository = require("../repositories/catalogRepository");
const orderRepository = require("../repositories/orderRepository");
const writeRepository = require("../repositories/writeRepository");
const syncRunRepository = require("../repositories/syncRunRepository");
const webhookRepository = require("../repositories/webhookRepository");
const financialRepository = require("../repositories/financialRepository");
const { checkAccountAccess } = require("../services/hubResourceAccessService");

function accountId(value) { const id=Number.parseInt(String(value == null ? "" : value),10); return Number.isFinite(id) && id > 0 ? id : null; }
const PERIODS={today:{days:1,label:"Hoje"},"7d":{days:7,label:"Últimos 7 dias"},"14d":{days:14,label:"Últimos 14 dias"},"30d":{days:30,label:"Últimos 30 dias"}};
function periodFor(value){return PERIODS[String(value||"7d")]||PERIODS["7d"];}
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

module.exports={status,_test:{accountId,periodFor,prioritiesFor,PERIODS}};
