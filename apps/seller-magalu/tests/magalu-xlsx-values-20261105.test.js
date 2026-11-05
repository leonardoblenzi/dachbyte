"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),zlib=require("node:zlib");
const {createXlsx}=require("../src/services/simpleXlsx");
function xmlFromZip(buffer,name){
 let pos=0;
 while(pos+30<=buffer.length && buffer.readUInt32LE(pos)===0x04034b50){
  const size=buffer.readUInt32LE(pos+18),nameLen=buffer.readUInt16LE(pos+26),extraLen=buffer.readUInt16LE(pos+28);
  const entry=buffer.subarray(pos+30,pos+30+nameLen).toString("utf8");
  const start=pos+30+nameLen+extraLen;
  if(entry===name)return zlib.inflateRawSync(buffer.subarray(start,start+size)).toString("utf8");
  pos=start+size;
 }
 throw new Error(`Arquivo ausente: ${name}`);
}
test("XLSX exporta custo como número e SKU com zeros à esquerda como texto",()=>{
 const buffer=createXlsx([{sku:"0000123",unit_cost:42.35},{sku:"SKU-2",unit_cost:null}],
   [{key:"sku",header:"SKU"},{key:"unit_cost",header:"Custo"}],"Custos");
 const xml=xmlFromZip(buffer,"xl/worksheets/sheet1.xml");
 assert.match(xml,/<c r="A2" t="inlineStr"><is><t xml:space="preserve">0000123<\/t>/);
 assert.match(xml,/<c r="B2" t="n"><v>42\.35<\/v><\/c>/);
 assert.doesNotMatch(xml,/<c r="B3" t="n">/);
});
