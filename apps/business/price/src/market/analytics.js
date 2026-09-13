"use strict";

function finite(value) { const result=Number(value);return Number.isFinite(result)?result:null; }
function round(value,scale=4){const factor=10**scale;return Math.round((Number(value)+Number.EPSILON)*factor)/factor;}
function normalize(value){return String(value??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();}
function identifier(value){return normalize(value).replace(/\s+/g,"");}
function productValue(product,key){return product?.[key]??product?.metadata?.[key]??null;}
function titleSimilarity(left,right){const a=new Set(normalize(left).split(" ").filter((token)=>token.length>1));const b=new Set(normalize(right).split(" ").filter((token)=>token.length>1));if(!a.size||!b.size)return 0;const intersection=[...a].filter((token)=>b.has(token)).length;return round(intersection/new Set([...a,...b]).size);}

function matchListing(listing={},products=[]){
  const gtin=identifier(listing.gtin||listing.ean);const exactGtin=gtin?products.filter((product)=>identifier(productValue(product,"gtin")||productValue(product,"ean"))===gtin):[];
  if(exactGtin.length>1)return {status:"review",productId:null,confidence:1,reason:"ambiguous_exact_gtin"};
  if(exactGtin.length===1)return {status:"matched",productId:exactGtin[0].id,confidence:1,reason:"exact_gtin"};
  const brand=normalize(listing.brand);const mpn=identifier(listing.mpn);
  const exactBrandMpn=brand&&mpn?products.filter((product)=>normalize(productValue(product,"brand"))===brand&&identifier(productValue(product,"mpn"))===mpn):[];
  if(exactBrandMpn.length>1)return {status:"review",productId:null,confidence:.98,reason:"ambiguous_brand_mpn"};
  if(exactBrandMpn.length===1)return {status:"matched",productId:exactBrandMpn[0].id,confidence:.98,reason:"exact_brand_mpn"};
  const ranked=products.map((product)=>({product,confidence:titleSimilarity(listing.title,product.name)})).sort((a,b)=>b.confidence-a.confidence);
  if(ranked[0]?.confidence>=.7){if(ranked[1]&&ranked[0].confidence-ranked[1].confidence<.08)return {status:"review",productId:null,confidence:ranked[0].confidence,reason:"ambiguous_title_similarity"};return {status:"review",productId:ranked[0].product.id,confidence:ranked[0].confidence,reason:"title_similarity_requires_review"};}
  return {status:"unmatched",productId:null,confidence:ranked[0]?.confidence||0,reason:"insufficient_evidence"};
}

function percentile(sorted,p){if(!sorted.length)return null;const index=(sorted.length-1)*p;const lower=Math.floor(index);const upper=Math.ceil(index);if(lower===upper)return sorted[lower];return round(sorted[lower]+(sorted[upper]-sorted[lower])*(index-lower),2);}
function marketRange(values=[],ownPrice=null){const sorted=values.map(finite).filter((value)=>value!==null&&value>=0).sort((a,b)=>a-b);if(!sorted.length)return {count:0,minimum:null,p25:null,median:null,p75:null,maximum:null,ownVsMedian:null,position:"insufficient_data"};const median=percentile(sorted,.5);const own=finite(ownPrice);const ownVsMedian=own===null||median<=0?null:round((own-median)/median);const position=ownVsMedian===null?"unknown":ownVsMedian>.05?"above_market":ownVsMedian<-.05?"below_market":"at_market";return {count:sorted.length,minimum:sorted[0],p25:percentile(sorted,.25),median,p75:percentile(sorted,.75),maximum:sorted.at(-1),ownVsMedian,position};}

function detectListingSignals(previous,current,threshold=.05){if(!previous)return [{type:"new_listing",severity:"info"}];const signals=[];if(previous.available&&!current.available)signals.push({type:"out_of_stock",severity:"opportunity"});if(!previous.available&&current.available)signals.push({type:"back_in_stock",severity:"info"});const before=finite(previous.price);const after=finite(current.price);if(before>0&&after!==null){const change=round((after-before)/before);if(change<=-Math.abs(threshold))signals.push({type:"price_drop",severity:"warning",change});else if(change>=Math.abs(threshold))signals.push({type:"price_increase",severity:"info",change});}return signals;}

function summarizeProductMarket(listings=[],ownPrice=null){const available=listings.filter((listing)=>Boolean(listing.available));return {availableCompetitors:available.length,outOfStock:listings.length-available.length,range:marketRange(available.map((listing)=>listing.observed_price??listing.price),ownPrice)};}
function missingFromCompleteSnapshot(existing=[],seenIds=[],complete=false){if(!complete)return [];const seen=new Set(seenIds.map(String));return existing.filter((listing)=>listing.available&&!seen.has(String(listing.external_listing_id)));}

module.exports = { matchListing, marketRange, detectListingSignals, summarizeProductMarket, missingFromCompleteSnapshot };
