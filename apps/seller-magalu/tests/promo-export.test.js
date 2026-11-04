"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),ExcelJS=require("exceljs");
const {buildPromotionWorkbook}=require("../src/services/promoWorkbookService");
const {sourceUnchanged}=require("../src/repositories/promoPricingPreviewRepository");

test("XLSX promocional contém apenas SKU texto e preço numérico com duas casas",async()=>{
  const buffer=await buildPromotionWorkbook([{sku:"000123",price:91.67},{sku:"ABC-2",price:110.5}]);
  const book=new ExcelJS.Workbook();await book.xlsx.load(buffer);const sheet=book.worksheets[0];
  assert.equal(book.worksheets.length,1);assert.equal(sheet.columnCount,2);
  assert.deepEqual(sheet.getRow(1).values.slice(1),["SKU","Preço promocional"]);
  assert.equal(sheet.getCell("A2").value,"000123");assert.equal(sheet.getCell("A2").type,ExcelJS.ValueType.String);
  assert.equal(sheet.getCell("B2").value,91.67);assert.equal(sheet.getCell("B2").numFmt,"0.00");
  assert.equal(sheet.getCell("B3").value,110.5);
});

test("exportação detecta preço ou custo alterado depois da prévia",()=>{
  const source={sku:"A",price:"100",list_price:"120",unit_cost:"50",tax_rate:"10",status:"PUBLISHED",active:true,price_present:true,price_synced_at:"2026-11-04T10:00:00Z"};
  assert.equal(sourceUnchanged(source,{...source}),true);
  assert.equal(sourceUnchanged(source,{...source,price:"101"}),false);
  assert.equal(sourceUnchanged(source,{...source,unit_cost:"51"}),false);
});

test("servidor exige confirmação explícita quando há SKUs pendentes",async()=>{
  const db=require("../src/config/postgres"),repo=require("../src/repositories/promoPricingPreviewRepository"),pricing=require("../src/services/promoPricingService"),original=db.query;
  const terms={target_margin:"20",commission_rate:"10",fixed_fee:"2",shipping:"3"},when=new Date().toISOString();
  const sources=[
    {sku:"001",price:110,list_price:120,unit_cost:50,tax_rate:10,status:"PUBLISHED",active:true,price_present:true,price_synced_at:when,price_error:null},
    {sku:"002",price:110,list_price:120,unit_cost:null,tax_rate:10,status:"PUBLISHED",active:true,price_present:true,price_synced_at:when,price_error:null}
  ];
  db.query=async(sql)=>{
    if(sql.includes("from magalu.promo_pricing_previews"))return{rows:[{total_count:2,terms}]};
    return{rows:sources.map(source=>({sku:source.sku,source,terms_override:{},price_override:null,result:pricing.evaluate(source,terms),current_sku:source.sku,...source}))};
  };
  const identity={accountId:7,tenantId:"T",userId:"U"};
  try{
    await assert.rejects(repo.exportReview("preview",identity),{status:409});
    const review=await repo.exportReview("preview",identity,{allowPartial:true});
    assert.deepEqual(review.rows,[{sku:"001",price:91.67}]);
    assert.equal(review.excluded_count,1);
    assert.equal(review.excluded[0].sku,"002");
  }finally{db.query=original;}
});
