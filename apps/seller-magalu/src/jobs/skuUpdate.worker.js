"use strict";

const { Worker } = require("bullmq");
const env = require("../config/env");
const { ensureRedisConnected } = require("../config/redis");
const queueNames = require("../config/queueNames");
const { executeSkuMassItem } = require("../services/skuMassExecutionService");
const skuMassRepository = require("../repositories/skuMassRepository");

let worker=null;
async function processSkuUpdateJob(job){
  const name=String(job?.name||"");
  if(name==="retention")return skuMassRepository.cleanupRetention();
  if(!["apply","verify"].includes(name))throw new Error(`Job de SKU Magalu desconhecido: ${name}`);
  return executeSkuMassItem(job.data.itemId);
}
async function startSkuUpdateWorker(){
  if(worker)return worker;
  const connection=await ensureRedisConnected();
  worker=new Worker(queueNames.skuUpdate,processSkuUpdateJob,{connection,concurrency:env.MAGALU_SKU_UPDATE_CONCURRENCY,limiter:{max:env.MAGALU_RATE_LIMIT_SKU_WRITE_PER_MINUTE,duration:60000}});
  worker.on("failed",(job,error)=>console.error("[seller-magalu:sku-worker] job failed",{job:job?.id||null,name:job?.name||null,itemId:job?.data?.itemId||null,message:error?.message||String(error)}));
  return worker;
}
async function stopSkuUpdateWorker(){if(!worker)return;const current=worker;worker=null;await current.close();}
module.exports={startSkuUpdateWorker,stopSkuUpdateWorker,_test:{processSkuUpdateJob}};
