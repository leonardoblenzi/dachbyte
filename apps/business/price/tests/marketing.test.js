"use strict";
const assert=require("node:assert/strict");const test=require("node:test");
const {ratio,calculateKpis,aggregateMetrics,marketingAlerts}=require("../src/marketing/metrics");

test("calcula ROAS, ACOS, TACOS, CPC, CTR, CVR e CAC",()=>{const k=calculateKpis({spend:100,attributedRevenue:500,attributedOrders:10,impressions:10000,clicks:200,conversions:10},1000,300);assert.equal(k.roas,5);assert.equal(k.acos,.2);assert.equal(k.tacos,.1);assert.equal(k.cpc,.5);assert.equal(k.ctr,.02);assert.equal(k.cvr,.05);assert.equal(k.cac,10);assert.equal(k.postAdsContribution,200);assert.equal(k.postAdsMargin,.2);});
test("divisao por zero nao fabrica KPI",()=>{assert.equal(ratio(10,0),null);assert.equal(calculateKpis({spend:0,revenue:0}).roas,null);});
test("agrega metricas antes de calcular razoes",()=>{const k=aggregateMetrics([{spend:10,attributed_revenue:20,clicks:2},{spend:30,attributed_revenue:180,clicks:8}],400,100);assert.equal(k.spend,40);assert.equal(k.attributedRevenue,200);assert.equal(k.roas,5);assert.equal(k.cpc,4);});
test("alerta destruicao de margem e investimento sem receita",()=>{const alerts=marketingAlerts([{channel:"meli_ads",kpis:calculateKpis({spend:120,revenue:0},100,50)}]);assert.ok(alerts.some(a=>a.code==="spend_without_revenue"));assert.ok(alerts.some(a=>a.code==="high_tacos"));assert.ok(alerts.some(a=>a.code==="negative_post_ads_margin"));});
