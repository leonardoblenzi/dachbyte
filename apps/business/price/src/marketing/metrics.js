"use strict";

function number(value) { const result = Number(value || 0); return Number.isFinite(result) ? result : 0; }
function round(value, scale = 4) { const factor = 10 ** scale; return Math.round((number(value) + Number.EPSILON) * factor) / factor; }
function ratio(numerator, denominator) { return number(denominator) > 0 ? round(number(numerator) / number(denominator)) : null; }

function calculateKpis(input = {}, gmv = null, contributionBeforeAds = null) {
  const spend = number(input.spend); const revenue = number(input.attributedRevenue ?? input.revenue);
  const orders = number(input.attributedOrders ?? input.orders); const impressions = number(input.impressions);
  const clicks = number(input.clicks); const conversions = number(input.conversions || orders);
  const postAdsContribution = contributionBeforeAds === null ? null : round(number(contributionBeforeAds) - spend, 2);
  return { spend:round(spend,2), attributedRevenue:round(revenue,2), attributedOrders:round(orders), impressions, clicks, conversions,
    roas:ratio(revenue,spend), acos:ratio(spend,revenue), tacos:ratio(spend,gmv), cpc:ratio(spend,clicks), ctr:ratio(clicks,impressions),
    cvr:ratio(conversions,clicks), cac:ratio(spend,conversions), postAdsContribution,
    postAdsMargin:postAdsContribution === null ? null : ratio(postAdsContribution,gmv) };
}

function aggregateMetrics(rows = [], gmv = null, contributionBeforeAds = null) {
  const totals = rows.reduce((acc,row) => { for (const key of ["spend","impressions","clicks","conversions"]) acc[key]+=number(row[key]); acc.attributedRevenue+=number(row.attributed_revenue ?? row.revenue); acc.attributedOrders+=number(row.attributed_orders ?? row.orders); return acc; },
    { spend:0,attributedRevenue:0,attributedOrders:0,impressions:0,clicks:0,conversions:0 });
  return calculateKpis(totals,gmv,contributionBeforeAds);
}

function marketingAlerts(groups = []) {
  const alerts=[];
  for (const group of groups) {
    const k=group.kpis||calculateKpis(group);
    if(k.spend>0&&k.attributedRevenue===0) alerts.push({severity:"critical",code:"spend_without_revenue",channel:group.channel,message:"Investimento sem receita atribuida."});
    else if(k.roas!==null&&k.roas<1) alerts.push({severity:"critical",code:"negative_roas",channel:group.channel,message:"ROAS abaixo de 1; midia destrói receita atribuida."});
    if(k.tacos!==null&&k.tacos>0.2) alerts.push({severity:"warning",code:"high_tacos",channel:group.channel,message:"TACOS acima de 20%."});
    if(k.postAdsContribution!==null&&k.postAdsContribution<0) alerts.push({severity:"critical",code:"negative_post_ads_margin",channel:group.channel,message:"Margem de contribuicao pos-Ads negativa."});
  }
  return alerts;
}

module.exports={number,ratio,calculateKpis,aggregateMetrics,marketingAlerts};
