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
  assert.deepEqual(f.params.at(-1),["00123"]);
  assert.throws(()=>prices.filters({accountId:7,publication:"INVALID"}),{status:422});
});
test("busca promocional combina identificadores separados por vírgula sem perder zeros",()=>{
  for(const type of ["sku","ean","group"]){
    const f=prices.filters({accountId:7,search_type:type,q:" 00123, 00456,00123 "});
    assert.deepEqual(f.params.at(-1),["00123","00456"]);
    assert.match(f.where.join(" "),/any\(/);
  }
  const product=prices.filters({accountId:7,search_type:"product",q:"Sofá, mesa"});
  assert.equal(product.params.at(-1),"%sofá, mesa%");
});

test("atualização percorre recorte completo em páginas sob um único job",async()=>{
  const service=require("../src/services/promoPriceRefreshService");
  const seen=[],pages=[];
  const result=await service.runSelection({id:7,dach_tenant_id:"T"},{publication:"PUBLISHED"},{onProgress:async progress=>seen.push(progress)},
    {count:async()=>10001,page:async(_account,_filters,after,limit)=>{pages.push({after,limit});return after===null?["0001","0002"]:after==="0002"?["0003"]:[];},
      getPrice:async()=>({data:{price:100,list_price:120},status:200}),upsertPrice:async()=>{}});
  assert.deepEqual(pages.map(item=>item.after),[null,"0002","0003"]);
  assert.equal(result.processed,3);
  assert.equal(result.total,10001);
  assert.equal(seen.at(-1).processed,3);
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
test("precificação promocional expõe preço sugerido na listagem e mantém os jobs separados por dono",()=>{
  const fs=require("node:fs"),path=require("node:path"),root=path.join(__dirname,"..");
  const view=fs.readFileSync(path.join(root,"views/app.html"),"utf8"),routes=fs.readFileSync(path.join(root,"src/routes/api.routes.js"),"utf8");
  const list=fs.readFileSync(path.join(root,"src/repositories/promoPriceRepository.js"),"utf8");
  const controller=fs.readFileSync(path.join(root,"src/controllers/promoPriceController.js"),"utf8");
  assert.match(view,/<th>Preço sugerido<\/th>/);
  assert.match(list,/preview_id=\$\$?\{/);
  assert.match(routes,/previews\/jobs\/:id/);
  assert.match(controller,/job\.data\.identity\?\.userId/);
});
test("páginas de preço e prévia consultam apenas a conta e avançam pelo último SKU",async()=>{
  const db=require("../src/config/postgres"),originalQuery=db.query,originalOne=db.queryOne,calls=[];
  db.queryOne=async()=>({total:1});
  db.query=async(sql,params)=>{calls.push({sql,params});return{rows:[]};};
  try{
    await prices.pageSkus(7,{publication:"PUBLISHED"},"SKU-5000",5000);
    await prices.detailsPage(7,{publication:"PUBLISHED"},"SKU-5000",1000);
    await prices.list(7,{preview_id:"00000000-0000-0000-0000-000000000001"});
    assert.ok(calls.slice(0,2).every(call=>/s\.account_id=\$1/.test(call.sql)&&/s\.sku>\$3/.test(call.sql)&&call.params[0]===7&&call.params[2]==="SKU-5000"));
    assert.match(calls[2].sql,/promo_pricing_preview_rows/);
    assert.equal(calls[2].params[1],"00000000-0000-0000-0000-000000000001");
  }finally{db.query=originalQuery;db.queryOne=originalOne;}
});
