"use strict";
const {randomUUID}=require("node:crypto");
const db=require("../config/postgres");
const prices=require("./promoPriceRepository");
const pricing=require("../services/promoPricingService");
function invalid(message,status=422){const e=new Error(message);e.status=status;return e;}
function sourceUnchanged(source,current){
  if(!current?.sku)return false;
  for(const key of ["price","list_price","unit_cost","tax_rate"]){const left=source[key]==null?null:Number(source[key]),right=current[key]==null?null:Number(current[key]);if(left!==right)return false;}
  for(const key of ["status","active","price_present","price_error"]){if((source[key]??null)!==(current[key]??null))return false;}
  return new Date(source.price_synced_at||0).getTime()===new Date(current.price_synced_at||0).getTime();
}
// Percentuais (margens, comissao e Pix) vao ate 100; valores em reais ate 10 milhoes.
const PERCENT_FIELDS=new Set(["target_margin","commission_rate","pix_discount","pix_seller_share","pix_margin"]);
function validateTerms(input){const fields=["target_margin","commission_rate","fixed_fee","shipping","pix_discount","pix_seller_share","pix_margin"],terms={};for(const field of fields){const value=input?.[field];if(value==null||String(value).trim()===""){terms[field]="";continue;}const n=Number(value);if(!Number.isFinite(n)||n<0||n>(PERCENT_FIELDS.has(field)?100:10000000)||!/^(?:\d+)(?:\.\d{1,2})?$/.test(String(value)))throw invalid(`${field}: informe um valor válido com até duas casas decimais.`);terms[field]=String(value);}
  const mode=String(input?.pix_mode??"").trim();if(mode&&!pricing.PIX_MODES.includes(mode))throw invalid("pix_mode: modo de preço Pix inválido.");terms.pix_mode=mode;return terms;}
async function createBatched(identity,filters,termsInput,{onProgress=async()=>{}}={},deps={}){
  const terms=validateTerms(termsInput),count=deps.count||prices.count,page=deps.page||prices.detailsPage,query=deps.query||db.query;
  const total=await count(identity.accountId,filters),id=randomUUID();
  if(!total)throw invalid("Nenhum SKU no recorte.",409);
  await query(`insert into magalu.promo_pricing_previews(id,account_id,dach_tenant_id,dach_user_id,filters,terms,total_count) values($1,$2,$3,$4,$5::jsonb,$6::jsonb,0)`,[id,identity.accountId,identity.tenantId,identity.userId,JSON.stringify(filters||{}),JSON.stringify(terms)]);
  let processed=0,eligible=0,after=null;
  try{
    while(true){
      const rows=await page(identity.accountId,filters,after,1000);
      if(!rows.length)break;
      const payload=rows.map(row=>({sku:row.sku,source:row,result:pricing.evaluate(row,terms)}));
      await query(`insert into magalu.promo_pricing_preview_rows(preview_id,sku,source,result) select $1,x->>'sku',x->'source',x->'result' from jsonb_array_elements($2::jsonb) x on conflict (preview_id,sku) do nothing`,[id,JSON.stringify(payload)]);
      processed+=rows.length;eligible+=payload.filter(item=>item.result.eligible).length;after=rows.at(-1).sku;
      await onProgress({total,processed,eligible,excluded:processed-eligible});
    }
    await query(`update magalu.promo_pricing_previews set total_count=$2 where id=$1`,[id,processed]);
    return{id,total:processed,eligible,excluded:processed-eligible};
  }catch(error){await query(`delete from magalu.promo_pricing_previews where id=$1`,[id]).catch(()=>{});throw error;}
}
async function get(id,identity,client=db,locked=false){const {rows}=await client.query(`select * from magalu.promo_pricing_previews where id=$1 and account_id=$2 and dach_tenant_id=$3 and dach_user_id=$4 and expires_at>now()${locked?" for update":""}`,[id,identity.accountId,identity.tenantId,identity.userId]);return rows[0]||null;}
async function page(id,identity,pageInput=1){const preview=await get(id,identity);if(!preview)throw invalid("Prévia não encontrada ou expirada.",404);const page=Math.max(1,Math.floor(Number(pageInput)||1)),limit=50;const {rows}=await db.query(`select sku,source,terms_override,price_override,result from magalu.promo_pricing_preview_rows where preview_id=$1 order by sku limit $2 offset $3`,[id,limit,(page-1)*limit]);const count=await db.queryOne(`select count(*) filter(where result->>'eligible'='true')::int eligible from magalu.promo_pricing_preview_rows where preview_id=$1`,[id]);return{rows,total:preview.total_count,eligible:Number(count.eligible||0),excluded:preview.total_count-Number(count.eligible||0),page,limit,terms:preview.terms,created_at:preview.created_at};}
async function update(id,identity,sku,input){const hasPrice=Object.prototype.hasOwnProperty.call(input||{},"price");const price=hasPrice?input.price:null;if(hasPrice&&(price===null||String(price).trim()===""||!/^(?:\d+)(?:\.\d{1,2})?$/.test(String(price))||Number(price)>10000000))throw invalid("Preço ajustado inválido.");const overrides=validateTerms(input?.terms||{});
  return db.withClient(async client=>{await client.query("begin");try{const preview=await get(id,identity,client,true);if(!preview)throw invalid("Prévia não encontrada ou expirada.",404);const selected=await client.query(`select source from magalu.promo_pricing_preview_rows where preview_id=$1 and sku=$2 for update`,[id,sku]);if(!selected.rows.length)throw invalid("SKU não pertence à prévia.",404);const termsOverride=Object.fromEntries(Object.entries(overrides).filter(([,value])=>value!==""));const result=pricing.evaluate(selected.rows[0].source,preview.terms,{...termsOverride,...(hasPrice?{price}: {})});await client.query(`update magalu.promo_pricing_preview_rows set terms_override=$3::jsonb,price_override=$4,result=$5::jsonb where preview_id=$1 and sku=$2`,[id,sku,JSON.stringify(termsOverride),hasPrice?Number(price):null,JSON.stringify(result)]);await client.query("commit");return{sku,result,terms_override:termsOverride,price_override:hasPrice?Number(price):null};}catch(e){await client.query("rollback");throw e;}});
}
async function exportReview(id,identity,{allowPartial=false,allowEmpty=false}={}){
  const preview=await get(id,identity);if(!preview)throw invalid("Prévia não encontrada ou expirada.",404);
  const {rows}=await db.query(`select r.sku,r.source,r.terms_override,r.price_override,r.result,
    s.sku as current_sku,s.status,s.active,c.unit_cost,t.aliquota as tax_rate,
    p.price,p.list_price,p.last_synced_at as price_synced_at,p.last_error as price_error,p.is_present as price_present
    from magalu.promo_pricing_preview_rows r
    left join magalu.skus s on s.account_id=$2 and s.sku=r.sku and s.is_present=true
    left join magalu.prices p on p.account_id=s.account_id and p.sku=s.sku
    left join magalu.sku_costs c on c.account_id=s.account_id and c.sku=s.sku
    left join magalu.finance_settings t on t.account_id=s.account_id
    where r.preview_id=$1 order by r.sku`,[id,identity.accountId]);
  if(rows.length!==preview.total_count)throw invalid("A prévia mudou. Calcule novamente.",409);
  const accepted=[],excluded=[];
  for(const row of rows){
    const current={sku:row.current_sku,status:row.status,active:row.active,unit_cost:row.unit_cost,tax_rate:row.tax_rate,price:row.price,list_price:row.list_price,price_synced_at:row.price_synced_at,price_error:row.price_error,price_present:row.price_present};
    if(!sourceUnchanged(row.source,current))throw invalid("Dados de preço, custo ou imposto mudaram após a revisão. Calcule novamente.",409);
    const result=pricing.evaluate(row.source,preview.terms,{...(row.terms_override||{}),...(row.price_override==null?{}:{price:row.price_override})});
    if(result.eligible&&result.suggested_price===Number(row.result?.suggested_price))accepted.push({sku:row.sku,price:result.suggested_price});
    else excluded.push({sku:row.sku,reasons:result.issues.length?result.issues:["Prévia alterada; recalcule o SKU"]});
  }
  if(!accepted.length&&!allowEmpty)throw invalid("Nenhum SKU apto para exportação.",409);
  if(excluded.length&&allowPartial!==true)throw invalid(`${excluded.length} SKU(s) pendente(s). Confirme a exportação somente dos aptos.`,409);
  return{rows:accepted,eligible:accepted.length,excluded_count:excluded.length,excluded};
}
module.exports={createBatched,get,page,update,validateTerms,sourceUnchanged,exportReview};
