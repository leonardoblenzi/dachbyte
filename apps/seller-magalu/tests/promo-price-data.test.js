"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const prices=require("../src/repositories/promoPriceRepository");

test("filtros de promoção exigem conta e distinguem publicação de atividade",()=>{
  const f=prices.filters({accountId:7,q:"00123",search_type:"ean",publication:"PUBLISHED",activity:"active",category:"C1"});
  assert.match(f.where.join(" "),/s\.account_id=\$1/);
  assert.match(f.where.join(" "),/s\.status=/);
  assert.match(f.where.join(" "),/s\.active=true/);
  assert.match(f.where.join(" "),/identifiers/);
  assert.ok(f.params.includes("00123"));
  assert.throws(()=>prices.filters({accountId:7,publication:"INVALID"}),{status:422});
});

test("atualização de preços não pode aceitar seleção acima do limite explícito",()=>{
  assert.throws(()=>prices.validateRefreshCount(5001),{status:413});
  assert.equal(prices.validateRefreshCount(5000),5000);
});

test("job de atualização usa somente a lista capturada e registra falhas sem interromper os demais",async()=>{
  const service=require("../src/services/promoPriceRefreshService");
  const seen=[];
  const result=await service.run({id:7,dach_tenant_id:"T"},["SKU-1","SKU-2"],{onProgress:async progress=>seen.push(progress)},
    {getPrice:async(_account,_tenant,sku)=>{if(sku==="SKU-2")throw new Error("falhou");return{data:{price:100,list_price:120},status:200};},
      upsertPrice:async()=>{}});
  assert.deepEqual(result,{total:2,updated:1,missing:0,failed:1,errors:[{sku:"SKU-2",message:"falhou"}]});
  assert.equal(seen.at(-1).processed,2);
});
