"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const root=path.resolve(__dirname,"..");
const read=f=>fs.readFileSync(path.join(root,f),"utf8");
const {stockQuantity}=require("../src/services/catalogPayload");
const {enrichMarginRows}=require("../src/services/marginOrderPresentation");
test("AVAILABLE de results[] é consolidado, RESERVED não é vendido",()=>{
  assert.equal(stockQuantity({results:[{type:"AVAILABLE",quantity:4,branch:{id:"a"},channel:{id:"x"}},{type:"RESERVED",quantity:7,branch:{id:"a"},channel:{id:"x"}},{type:"AVAILABLE",quantity:3,branch:{id:"b"},channel:{id:"x"}}]}),7);
  assert.equal(stockQuantity({results:[{type:"RESERVED",quantity:9}]}),null);
  assert.equal(stockQuantity({results:[]}),null);
  assert.equal(stockQuantity({quantity:5}),5);
});
test("itens da entrega identificam SKU e custo ausente sem inventar valor",()=>{
  const [row]=enrichMarginRows([{id:8,code:"100"}],[],[{order_id:8,sku:"SKU-8",name:"Poltrona",quantity:2,unit_cost:null,catalog_present:true}]);
  assert.equal(row.identity_state,"delivery_only");
  assert.equal(row.first_sku,"SKU-8");
  assert.deepEqual(row.missing_cost_skus,[{sku:"SKU-8",name:"Poltrona",quantity:2}]);
});
test("frontend não solicita identificação manual e mantém a navegação por campanhas",()=>{
  const html=read("views/app.html"),financial=read("public/js/magalu-financial.js"),campaigns=read("public/js/magalu-campaign-tabs.js");
  assert.doesNotMatch(html,/id="mg-orders-reconnect"|Worker Magalu|id="mg-orders-runs"/);
  assert.match(html,/mg-margin-data-table/);
  assert.match(html,/mg-margin-export/);
  assert.doesNotMatch(financial,/Tentar identificar produto/);
  assert.match(campaigns,/let active = "pricing"/);
});
test("consulta por período reconcilia detalhes e valida cobertura antes do retorno",()=>{
  const orders=read("src/services/orderSyncService.js"),repo=read("src/repositories/orderRepository.js"),analytics=read("src/repositories/uxAnalyticsRepository.js");
  assert.match(orders,/await enrichDetails\(account,detailsNeeded\.filter\(r=>r\.listedItems\|\|!known\.has\(String\(r\.code\)\)\),"order"/);
  assert.match(orders,/await enrichDetails\(account,deliveryDetailsNeeded,"delivery"/);
  assert.match(repo,/async function itemCoverage/);
  assert.match(analytics,/dc\.expected_items>0/);
});
test("XLSX da margem grava números e datas reais e deixa resultado incompleto vazio",async()=>{
  const ExcelJS=require("exceljs");
  const {buildMarginWorkbook}=require("../src/services/marginWorkbookService");
  const buffer=await buildMarginWorkbook([
    {code:"A1",purchased_at:new Date("2026-11-01T12:00:00Z"),gmv:"150.50",known_result:"20",known_margin_pct:"12.5",result_complete:true,missing_cost_items:0},
    {code:"B2",purchased_at:"2026-11-02T12:00:00Z",gmv:"99.90",known_result:"0",known_margin_pct:null,result_complete:false,missing_cost_items:1},
  ]);
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(buffer);
  const sheet=wb.getWorksheet("Margem Magalu");
  const col=key=>sheet.getRow(1).values.indexOf(key);
  assert.equal(sheet.getRow(2).getCell(col("GMV")).value,150.5);
  assert.ok(sheet.getRow(2).getCell(col("Data")).value instanceof Date);
  assert.equal(sheet.getRow(2).getCell(col("Margem (%)")).value,0.125);
  assert.equal(sheet.getRow(3).getCell(col("Resultado")).value,null);
  assert.equal(sheet.getRow(3).getCell(col("Resultado completo")).value,"Não");
});
test("sincronização não repete o detalhe de pedidos já recuperados",()=>{
  const src=read("src/services/orderSyncService.js");
  assert.match(src,/function needsDetail\(normalized,saved\)/);
  assert.match(src,/normalized\.items\.length===0 && Number\(saved\?\.item_count\)>0/);
  assert.match(src,/if\(needsDetail\(normalized,saved\)\)details\.push/);
  assert.match(src,/orderRepository\.codesWithIdentifiedItems\(account\.id,detailsNeeded\.filter\(r=>!r\.listedItems\)/);
  assert.match(read("src/repositories/orderRepository.js"),/async function codesWithIdentifiedItems\(accountId,codes\)/);
});
test("detalhe do pedido grava as entregas aninhadas com itens identificados",()=>{
  const src=read("src/services/orderSyncService.js");
  assert.match(src,/const embedded=\(normalized\.embedded_deliveries\|\|\[\]\)\.filter\(d=>identifiedItems\(d\.items\)\);/);
  assert.match(src,/for\(const delivery of embedded\)await orderRepository\.upsertDelivery\(account\.id,delivery,\{httpStatus:response\.status\|\|200\}\);/);
});
