"use strict";
const express=require("express");
const {authenticate,requirePasswordChangeComplete}=require("../auth");
const {requirePermission}=require("../permissions");
const {withTenant}=require("../db");
const router=express.Router();
router.use(authenticate,requirePasswordChangeComplete,requirePermission("dashboard.read"));
router.get("/",async(req,res,next)=>{try{if(!req.vpAuth.tenantId)return res.json({integrations:0,orders:0,fees:0,commissionReferences:0,lastSync:null});const data=await withTenant(req.vpAuth.tenantId,req.vpAuth.userId,async(client)=>{const [i,o,f,c,s]=await Promise.all([client.query("SELECT count(*)::int count FROM volt_price.integration_connections WHERE status='active'"),client.query("SELECT count(*)::int count FROM volt_price.orders"),client.query("SELECT count(*)::int count FROM volt_price.fee_snapshots"),client.query("SELECT count(*)::int count FROM volt_price.commission_references WHERE tenant_id IS NULL OR tenant_id=$1",[req.vpAuth.tenantId]),client.query("SELECT max(last_sync_at) last_sync FROM volt_price.integration_connections")]);return{integrations:i.rows[0].count,orders:o.rows[0].count,fees:f.rows[0].count,commissionReferences:c.rows[0].count,lastSync:s.rows[0].last_sync};});res.json(data);}catch(e){next(e);}});
module.exports={dashboardRouter:router};
