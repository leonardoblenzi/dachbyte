"use strict";

function enrichMarginRows(rows,itemRows,deliveryRows,financialRows=[]){
  const byOrder=items=>{
    const map=new Map();
    for(const item of items||[]){
      const key=Number(item.order_id);
      if(!map.has(key))map.set(key,[]);
      map.get(key).push(item);
    }
    return map;
  };
  const itemsByOrder=byOrder(itemRows),deliveriesByOrder=byOrder(deliveryRows),financialByOrder=byOrder(financialRows);
  return rows.map(row=>{
    const orderItems=itemsByOrder.get(Number(row.id))||[];
    const deliveryItems=deliveriesByOrder.get(Number(row.id))||[];
    const financialItems=financialByOrder.get(Number(row.id))||[];
    const ownComplete=orderItems.length>0 && orderItems.every(item=>item.sku&&Number(item.quantity)>0
      && (item.amount_total!=null || item.unit_price!=null) && Number(item.amount_normalizer)>0);
    const actual=row.item_source==='financial' && financialItems.length?financialItems:
      ownComplete?orderItems:(deliveryItems.length?deliveryItems:financialItems.length?financialItems:orderItems);
    const identified=actual.find(item=>item.sku);
    const display=identified||actual.find(item=>item.name)||deliveryItems.find(item=>item.sku||item.name)||financialItems.find(item=>item.sku||item.name);
    const missing=new Map(), unavailable=new Set();
    for(const item of actual){
      const sku=String(item.sku||"").trim();
      if(!sku || item.unit_cost!=null)continue;
      if(item.catalog_present===false || (row.item_source!=='order' && !(row.item_source==null && orderItems.length && !deliveryItems.length) && item.catalog_present!==true)){
        unavailable.add(sku);continue;
      }
      const prior=missing.get(sku);
      if(prior)prior.quantity+=Number(item.quantity||0);
      else missing.set(sku,{sku,name:item.name||null,quantity:Number(item.quantity||0)});
    }
    const orderIdentified=orderItems.length>0 && orderItems.every(item=>item.sku&&Number(item.quantity)>0);
    const deliveryIdentified=deliveryItems.length>0 && deliveryItems.every(item=>item.sku&&Number(item.quantity)>0);
    const financialIdentified=financialItems.length>0 && financialItems.every(item=>item.sku&&Number(item.quantity)>0);
    return {...row,
      first_sku:display?.sku||row.first_sku||null,
      first_product:display?.name||row.first_product||null,
      identity_state:row.item_source==='financial'&&financialIdentified?"financial_only":
        orderIdentified?"identified":deliveryIdentified?"delivery_only":"unavailable",
      missing_cost_skus:[...missing.values()],unavailable_cost_skus:[...unavailable]};
  });
}
module.exports={enrichMarginRows};
