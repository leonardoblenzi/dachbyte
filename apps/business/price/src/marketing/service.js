"use strict";

const { withTenant } = require("../db");
const { audit } = require("../audit");
const { redactForStorage } = require("../redact");
const { calculateKpis, aggregateMetrics, marketingAlerts, number } = require("./metrics");

const CHANNELS=new Set(["meli_ads","shopee_ads","meta_ads","google_ads","tiktok_ads","manual"]);
const COST_TYPES=new Set(["ads","seller_coupon","marketplace_coupon","coins","affiliate","promotion"]);
function clean(value,max=500){return String(value??"").trim().slice(0,max);}
function channel(value){const result=clean(value,40);if(!CHANNELS.has(result))throw Object.assign(new Error("Canal de marketing invalido."),{statusCode:400});return result;}
function positive(value,label="Valor"){const result=number(value);if(result<0)throw Object.assign(new Error(`${label} nao pode ser negativo.`),{statusCode:400});return result;}
async function log(client,auth,request,action,type,id,metadata={}){await audit(client,{tenantId:auth.tenantId,actorUserId:auth.userId,action,resourceType:type,resourceId:String(id),metadata:redactForStorage(metadata),ip:request?.ip,userAgent:request?.get?.("user-agent")});}
async function ensureVisible(client,table,id,label){if(!id)return null;const allowed=new Set(["integration_connections","marketing_sources","ad_campaigns","orders","products"]);if(!allowed.has(table))throw new Error("Tabela de validacao invalida.");const row=(await client.query(`SELECT * FROM volt_price.${table} WHERE id=$1`,[id])).rows[0];if(!row)throw Object.assign(new Error(`${label} nao encontrado neste tenant.`),{statusCode:404});return row;}

async function marketingOverview(auth,query={}){
  return withTenant(auth.tenantId,auth.userId,async(client)=>{
    const from=clean(query.from,10)||new Date(Date.now()-30*86400000).toISOString().slice(0,10);
    const to=clean(query.to,10)||new Date().toISOString().slice(0,10);
    const [metrics,sources,campaigns,costs,promotions,affiliates,orders,profit]=await Promise.all([
      client.query(`SELECT m.*,c.name campaign_name FROM volt_price.ads_metrics m LEFT JOIN volt_price.ad_campaigns c ON c.id=m.campaign_id WHERE m.is_current AND m.metric_date BETWEEN $1::date AND $2::date ORDER BY m.metric_date DESC,m.updated_at DESC LIMIT 2000`,[from,to]),
      client.query("SELECT * FROM volt_price.marketing_sources ORDER BY channel,display_name"),
      client.query("SELECT * FROM volt_price.ad_campaigns ORDER BY updated_at DESC LIMIT 500"),
      client.query(`SELECT c.*,o.source_order_id FROM volt_price.order_marketing_costs c JOIN volt_price.orders o ON o.id=c.order_id WHERE c.created_at::date BETWEEN $1::date AND $2::date ORDER BY c.created_at DESC LIMIT 500`,[from,to]),
      client.query(`SELECT * FROM volt_price.promotions WHERE created_at::date BETWEEN $1::date AND $2::date ORDER BY created_at DESC LIMIT 300`,[from,to]),
      client.query(`SELECT * FROM volt_price.affiliate_attributions WHERE attribution_date BETWEEN $1::date AND $2::date ORDER BY attribution_date DESC LIMIT 300`,[from,to]),
      client.query(`SELECT coalesce(sum(total_amount),0)::numeric gmv FROM volt_price.orders WHERE order_date BETWEEN $1::date AND $2::date`,[from,to]),
      client.query(`SELECT count(*)::int snapshot_count,sum(contribution_amount+ads_amount)::numeric contribution_before_ads FROM (SELECT DISTINCT ON(order_id) * FROM volt_price.profit_snapshots WHERE order_id IS NOT NULL AND calculated_at::date BETWEEN $1::date AND $2::date ORDER BY order_id,version DESC) p`,[from,to]),
    ]);
    const gmv=number(orders.rows[0]?.gmv);const contributionBeforeAds=profit.rows[0]?.snapshot_count>0?number(profit.rows[0]?.contribution_before_ads):null;
    const grouped=new Map();
    for(const row of metrics.rows){const key=row.channel||"manual";if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(row);}
    const byChannel=[...grouped].map(([key,rows])=>({channel:key,kpis:aggregateMetrics(rows,gmv,contributionBeforeAds)}));
    const totals=aggregateMetrics(metrics.rows,gmv,contributionBeforeAds);
    return {period:{from,to},metrics:metrics.rows,sources:sources.rows,campaigns:campaigns.rows,costs:costs.rows,promotions:promotions.rows,affiliates:affiliates.rows,
      totals:{...totals,gmv,contributionBeforeAds},byChannel,alerts:marketingAlerts(byChannel)};
  });
}

async function upsertSource(auth,input={},request=null){
  const selected=channel(input.channel);const account=clean(input.externalAccountId,200)||"default";const name=clean(input.displayName,200);
  if(!name)throw Object.assign(new Error("Nome da fonte e obrigatorio."),{statusCode:400});
  return withTenant(auth.tenantId,auth.userId,async(client)=>{if(input.connectionId)await ensureVisible(client,"integration_connections",input.connectionId,"Conexao");const row=(await client.query(`INSERT INTO volt_price.marketing_sources(tenant_id,channel,connection_id,external_account_id,display_name,auth_mode,status,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(tenant_id,channel,external_account_id) DO UPDATE SET connection_id=EXCLUDED.connection_id,display_name=EXCLUDED.display_name,auth_mode=EXCLUDED.auth_mode,status=EXCLUDED.status,metadata=volt_price.marketing_sources.metadata||EXCLUDED.metadata,updated_at=now() RETURNING *`,
    [auth.tenantId,selected,input.connectionId||null,account,name,clean(input.authMode,30)||"import",clean(input.status,30)||"active",JSON.stringify(redactForStorage(input.metadata||{}))])).rows[0];await log(client,auth,request,"marketing.source.upsert","marketing_source",row.id,{channel:selected,account});return row;});
}

async function importMetrics(auth,input={},request=null){
  const rows=Array.isArray(input.metrics)?input.metrics:[input];if(!rows.length)throw Object.assign(new Error("Informe ao menos uma metrica."),{statusCode:400});
  return withTenant(auth.tenantId,auth.userId,async(client)=>{const imported=[];
    for(const item of rows){const selected=channel(item.channel||input.channel);const metricDate=clean(item.metricDate||item.metric_date,10);const sourceRef=clean(item.sourceRef||item.source_ref,300);
      if(!metricDate||!sourceRef)throw Object.assign(new Error("metricDate e sourceRef sao obrigatorios para importacao idempotente."),{statusCode:400});
      if(item.sourceId){const source=await ensureVisible(client,"marketing_sources",item.sourceId,"Fonte");if(source.channel!==selected)throw Object.assign(new Error("Canal da metrica difere do canal da fonte."),{statusCode:400});}
      let campaignId=item.campaignId||null;const externalCampaignId=clean(item.externalCampaignId,200)||null;
      if(item.sourceId&&externalCampaignId){const campaign=(await client.query(`INSERT INTO volt_price.ad_campaigns(tenant_id,source_id,external_campaign_id,name,status,currency,metadata) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
        ON CONFLICT(tenant_id,source_id,external_campaign_id) DO UPDATE SET name=EXCLUDED.name,status=EXCLUDED.status,metadata=volt_price.ad_campaigns.metadata||EXCLUDED.metadata,updated_at=now() RETURNING id`,
        [auth.tenantId,item.sourceId,externalCampaignId,clean(item.campaignName,300)||externalCampaignId,clean(item.campaignStatus,40)||null,clean(item.currency,10)||"BRL",JSON.stringify(redactForStorage(item.campaignMetadata||{}))])).rows[0];campaignId=campaign.id;}
      if(campaignId&&!externalCampaignId)await ensureVisible(client,"ad_campaigns",campaignId,"Campanha");
      if(item.productId)await ensureVisible(client,"products",item.productId,"Produto");
      const current=(await client.query("SELECT * FROM volt_price.ads_metrics WHERE channel=$1 AND source_ref=$2 AND is_current FOR UPDATE",[selected,sourceRef])).rows[0];
      const normalized={spend:positive(item.spend,"Spend"),revenue:positive(item.attributedRevenue??item.revenue,"Receita atribuida"),orders:positive(item.attributedOrders??item.orders,"Pedidos atribuidos"),impressions:Math.trunc(positive(item.impressions,"Impressoes")),clicks:Math.trunc(positive(item.clicks,"Cliques")),conversions:positive(item.conversions??item.attributedOrders??item.orders,"Conversoes")};
      const fingerprint=JSON.stringify([metricDate,campaignId,externalCampaignId,...Object.values(normalized)]);
      if(current?.payload?.fingerprint===fingerprint){imported.push({...current,unchanged:true});continue;}
      if(current)await client.query("UPDATE volt_price.ads_metrics SET is_current=false,updated_at=now() WHERE id=$1",[current.id]);
      const row=(await client.query(`INSERT INTO volt_price.ads_metrics(tenant_id,source_id,campaign_id,channel,metric_date,external_campaign_id,product_id,spend,revenue,orders,impressions,clicks,conversions,attributed_revenue,attributed_orders,currency,source_type,source_ref,source_updated_at,version,is_current,payload)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$9,$10,$14,$15,$16,$17,$18,true,$19::jsonb) RETURNING *`,
        [auth.tenantId,item.sourceId||null,campaignId,selected,metricDate,externalCampaignId,item.productId||null,normalized.spend,normalized.revenue,normalized.orders,normalized.impressions,normalized.clicks,normalized.conversions,clean(item.currency,10)||"BRL",clean(item.sourceType,20)||"IMPORT",sourceRef,item.sourceUpdatedAt||null,Number(current?.version||0)+1,JSON.stringify(redactForStorage({...item.payload,fingerprint}))])).rows[0];imported.push(row);
    }await log(client,auth,request,"marketing.metrics.import","ads_metric",imported[0]?.id,{count:imported.length});return imported;});
}

async function createOrderCost(auth,input={},request=null){
  const type=clean(input.costType,40);if(!COST_TYPES.has(type))throw Object.assign(new Error("Tipo de custo de marketing invalido."),{statusCode:400});
  if(!input.orderId)throw Object.assign(new Error("Pedido e obrigatorio."),{statusCode:400});const value=positive(input.amount);
  return withTenant(auth.tenantId,auth.userId,async(client)=>{await ensureVisible(client,"orders",input.orderId,"Pedido");if(input.productId)await ensureVisible(client,"products",input.productId,"Produto");if(input.campaignId)await ensureVisible(client,"ad_campaigns",input.campaignId,"Campanha");const row=(await client.query(`INSERT INTO volt_price.order_marketing_costs(tenant_id,order_id,product_id,campaign_id,cost_type,amount,funded_by,source_type,source_ref,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT(tenant_id,order_id,cost_type,source_ref) WHERE source_ref IS NOT NULL DO UPDATE SET amount=EXCLUDED.amount,funded_by=EXCLUDED.funded_by,metadata=EXCLUDED.metadata,updated_at=now() RETURNING *`,
    [auth.tenantId,input.orderId,input.productId||null,input.campaignId||null,type,value,clean(input.fundedBy,20)||"seller",clean(input.sourceType,20)||"MANUAL",clean(input.sourceRef,300)||null,JSON.stringify(redactForStorage(input.metadata||{}))])).rows[0];await log(client,auth,request,"marketing.order_cost.upsert","order_marketing_cost",row.id,{orderId:input.orderId,type,value});return row;});
}

async function createPromotion(auth,input={},request=null){
  const selected=clean(input.channel,40);const seller=positive(input.sellerFundedAmount);const marketplace=positive(input.marketplaceFundedAmount);const coins=positive(input.coinsAmount);
  return withTenant(auth.tenantId,auth.userId,async(client)=>{if(input.orderId)await ensureVisible(client,"orders",input.orderId,"Pedido");if(input.productId)await ensureVisible(client,"products",input.productId,"Produto");const row=(await client.query(`INSERT INTO volt_price.promotions(tenant_id,order_id,product_id,channel,external_promotion_id,promotion_type,code,seller_funded_amount,marketplace_funded_amount,coins_amount,starts_at,ends_at,status,source_type,source_ref,payload)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb) ON CONFLICT(tenant_id,channel,source_ref) WHERE source_ref IS NOT NULL DO UPDATE SET seller_funded_amount=EXCLUDED.seller_funded_amount,marketplace_funded_amount=EXCLUDED.marketplace_funded_amount,coins_amount=EXCLUDED.coins_amount,status=EXCLUDED.status,payload=EXCLUDED.payload,updated_at=now() RETURNING *`,
    [auth.tenantId,input.orderId||null,input.productId||null,selected,clean(input.externalPromotionId,200)||null,clean(input.promotionType,80)||"coupon",clean(input.code,100)||null,seller,marketplace,coins,input.startsAt||null,input.endsAt||null,clean(input.status,30)||"active",clean(input.sourceType,20)||"MANUAL",clean(input.sourceRef,300)||null,JSON.stringify(redactForStorage(input.payload||{}))])).rows[0];
    if(input.orderId&&seller+coins>0)await client.query(`INSERT INTO volt_price.order_marketing_costs(tenant_id,order_id,product_id,cost_type,amount,funded_by,source_type,source_ref,metadata) VALUES($1,$2,$3,$4,$5,'seller',$6,$7,$8::jsonb) ON CONFLICT(tenant_id,order_id,cost_type,source_ref) WHERE source_ref IS NOT NULL DO UPDATE SET amount=EXCLUDED.amount,updated_at=now()`,[auth.tenantId,input.orderId,input.productId||null,coins>0?"coins":"seller_coupon",seller+coins,clean(input.sourceType,20)||"MANUAL",`promotion:${row.id}`,JSON.stringify({promotionId:row.id})]);
    await log(client,auth,request,"marketing.promotion.upsert","promotion",row.id,{seller,marketplace,coins});return row;});
}

async function createAffiliate(auth,input={},request=null){
  const commission=positive(input.commissionAmount);if(!input.attributionDate)throw Object.assign(new Error("Data de atribuicao e obrigatoria."),{statusCode:400});
  return withTenant(auth.tenantId,auth.userId,async(client)=>{if(input.orderId)await ensureVisible(client,"orders",input.orderId,"Pedido");if(input.productId)await ensureVisible(client,"products",input.productId,"Produto");const row=(await client.query(`INSERT INTO volt_price.affiliate_attributions(tenant_id,order_id,product_id,channel,external_attribution_id,affiliate_name,campaign_name,commission_amount,attributed_revenue,attribution_date,source_type,source_ref,payload)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) ON CONFLICT(tenant_id,channel,source_ref) WHERE source_ref IS NOT NULL DO UPDATE SET commission_amount=EXCLUDED.commission_amount,attributed_revenue=EXCLUDED.attributed_revenue,payload=EXCLUDED.payload,updated_at=now() RETURNING *`,
    [auth.tenantId,input.orderId||null,input.productId||null,clean(input.channel,40),clean(input.externalAttributionId,200)||null,clean(input.affiliateName,200)||null,clean(input.campaignName,200)||null,commission,positive(input.attributedRevenue),input.attributionDate,clean(input.sourceType,20)||"MANUAL",clean(input.sourceRef,300)||null,JSON.stringify(redactForStorage(input.payload||{}))])).rows[0];
    if(input.orderId&&commission>0)await client.query(`INSERT INTO volt_price.order_marketing_costs(tenant_id,order_id,product_id,cost_type,amount,funded_by,source_type,source_ref,metadata) VALUES($1,$2,$3,'affiliate',$4,'seller',$5,$6,$7::jsonb) ON CONFLICT(tenant_id,order_id,cost_type,source_ref) WHERE source_ref IS NOT NULL DO UPDATE SET amount=EXCLUDED.amount,updated_at=now()`,[auth.tenantId,input.orderId,input.productId||null,commission,clean(input.sourceType,20)||"MANUAL",`affiliate:${row.id}`,JSON.stringify({attributionId:row.id})]);
    await log(client,auth,request,"marketing.affiliate.upsert","affiliate_attribution",row.id,{commission});return row;});
}

module.exports={marketingOverview,upsertSource,importMetrics,createOrderCost,createPromotion,createAffiliate};
