"use strict";
const remote=require("./portfolioReadService");
const catalog=require("../repositories/catalogRepository");
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
module.exports={run};
