"use strict";

function enrichMarginRows(rows,itemRows,deliveryRows){
  const itemsByOrder=new Map(),deliveriesByOrder=new Map();
  for(const item of itemRows||[]){
    const key=Number(item.order_id);
    if(!itemsByOrder.has(key))itemsByOrder.set(key,[]);
    itemsByOrder.get(key).push(item);
  }
  for(const item of deliveryRows||[]){
    const key=Number(item.order_id);
    if(!deliveriesByOrder.has(key))deliveriesByOrder.set(key,[]);
    deliveriesByOrder.get(key).push(item);
  }
  return rows.map(row=>{
    const items=itemsByOrder.get(Number(row.id))||[];
    const deliveryItems=deliveriesByOrder.get(Number(row.id))||[];
    const confirmed=items.find(item=>item.sku);
    const display=confirmed||items.find(item=>item.name)||deliveryItems.find(item=>item.sku||item.name);
    const missing=new Map(),unavailable=new Set();
    for(const item of items){
      const sku=String(item.sku||"").trim();
      if(!sku||item.unit_cost!=null)continue;
      if(item.catalog_present===false){unavailable.add(sku);continue;}
      const prior=missing.get(sku);
      if(prior)prior.quantity+=Number(item.quantity||0);
      else missing.set(sku,{sku,name:item.name||null,quantity:Number(item.quantity||0)});
    }
    return {...row,
      first_sku:display?.sku||row.first_sku||null,
      first_product:display?.name||row.first_product||null,
      identity_state:confirmed?"identified":deliveryItems.some(item=>item.sku)?"delivery_only":"unavailable",
      missing_cost_skus:[...missing.values()],unavailable_cost_skus:[...unavailable]};
  });
}

module.exports={enrichMarginRows};
