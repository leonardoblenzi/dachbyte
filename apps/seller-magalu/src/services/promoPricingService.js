"use strict";
// Precificacao promocional Magalu. Valores em centavos e taxas em pontos-base (1% = 100).
//
// Sem Pix: preco minimo = (custo + tarifa + frete) / (1 - imposto - comissao - margem).
// Com Pix: o cliente paga o preco anunciado com desconto Pix; o seller banca a parte dele
// (ex.: 7% de 15%) e recebe R = anunciado x (1 - parte do seller). Comissao e imposto incidem
// sobre R e a margem no Pix e calculada sobre R. O preco fica com a maior exigencia
// (margem sem Pix e margem no Pix) e e arredondado:
//   - "com_datas": preco anunciado terminado em R$ 9,90;
//   - "sem_datas": preco final no Pix terminado em R$ 9,99 (anunciado = Pix / (1 - desconto)).
function numeric(value,min,max){if(value===null||value===undefined||String(value).trim()==="")return null;const n=Number(value);return Number.isFinite(n)&&n>=min&&n<=max?n:null;}
function money(value){const n=numeric(value,0,10000000);return n===null?null:Math.round((n+Number.EPSILON)*100);}
function rate(value){const n=numeric(value,0,100);return n===null?null:Math.round((n+Number.EPSILON)*100);}
const PIX_MODES=["sem_datas","com_datas"];
function pixMode(value){return PIX_MODES.includes(String(value||""))?String(value):"";}
// Menor valor >= cents cujos centavos finais (mod R$ 10) sejam `ending` (990 = 9,90; 999 = 9,99).
function endingAtLeast(cents,ending){let value=Math.floor(cents/1000)*1000+ending;if(value<cents)value+=1000;return value;}
// Preco anunciado cujo valor com desconto Pix (arredondado) da exatamente pixCents.
function listForPix(pixCents,discount,minimum){
  const exact=pixCents*10000/(10000-discount);
  const candidates=[Math.floor(exact),Math.ceil(exact),Math.ceil(exact)+1].filter(value=>value>=minimum);
  return candidates.find(value=>Math.round(value*(10000-discount)/10000)===pixCents)??Math.max(Math.ceil(exact),minimum);
}
function marginOn(receivable,base,tax,commission){return receivable>0?Math.round(((receivable-base)/receivable*10000-tax-commission))/100:null;}

function evaluate(row,global,override={}){
  const terms={...global,...Object.fromEntries(Object.entries(override).filter(([key])=>key!=="price"))};
  const issues=[],cost=money(row.unit_cost),full=money(row.list_price),current=money(row.price);
  const tax=rate(row.tax_rate),commission=rate(terms.commission_rate),margin=rate(terms.target_margin),fee=money(terms.fixed_fee),shipping=money(terms.shipping);
  const mode=pixMode(terms.pix_mode),pixDiscount=rate(terms.pix_discount),pixShare=rate(terms.pix_seller_share),pixMargin=rate(terms.pix_margin);
  if(row.status!=="PUBLISHED"||row.active!==true)issues.push("SKU não está publicado e ativo");
  if(cost===null)issues.push("Custo ausente");
  if(tax===null)issues.push("Imposto ausente");
  if(commission===null)issues.push("Comissão não informada");
  if(margin===null)issues.push("Margem alvo não informada");
  if(fee===null)issues.push("Tarifa fixa não informada");
  if(shipping===null)issues.push("Frete estimado não informado");
  if(mode){
    if(pixDiscount===null||pixDiscount<=0||pixDiscount>=10000)issues.push("Desconto Pix não informado");
    if(pixShare===null)issues.push("Participação no Pix não informada");
    if(pixMargin===null)issues.push("Margem no Pix não informada");
    if(pixShare!==null&&pixDiscount!==null&&pixShare>pixDiscount)issues.push("Participação no Pix maior que o desconto");
  }
  if(!row.price_present||current===null||current<=0||row.price_error)issues.push("Preço atual indisponível");
  if(full===null||full<=0)issues.push("Preço cheio indisponível");
  const age=Date.now()-new Date(row.price_synced_at||0).getTime();
  if(!Number.isFinite(age)||age>24*60*60*1000||age<0)issues.push("Leitura de preço antiga ou ausente");
  const denominator=tax===null||commission===null||margin===null?null:10000-tax-commission-margin;
  if(denominator!==null&&denominator<=0)issues.push("Soma de imposto, comissão e margem inviável");
  const pixDenominator=mode&&tax!==null&&commission!==null&&pixMargin!==null?10000-tax-commission-pixMargin:null;
  if(pixDenominator!==null&&pixDenominator<=0)issues.push("Soma de imposto, comissão e margem no Pix inviável");
  const pixReady=Boolean(mode)&&pixDenominator>0&&pixDiscount!==null&&pixDiscount>0&&pixDiscount<10000&&pixShare!==null&&pixShare<=pixDiscount;
  let floor=null,suggested=null,estimated=null,discount=null,pixPrice=null,pixMarginResult=null,pixReceivable=null;
  if([cost,fee,shipping,denominator].every(v=>v!==null)&&denominator>0){
    const base=cost+fee+shipping;
    floor=Math.ceil(base*10000/denominator);
    let rounded=floor,roundedPix=null;
    if(pixReady){
      const receivableMin=Math.ceil(base*10000/pixDenominator);
      floor=Math.max(floor,Math.ceil(receivableMin*10000/(10000-pixShare)));
      if(mode==="com_datas")rounded=endingAtLeast(floor,990);
      else{roundedPix=endingAtLeast(Math.ceil(floor*(10000-pixDiscount)/10000),999);rounded=listForPix(roundedPix,pixDiscount,floor);}
    }
    const edited=Object.prototype.hasOwnProperty.call(override,"price")?money(override.price):null;
    if(Object.prototype.hasOwnProperty.call(override,"price")&&edited===null)issues.push("Preço ajustado inválido");
    suggested=edited===null?rounded:edited;
    if(suggested<floor)issues.push(pixReady?"Preço abaixo do mínimo para as margens com e sem Pix":"Preço abaixo do mínimo para a margem alvo");
    if(suggested<=0)issues.push("Preço promocional inválido");
    if(full!==null&&suggested>=full)issues.push("Sem desconto sobre o preço cheio");
    if(suggested>0){
      estimated=Math.round(((suggested-cost-fee-shipping)/suggested*10000-tax-commission))/100;
      discount=full===null?null:Math.round((1-suggested/full)*10000)/100;
      if(pixReady){
        pixPrice=edited===null&&roundedPix!==null?roundedPix:Math.round(suggested*(10000-pixDiscount)/10000);
        const receivable=suggested*(10000-pixShare)/10000;
        pixReceivable=Math.round(receivable);
        pixMarginResult=marginOn(receivable,base,tax,commission);
      }
    }
  }
  return{sku:row.sku,suggested_price:suggested===null?null:suggested/100,minimum_price:floor===null?null:floor/100,estimated_margin:estimated,discount_pct:discount,
    pix_mode:mode||null,pix_price:pixPrice===null?null:pixPrice/100,pix_receivable:pixReceivable===null?null:pixReceivable/100,pix_margin:pixMarginResult,
    eligible:issues.length===0,issues};
}
// Parâmetros gerais sem os quais nenhum SKU pode ser elegível (evita rodar o recorte inteiro à toa).
const REQUIRED_TERMS=[["commission_rate","Comissão estimada"],["target_margin","Margem sem Pix"],["fixed_fee","Tarifa fixa"],["shipping","Frete estimado"]];
const REQUIRED_PIX_TERMS=[["pix_discount","Desconto Pix ao cliente"],["pix_seller_share","Sua parte no desconto"],["pix_margin","Margem no Pix"]];
function missingTerms(terms={}){
  const empty=([key])=>terms[key]==null||String(terms[key]).trim()==="";
  const missing=REQUIRED_TERMS.filter(empty);
  if(pixMode(terms.pix_mode))missing.push(...REQUIRED_PIX_TERMS.filter(empty));
  return missing.map(([key,label])=>({key,label}));
}
module.exports={evaluate,missingTerms,PIX_MODES,_test:{endingAtLeast,listForPix}};
