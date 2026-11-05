"use strict";

// Evidência de item vinda exclusivamente de lançamentos SALE/CREDIT do relatório
// financeiro oficial. Não é um custo de aquisição e não autoriza aproximações
// por título, família, preço ou similaridade textual.
function clean(value, max=250) { return String(value == null ? "" : value).trim().slice(0, max); }
function extractFinancialItemEvidence(report) {
  const transactions=Array.isArray(report?.transactions)?report.transactions:[];
  const sales=transactions.filter(tx=>String(tx?.category||"").toUpperCase()==="SALE" && String(tx?.type||"").toUpperCase()==="CREDIT");
  if(!sales.length)return {complete:false,reason:"NO_SALE_LINES",items:[]};
  const seen=new Set(),items=[];
  let errors=0;
  for(const tx of sales){
    const entity=tx?.entity||{}, extras=entity?.extras||{};
    const id=clean(entity.id,300), sku=clean(extras.sku,200), name=clean(extras.name,500);
    const quantity=Number(extras.quantity), raw=Number(tx?.value),normalizer=Number(tx?.normalizer);
    const currency=clean(tx?.currency||"BRL",12).toUpperCase();
    // Não deduplicar por SKU: um pedido pode ter linhas distintas do mesmo SKU.
    // Sem ID único não há como provar que dois lançamentos são itens distintos.
    if(String(entity.type||"").toUpperCase()!=="ITEM" || !id || !sku ||
       !Number.isFinite(quantity) || quantity<=0 || !Number.isFinite(raw) || raw<=0 ||
       !Number.isFinite(normalizer) || normalizer<=0 || currency!=="BRL" || seen.has(id)){
      errors++;continue;
    }
    seen.add(id);
    items.push({remote_item_id:id,sku,name:name||null,quantity,
      amount_total:raw,amount_normalizer:normalizer,
      delivery_id:clean(extras.delivery_id,300)||null});
  }
  return {complete:errors===0 && items.length===sales.length,
    reason:errors?"INCOMPLETE_SALE_ENTITIES":null,items};
}
module.exports={extractFinancialItemEvidence,_test:{clean}};
