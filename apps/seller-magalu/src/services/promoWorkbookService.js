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
// Planilha do recorte de "Precos do catalogo" (com o resultado da revisao, se houver).
const STALE_MS=24*60*60*1000;
function priceReading(row){if(row.price_error)return"Falha na leitura";if(!row.price_present)return"Preço ausente";const age=Date.now()-new Date(row.price_synced_at||0).getTime();return!Number.isFinite(age)||age>STALE_MS?"Leitura antiga":"Recente";}
function num(value){if(value===null||value===undefined||value==="")return null;const n=Number(value);return Number.isFinite(n)?n:null;}
async function buildCatalogPriceWorkbook(rows,{withPreview=false}={}){
  const book=new ExcelJS.Workbook();const sheet=book.addWorksheet("Preços do catálogo");
  const columns=[{header:"SKU",key:"sku",width:22},{header:"EAN",key:"ean",width:16},{header:"Família",key:"group",width:26},{header:"Produto",key:"title",width:52},
    {header:"Publicação",key:"status",width:14},{header:"Atividade",key:"active",width:11},{header:"Categoria",key:"category",width:16},
    {header:"Custo (R$)",key:"cost",width:12},{header:"Imposto (%)",key:"tax",width:11},{header:"Preço cheio (R$)",key:"list",width:15},{header:"Preço atual (R$)",key:"price",width:15}];
  if(withPreview)columns.push({header:"Preço sugerido (R$)",key:"suggested",width:17},{header:"Preço no Pix (R$)",key:"pix",width:16},{header:"Margem sem Pix (%)",key:"margin",width:17},{header:"Margem no Pix (%)",key:"pixMargin",width:16},{header:"Situação na revisão",key:"review",width:40});
  columns.push({header:"Leitura do preço",key:"reading",width:16},{header:"Lido em",key:"readAt",width:18});
  sheet.columns=columns;
  for(const row of rows){
    const result=row.preview_result||null;
    sheet.addRow({sku:String(row.sku||""),ean:row.ean?String(row.ean):"",group:row.group_id||"",title:row.title||"",status:row.status||"",active:row.active===true?"Ativo":row.active===false?"Inativo":"",category:row.category_id||"",
      cost:num(row.unit_cost),tax:num(row.tax_rate),list:row.price_present?num(row.list_price):null,price:row.price_present?num(row.price):null,
      ...(withPreview?{suggested:num(result?.suggested_price),pix:num(result?.pix_price),margin:num(result?.estimated_margin),pixMargin:num(result?.pix_margin),review:!result?"Fora da revisão":result.eligible?"Apto":(result.issues||[]).join("; ")}:{}),
      reading:priceReading(row),readAt:row.price_synced_at?new Date(row.price_synced_at):null});
  }
  for(const key of ["sku","ean","group","category"])sheet.getColumn(key).numFmt="@";
  for(const key of ["cost","list","price",...(withPreview?["suggested","pix"]:[])])sheet.getColumn(key).numFmt="#,##0.00";
  for(const key of ["tax",...(withPreview?["margin","pixMargin"]:[])])sheet.getColumn(key).numFmt="0.00";
  sheet.getColumn("readAt").numFmt="dd/mm/yyyy hh:mm";
  sheet.getRow(1).font={bold:true};sheet.views=[{state:"frozen",ySplit:1}];
  sheet.autoFilter={from:{row:1,column:1},to:{row:1,column:columns.length}};
  return Buffer.from(await book.xlsx.writeBuffer());
}
module.exports={buildPromotionWorkbook,buildCatalogPriceWorkbook};
