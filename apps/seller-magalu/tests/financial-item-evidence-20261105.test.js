"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {extractFinancialItemEvidence}=require("../src/services/financialItemEvidence");
function sale(id,sku,quantity=2){return {category:"SALE",type:"CREDIT",value:20400,normalizer:100,currency:"BRL",entity:{type:"ITEM",id,extras:{sku,name:"Poltrona",quantity,delivery_id:"D-1"}}};}
test("extrai SKU, quantidade e valor monetário sem custos inventados",()=>{
 const x=extractFinancialItemEvidence({transactions:[sale("ITEM-1","SKU-1"),{category:"COMMISSION",type:"DEBIT",value:1500,normalizer:100}]});
 assert.equal(x.complete,true);assert.deepEqual(x.items,[{remote_item_id:"ITEM-1",sku:"SKU-1",name:"Poltrona",quantity:2,amount_total:20400,amount_normalizer:100,delivery_id:"D-1"}]);
 assert.equal(x.items[0].unit_cost,undefined);
});
test("não aceita linha sem SKU, quantidade ou ID; não deduplica pelo SKU",()=>{
 assert.equal(extractFinancialItemEvidence({transactions:[sale("ID-1","SKU"),sale("ID-2","SKU")]}).complete,true);
 assert.equal(extractFinancialItemEvidence({transactions:[sale("ID-1","SKU"),sale("ID-1","SKU")]}).complete,false);
 assert.equal(extractFinancialItemEvidence({transactions:[sale("ID-1","")]}).complete,false);
 assert.equal(extractFinancialItemEvidence({transactions:[sale("ID-1","SKU",0)]}).complete,false);
});
test("não transforma dados financeiros parciais em produto identificado",()=>{
 assert.equal(extractFinancialItemEvidence({transactions:[{category:"COMMISSION",type:"DEBIT",value:100,normalizer:100}]}).complete,false);
 assert.equal(extractFinancialItemEvidence({transactions:[sale("ID-1","SKU"),{category:"SALE",type:"CREDIT",value:100,normalizer:100}]}).complete,false);
});
