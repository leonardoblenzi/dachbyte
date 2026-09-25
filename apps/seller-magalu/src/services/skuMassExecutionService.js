"use strict";

const env = require("../config/env");
const accountRepository = require("../repositories/accountRepository");
const catalogRepository = require("../repositories/catalogRepository");
const skuMassRepository = require("../repositories/skuMassRepository");
const { appendAuditEvent } = require("../repositories/auditRepository");
const { checkAccountAccess } = require("./hubResourceAccessService");
const remote = require("./skuRemoteService");
const { hasWriteScope, remoteState, samePreviewState, desiredActive } = require("./skuMassPayload");

const RECONCILIATION_ONLY = new Set(["dispatching","accepted","divergent","uncertain"]);
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function safe(value,max=1000){return String(value==null?"":value).trim().slice(0,max);}
function isReconciliationOnly(item){return RECONCILIATION_ONLY.has(String(item?.status||""))||Boolean(item?.remote_accepted_at);}

async function audit(item, action, { category="write", severity="info", outcome="success", details={} } = {}) {
  return appendAuditEvent({
    accountId:item.account_id,dachTenantId:item.dach_tenant_id,dachUserId:item.dach_user_id,
    action,category,severity,outcome,resourceType:"sku",sku:item.sku,batchId:item.batch_id,
    requestId:item.request_id||item.idempotency_key||null,source:"sku-mass-worker",details,
  }).catch(()=>null);
}
async function finish(item,status,code,message,extra={}){
  const saved=await skuMassRepository.finishItem(item.id,{status,afterPayload:extra.afterPayload||null,errorCode:code||null,errorMessage:message||null,responseStatus:extra.responseStatus||null,responsePayload:extra.responsePayload||null,requestId:extra.requestId||item.request_id||null});
  const outcome=status==="uncertain"?"uncertain":status==="divergent"?"divergent":status==="stale"?"stale":status==="succeeded"?"success":"failure";
  await audit({...item,...saved},`SKU_MASS_${status.toUpperCase()}`,{severity:["failed","uncertain","divergent"].includes(status)?"warning":"info",outcome,details:{code:code||null,message:message||null,response_status:extra.responseStatus||null,previous_status:item.status}});
  return saved;
}
async function verifyDesired(account,item){
  const wanted=desiredActive(item.action);
  let last=null;
  for(let attempt=1;attempt<=env.MAGALU_SKU_VERIFY_ATTEMPTS;attempt+=1){
    if(attempt>1)await sleep(env.MAGALU_SKU_VERIFY_DELAY_MS*Math.min(attempt,4));
    try{
      const response=await remote.readSku(account,item.sku);last=response;
      const state=remoteState(response.data||{});
      if(state.active===wanted){
        await catalogRepository.upsertSku(account.id,response.data||{}, {httpStatus:response.status||200,error:null}).catch(()=>{});
        return{verified:true,payload:response.data||{},requestId:response.requestId||null};
      }
    }catch(error){last=error;}
  }
  return{verified:false,last};
}
async function reconcile(account,item){
  const check=await verifyDesired(account,item);
  if(check.verified)return finish(item,"succeeded",null,null,{afterPayload:check.payload,requestId:check.requestId});
  const accepted=item.status==="accepted"||item.status==="divergent"||Boolean(item.remote_accepted_at);
  return finish(item,accepted?"divergent":"uncertain",accepted?"MAGALU_SKU_WRITE_NOT_CONVERGED":"MAGALU_SKU_WRITE_RESULT_UNCERTAIN",accepted?"A alteração foi aceita/possivelmente aplicada, mas a leitura ainda não convergiu.":"Não é seguro afirmar se o PATCH chegou ao Magalu. Nenhum reenvio automático foi feito.");
}
async function executeSkuMassItem(itemId){
  let item=await skuMassRepository.getItem(itemId);
  if(!item)throw new Error(`Item massivo Magalu inexistente: ${itemId}`);
  if(["succeeded","stale","failed","canceled"].includes(String(item.status)))return item;
  if(item.status==="queued")item=await skuMassRepository.claimItem(item.id)||item;
  if(!["running","dispatching","accepted","divergent","uncertain"].includes(String(item.status)))return item;

  const account=await accountRepository.findAccountById(item.account_id);
  if(!account||String(account.dach_tenant_id)!==String(item.dach_tenant_id))return finish(item,"failed","MAGALU_SKU_ACCOUNT_MISMATCH","Conta/tenant não correspondem ao item do lote.");
  // Depois de dispatching/accepted/uncertain/divergent, o item só pode ser
  // reconciliado por GET. Não condicionamos essa verificação à flag de escrita,
  // status ativo da conta ou write scope, pois isso poderia apagar uma ambiguidade
  // remota sem conferir o que efetivamente ocorreu.
  if(isReconciliationOnly(item))return reconcile(account,item);
  if(String(account.status)!=="active")return finish(item,"failed","MAGALU_SKU_ACCOUNT_INACTIVE","A conta Magalu não está ativa.");
  if(!env.MAGALU_SKU_WRITE_ENABLED)return finish(item,"failed","MAGALU_SKU_WRITE_DISABLED","Gestão massiva de SKUs está desabilitada por configuração.");
  if(!hasWriteScope(account.scopes))return finish(item,"failed","MAGALU_SKU_WRITE_SCOPE_MISSING","Scope open:portfolio-skus-seller:write ausente na conta.");

  let beforeResponse;
  try{beforeResponse=await remote.readSku(account,item.sku);}catch(error){
    const status=Number(error?.status)||null;
    return finish(item,status===404?"stale":"failed",status===404?"MAGALU_SKU_REMOTE_NOT_FOUND":(error?.code||`MAGALU_SKU_GET_${status||"ERROR"}`),status===404?"O SKU não existe mais no portfólio remoto. Gere um novo preview.":(error?.message||String(error)),{responseStatus:status,responsePayload:error?.payload||null,requestId:error?.requestId||null});
  }
  const current=remoteState(beforeResponse.data||{});
  if(!samePreviewState(item.before_payload,current)){
    return finish(item,"stale","MAGALU_SKU_REMOTE_STATE_CHANGED","O estado remoto do SKU mudou após o preview. Gere um novo preview antes de sobrescrever.",{afterPayload:beforeResponse.data||{},requestId:beforeResponse.requestId||null});
  }

  const hub=await checkAccountAccess({dachTenantId:item.dach_tenant_id,dachUserId:item.dach_user_id},account,{force:true,action:"WRITE magalu"});
  if(!hub.allow)return finish(item,"failed","MAGALU_SKU_HUB_ACCESS_DENIED","O Hub não confirmou WRITE magalu imediatamente antes do PATCH.",{responsePayload:{hub_reason:hub.reason||"hub_denied"}});

  item=await skuMassRepository.setDispatching(item.id,item.idempotency_key)||{...item,status:"dispatching",request_id:item.idempotency_key};
  await audit(item,"SKU_MASS_DISPATCHING",{details:{method:"PATCH",requested:item.requested_payload}});
  let response;
  try{
    response=await remote.patchActive(account,item.sku,desiredActive(item.action),item.idempotency_key);
  }catch(error){
    const status=Number(error?.status)||null;
    const explicit=status&&status>=400&&status<500&&status!==408;
    return finish(item,explicit?"failed":"uncertain",explicit?(error?.code||`MAGALU_SKU_PATCH_${status}`):"MAGALU_SKU_WRITE_RESULT_UNCERTAIN",error?.message||String(error),{responseStatus:status,responsePayload:error?.payload||null,requestId:error?.requestId||item.idempotency_key});
  }
  item=await skuMassRepository.setAccepted(item.id,{responseStatus:response.status,responsePayload:response.data,requestId:response.requestId||item.idempotency_key})||item;
  await audit(item,"SKU_MASS_ACCEPTED",{details:{response_status:response.status}});
  const verified=await verifyDesired(account,item);
  if(!verified.verified)return finish(item,"divergent","MAGALU_SKU_WRITE_NOT_CONVERGED","O PATCH foi aceito, mas o estado remoto não convergiu dentro da janela de verificação.");
  return finish(item,"succeeded",null,null,{afterPayload:verified.payload,requestId:verified.requestId||response.requestId});
}
module.exports={executeSkuMassItem,_test:{isReconciliationOnly,verifyDesired,safe}};
