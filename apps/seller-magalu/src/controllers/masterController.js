"use strict";

const path = require("node:path");
const masterRepository = require("../repositories/masterRepository");
const masterService = require("../services/masterService");

const masterView = path.resolve(__dirname, "../../views/master.html");

function statusFor(error) {
  const value = Number(error?.status || error?.statusCode || 0);
  return Number.isFinite(value) && value >= 400 && value <= 599 ? value : 500;
}
function failure(res, error, fallback = "Falha no Painel Master Magalu.") {
  const status = statusFor(error);
  return res.status(status).json({
    ok: false,
    error: error?.code || "MAGALU_MASTER_ERROR",
    message: status >= 500 ? fallback : (error?.message || fallback),
    ...(Array.isArray(error?.blockers) ? { blockers: error.blockers } : {}),
  });
}
function filters(query = {}) {
  return {
    search: query.search,
    tenant: query.tenant,
    accountId: query.account_id,
    user: query.user,
    status: query.status,
    sku: query.sku,
    batchId: query.batch_id,
    from: query.from,
    to: query.to,
    page: query.page,
    limit: query.limit,
  };
}

function auditFilters(query = {}) {
  return {
    search: query.search, eventKey: query.event_key, category: query.category, severity: query.severity, outcome: query.outcome,
    tenant: query.tenant, accountId: query.account_id, user: query.user, sku: query.sku, batchId: query.batch_id,
    requestId: query.request_id, source: query.source, from: query.from, to: query.to, page: query.page, limit: query.limit,
  };
}

function page(_req, res) {
  return res.sendFile(masterView);
}
function session(req, res) {
  return res.json({
    ok: true,
    module: "magalu",
    master: {
      role: req.magaluMaster.role,
      hub_reason: req.magaluMaster.hubReason,
      can_destroy: req.magaluMaster.canDestroy === true,
      user_id: req.magaluMaster.userId,
      email: req.magaluMaster.email || null,
    },
  });
}

async function overview(_req, res, next) {
  try { return res.json({ ok: true, ...(await masterService.getOverview()) }); }
  catch (error) { return next(error); }
}
async function accounts(req, res, next) {
  try { return res.json({ ok: true, ...(await masterRepository.listAccounts(filters(req.query))) }); }
  catch (error) { return next(error); }
}
async function account(req, res, next) {
  try {
    const result = await masterService.getAccount(req.params.accountId);
    if (!result) return res.status(404).json({ ok: false, error: "MAGALU_MASTER_ACCOUNT_NOT_FOUND" });
    return res.json({ ok: true, ...result });
  } catch (error) { return next(error); }
}
async function testConnection(req, res) {
  try { return res.json({ ok: true, diagnostics: await masterService.testAccountConnection(req.params.accountId) }); }
  catch (error) { return failure(res, error, "Não foi possível testar a conexão Magalu."); }
}
async function forceSync(req, res) {
  try { return res.status(202).json({ ok: true, ...(await masterService.forceAccountSync(req.params.accountId, req.magaluMaster)) }); }
  catch (error) { return failure(res, error, "Não foi possível enfileirar a sincronização."); }
}
async function reconcile(req, res) {
  try { return res.status(202).json({ ok: true, ...(await masterService.reconcileAccount(req.params.accountId, req.magaluMaster)) }); }
  catch (error) { return failure(res, error, "Não foi possível enfileirar a reconciliação."); }
}
async function unlink(req, res) {
  try {
    const result = await masterService.unlinkAccount(req.params.accountId, {
      reason: req.body?.reason,
      actor: req.magaluMaster,
    });
    return res.json({ ok: true, ...result });
  } catch (error) { return failure(res, error, "Não foi possível desvincular a conta."); }
}

async function operations(req, res, next) {
  try {
    const caps = await masterRepository.schemaCapabilities();
    const data = await masterRepository.listOperationBatches(filters(req.query));
    return res.json({
      ok: true,
      ...data,
      sources: { protected_write: true, mass_sku: caps.massSkuOperations, mass_sku_schema_detected: caps.massSkuOperations },
      notice: caps.massSkuOperations ? null : "A migration 007 da Gestão Massiva de SKUs não está aplicada nesta base; o Master exibe apenas as operações protegidas existentes.",
    });
  } catch (error) { return next(error); }
}
async function operation(req, res, next) {
  try {
    const result = await masterRepository.operationBatchDetail(req.params.batchId);
    if (!result) return res.status(404).json({ ok: false, error: "MAGALU_MASTER_BATCH_NOT_FOUND" });
    return res.json({ ok: true, ...result });
  } catch (error) { return next(error); }
}
async function reverify(req, res) {
  try { return res.status(202).json({ ok: true, ...(await masterService.reverifyOperation(req.params.operationId, req.magaluMaster)) }); }
  catch (error) { return failure(res, error, "Não foi possível solicitar a reverificação."); }
}
async function reverifyMass(req, res) {
  try { return res.status(202).json({ ok: true, ...(await masterService.reverifyMassOperation(req.params.itemId, req.magaluMaster)) }); }
  catch (error) { return failure(res, error, "Não foi possível solicitar a reverificação do item massivo."); }
}
async function exportOperations(req, res, next) {
  try {
    const result = await masterService.exportOperations(filters(req.query));
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="magalu-operacoes-${stamp}-${result.count}.csv"`);
    return res.status(200).send(result.body);
  } catch (error) { return next(error); }
}
async function workers(_req, res, next) {
  try { return res.json({ ok: true, ...(await masterService.getWorkersAndQueues()) }); }
  catch (error) { return next(error); }
}
async function integrations(_req, res, next) {
  try { return res.json({ ok: true, ...(await masterRepository.integrationSummary()) }); }
  catch (error) { return next(error); }
}
async function readiness(_req, res, next) {
  try {
    const capabilities = await masterRepository.schemaCapabilities();
    return res.json({
      ok: true,
      audit: {
        navigation_ready: true,
        implementation_ready: capabilities.auditV2Retention,
        reason: capabilities.auditV2Retention ? null : "migration_006_not_applied",
      },
      retention: {
        navigation_ready: true,
        implementation_ready: capabilities.auditV2Retention,
        reason: capabilities.auditV2Retention ? null : "migration_006_not_applied",
      },
      mass_sku: {
        implementation_ready: capabilities.massSkuOperations,
        reason: capabilities.massSkuOperations ? null : "migration_007_not_applied",
      },
    });
  } catch (error) { return next(error); }
}

async function auditEvents(req,res,next){try{return res.json({ok:true,...(await masterService.listAuditEvents(auditFilters(req.query)))});}catch(error){return next(error);}}
async function auditEvent(req,res,next){try{const event=await masterService.getAuditEvent(req.params.eventId);if(!event)return res.status(404).json({ok:false,error:"MAGALU_AUDIT_EVENT_NOT_FOUND"});return res.json({ok:true,event});}catch(error){return next(error);}}
async function exportAuditCsv(req,res,next){try{const result=await masterService.exportAudit(auditFilters(req.query),"csv");const stamp=new Date().toISOString().slice(0,10);res.setHeader("Content-Type","text/csv; charset=utf-8");res.setHeader("Content-Disposition",`attachment; filename="magalu-auditoria-${stamp}-${result.count}.csv"`);return res.send(result.body);}catch(error){return next(error);}}
async function exportAuditXlsx(req,res,next){try{const result=await masterService.exportAudit(auditFilters(req.query),"xlsx");const stamp=new Date().toISOString().slice(0,10);res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");res.setHeader("Content-Disposition",`attachment; filename="magalu-auditoria-${stamp}-${result.count}.xlsx"`);return res.send(result.body);}catch(error){return next(error);}}
async function retention(req,res,next){try{return res.json({ok:true,...(await masterService.getRetention())});}catch(error){return next(error);}}
async function retentionDryRun(req,res){try{return res.json({ok:true,...(await masterService.dryRunRetention(req.magaluMaster))});}catch(error){return failure(res,error,"Falha no dry-run de retenção.");}}
async function retentionUpdate(req,res){try{return res.json({ok:true,rules:await masterService.saveRetentionRules(req.body?.rules,req.magaluMaster)});}catch(error){return failure(res,error,"Falha ao atualizar retenção.");}}
async function retentionCleanup(req,res){try{return res.json({ok:true,run:await masterService.runRetentionCleanup(req.magaluMaster)});}catch(error){return failure(res,error,"Falha na limpeza de auditoria.");}}

module.exports = {
  page, session, overview, accounts, account, testConnection, forceSync, reconcile, unlink,
  operations, operation, reverify, reverifyMass, exportOperations, workers, integrations, readiness,
  auditEvents, auditEvent, exportAuditCsv, exportAuditXlsx, retention, retentionDryRun, retentionUpdate, retentionCleanup,
  _test: { statusFor, filters, auditFilters },
};
