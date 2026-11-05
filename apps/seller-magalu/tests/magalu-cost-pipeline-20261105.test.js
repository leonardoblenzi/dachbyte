"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {normalizeOrder}=require("../src/services/orderPayload");
const {normalizeReport}=require("../src/services/financialAnalysisNormalizer");
const root=path.resolve(__dirname,"..");const read=f=>fs.readFileSync(path.join(root,f),"utf8");

test("pedido Magalu obtém SKU real via deliveries[].items, sem criar pedido fictício",()=>{
 const order=normalizeOrder({code:"PED-100",channel:{id:"CHANNEL-1"},amounts:{total:{value:23600,normalizer:100,currency:"BRL"}},deliveries:[
   {id:"DEL-100",items:[{info:{sku:"POL-140",id:"ITEM-1",name:"Poltrona"},quantity:2,unit_price:{value:11800,normalizer:100,currency:"BRL"},amounts:{total:{value:23600,normalizer:100,currency:"BRL"}}}]}
 ]});
 assert.equal(order.items.length,0);assert.equal(order.embedded_deliveries.length,1);
 const delivery=order.embedded_deliveries[0];assert.equal(delivery.order_code,"PED-100");assert.equal(delivery.channel_id,"CHANNEL-1");
 assert.equal(delivery.items[0].sku,"POL-140");assert.equal(delivery.items[0].quantity,2);assert.equal(delivery.items[0].amount_normalizer,100);
});
test("relatório financeiro mantém custo independente do marketplace e separa linhas informativas",()=>{
 const row=normalizeReport({external_id:"PED-100",transactions:[
   {type:"CREDIT",category:"SALE",value:23600,normalizer:100,currency:"BRL",entity:{type:"ITEM",id:"I-1",extras:{sku:"POL-140",quantity:2,name:"Poltrona"}}},
   {type:"DEBIT",category:"COMMISSION",value:3500,normalizer:100,currency:"BRL"},
   {type:"INFORMATIVE",category:"TAXES",value:900,normalizer:100,currency:"BRL"}
 ]});
 assert.equal(row.itemEvidence.complete,true);assert.equal(row.itemEvidence.items[0].sku,"POL-140");
 assert.equal(row.transactionCount,2);assert.equal(row.netReceivable,201);
 assert.equal(row.itemEvidence.items[0].unit_cost,undefined);
});
test("custo manual e XLSX não dependem de custo informado pela API",()=>{
 const sql=read("src/repositories/financialRepository.js");
 assert.match(sql,/magalu\.sku_costs/);assert.match(sql,/magalu\.sku_cost_history/);
 assert.match(sql,/magalu\.order_items oi/);assert.match(sql,/magalu\.delivery_items di/);
 assert.match(read("src/repositories/uxAnalyticsRepository.js"),/lower\(btrim\(sc\.sku\)\)=lower\(btrim\(si\.sku\)\)/);
});
