"use strict";
process.env.MAGALU_ENCRYPTION_KEY=Buffer.alloc(32,13).toString("base64");process.env.MAGALU_SYNC_PAGE_SIZE="100";process.env.MAGALU_SYNC_DETAIL_CONCURRENCY="2";
const test=require("node:test");const assert=require("node:assert/strict");const Module=require("node:module");const payload=require("../src/services/catalogPayload");
function clearModule(r){try{delete require.cache[require.resolve(r)];}catch(_){}}
async function withLoadStubs(stubs,load,run){const original=Module._load;Module._load=function(req,parent,isMain){if(Object.prototype.hasOwnProperty.call(stubs,req))return stubs[req];return original.call(this,req,parent,isMain);};try{return await run(load());}finally{Module._load=original;}}
test("catalog payload maps SKU and price fields",()=>{assert.equal(payload.skuFields({sku:"A",title:"P",status:"PUBLISHED",group:{id:"G"}}).groupId,"G");assert.deepEqual(payload.priceFields({price:89.9,list_price:109.9}),{price:89.9,listPrice:109.9});});
test("price payload unwraps Magalu results and normalizes minor currency units",()=>{
  assert.deepEqual(payload.priceFields({results:[{price:51081,list_price:60000,normalizer:100,currency:"BRL"}]}),{price:510.81,listPrice:600});
  assert.deepEqual(payload.priceFields({results:[{price:51081,list_price:60000,normalizer:0}]}),{price:null,listPrice:null});
  assert.deepEqual(payload.priceFields({results:[]}),{price:null,listPrice:null});
  assert.deepEqual(payload.priceFields({results:[{price:349900000000000,list_price:349900000000000,normalizer:100}]}),{price:null,listPrice:null});
  assert.deepEqual(payload.priceFields({price:null,list_price:null}),{price:null,listPrice:null});
});
test("stock display extraction is conservative",()=>{assert.equal(payload.stockQuantity({quantity:8}),8);assert.equal(payload.stockQuantity({inventory:{available_quantity:3}}),3);assert.equal(payload.stockQuantity({unknown_shape:9}),null);});
test("unseen-SKU cleanup is limited to the status partitions that were fully scanned",async()=>{
  let statement,parameters;
  clearModule("../src/repositories/catalogRepository");
  await withLoadStubs({"../config/postgres":{query:async(sql,params)=>{statement=sql;parameters=params;return {rowCount:2};}}},()=>require("../src/repositories/catalogRepository"),async repository=>{
    assert.equal(await repository.markUnseenSkusMissing(7,"2026-10-13T10:00:00Z",["PUBLISHED","UNPUBLISHED","BLOCKED"]),2);
  });
  assert.match(statement,/status\s*=\s*any\(\$3::text\[\]\)/i);
  assert.deepEqual(parameters[2],["PUBLISHED","UNPUBLISHED","BLOCKED"]);
});
test("price webhook bootstraps missing SKU before FK-bound price mirror",async()=>{const calls=[];const account={id:7,dach_tenant_id:"dach-7",status:"active"};clearModule("../src/services/catalogSyncService");await withLoadStubs({"../repositories/accountRepository":{findAccountById:async()=>account,findAccountByIdForTenant:async()=>account},"../repositories/catalogRepository":{getCatalogItem:async()=>null,upsertSku:async(_i,d)=>calls.push(`upsert-sku:${d.sku}`),upsertPrice:async(_i,s)=>calls.push(`upsert-price:${s}`),markPriceMissing:async()=>{},markStockMissing:async()=>{},recordPriceError:async()=>{},recordStockError:async()=>{},markSkuMissing:async()=>{}},"../repositories/syncRunRepository":{},"./portfolioReadService":{getSku:async()=>{calls.push("get-sku:A");return{status:200,data:{sku:"A"}};},getPrice:async()=>{calls.push("get-price:A");return{status:200,data:{price:10,list_price:12}};},getStock:async()=>{throw new Error("unexpected stock");}}},()=>require("../src/services/catalogSyncService"),async s=>{const r=await s.reconcileSku(7,"A",{topic:"portfolios_price"});assert.equal(r.price_ok,true);assert.deepEqual(calls,["get-sku:A","upsert-sku:A","get-price:A","upsert-price:A"]);});});
test("full sync paginates and reads price/stock",async()=>{const offsets=[],details=[];const account={id:8,dach_tenant_id:"dach-8",status:"active"};clearModule("../src/services/catalogSyncService");await withLoadStubs({"../repositories/accountRepository":{findAccountById:async()=>account,updateSellerProfile:async()=>{},setCatalogSyncState:async()=>{}},"../repositories/catalogRepository":{upsertSku:async()=>({inserted:true}),upsertPrice:async(_i,s)=>details.push(`p:${s}`),upsertStock:async(_i,s)=>details.push(`s:${s}`),markPriceMissing:async()=>{},markStockMissing:async()=>{},recordPriceError:async()=>{},recordStockError:async()=>{},markUnseenSkusMissing:async()=>0},"../repositories/syncRunRepository":{createRun:async()=>({id:44}),finishRun:async()=>{}},"./portfolioReadService":{getSeller:async()=>({data:{name:"Seller"}}),listSkus:async(_i,_t,{offset,status})=>{offsets.push(`${status}:${offset}`);return status==="PUBLISHED"?(offset===0?{status:200,data:{results:[{sku:"A"},{sku:"B"}],meta:{page:{limit:2},links:{next:"next"}}}}:{status:200,data:{results:[{sku:"C"}],meta:{page:{limit:2},links:{next:null}}}}):{status:200,data:{results:[],meta:{links:{next:null}}}};},getPrice:async()=>({status:200,data:{price:1,list_price:2}}),getStock:async()=>({status:200,data:{quantity:2}})}},()=>require("../src/services/catalogSyncService"),async s=>{const r=await s.fullCatalogSync(8,{reason:"test"});assert.deepEqual(offsets,["PUBLISHED:0","PUBLISHED:2","UNPUBLISHED:0","BLOCKED:0"]);assert.equal(r.scanned,3);assert.equal(details.length,6);});});

test("full sync partitions SKU pagination by status and finalizes only after every partition",async()=>{
  const calls=[];const account={id:8,dach_tenant_id:"dach-8",status:"active"};
  clearModule("../src/services/catalogSyncService");
  await withLoadStubs({
    "../repositories/accountRepository":{findAccountById:async()=>account,updateSellerProfile:async()=>{},setCatalogSyncState:async()=>{}},
    "../repositories/catalogRepository":{upsertSku:async()=>({inserted:true}),upsertPrice:async()=>{},upsertStock:async()=>{},markUnseenSkusMissing:async(_id,_started,statuses)=>{calls.push(`mark-missing:${statuses?.join(",")}`);return 0;}},
    "../repositories/syncRunRepository":{createRun:async()=>({id:45}),finishRun:async()=>{}},
    "./portfolioReadService":{
      getSeller:async()=>({data:{}}),
      listSkus:async(_id,_tenant,{status,offset})=>{calls.push(`${status}:${offset}`);return {status:200,data:{results:offset===0?[{sku:`${status}-1`}]:[],meta:{links:{next:offset===0?`/seller/v1/portfolios/skus?_offset=1&_limit=100`:null}}}};},
      getPrice:async()=>({status:200,data:{results:[{price:1000,list_price:1000,normalizer:100}]}}),
      getStock:async()=>({status:200,data:{quantity:1}}),
    },
  },()=>require("../src/services/catalogSyncService"),async service=>{
    const result=await service.fullCatalogSync(8,{reason:"test"});
    assert.equal(result.scanned,3);
    assert.deepEqual(calls,["PUBLISHED:0","PUBLISHED:1","UNPUBLISHED:0","UNPUBLISHED:1","BLOCKED:0","BLOCKED:1","mark-missing:PUBLISHED,UNPUBLISHED,BLOCKED"]);
  });
});
test("full sync refuses an over-limit status partition without marking unseen SKUs missing",async()=>{
  const requested=[];let marked=false;const account={id:8,dach_tenant_id:"dach-8",status:"active"};
  clearModule("../src/services/catalogSyncService");
  await withLoadStubs({
    "../repositories/accountRepository":{findAccountById:async()=>account,updateSellerProfile:async()=>{},setCatalogSyncState:async()=>{}},
    "../repositories/catalogRepository":{upsertSku:async()=>({inserted:true}),upsertPrice:async()=>{},upsertStock:async()=>{},markUnseenSkusMissing:async()=>{marked=true;return 0;}},
    "../repositories/syncRunRepository":{createRun:async()=>({id:46}),finishRun:async()=>{}},
    "./portfolioReadService":{
      getSeller:async()=>({data:{}}),
      listSkus:async(_id,_tenant,{status,offset})=>{requested.push(`${status}:${offset}`);if(offset>0)throw new Error("invalid offset requested");return {status:200,data:{results:[{sku:"A"}],meta:{links:{next:"/seller/v1/portfolios/skus?_offset=20100&_limit=100"}}}};},
      getPrice:async()=>({status:200,data:{price:10,list_price:10}}),
      getStock:async()=>({status:200,data:{quantity:1}}),
    },
  },()=>require("../src/services/catalogSyncService"),async service=>{
    await assert.rejects(service.fullCatalogSync(8,{reason:"test"}),/20\.000/);
    assert.deepEqual(requested,["PUBLISHED:0"]);
    assert.equal(marked,false);
  });
});

test("catalog pagination follows offset carried by meta.links.next",async()=>{clearModule("../src/services/catalogSyncService");await withLoadStubs({"../repositories/accountRepository":{},"../repositories/catalogRepository":{},"../repositories/syncRunRepository":{},"./portfolioReadService":{}},()=>require("../src/services/catalogSyncService"),async service=>{assert.equal(service._test.nextOffsetFromLink("/seller/v1/portfolios/skus?_limit=100&_offset=250",100),250);assert.equal(service._test.nextOffsetFromLink(null,100),null);assert.equal(service._test.nextOffsetFromLink("not a valid url %",100),100);});});
