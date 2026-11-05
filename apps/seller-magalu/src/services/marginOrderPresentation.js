"use strict";

function enrichMarginRows(rows,itemRows,deliveryRows){
  const byOrder=items=>{
    const map=new Map();
    for(const item of items||[]){
      const key=Number(item.order_id);
      if(!map.has(key))map.set(key,[]);
      map.get(key).push(item);
    }
    return map;
  };
  const itemsByOrder=byOrder(itemRows),deliveriesByOrder=byOrder(deliveryRows);
  return rows.map(row=>{
    const orderItems=itemsByOrder.get(Number(row.id))||[];
    const deliveryItems=deliveriesByOrder.get(Number(row.id))||[];
    const ownComplete=orderItems.length>0 && orderItems.every(item=>item.sku&&Number(item.quantity)>0
      && (item.amount_total!=null || item.unit_price!=null) && Number(item.amount_normalizer)>0);
    const actual=ownComplete?orderItems:(deliveryItems.length?deliveryItems:orderItems);
    const identified=actual.find(item=>item.sku);
    const display=identified||actual.find(item=>item.name)||deliveryItems.find(item=>item.sku||item.name);
    const missing=new Map(), unavailable=new Set();
    for(const item of actual){
      const sku=String(item.sku||"").trim();
      if(!sku || item.unit_cost!=null)continue;
      if(item.catalog_present===false){unavailable.add(sku);continue;}
      const prior=missing.get(sku);
      if(prior)prior.quantity+=Number(item.quantity||0);
      else missing.set(sku,{sku,name:item.name||null,quantity:Number(item.quantity||0)});
    }
    const orderIdentified=orderItems.length>0 && orderItems.every(item=>item.sku&&Number(item.quantity)>0);
    const deliveryIdentified=deliveryItems.length>0 && deliveryItems.every(item=>item.sku&&Number(item.quantity)>0);
    return {...row,
      first_sku:display?.sku||row.first_sku||null,
      first_product:display?.name||row.first_product||null,
      identity_state:orderIdentified?"identified":deliveryIdentified?"delivery_only":"unavailable",
      missing_cost_skus:[...missing.values()],unavailable_cost_skus:[...unavailable]};
  });
}
module.exports={enrichMarginRows};
