"use strict";
const {Worker}=require("bullmq");
const {ensureRedisConnected}=require("../config/redis");
const queueNames=require("../config/queueNames");
const accounts=require("../repositories/accountRepository");
const refresh=require("../services/promoPriceRefreshService");
const previews=require("../repositories/promoPricingPreviewRepository");
let worker=null;
async function processJob(job){
  if(job.name==="promo-preview"){
    const identity=job.data.identity;
    const account=await accounts.findAccountByIdForTenant(identity.accountId,identity.tenantId);
    if(!account||account.status!=="active")throw new Error("Conta Magalu indisponível para calcular preços.");
    return previews.createBatched(identity,job.data.filters,job.data.terms,{onProgress:progress=>job.updateProgress(progress)});
  }
  if(job.name!=="promo-prices")throw new Error("Job de preços promocionais desconhecido.");
  const account=await accounts.findAccountByIdForTenant(job.data.accountId,job.data.dachTenantId);
  if(!account||account.status!=="active")throw new Error("Conta Magalu indisponível para atualizar preços.");
  return refresh.runSelection(account,job.data.filters,{onProgress:progress=>job.updateProgress(progress)});
}
async function startPromoPriceRefreshWorker(){if(worker)return worker;worker=new Worker(queueNames.promoPriceRefresh,processJob,{connection:await ensureRedisConnected(),concurrency:1});worker.on("failed",(job,error)=>console.error("[seller-magalu:promo-price-refresh] job failed",{id:job?.id,message:error?.message}));return worker;}
async function stopPromoPriceRefreshWorker(){if(!worker)return;const current=worker;worker=null;await current.close();}
module.exports={startPromoPriceRefreshWorker,stopPromoPriceRefreshWorker,_test:{processJob}};
