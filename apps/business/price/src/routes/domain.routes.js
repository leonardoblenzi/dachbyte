"use strict";

const express = require("express");
const { authenticate, requirePasswordChangeComplete, requireCsrf } = require("../auth");
const { requirePermission } = require("../permissions");
const { withTenant } = require("../db");
const { audit } = require("../audit");
const { redactForStorage } = require("../redact");

const router = express.Router();
router.use(authenticate, requirePasswordChangeComplete);

function n(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}
function text(value, max = 500) { return String(value ?? "").trim().slice(0, max); }
function json(value, fallback) { return value && typeof value === "object" ? value : fallback; }
async function logMutation(client, req, action, resourceType, resourceId, metadata = {}) {
  await audit(client, { tenantId:req.vpAuth.tenantId, actorUserId:req.vpAuth.userId, action, resourceType, resourceId:String(resourceId || ""), metadata:redactForStorage(metadata), ip:req.ip, userAgent:req.get("user-agent") });
}

router.get("/products", requirePermission("products.read"), async (req,res,next)=>{try{
  const q=text(req.query.q,120); const values=[]; let where="";
  if(q){values.push(`%${q}%`);where=`WHERE (sku ILIKE $1 OR name ILIKE $1)`;}
  const rows=await withTenant(req.vpAuth.tenantId,req.vpAuth.userId,async c=>(await c.query(`SELECT id,sku,name,cost,stock,metadata,created_at,updated_at FROM volt_price.products ${where} ORDER BY name,sku LIMIT 500`,values)).rows);
  res.json({products:rows});
}catch(e){next(e);}});
router.post("/products", requireCsrf, requirePermission("products.manage"), async (req,res,next)=>{try{
  const sku=text(req.body?.sku,120); const name=text(req.body?.name,300); if(!sku||!name)throw Object.assign(new Error("SKU e nome sao obrigatorios."),{statusCode:400});
  const row=await withTenant(req.vpAuth.tenantId,req.vpAuth.userId,async c=>{const r=(await c.query(`INSERT INTO volt_price.products(tenant_id,sku,name,cost,stock,metadata) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(tenant_id,sku) DO UPDATE SET name=EXCLUDED.name,cost=EXCLUDED.cost,stock=EXCLUDED.stock,metadata=volt_price.products.metadata||EXCLUDED.metadata,updated_at=now() RETURNING *`,[req.vpAuth.tenantId,sku,name,n(req.body?.cost),n(req.body?.stock),JSON.stringify(redactForStorage(json(req.body?.metadata,{})))] )).rows[0];await logMutation(c,req,"product.upsert","product",r.id,{sku});return r;});
  res.status(201).json({product:row});
}catch(e){next(e);}});

router.post("/pricing/decisions", requireCsrf, requirePermission("pricing.manage"), async (req,res,next)=>{try{
  const row=await withTenant(req.vpAuth.tenantId,req.vpAuth.userId,async c=>{const r=(await c.query(`INSERT INTO volt_price.pricing_decisions(tenant_id,product_id,state,current_price,recommended_price,confidence,recommendation,evidence,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING *`,[req.vpAuth.tenantId,req.body?.productId||null,text(req.body?.state,80)||null,n(req.body?.currentPrice),n(req.body?.recommendedPrice),n(req.body?.confidence),text(req.body?.recommendation,2000)||null,JSON.stringify(redactForStorage(json(req.body?.evidence,[]))),text(req.body?.status,40)||"suggested"] )).rows[0];await logMutation(c,req,"pricing.decision.create","pricing_decision",r.id,{productId:r.product_id});return r;});res.status(201).json({decision:row});
}catch(e){next(e);}});

router.post("/market", requireCsrf, requirePermission("market.manage"), async (req,res,next)=>{try{const row=await withTenant(req.vpAuth.tenantId,req.vpAuth.userId,async c=>{const r=(await c.query(`INSERT INTO volt_price.market_observations(tenant_id,product_id,channel,competitor,observed_price,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,[req.vpAuth.tenantId,req.body?.productId||null,text(req.body?.channel,80)||null,text(req.body?.competitor,200)||null,n(req.body?.observedPrice),JSON.stringify(redactForStorage(json(req.body?.payload,{})))])).rows[0];await logMutation(c,req,"market.observation.create","market_observation",r.id,{});return r;});res.status(201).json({observation:row});}catch(e){next(e);}});
router.post("/ads", requireCsrf, requirePermission("ads.manage"), async (req,res,next)=>{try{const row=await withTenant(req.vpAuth.tenantId,req.vpAuth.userId,async c=>{const r=(await c.query(`INSERT INTO volt_price.ads_metrics(tenant_id,channel,metric_date,spend,revenue,orders,payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,[req.vpAuth.tenantId,text(req.body?.channel,80),req.body?.metricDate||new Date().toISOString().slice(0,10),n(req.body?.spend,0),n(req.body?.revenue,0),Math.trunc(n(req.body?.orders,0)||0),JSON.stringify(redactForStorage(json(req.body?.payload,{})))])).rows[0];await logMutation(c,req,"ads.metric.create","ads_metric",r.id,{});return r;});res.status(201).json({metric:row});}catch(e){next(e);}});
router.get("/audit", requirePermission("audit.read"), async (req,res,next)=>{try{const data=await withTenant(req.vpAuth.tenantId,req.vpAuth.userId,async c=>{const cases=(await c.query(`SELECT * FROM volt_price.audit_cases ORDER BY created_at DESC LIMIT 300`)).rows;const logs=(await c.query(`SELECT id,actor_user_id,actor_type,action,resource_type,resource_id,metadata,ip,created_at FROM volt_price.audit_logs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 200`,[req.vpAuth.tenantId])).rows;return{cases,logs};});res.json(data);}catch(e){next(e);}});
router.post("/audit/cases", requireCsrf, requirePermission("audit.manage"), async (req,res,next)=>{try{const title=text(req.body?.title,500);if(!title)throw Object.assign(new Error("Titulo obrigatorio."),{statusCode:400});const row=await withTenant(req.vpAuth.tenantId,req.vpAuth.userId,async c=>{const r=(await c.query(`INSERT INTO volt_price.audit_cases(tenant_id,source_channel,source_order_id,severity,status,title,expected,realized) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) RETURNING *`,[req.vpAuth.tenantId,text(req.body?.sourceChannel,80)||null,text(req.body?.sourceOrderId,160)||null,text(req.body?.severity,40)||"medium",text(req.body?.status,40)||"open",title,JSON.stringify(redactForStorage(json(req.body?.expected,{}))),JSON.stringify(redactForStorage(json(req.body?.realized,{})))])).rows[0];await logMutation(c,req,"audit.case.create","audit_case",r.id,{title});return r;});res.status(201).json({case:row});}catch(e){next(e);}});

router.get("/actions", requirePermission("actions.read"), async (req,res,next)=>{try{const rows=await withTenant(req.vpAuth.tenantId,req.vpAuth.userId,async c=>(await c.query(`SELECT * FROM volt_price.actions ORDER BY created_at DESC LIMIT 300`)).rows);res.json({actions:rows});}catch(e){next(e);}});
router.post("/actions", requireCsrf, requirePermission("actions.manage"), async (req,res,next)=>{try{const actionType=text(req.body?.actionType,120);if(!actionType)throw Object.assign(new Error("Tipo da acao obrigatorio."),{statusCode:400});const row=await withTenant(req.vpAuth.tenantId,req.vpAuth.userId,async c=>{const r=(await c.query(`INSERT INTO volt_price.actions(tenant_id,action_type,status,reason,before_state,after_state,result,created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8) RETURNING *`,[req.vpAuth.tenantId,actionType,text(req.body?.status,40)||"planned",text(req.body?.reason,2000)||null,JSON.stringify(redactForStorage(json(req.body?.beforeState,{}))),JSON.stringify(redactForStorage(json(req.body?.afterState,{}))),JSON.stringify(redactForStorage(json(req.body?.result,{}))),req.vpAuth.userId])).rows[0];await logMutation(c,req,"action.create","action",r.id,{actionType});return r;});res.status(201).json({action:row});}catch(e){next(e);}});
router.patch("/actions/:id/evaluate", requireCsrf, requirePermission("actions.manage"), async (req,res,next)=>{try{const row=await withTenant(req.vpAuth.tenantId,req.vpAuth.userId,async c=>{const r=(await c.query(`UPDATE volt_price.actions SET status=$2,result=$3::jsonb,evaluated_at=now() WHERE id=$1 RETURNING *`,[req.params.id,text(req.body?.status,40)||"evaluated",JSON.stringify(redactForStorage(json(req.body?.result,{})))])).rows[0];if(!r)throw Object.assign(new Error("Acao nao encontrada."),{statusCode:404});await logMutation(c,req,"action.evaluate","action",r.id,{status:r.status});return r;});res.json({action:row});}catch(e){next(e);}});

router.get("/reports", requirePermission("reports.read"), async (req,res,next)=>{try{const data=await withTenant(req.vpAuth.tenantId,req.vpAuth.userId,async c=>{const [orders,fees,profit,products,actions]=await Promise.all([
 c.query(`SELECT date_trunc('month',order_date)::date month,count(*)::int orders,coalesce(sum(total_amount),0)::numeric revenue FROM volt_price.orders WHERE order_date IS NOT NULL GROUP BY 1 ORDER BY 1 DESC LIMIT 24`),
 c.query(`SELECT channel,count(*)::int lookups,max(fetched_at) last_lookup FROM volt_price.fee_snapshots GROUP BY channel ORDER BY channel`),
 c.query(`SELECT date_trunc('month',calculated_at)::date month,coalesce(sum(gross_amount),0)::numeric gross,coalesce(sum(contribution_amount),0)::numeric contribution FROM volt_price.profit_snapshots GROUP BY 1 ORDER BY 1 DESC LIMIT 24`),
 c.query(`SELECT count(*)::int count FROM volt_price.products`), c.query(`SELECT status,count(*)::int count FROM volt_price.actions GROUP BY status`)]);return{monthlyOrders:orders.rows,feeLookups:fees.rows,monthlyProfit:profit.rows,productCount:products.rows[0]?.count||0,actionsByStatus:actions.rows};});res.json(data);}catch(e){next(e);}});

module.exports = { domainRouter: router };
