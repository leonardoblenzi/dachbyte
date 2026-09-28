"use strict";

const accountRepository = require("../repositories/accountRepository");
const catalogRepository = require("../repositories/catalogRepository");
const orderRepository = require("../repositories/orderRepository");
const writeRepository = require("../repositories/writeRepository");
const syncRunRepository = require("../repositories/syncRunRepository");
const webhookRepository = require("../repositories/webhookRepository");
const { checkAccountAccess } = require("../services/hubResourceAccessService");

function accountId(value) { const id=Number.parseInt(String(value == null ? "" : value),10); return Number.isFinite(id) && id > 0 ? id : null; }

async function status(req,res,next) {
  try {
    const id=accountId(req.query?.account_id);
    if(!id) return res.status(400).json({ok:false,error:"MAGALU_ACCOUNT_ID_REQUIRED",message:"Selecione uma conta Magalu."});
    const identity=req.magaluIdentity;
    const account=await accountRepository.findAccountByIdForTenant(id,identity.dachTenantId);
    if(!account) return res.status(404).json({ok:false,error:"MAGALU_ACCOUNT_NOT_FOUND"});
    const access=await checkAccountAccess(identity,account,{action:"READ magalu"});
    if(!access.allow) return res.status(403).json({ok:false,error:"MAGALU_HUB_ACCESS_DENIED"});
    const [catalog,orders,operations,latestRun,subscriptions]=await Promise.all([
      catalogRepository.stats(account.id), orderRepository.stats(account.id), writeRepository.listOperations(account.id,identity.dachTenantId,10), syncRunRepository.latestRun(account.id), webhookRepository.listSubscriptionsForAccount(account.id),
    ]);
    return res.json({ok:true,account:{id:account.id,magalu_tenant_id:account.magalu_tenant_id,magalu_tenant_name:account.magalu_tenant_name,status:account.status,scopes:Array.isArray(account.scopes)?account.scopes:[],access_expires_at:account.access_expires_at||null,catalog_sync_status:account.catalog_sync_status,catalog_last_synced_at:account.catalog_last_synced_at,catalog_last_error:account.catalog_last_error},catalog,orders,operations,latest_run:latestRun,webhooks:{active_count:subscriptions.filter(row=>row.status==="active").length},ads:{status:"pending",message:"Integração de Ads pendente"}});
  } catch(error) { return next(error); }
}

module.exports={status,_test:{accountId}};
