"use strict";
const ExcelJS=require("exceljs");
async function buildPromotionWorkbook(rows){
  const book=new ExcelJS.Workbook();const sheet=book.addWorksheet("Preços promocionais");
  sheet.columns=[{header:"SKU",key:"sku",width:28},{header:"Preço promocional",key:"price",width:22}];
  for(const row of rows){
    const sku=String(row.sku||"").trim(),price=Number(row.price);
    if(!sku||!Number.isFinite(price)||price<=0||Math.abs(Math.round(price*100)-price*100)>1e-7)throw new Error("Linha promocional inválida.");
    sheet.addRow({sku,price});
  }
  sheet.getColumn(1).numFmt="@";sheet.getColumn(2).numFmt="0.00";
  sheet.getRow(1).font={bold:true};sheet.views=[{state:"frozen",ySplit:1}];
  sheet.autoFilter={from:"A1",to:"B1"};
  return Buffer.from(await book.xlsx.writeBuffer());
}
module.exports={buildPromotionWorkbook};
