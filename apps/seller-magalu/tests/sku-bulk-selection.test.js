"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const selections=require("../src/repositories/skuBulkSelectionRepository");

test("valores enviados em partes preservam zeros e não são truncados",()=>{
  assert.deepEqual(selections._test.normalizeIdentifiers(["00123"," 00123 ","00042"]),["00123","00042"]);
  assert.throws(()=>selections._test.normalizeIdentifiers(["X".repeat(129)]),{status:422});
  assert.throws(()=>selections._test.normalizeIdentifiers(Array(1001).fill("A")),{status:413});
  const skus=require("../src/repositories/skuMassRepository");
  assert.throws(()=>skus._test.normalizeExplicitSkus(["X".repeat(65)]),{status:422});
});
test("busca por SKU, EAN e família usa correspondência exata e conta",()=>{
  for(const type of ["sku","ean","group"]){const sql=selections._test.matchingQuery(type);assert.match(sql,/s\.account_id=\$2/);assert.match(sql,/i\.selection_id=\$1/);assert.match(sql,/filtered\.status=\$3/);assert.match(sql,/filtered\.active=\$4/);}
  assert.match(selections._test.matchingQuery("ean"),/jsonb_array_elements/);
  assert.match(selections._test.matchingQuery("group"),/s\.group_id/);
});
test("seleção persistida exige conta, tenant e usuário",async()=>{
  const db=require("../src/config/postgres"),original=db.query,calls=[];
  db.query=async(sql,params)=>{calls.push({sql,params});return{rows:[]};};
  try{await selections.get("selection-1",7,"tenant-1","user-1");assert.deepEqual(calls[0].params,["selection-1",7,"tenant-1","user-1"]);assert.match(calls[0].sql,/account_id=\$2 and dach_tenant_id=\$3 and dach_user_id=\$4/);}
  finally{db.query=original;}
});
test("interface envia listas em partes, mostra lotes e painel agrega o processo",()=>{
  const root=path.join(__dirname,"..");
  const client=fs.readFileSync(path.join(root,"public/js/magalu-sku-management.js"),"utf8");
  const worker=fs.readFileSync(path.join(root,"src/jobs/skuUpdate.worker.js"),"utf8");
  const panel=fs.readFileSync(path.join(root,"src/repositories/processPanelRepository.js"),"utf8");
  assert.match(client,/offset\+=1000/);assert.match(client,/bulk\/groups\/preview/);assert.match(client,/bulk\/groups\/apply/);
  assert.match(worker,/apply-group/);assert.match(panel,/sku_bulk_groups/);
});

test("revisão divide seleção acima de 5.000 sem descartar SKUs",async()=>{
  const db=require("../src/config/postgres");
  const sku=require("../src/repositories/skuMassRepository");
  const groups=require("../src/repositories/skuBulkGroupRepository");
  const oldGet=selections.get,oldPage=selections.skuPage,oldPreview=sku.createPreview,oldQuery=db.query;
  const previewCounts=[],queries=[];
  selections.get=async()=>({state:"ready",matched_count:10001});
  selections.skuPage=async(_id,_identity,offset,limit)=>({skus:Array.from({length:Math.min(limit,10001-offset)},(_,i)=>`SKU-${offset+i}`)});
  sku.createPreview=async({selection})=>{previewCounts.push(selection.skus.length);return{id:`00000000-0000-4000-8000-${String(previewCounts.length).padStart(12,"0")}`,selected_count:selection.skus.length,change_count:selection.skus.length};};
  db.query=async(sql,params)=>{queries.push({sql,params});return{rows:[]};};
  try{
    const group=await groups.create({accountId:7,tenantId:"T",userId:"U"},"selection-1","activate");
    assert.deepEqual(previewCounts,[5000,5000,1]);
    assert.equal(group.selected_count,10001);
    assert.equal(group.previews.length,3);
    assert.ok(queries.some(call=>/insert into magalu\.sku_bulk_groups/.test(call.sql)));
  }finally{selections.get=oldGet;selections.skuPage=oldPage;sku.createPreview=oldPreview;db.query=oldQuery;}
});

test("worker retoma lote já criado sem duplicar o batch",async()=>{
  const db=require("../src/config/postgres"),sku=require("../src/repositories/skuMassRepository"),groups=require("../src/repositories/skuBulkGroupRepository");
  const oldOne=db.queryOne,oldQuery=db.query,oldCreate=sku.createBatchFromPreview,calls=[],enqueued=[];
  db.queryOne=async sql=>{calls.push(sql);if(sql.includes("from magalu.sku_bulk_groups"))return{preview_ids:["preview-1"],expires_at:new Date(Date.now()+60000).toISOString(),applied_at:null};if(sql.includes("from magalu.mass_operation_batches"))return{id:"batch-1"};return null;};
  db.query=async sql=>{calls.push(sql);if(sql.includes("from magalu.mass_operation_items"))return{rows:[{id:1},{id:2}]};return{rows:[]};};
  sku.createBatchFromPreview=async()=>{throw new Error("batch duplicado");};
  try{const result=await groups.apply({accountId:7,tenantId:"T",userId:"U"},"group-1",async items=>{enqueued.push(...items);return items;});assert.equal(result.batches[0].reused,true);assert.deepEqual(enqueued.map(item=>item.id),[1,2]);assert.ok(calls.some(sql=>sql.includes("applied_at=now()")));}
  finally{db.queryOne=oldOne;db.query=oldQuery;sku.createBatchFromPreview=oldCreate;}
});
