"use strict";
const accounts=require("../repositories/accountRepository");
const prices=require("../repositories/promoPriceRepository");
const previews=require("../repositories/promoPricingPreviewRepository");
const {buildPromotionWorkbook}=require("../services/promoWorkbookService");
const {checkAccountAccess}=require("../services/hubResourceAccessService");
const {enqueuePromoPriceRefresh,getQueue,queueNames}=require("../queues/magaluQueue");
function error(message,status){const e=new Error(message);e.status=status;return e;}
async function accountFor(req){
  const id=Number(req.query?.account_id||req.body?.account_id);
  if(!Number.isSafeInteger(id)||id<=0)throw error("Selecione uma conta Magalu.",400);
  const account=await accounts.findAccountByIdForTenant(id,req.magaluIdentity.dachTenantId);
  if(!account)throw error("Conta não encontrada.",404);
  if(account.status!=="active")throw error("Conta Magalu inativa.",409);
  const access=await checkAccountAccess(req.magaluIdentity,account,{action:"READ magalu",force:true});
  if(!access.allow)throw error("Acesso à conta não confirmado pelo Hub.",403);
  return account;
}
function fail(res,e){return res.status(e.status||500).json({ok:false,message:e.status?e.message:"Falha ao consultar preços Magalu."});}
async function list(req,res){try{const account=await accountFor(req);return res.json({ok:true,...await prices.list(account.id,req.query)});}catch(e){return fail(res,e);}}
async function refresh(req,res){try{const account=await accountFor(req);const skus=await prices.snapshot(account.id,req.body?.filters||{});const job=await enqueuePromoPriceRefresh(account.id,req.magaluIdentity.dachTenantId,skus);return res.status(202).json({ok:true,job_id:job.id,total:skus.length});}catch(e){return fail(res,e);}}
async function refreshStatus(req,res){try{await accountFor(req);const q=await getQueue(queueNames.promoPriceRefresh),job=await q.getJob(req.params.id);if(!job||job.name!=="promo-prices"||Number(job.data.accountId)!==Number(req.query.account_id)||String(job.data.dachTenantId)!==String(req.magaluIdentity.dachTenantId))throw error("Atualização não encontrada.",404);const state=await job.getState();return res.json({ok:true,state,progress:job.progress||null,result:state==="completed"?job.returnvalue:null,error:state==="failed"?job.failedReason:null});}catch(e){return fail(res,e);}}
function identity(req,account){return{accountId:account.id,tenantId:req.magaluIdentity.dachTenantId,userId:req.magaluIdentity.dachUserId};}
async function createPreview(req,res){try{const account=await accountFor(req);return res.json({ok:true,...await previews.create(identity(req,account),req.body?.filters||{},req.body?.terms||{})});}catch(e){return fail(res,e);}}
async function previewPage(req,res){try{const account=await accountFor(req);return res.json({ok:true,...await previews.page(req.params.id,identity(req,account),req.query.page)});}catch(e){return fail(res,e);}}
async function updatePreviewRow(req,res){try{const account=await accountFor(req);return res.json({ok:true,...await previews.update(req.params.id,identity(req,account),req.params.sku,req.body||{})});}catch(e){return fail(res,e);}}
async function exportCheck(req,res){try{const account=await accountFor(req),review=await previews.exportReview(req.params.id,identity(req,account),{allowPartial:true,allowEmpty:true});const offset=Math.max(0,Math.floor(Number(req.query.offset)||0));return res.json({ok:true,eligible:review.eligible,excluded_count:review.excluded_count,excluded:review.excluded.slice(offset,offset+50),offset});}catch(e){return fail(res,e);}}
async function exportWorkbook(req,res){try{const account=await accountFor(req),review=await previews.exportReview(req.params.id,identity(req,account),{allowPartial:req.query.allow_partial==="true"});const buffer=await buildPromotionWorkbook(review.rows);res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");res.setHeader("Content-Disposition",'attachment; filename="promocoes-magalu.xlsx"');res.setHeader("Cache-Control","no-store");return res.send(buffer);}catch(e){return fail(res,e);}}
module.exports={list,refresh,refreshStatus,createPreview,previewPage,updatePreviewRow,exportCheck,exportWorkbook};
