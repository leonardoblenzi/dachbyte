"use strict";
const {Worker}=require("bullmq");
const {ensureRedisConnected}=require("../config/redis");
const queueNames=require("../config/queueNames");
const {execute}=require("../services/deliveryWriteExecutionService");
const {cleanupRetention}=require("../repositories/deliveryWriteRepository");
let worker=null;
async function processJob(job){if(job.name==="retention")return cleanupRetention();if(!["apply","verify"].includes(job.name))throw new Error(`Job de entrega Magalu desconhecido: ${job.name}`);return execute(job.data.operationId);}
async function startDeliveryWriteWorker(){if(worker)return worker;const connection=await ensureRedisConnected();worker=new Worker(queueNames.deliveryWrite,processJob,{connection,concurrency:2});worker.on("failed",(job,error)=>console.error("[seller-magalu:delivery-write-worker] job failed",{job:job?.id||null,name:job?.name||null,message:error?.message||String(error)}));return worker;}
async function stopDeliveryWriteWorker(){if(!worker)return;const current=worker;worker=null;await current.close();}
module.exports={startDeliveryWriteWorker,stopDeliveryWriteWorker,_test:{processJob}};
