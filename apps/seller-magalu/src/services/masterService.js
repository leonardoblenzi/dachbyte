"use strict";

const masterRepository = require("../repositories/masterRepository");
const accountRepository = require("../repositories/accountRepository");
const accountManagementRepository = require("../repositories/accountManagementRepository");
const writeRepository = require("../repositories/writeRepository");
const skuMassRepository = require("../repositories/skuMassRepository");
const { runPortfolioDiagnostics } = require("./catalogDiagnosticsService");
const { unlinkHubResource } = require("./hubAccountService");
const { clearHubAccessCache } = require("./hubAccessService");
const { enqueueCatalogSync, enqueueHubResourceSync, enqueueWriteOperation, enqueueSkuMassReverify, enqueueDeliveryWriteOperation, getQueue, queueNames } = require("../queues/magaluQueue");
const { ensureRedisConnected } = require("../config/redis");
const auditRetentionService = require("./auditRetentionService");
const { createXlsx } = require("./simpleXlsx");
const { appendAuditEvent } = require("../repositories/auditRepository");
const integrationHealthService = require("./integrationHealthService");

const HEARTBEAT_KEY = "magalu:worker:heartbeat";
const HEARTBEAT_FRESH_MS = 65_000;
const FUTURE_QUEUE_NAMES = Object.freeze([]);

function safeText(value, max = 1000) {
  return String(value == null ? "" : value).trim().slice(0, max);
}
function accountId(value) {
  const parsed = Number.parseInt(String(value == null ? "" : value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function csvCell(value) {
  let normalized = value;
  if (value && typeof value === "object") normalized = JSON.stringify(value);
  const text = String(normalized == null ? "" : normalized).replace(/\r?\n/g, " ");
  return /[",;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function csv(rows, columns) {
  const lines = [columns.map(([header]) => csvCell(header)).join(";")];
  for (const row of rows) lines.push(columns.map(([, key]) => csvCell(row[key])).join(";"));
  return `\ufeff${lines.join("\r\n")}`;
}

async function getOverview() {
  const data = await masterRepository.overview();
  const workers = await getWorkersAndQueues().catch((error) => ({
    online: false,
    lastHeartbeat: null,
    pending: null,
    error: safeText(error?.message || error),
    queues: [],
  }));
  return { ...data, worker: workers };
}

async function getAccount(id) {
  const numericId = accountId(id);
  if (!numericId) return null;
  return masterRepository.accountDetail(numericId);
}

async function testAccountConnection(id) {
  const numericId = accountId(id);
  const account = numericId ? await accountRepository.findAccountById(numericId) : null;
  if (!account) {
    const error = new Error("Conta Magalu não encontrada.");
    error.status = 404;
    error.code = "MAGALU_MASTER_ACCOUNT_NOT_FOUND";
    throw error;
  }
  const result = await runPortfolioDiagnostics(account);
  // runPortfolioDiagnostics já retorna somente status/request-id/metadados de
  // catálogo; credenciais jamais são incluídas na resposta.
  return result;
}

async function forceAccountSync(id, actor) {
  const numericId = accountId(id);
  const account = numericId ? await accountRepository.findAccountById(numericId) : null;
  if (!account) {
    const error = new Error("Conta Magalu não encontrada.");
    error.status = 404;
    error.code = "MAGALU_MASTER_ACCOUNT_NOT_FOUND";
    throw error;
  }
  if (String(account.status) !== "active") {
    const error = new Error("Somente contas ativas podem iniciar sincronização.");
    error.status = 409;
    error.code = "MAGALU_MASTER_ACCOUNT_INACTIVE";
    throw error;
  }
  const job = await enqueueCatalogSync(account.id, {
    dachTenantId: account.dach_tenant_id,
    reason: `master:${safeText(actor?.userId, 120) || "unknown"}`,
  });
  await appendAuditEvent({ action:"MASTER_ACCOUNT_SYNC_QUEUED", category:"admin", outcome:"success", accountId:account.id, dachTenantId:account.dach_tenant_id, dachUserId:actor?.userId || null, magaluTenantId:account.magalu_tenant_id, source:"magalu-master", details:{ job_id:job?.id || null } }).catch(()=>{});
  return { queued: true, job_id: job?.id || null, account_id: account.id };
}

async function reconcileAccount(id, actor) {
  const numericId = accountId(id);
  const account = numericId ? await accountRepository.findAccountById(numericId) : null;
  if (!account) {
    const error = new Error("Conta Magalu não encontrada.");
    error.status = 404;
    error.code = "MAGALU_MASTER_ACCOUNT_NOT_FOUND";
    throw error;
  }
  if (String(account.status) !== "active") {
    const error = new Error("Somente contas ativas podem ser reconciliadas.");
    error.status = 409;
    error.code = "MAGALU_MASTER_ACCOUNT_INACTIVE";
    throw error;
  }
  const [resourceJob, catalogJob] = await Promise.all([
    enqueueHubResourceSync(account.id),
    enqueueCatalogSync(account.id, {
      dachTenantId: account.dach_tenant_id,
      reason: `master-reconcile:${safeText(actor?.userId, 120) || "unknown"}`,
    }),
  ]);
  await appendAuditEvent({ action:"MASTER_ACCOUNT_RECONCILE_QUEUED", category:"admin", outcome:"success", accountId:account.id, dachTenantId:account.dach_tenant_id, dachUserId:actor?.userId || null, magaluTenantId:account.magalu_tenant_id, source:"magalu-master", details:{ hub_resource_job_id:resourceJob?.id || null,catalog_job_id:catalogJob?.id || null } }).catch(()=>{});
  return {
    queued: true,
    account_id: account.id,
    hub_resource_job_id: resourceJob?.id || null,
    catalog_job_id: catalogJob?.id || null,
  };
}

async function unlinkAccount(id, { reason, actor } = {}) {
  const numericId = accountId(id);
  const account = numericId ? await accountRepository.findAccountById(numericId) : null;
  if (!account) {
    const error = new Error("Conta Magalu não encontrada.");
    error.status = 404;
    error.code = "MAGALU_MASTER_ACCOUNT_NOT_FOUND";
    throw error;
  }

  const cleanReason = safeText(reason, 500) || "Conta Magalu desvinculada pelo Painel Master.";
  const local = await accountManagementRepository.unlinkLocalAccount(
    account.id,
    account.dach_tenant_id,
    actor?.userId || "platform_admin",
    cleanReason,
  );

  clearHubAccessCache();
  let hubUnlink;
  try {
    await unlinkHubResource(account, {
      reason: cleanReason,
      actor: `magalu_master:${safeText(actor?.userId, 120) || "platform_admin"}`,
    });
    hubUnlink = { ok: true, error: null };
  } catch (error) {
    hubUnlink = { ok: false, error: safeText(error?.code || error?.message || "hub_unlink_failed", 500) };
  }
  await accountManagementRepository.recordHubUnlinkResult(account.id, hubUnlink).catch(() => {});
  await appendAuditEvent({ action:"MASTER_ACCOUNT_UNLINKED", category:"admin", severity:hubUnlink.ok?"info":"warning", outcome:hubUnlink.ok?"success":"failure", accountId:account.id, dachTenantId:account.dach_tenant_id, dachUserId:actor?.userId || null, magaluTenantId:account.magalu_tenant_id, source:"magalu-master", details:{ reason:cleanReason,hub_unlink_ok:hubUnlink.ok,hub_error:hubUnlink.error || null } }).catch(()=>{});
  return {
    account: { id: account.id, magalu_tenant_id: account.magalu_tenant_id, status: "revoked" },
    removed_tokens: local.deletedTokens,
    disabled_webhooks: local.disabledWebhooks,
    already_revoked: local.alreadyRevoked,
    hub_unlink: hubUnlink,
  };
}

async function reverifyOperation(id, actor) {
  const operationId = accountId(id);
  const operation = operationId ? await masterRepository.getWriteOperation(operationId) : null;
  if (!operation) {
    const error = new Error("Operação Magalu não encontrada.");
    error.status = 404;
    error.code = "MAGALU_MASTER_OPERATION_NOT_FOUND";
    throw error;
  }
  if (!["uncertain", "divergent"].includes(String(operation.status))) {
    const error = new Error("Somente operações uncertain/divergent podem ser reverificadas pelo Master.");
    error.status = 409;
    error.code = "MAGALU_MASTER_REVERIFY_INVALID_STATE";
    throw error;
  }

  await writeRepository.appendAudit({
    accountId: operation.account_id,
    operationId: operation.id,
    dachTenantId: operation.dach_tenant_id,
    dachUserId: actor?.userId || null,
    action: "MASTER_REVERIFY_REQUESTED",
    resourceType: operation.resource_type,
    sku: operation.sku,
    details: {
      requested_by: safeText(actor?.userId, 160) || null,
      previous_status: operation.status,
      mode: "verification_only",
    },
  });
  const job = await enqueueWriteOperation(operation, { reason: "reverify" });
  return { queued: true, operation_id: operation.id, job_id: job?.id || null, mode: "verification_only" };
}

async function reverifyMassOperation(id, actor) {
  const itemId = accountId(id);
  const item = itemId ? await masterRepository.getMassOperationItem(itemId) : null;
  if (!item) {
    const error = new Error("Item massivo Magalu não encontrado.");
    error.status = 404; error.code = "MAGALU_MASTER_MASS_ITEM_NOT_FOUND"; throw error;
  }
  if (!["uncertain", "divergent"].includes(String(item.status))) {
    const error = new Error("Somente itens massivos uncertain/divergent podem ser reverificados.");
    error.status = 409; error.code = "MAGALU_MASTER_MASS_REVERIFY_INVALID_STATE"; throw error;
  }
  await appendAuditEvent({ accountId:item.account_id,dachTenantId:item.dach_tenant_id,dachUserId:actor?.userId||null,magaluTenantId:item.magalu_tenant_id,
    action:"MASTER_SKU_MASS_REVERIFY_REQUESTED",category:"admin",outcome:"info",resourceType:"sku",sku:item.sku,batchId:item.batch_id,requestId:item.request_id||null,source:"magalu-master",
    details:{item_id:item.id,previous_status:item.status,mode:"verification_only"} }).catch(()=>{});
  const jobs = await enqueueSkuMassReverify(item);
  return { queued:true,item_id:item.id,batch_id:item.batch_id,job_id:jobs?.[0]?.id||null,mode:"verification_only" };
}

async function reverifyDeliveryOperation(id, actor) {
  const operationId=accountId(id),op=operationId?await masterRepository.getDeliveryWriteOperation(operationId):null; if(!op){const e=new Error("Operação de entrega não encontrada.");e.status=404;e.code="MAGALU_MASTER_DELIVERY_OPERATION_NOT_FOUND";throw e;} if(!["uncertain","divergent"].includes(String(op.status))){const e=new Error("Somente operações de entrega uncertain/divergent podem ser reverificadas.");e.status=409;e.code="MAGALU_MASTER_DELIVERY_REVERIFY_INVALID_STATE";throw e;} await appendAuditEvent({action:"MASTER_DELIVERY_REVERIFY_REQUESTED",category:"admin",outcome:"info",accountId:op.account_id,dachTenantId:op.dach_tenant_id,dachUserId:actor?.userId||null,magaluTenantId:op.magalu_tenant_id,resourceType:"delivery",batchId:`delivery:${op.id}`,requestId:op.request_id||null,source:"magalu-master",details:{operation_id:op.id,delivery_id:op.delivery_id,action:op.action,previous_status:op.status,mode:"verification_only"}}).catch(()=>{}); const job=await enqueueDeliveryWriteOperation(op,{reason:"reverify"}); return{queued:true,operation_id:op.id,job_id:job?.id||null,mode:"verification_only"};
}

async function getWorkersAndQueues() {
  const redis = await ensureRedisConnected();
  let heartbeat = null;
  try {
    const raw = await redis.get(HEARTBEAT_KEY);
    heartbeat = raw ? JSON.parse(raw) : null;
  } catch (_error) {
    heartbeat = null;
  }
  const ts = Number(heartbeat?.ts || 0);
  const ageMs = ts > 0 ? Date.now() - ts : null;
  const online = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= HEARTBEAT_FRESH_MS;

  const currentNames = Object.values(queueNames);
  const currentSet = new Set(currentNames);
  const stats = [];
  for (const name of currentNames) {
    try {
      const queue = await getQueue(name);
      const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed", "completed", "paused");
      stats.push({ name, installed: true, processor: Array.isArray(heartbeat?.processors) ? heartbeat.processors.includes(name) : null, ...counts });
    } catch (error) {
      stats.push({ name, installed: true, processor: null, error: safeText(error?.message || error, 500) });
    }
  }
  for (const name of FUTURE_QUEUE_NAMES) {
    if (!currentSet.has(name)) stats.push({ name, installed: false, processor: false, waiting: null, active: null, delayed: null, failed: null, completed: null, paused: null });
  }
  const pending = stats.reduce((sum, row) => sum + (row.installed ? Number(row.waiting || 0) + Number(row.active || 0) + Number(row.delayed || 0) : 0), 0);
  const capabilities = await masterRepository.schemaCapabilities();
  return {
    online,
    heartbeatKey: HEARTBEAT_KEY,
    lastHeartbeat: ts > 0 ? new Date(ts).toISOString() : null,
    heartbeatAgeMs: ageMs,
    worker: heartbeat?.worker || "seller-magalu",
    heartbeatStage: heartbeat?.stage ?? null,
    processors: Array.isArray(heartbeat?.processors) ? heartbeat.processors : [],
    heartbeatQueues: Array.isArray(heartbeat?.queues) ? heartbeat.queues : [],
    pending,
    queues: stats,
    capabilities: {
      protectedWrites: true,
      massSkuOperations: capabilities.massSkuOperations,
      auditRetention: capabilities.auditV2Retention,
    },
  };
}

async function exportOperations(filters) {
  const rows = await masterRepository.exportOperations(filters, 5000);
  const body = csv(rows, [
    ["source", "source"], ["batch_id", "batch_id"], ["operation_id", "id"], ["tenant", "dach_tenant_id"],
    ["account_id", "account_id"], ["magalu_tenant_id", "magalu_tenant_id"], ["organizacao", "magalu_tenant_name"],
    ["usuario", "dach_user_id"], ["tipo", "resource_type"], ["acao", "action"], ["sku", "sku"], ["status", "status"],
    ["request_id", "request_id"], ["erro_codigo", "error_code"], ["erro", "error_message"],
    ["antes", "before_payload"], ["solicitado", "requested_payload"], ["depois", "after_payload"],
    ["criado_em", "created_at"], ["iniciado_em", "started_at"], ["aceito_remoto_em", "remote_accepted_at"],
    ["concluido_em", "completed_at"], ["atualizado_em", "updated_at"],
  ]);
  return { body, count: rows.length };
}

async function listAuditEvents(filters) { return auditRetentionService.listEvents(filters); }
async function getAuditEvent(id) { return auditRetentionService.eventDetail(id); }
async function getRetention() {
  const [rules,runs,preview] = await Promise.all([auditRetentionService.listRules(),auditRetentionService.listRuns(30),auditRetentionService.retentionPreview()]);
  return { rules, runs, preview };
}
async function dryRunRetention(actor) { return auditRetentionService.dryRun(actor?.userId || null); }
async function saveRetentionRules(rules, actor) { return auditRetentionService.updateRules(rules, actor?.userId || null); }
async function runRetentionCleanup(actor) { return auditRetentionService.cleanup({ mode:"manual", actorUserId:actor?.userId || null }); }
async function getIntegrations(identity) {
  const [health, worker] = await Promise.all([integrationHealthService.overview(identity), getWorkersAndQueues().catch((error)=>({online:false,error:safeText(error?.message||error),queues:[],pending:null}))]);
  return { ...health, worker };
}
async function getIntegrationAccount(id) { return integrationHealthService.accountDetails(id); }
async function diagnoseIntegrationAccount(id, actor) { return integrationHealthService.diagnoseAccount(id, actor); }
async function refreshIntegrationOAuth(id, actor) { return integrationHealthService.refreshOAuth(id, actor); }
async function reconcileIntegrationHub(id, actor) { return integrationHealthService.reconcileHub(id, actor); }
async function reconcileIntegrationWebhooks(id, actor) { return integrationHealthService.reconcileWebhooks(id, actor); }

async function exportAudit(filters, format="csv") {
  const rows = await auditRetentionService.exportEvents(filters, 20000);
  const columns = [
    {header:"id",key:"id"},{header:"created_at",key:"created_at"},{header:"event_key",key:"event_key"},{header:"action",key:"action"},
    {header:"category",key:"category"},{header:"severity",key:"severity"},{header:"outcome",key:"outcome"},{header:"dach_tenant_id",key:"dach_tenant_id"},
    {header:"dach_user_id",key:"dach_user_id"},{header:"account_id",key:"account_id"},{header:"magalu_tenant_id",key:"magalu_tenant_id"},{header:"operation_id",key:"operation_id"},
    {header:"resource_type",key:"resource_type"},{header:"sku",key:"sku"},{header:"batch_id",key:"batch_id"},{header:"request_id",key:"request_id"},
    {header:"source",key:"source"},{header:"retention_rule",key:"retention_rule"},{header:"retention_days",key:"retention_days"},{header:"details",key:"details"},
  ];
  if (format === "xlsx") return { body:createXlsx(rows,columns,"Auditoria Magalu"), count:rows.length };
  return { body:csv(rows,columns.map(c=>[c.header,c.key])), count:rows.length };
}

module.exports = {
  getOverview,
  getAccount,
  testAccountConnection,
  forceAccountSync,
  reconcileAccount,
  unlinkAccount,
  reverifyOperation,
  reverifyMassOperation,
  reverifyDeliveryOperation,
  getWorkersAndQueues,
  exportOperations,
  listAuditEvents, getAuditEvent, getRetention, dryRunRetention, saveRetentionRules, runRetentionCleanup, exportAudit,
  getIntegrations, getIntegrationAccount, diagnoseIntegrationAccount, refreshIntegrationOAuth, reconcileIntegrationHub, reconcileIntegrationWebhooks,
  _test: { csvCell, csv, safeText, accountId, HEARTBEAT_KEY, HEARTBEAT_FRESH_MS, FUTURE_QUEUE_NAMES },
};
