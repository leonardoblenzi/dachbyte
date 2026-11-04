"use strict";
const remote=require("./portfolioReadService");
const catalog=require("../repositories/catalogRepository");
const prices=require("../repositories/promoPriceRepository");
async function run(account,skus,{onProgress=async()=>{}}={},deps={}){
  const api=deps.getPrice||remote.getPrice,save=deps.upsertPrice||catalog.upsertPrice;
  const result={total:skus.length,updated:0,missing:0,failed:0,errors:[]};
  for(const sku of skus){
    try{
      const response=await api(account.id,account.dach_tenant_id,sku);
      await save(account.id,sku,response.data,{httpStatus:response.status});result.updated++;
    }catch(error){
      if(Number(error.status)===404){await catalog.markPriceMissing(account.id,sku,{httpStatus:404,error:"Preço não encontrado no Magalu."});result.missing++;}
      else{await catalog.recordPriceError(account.id,sku,{httpStatus:error.status||null,error:String(error.message||error)}).catch(()=>{});result.failed++;if(result.errors.length<100)result.errors.push({sku,message:String(error.message||error).slice(0,300)});}
    }
    await onProgress({...result,processed:result.updated+result.missing+result.failed});
  }
  return result;
}
async function runSelection(account,filters,{onProgress=async()=>{}}={},deps={}){
  const count=deps.count||prices.count,page=deps.page||prices.pageSkus;
  const total=await count(account.id,filters);
  const result={total,updated:0,missing:0,failed:0,processed:0,errors:[]};
  let after=null;
  while(true){
    const skus=await page(account.id,filters,after,prices.MAX_REFRESH);
    if(!skus.length)break;
    const batch=await run(account,skus,{onProgress:async current=>{
      if(current.processed%25!==0&&current.processed!==skus.length)return;
      await onProgress({...result,updated:result.updated+current.updated,missing:result.missing+current.missing,failed:result.failed+current.failed,processed:result.processed+current.processed});
    }},deps);
    result.updated+=batch.updated;result.missing+=batch.missing;result.failed+=batch.failed;result.processed+=skus.length;
    result.errors.push(...batch.errors.slice(0,Math.max(0,100-result.errors.length)));
    after=skus.at(-1);
  }
  await onProgress(result);
  return result;
}
module.exports={run,runSelection};
