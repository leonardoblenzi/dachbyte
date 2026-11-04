"use strict";
function numeric(value,min,max){if(value===null||value===undefined||String(value).trim()==="")return null;const n=Number(value);return Number.isFinite(n)&&n>=min&&n<=max?n:null;}
function money(value){const n=numeric(value,0,10000000);return n===null?null:Math.round((n+Number.EPSILON)*100);}
function rate(value){const n=numeric(value,0,100);return n===null?null:Math.round((n+Number.EPSILON)*100);}
function evaluate(row,global,override={}){
  const terms={...global,...Object.fromEntries(Object.entries(override).filter(([key])=>key!=="price"))};
  const issues=[],cost=money(row.unit_cost),full=money(row.list_price),current=money(row.price);
  const tax=rate(row.tax_rate),commission=rate(terms.commission_rate),margin=rate(terms.target_margin),fee=money(terms.fixed_fee),shipping=money(terms.shipping);
  if(row.status!=="PUBLISHED"||row.active!==true)issues.push("SKU não está publicado e ativo");
  if(cost===null)issues.push("Custo ausente");
  if(tax===null)issues.push("Imposto ausente");
  if(commission===null)issues.push("Comissão não informada");
  if(margin===null)issues.push("Margem alvo não informada");
  if(fee===null)issues.push("Tarifa fixa não informada");
  if(shipping===null)issues.push("Frete estimado não informado");
  if(!row.price_present||current===null||current<=0||row.price_error)issues.push("Preço atual indisponível");
  if(full===null||full<=0)issues.push("Preço cheio indisponível");
  const age=Date.now()-new Date(row.price_synced_at||0).getTime();
  if(!Number.isFinite(age)||age>24*60*60*1000||age<0)issues.push("Leitura de preço antiga ou ausente");
  const denominator=tax===null||commission===null||margin===null?null:10000-tax-commission-margin;
  if(denominator!==null&&denominator<=0)issues.push("Soma de imposto, comissão e margem inviável");
  let floor=null,suggested=null,estimated=null,discount=null;
  if([cost,fee,shipping,denominator].every(v=>v!==null)&&denominator>0){
    floor=Math.ceil((cost+fee+shipping)*10000/denominator);
    const edited=Object.prototype.hasOwnProperty.call(override,"price")?money(override.price):null;
    if(Object.prototype.hasOwnProperty.call(override,"price")&&edited===null)issues.push("Preço ajustado inválido");
    suggested=edited===null?floor:edited;
    if(suggested<floor)issues.push("Preço abaixo do mínimo para a margem alvo");
    if(suggested<=0)issues.push("Preço promocional inválido");
    if(full!==null&&suggested>=full)issues.push("Sem desconto sobre o preço cheio");
    if(suggested>0){estimated=Math.round(((suggested-cost-fee-shipping)/suggested*10000-tax-commission))/100;discount=full===null?null:Math.round((1-suggested/full)*10000)/100;}
  }
  return{sku:row.sku,suggested_price:suggested===null?null:suggested/100,minimum_price:floor===null?null:floor/100,estimated_margin:estimated,discount_pct:discount,eligible:issues.length===0,issues};
}
module.exports={evaluate};
