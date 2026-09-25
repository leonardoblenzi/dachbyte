"use strict";

const accountRepository = require("../repositories/accountRepository");
const accountManagementRepository = require("../repositories/accountManagementRepository");
const syncRunRepository = require("../repositories/syncRunRepository");
const { checkHubAccess, clearHubAccessCache } = require("../services/hubAccessService");
const { checkAccountAccess } = require("../services/hubResourceAccessService");
const { unlinkHubResource } = require("../services/hubAccountService");
const { sendHelpContact, TOPICS } = require("../services/helpContactService");

function int(value) {
  const parsed = Number.parseInt(String(value == null ? "" : value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function text(value, max = 1000) { return String(value == null ? "" : value).trim().slice(0, max); }

function pickSubscription(subscription) {
  const source = subscription && typeof subscription === "object" ? subscription : {};
  return {
    active: source.active === true,
    status: text(source.status, 80) || null,
    plan_code: text(source.plan_code || source.planCode || source.code, 120) || null,
    plan_name: text(source.plan_name || source.planName || source.name, 160) || null,
    cycle: text(source.cycle || source.billing_cycle || source.billingCycle, 80) || null,
    expires_at: source.expires_at || source.expiresAt || source.valid_until || null,
    renewal_url: text(source.renewal_url || source.renewalUrl, 1000) || null,
  };
}

function pickHubAccess(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const resource = source.resource && typeof source.resource === "object" ? source.resource : {};
  const credits = source.credits && typeof source.credits === "object" ? source.credits : {};
  const wallet = source.wallet && typeof source.wallet === "object" ? source.wallet : {};
  const balance = [credits.balance, wallet.balance, source.credit_balance, source.credits_balance]
    .map(Number).find(Number.isFinite);
  return {
    allow: source.allow === true,
    reason: text(source.reason, 120) || null,
    status: text(source.status, 120) || null,
    resource_status: text(resource.status, 120) || null,
    billing_mode: text(resource.billing_mode || source.billing_mode, 120) || null,
    usage_policy: text(resource.usage_policy || source.usage_policy, 120) || null,
    plan_code: text(resource.plan_code || source.plan_code, 120) || null,
    credit_balance: Number.isFinite(balance) ? balance : null,
  };
}

async function context(req, res, next) {
  try {
    const identity = req.magaluIdentity;
    const hub = await checkHubAccess(identity, { action: "ACCESS magalu", force: true });
    let selectedAccount = null;
    const accountId = int(req.query?.account_id);
    if (accountId) {
      selectedAccount = await accountRepository.findAccountByIdForTenant(accountId, identity.dachTenantId);
      if (selectedAccount) {
        const resource = await checkAccountAccess(identity, selectedAccount, { action: "READ magalu", force: true });
        if (!resource.allow) selectedAccount = null;
      }
    }
    return res.json({
      ok: true,
      tenant_id: identity.dachTenantId,
      user: { id: identity.dachUserId, name: identity.name, email: identity.email },
      module: "magalu",
      access: pickHubAccess(hub.payload || hub),
      subscription: pickSubscription(identity.subscription),
      selected_account: selectedAccount ? {
        id: selectedAccount.id,
        magalu_tenant_id: selectedAccount.magalu_tenant_id,
        magalu_tenant_name: selectedAccount.magalu_tenant_name,
        status: selectedAccount.status,
        catalog_sync_status: selectedAccount.catalog_sync_status,
        catalog_last_synced_at: selectedAccount.catalog_last_synced_at,
        catalog_last_error: selectedAccount.catalog_last_error,
      } : null,
      users: {
        source: "hub",
        local_replica: false,
        current_user_only: true,
      },
      credits: {
        source: "hub_access_payload",
        balance: pickHubAccess(hub.payload || hub).credit_balance,
      },
    });
  } catch (error) { next(error); }
}

async function unlink(req, res, next) {
  try {
    const accountId = int(req.params.accountId);
    if (!accountId) return res.status(400).json({ ok: false, error: "invalid_account_id" });
    const identity = req.magaluIdentity;
    const account = await accountRepository.findAccountByIdForTenant(accountId, identity.dachTenantId);
    if (!account) return res.status(404).json({ ok: false, error: "account_not_found" });

    const access = await checkHubAccess(identity, { action: "WRITE magalu", force: true });
    if (!access.allow) return res.status(403).json({ ok: false, error: "hub_write_access_denied", message: "O Hub não autorizou a desvinculação desta conta." });

    const reason = text(req.body?.reason, 500) || "Conta Magalu desvinculada pelo usuário.";
    const local = await accountManagementRepository.unlinkLocalAccount(
      accountId,
      identity.dachTenantId,
      identity.dachUserId,
      reason,
    );

    clearHubAccessCache(identity);
    let hubUnlink = { ok: false, skipped: false, error: null };
    try {
      await unlinkHubResource(account, { reason, actor: `magalu_user:${identity.dachUserId}` });
      hubUnlink = { ok: true, skipped: false, error: null };
    } catch (error) {
      hubUnlink = { ok: false, skipped: false, error: error?.code || error?.message || "hub_unlink_failed" };
    }
    await accountManagementRepository.recordHubUnlinkResult(accountId, hubUnlink).catch(() => {});

    return res.json({
      ok: true,
      account: { id: accountId, status: "revoked", magalu_tenant_id: account.magalu_tenant_id },
      replacement_account_id: local.replacementAccountId,
      removed_tokens: local.deletedTokens,
      disabled_webhooks: local.disabledWebhooks,
      already_revoked: local.alreadyRevoked,
      hub_unlink: hubUnlink,
    });
  } catch (error) {
    if (error?.code === "MAGALU_ACCOUNT_UNLINK_BLOCKED_BY_WRITE") {
      return res.status(409).json({
        ok: false,
        error: error.code,
        message: error.message,
        blockers: Array.isArray(error.blockers) ? error.blockers : [],
      });
    }
    return next(error);
  }
}

async function help(req, res, next) {
  try {
    const identity = req.magaluIdentity;
    const topic = text(req.body?.topic, 40).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(TOPICS, topic)) return res.status(400).json({ ok: false, error: "invalid_topic" });
    const message = text(req.body?.message, 5000);
    if (message.length < 10) return res.status(400).json({ ok: false, error: "message_too_short", message: "Escreva uma mensagem com pelo menos 10 caracteres." });
    const replyPreference = text(req.body?.reply_preference, 20).toLowerCase() === "cellphone" ? "cellphone" : "email";
    const cellphone = text(req.body?.cellphone, 40);
    if (replyPreference === "cellphone" && cellphone.replace(/\D/g, "").length < 8) {
      return res.status(400).json({ ok: false, error: "invalid_cellphone", message: "Informe um celular válido." });
    }

    let account = null;
    let latestRun = null;
    const accountId = int(req.body?.account_id);
    if (accountId) {
      account = await accountRepository.findAccountByIdForTenant(accountId, identity.dachTenantId);
      if (account) latestRun = await syncRunRepository.latestRun(account.id).catch(() => null);
    }
    const result = await sendHelpContact({
      userName: identity.name,
      userEmail: identity.email,
      topic,
      message,
      replyPreference,
      cellphone,
      accountLabel: account?.magalu_tenant_name || account?.magalu_tenant_id || null,
      magaluTenantId: account?.magalu_tenant_id || null,
      pagePath: text(req.body?.page_path, 200),
      syncStatus: account?.catalog_sync_status || latestRun?.status || null,
      syncError: account?.catalog_last_error || latestRun?.error_message || null,
      requestId: latestRun?.result?.request_id || null,
    });
    if (!result.sent) return res.status(503).json({ ok: false, error: "support_not_configured", message: result.reason || "Suporte por email não configurado." });
    return res.json({ ok: true, message: "Mensagem enviada ao suporte DACHBYTE.", delivery: { sent: true, message_id: result.messageId || null } });
  } catch (error) { next(error); }
}

module.exports = { context, unlink, help, _test: { pickSubscription, pickHubAccess } };
