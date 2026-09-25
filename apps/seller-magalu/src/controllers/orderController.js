"use strict";

const env = require("../config/env");
const accountRepository = require("../repositories/accountRepository");
const orderRepository = require("../repositories/orderRepository");
const { appendAuditEvent } = require("../repositories/auditRepository");
const { checkAccountAccess } = require("../services/hubResourceAccessService");
const { ORDER_SCOPE, DELIVERY_SCOPE, hasScope } = require("../services/orderSyncService");
const { enqueueOrdersSync, enqueueOrderReconcile } = require("../queues/magaluQueue");

function int(value){const n=Number.parseInt(String(value==null?"":value),10);return Number.isFinite(n)&&n>0?n:null;}
function text(value,max=500){return String(value==null?"":value).trim().slice(0,max);}
function fail(res,error,fallback){const status=Number(error?.status)||500;return res.status(status).json({ok:false,error:error?.code||"MAGALU_ORDERS_ERROR",message:status>=500?fallback:(error?.message||fallback)});}
async function accountFor(req,{force=false}={}){
  const accountId=int(req.query?.account_id||req.body?.account_id||req.params?.accountId);
  if(!accountId){const e=new Error("account_id inválido.");e.status=400;e.code="MAGALU_ACCOUNT_ID_REQUIRED";throw e;}
  const identity=req.magaluIdentity;
  const account=await accountRepository.findAccountByIdForTenant(accountId,identity.dachTenantId);
  if(!account){const e=new Error("Conta Magalu não encontrada para esta empresa.");e.status=404;e.code="MAGALU_ACCOUNT_NOT_FOUND";throw e;}
  if(String(account.status)!=="active"){const e=new Error("A conta Magalu não está ativa.");e.status=409;e.code="MAGALU_ACCOUNT_INACTIVE";throw e;}
  const hub=await checkAccountAccess(identity,account,{action:"READ magalu",force});
  if(!hub.allow){const e=new Error("O Hub não confirmou acesso a esta conta Magalu.");e.status=403;e.code="MAGALU_ORDERS_HUB_ACCESS_DENIED";throw e;}
  return account;
}
function scopeInfo(account){return{order:{scope:ORDER_SCOPE,ok:hasScope(account,ORDER_SCOPE)},delivery:{scope:DELIVERY_SCOPE,ok:hasScope(account,DELIVERY_SCOPE)}};}
async function status(req,res){try{const account=await accountFor(req);const [stats,syncState]=await Promise.all([orderRepository.stats(account.id),orderRepository.accountSyncState(account.id)]);return res.json({ok:true,read_only:true,lookback_days:env.MAGALU_ORDER_SYNC_LOOKBACK_DAYS,page_size:env.MAGALU_ORDER_SYNC_PAGE_SIZE,max_pages:env.MAGALU_ORDER_SYNC_MAX_PAGES,rate_limit_order:env.MAGALU_RATE_LIMIT_ORDER_READ_PER_MINUTE,rate_limit_delivery:env.MAGALU_RATE_LIMIT_DELIVERY_READ_PER_MINUTE,scopes:scopeInfo(account),account:{id:account.id,name:account.magalu_tenant_name||null,magalu_tenant_id:account.magalu_tenant_id,orders_sync_status:syncState?.orders_sync_status||"idle",orders_last_synced_at:syncState?.orders_last_synced_at||null,orders_last_error:syncState?.orders_last_error||null},stats});}catch(error){return fail(res,error,"Não foi possível carregar o status de Pedidos.");}}
async function list(req,res){try{const account=await accountFor(req);const data=await orderRepository.listOrders(account.id,{q:req.query?.q,status:req.query?.status,from:req.query?.from,to:req.query?.to,page:req.query?.page,limit:req.query?.limit});return res.json({ok:true,...data});}catch(error){return fail(res,error,"Não foi possível listar os pedidos.");}}
async function detail(req,res){try{const account=await accountFor(req);const data=await orderRepository.orderDetail(account.id,text(req.params.code,300));if(!data)return res.status(404).json({ok:false,error:"MAGALU_ORDER_NOT_FOUND"});return res.json({ok:true,...data});}catch(error){return fail(res,error,"Não foi possível abrir o pedido.");}}
async function sync(req,res){try{const account=await accountFor(req,{force:true});if(!hasScope(account,ORDER_SCOPE))return res.status(409).json({ok:false,error:"MAGALU_ORDER_SCOPE_MISSING",message:`Scope ausente: ${ORDER_SCOPE}. Reconecte a conta antes de sincronizar pedidos.`});const identity=req.magaluIdentity;const job=await enqueueOrdersSync(account.id,{dachTenantId:identity.dachTenantId,dachUserId:identity.dachUserId,reason:"manual"});await orderRepository.setSyncState(account.id,{status:"queued",error:null});await appendAuditEvent({action:"ORDERS_SYNC_QUEUED",category:"sync",outcome:"success",accountId:account.id,dachTenantId:identity.dachTenantId,dachUserId:identity.dachUserId,magaluTenantId:account.magalu_tenant_id,source:"orders-ui",details:{job_id:job?.id||null,read_only:true}}).catch(()=>{});return res.status(202).json({ok:true,queued:true,job_id:job?.id||null});}catch(error){return fail(res,error,"Não foi possível enfileirar a sincronização de pedidos.");}}
async function reconcile(req,res){try{const account=await accountFor(req,{force:true});const code=text(req.params.code,300);if(!code)return res.status(400).json({ok:false,error:"MAGALU_ORDER_CODE_REQUIRED"});if(!hasScope(account,ORDER_SCOPE))return res.status(409).json({ok:false,error:"MAGALU_ORDER_SCOPE_MISSING"});const identity=req.magaluIdentity;const job=await enqueueOrderReconcile(account.id,code,{dachTenantId:identity.dachTenantId,dachUserId:identity.dachUserId,reason:"manual"});await appendAuditEvent({action:"ORDER_RECONCILE_QUEUED",category:"sync",outcome:"success",accountId:account.id,dachTenantId:identity.dachTenantId,dachUserId:identity.dachUserId,magaluTenantId:account.magalu_tenant_id,source:"orders-ui",details:{job_id:job?.id||null,code,read_only:true}}).catch(()=>{});return res.status(202).json({ok:true,queued:true,job_id:job?.id||null,code});}catch(error){return fail(res,error,"Não foi possível enfileirar a reconciliação do pedido.");}}
async function runs(req,res){try{const account=await accountFor(req);return res.json({ok:true,runs:await orderRepository.runs(account.id,req.query?.limit)});}catch(error){return fail(res,error,"Não foi possível carregar o histórico de pedidos.");}}
module.exports={status,list,detail,sync,reconcile,runs,_test:{int,text,scopeInfo}};
