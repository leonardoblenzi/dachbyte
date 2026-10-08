"use strict";
const accountRepository=require("../repositories/accountRepository");
const analytics=require("../repositories/uxAnalyticsRepository");
const financialAnalysis=require("../services/financialAnalysisSyncService");
const {checkAccountAccess}=require("../services/hubResourceAccessService");
function int(v){const n=Number.parseInt(String(v==null?"":v),10);return Number.isFinite(n)&&n>0?n:null;}
async function accountFor(req){const id=int(req.query?.account_id);if(!id){const e=new Error("account_id obrigatório.");e.status=400;e.code="MAGALU_ACCOUNT_ID_REQUIRED";throw e;}const account=await accountRepository.findAccountByIdForTenant(id,req.magaluIdentity.dachTenantId);if(!account){const e=new Error("Conta Magalu não encontrada.");e.status=404;e.code="MAGALU_ACCOUNT_NOT_FOUND";throw e;}const access=await checkAccountAccess(req.magaluIdentity,account,{action:"READ magalu"});if(!access.allow){const e=new Error("O Hub não confirmou acesso a esta conta Magalu.");e.status=403;e.code="MAGALU_HUB_ACCESS_DENIED";throw e;}return account;}
function fail(res,e){const status=Number(e?.status)||500;return res.status(status).json({ok:false,error:e?.code||"MAGALU_UX_ANALYTICS_ERROR",message:status>=500?"Não foi possível carregar a análise Magalu.":e.message});}
async function stock(req,res){try{const a=await accountFor(req);return res.json({ok:true,...await analytics.stockAnalysis(a.id,req.query)});}catch(e){return fail(res,e);}}
async function costs(req,res){try{const a=await accountFor(req);return res.json({ok:true,...await analytics.costOverview(a.id)});}catch(e){return fail(res,e);}}
async function margins(req,res){try{const a=await accountFor(req);return res.json({ok:true,...await analytics.marginOverview(a.id,req.query)});}catch(e){return fail(res,e);}}
async function syncMargins(req,res){try{const a=await accountFor(req);return res.json({ok:true,...await financialAnalysis.syncRange(a,{from:req.body?.from,to:req.body?.to})});}catch(e){return fail(res,e);}}
async function equilibrium(req,res){try{const a=await accountFor(req);return res.json({ok:true,...await analytics.equilibrium(a.id,req.query)});}catch(e){return fail(res,e);}}
module.exports={stock,costs,margins,syncMargins,equilibrium,_test:{int}};
