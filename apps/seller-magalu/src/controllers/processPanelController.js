"use strict";
const accounts = require("../repositories/accountRepository");
const processes = require("../repositories/processPanelRepository");
const { checkAccountAccess } = require("../services/hubResourceAccessService");
const {getQueue,queueNames}=require("../queues/magaluQueue");

async function accountFor(req) {
  const id = Number(req.query?.account_id);
  if (!Number.isSafeInteger(id) || id < 1) { const e = new Error("Selecione uma conta Magalu."); e.status = 400; throw e; }
  const account = await accounts.findAccountByIdForTenant(id, req.magaluIdentity.dachTenantId);
  if (!account) { const e = new Error("Conta não encontrada."); e.status = 404; throw e; }
  const access = await checkAccountAccess(req.magaluIdentity, account, { action: "READ magalu" });
  if (!access.allow) { const e = new Error("Acesso à conta não autorizado."); e.status = 403; throw e; }
  return account;
}
function fail(res,error) { return res.status(error.status || 500).json({ ok:false, message: error.status ? error.message : "Não foi possível consultar processos." }); }
async function promoJobRow(job,owner){
  if(!["promo-prices","promo-preview"].includes(job.name))return null;
  const identity=job.name==="promo-preview"?job.data.identity:job.data;
  if(Number(identity?.accountId)!==Number(owner.accountId)||String(identity?.dachTenantId||identity?.tenantId)!==String(owner.tenantId)||job.name==="promo-preview"&&String(identity?.userId)!==String(owner.userId))return null;
  const state=await job.getState(),progress=job.progress||{},result=job.returnvalue||{},total=Number(progress.total||result.total||job.data.total||0),processed=Number(progress.processed||result.processed||0),finished=["completed","failed"].includes(state);
  return{id:job.id,kind:"promo",action:job.name,resource:"promotion",status:state,total_count:total,success_count:Number(progress.updated||progress.eligible||result.updated||result.eligible||0),failed_count:Number(progress.failed||result.failed||0)+(state==="failed"?1:0),pending_count:finished?0:Math.max(0,total-processed),created_at:new Date(job.timestamp||Date.now()).toISOString(),error_message:state==="failed"?String(job.failedReason||"Falha no processamento.").slice(0,300):null};
}
async function promoJobs(owner){const q=await getQueue(queueNames.promoPriceRefresh),jobs=await q.getJobs(["active","waiting","delayed","completed","failed"],0,99);return(await Promise.all(jobs.map(job=>promoJobRow(job,owner)))).filter(Boolean);}
async function list(req,res) { try { const account = await accountFor(req),owner={accountId:account.id,tenantId:req.magaluIdentity.dachTenantId,userId:req.magaluIdentity.dachUserId};const [stored,promo]=await Promise.all([processes.list(account.id,owner.tenantId),promoJobs(owner)]);return res.json({ok:true,rows:[...stored,...promo].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,100)}); } catch(error) { return fail(res,error); } }
async function detail(req,res) { try { const account = await accountFor(req);if(req.params.kind==="promo"){const q=await getQueue(queueNames.promoPriceRefresh),job=await q.getJob(req.params.id),owner={accountId:account.id,tenantId:req.magaluIdentity.dachTenantId,userId:req.magaluIdentity.dachUserId};if(!job||!await promoJobRow(job,owner))return res.status(404).json({ok:false,message:"Processo não encontrado nesta conta."});return res.json({ok:true,rows:(job.returnvalue?.errors||job.progress?.errors||[]).map(item=>({sku:item.sku,status:"failed",error_message:item.message}))});}const rows = await processes.detail(account.id, req.magaluIdentity.dachTenantId, req.params.kind, req.params.id); if (!rows) return res.status(404).json({ok:false,message:"Processo não encontrado nesta conta."}); return res.json({ok:true,rows}); } catch(error) { return fail(res,error); } }
module.exports = { list, detail,promoJobRow };
