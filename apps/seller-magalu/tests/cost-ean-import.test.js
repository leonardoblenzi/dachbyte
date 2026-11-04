"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const {parseEanCostWorkbook,buildEanCostTemplate}=require("../src/services/costWorkbookService");
const { _test:{expandEanRows} }=require("../src/repositories/financialRepository");
async function workbook(rows){const w=new ExcelJS.Workbook();const s=w.addWorksheet("Custos por EAN");s.addRow(["EAN","Custo produto"]);for(const row of rows)s.addRow(row);return Buffer.from(await w.xlsx.writeBuffer());}
test("lê EAN como texto preservando zeros e agrupa valores idênticos",async()=>{
 const rows=await parseEanCostWorkbook({filename:"custos.xlsx",buffer:await workbook([["0012345678901",12.5],["0012345678901",12.5]])});
 assert.deepEqual(rows,[{ean:"0012345678901",unit_cost:12.5}]);
});
test("rejeita EAN numérico e custos conflitantes",async()=>{
 const numeric=await workbook([[12345,10]]),conflict=await workbook([["12345",10],["12345",20]]);
 await assert.rejects(()=>parseEanCostWorkbook({filename:"custos.xlsx",buffer:numeric}));
 await assert.rejects(()=>parseEanCostWorkbook({filename:"custos.xlsx",buffer:conflict}));
});
test("modelo EAN pode ser preenchido e lido",async()=>{
 const template=await buildEanCostTemplate(),book=new ExcelJS.Workbook();await book.xlsx.load(template);
 book.worksheets[0].addRow(["0001234567890",42.75]);
 const rows=await parseEanCostWorkbook({filename:"modelo.xlsx",buffer:Buffer.from(await book.xlsx.writeBuffer())});
 assert.deepEqual(rows,[{ean:"0001234567890",unit_cost:42.75}]);
});
test("EAN compartilhado inclui todos os SKUs e sinaliza não encontrados",()=>{
 const result=expandEanRows([{ean:"123",unit_cost:10},{ean:"456",unit_cost:20}],
  [{ean:"123",sku:"A",unit_cost:null},{ean:"123",sku:"B",unit_cost:"5"}]);
 assert.deepEqual(result.rows.map(row=>row.sku),["A","B"]);
 assert.deepEqual(result.missing,["456"]);
 assert.deepEqual(result.rows[1].previous_cost,5);
});
test("SKU com dois EANs e custos conflitantes é rejeitado",()=>{
 assert.throws(()=>expandEanRows([{ean:"123",unit_cost:10},{ean:"456",unit_cost:20}],
  [{ean:"123",sku:"A",unit_cost:null},{ean:"456",sku:"A",unit_cost:null}]),{status:422});
});
test("confirmação grava todos os SKUs e histórico em uma transação",async()=>{
 const db=require("../src/config/postgres"),repository=require("../src/repositories/financialRepository");
 const original=db.withClient,calls=[];
 db.withClient=async callback=>callback({query:async(sql,params=[])=>{
  calls.push({sql,params});
  if(/from magalu\.ean_cost_import_previews.*for update/s.test(sql))return{rows:[{rows:{input:[{ean:"123",unit_cost:10}],missing:[],rows:[{sku:"A",eans:["123"],unit_cost:10,previous_cost:null},{sku:"B",eans:["123"],unit_cost:10,previous_cost:5}]}}]};
  if(/cross join lateral/.test(sql))return{rows:[{sku:"A",ean:"123",unit_cost:null},{sku:"B",ean:"123",unit_cost:5}]};
  if(/for update of s/.test(sql))return{rows:[{sku:"A",unit_cost:null},{sku:"B",unit_cost:5}]};
  return{rows:[]};
 }});
 try{const result=await repository.confirmEanCosts(7,"preview-1","user-1");assert.deepEqual(result,{updated:2,total:2});assert.equal(calls[0].sql,"BEGIN");assert.equal(calls.at(-1).sql,"COMMIT");assert.equal(calls.filter(call=>/insert into magalu\.sku_cost_history/.test(call.sql)).length,2);assert.ok(calls.some(call=>call.params.includes(7)));}
 finally{db.withClient=original;}
});
test("mudança de custo após prévia faz rollback sem escrita",async()=>{
 const db=require("../src/config/postgres"),repository=require("../src/repositories/financialRepository"),original=db.withClient,calls=[];
 db.withClient=async callback=>callback({query:async(sql)=>{
  calls.push(sql);
  if(/from magalu\.ean_cost_import_previews.*for update/s.test(sql))return{rows:[{rows:{input:[{ean:"123",unit_cost:10}],missing:[],rows:[{sku:"A",eans:["123"],unit_cost:10,previous_cost:null}]}}]};
  if(/cross join lateral/.test(sql))return{rows:[{sku:"A",ean:"123",unit_cost:5}]};
  return{rows:[]};
 }});
 try{await assert.rejects(()=>repository.confirmEanCosts(7,"preview-1","user-1"),{status:409});assert.equal(calls.at(-1),"ROLLBACK");assert.ok(!calls.some(sql=>/insert into magalu\.sku_costs/.test(sql)));}
 finally{db.withClient=original;}
});
