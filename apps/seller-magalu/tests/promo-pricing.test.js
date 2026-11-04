"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const pricing=require("../src/services/promoPricingService");
const base={sku:"001",status:"PUBLISHED",active:true,unit_cost:"50",tax_rate:"10",list_price:"120",price:"110",price_present:true,price_synced_at:new Date().toISOString()};
const terms={target_margin:"20",commission_rate:"10",fixed_fee:"2",shipping:"3"};
test("preço mínimo arredonda para cima e margem é recalculada em centavos",()=>{
  const row=pricing.evaluate(base,terms);
  assert.equal(row.suggested_price,91.67);
  assert.ok(row.estimated_margin>=20);
  assert.equal(row.eligible,true);
});
test("frete vazio permanece desconhecido; custo, imposto e preço cheio ausentes bloqueiam",()=>{
  assert.equal(pricing.evaluate(base,{...terms,shipping:""}).eligible,false);
  assert.equal(pricing.evaluate({...base,unit_cost:null},terms).eligible,false);
  assert.equal(pricing.evaluate({...base,tax_rate:null},terms).eligible,false);
  assert.equal(pricing.evaluate({...base,list_price:null},terms).eligible,false);
});
test("taxas inviáveis, preço sem desconto e leitura antiga são pendências explícitas",()=>{
  assert.equal(pricing.evaluate(base,{...terms,target_margin:"90"}).eligible,false);
  assert.equal(pricing.evaluate({...base,list_price:"90"},terms).eligible,false);
  assert.equal(pricing.evaluate({...base,price_synced_at:"2020-01-01T00:00:00Z"},terms).eligible,false);
});
test("ajuste por SKU recalcula margem e não aceita valor abaixo do piso",()=>{
  const good=pricing.evaluate(base,terms,{price:"100"});assert.equal(good.suggested_price,100);assert.equal(good.eligible,true);
  const bad=pricing.evaluate(base,terms,{price:"80"});assert.equal(bad.eligible,false);
});
test("prévia rejeita parâmetros monetários imprecisos e mantém frete vazio explícito",()=>{
  const preview=require("../src/repositories/promoPricingPreviewRepository");
  assert.throws(()=>preview.validateTerms({...terms,fixed_fee:"2.345"}),{status:422});
  assert.equal(preview.validateTerms({...terms,shipping:""}).shipping,"");
});
test("prévia só pode ser lida pela mesma conta, empresa e usuário",async()=>{
  const db=require("../src/config/postgres"),previews=require("../src/repositories/promoPricingPreviewRepository"),original=db.query,calls=[];
  db.query=async(sql,params)=>{calls.push({sql,params});return{rows:[]};};
  try{await previews.get("preview",{accountId:7,tenantId:"tenant",userId:"user"});assert.deepEqual(calls[0].params,["preview",7,"tenant","user"]);assert.match(calls[0].sql,/account_id=\$2 and dach_tenant_id=\$3 and dach_user_id=\$4/);}finally{db.query=original;}
});
