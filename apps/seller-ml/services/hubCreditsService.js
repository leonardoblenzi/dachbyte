"use strict";

const crypto = require("crypto");
const {
  calculateOperationCredits,
  estimateAdsFilterCredits,
} = require("./mlCreditCosts");

const DEFAULT_TIMEOUT_MS = 5000;
const SYNC_TTL_MS = 5 * 60 * 1000;
const syncedAccounts = new Map();
const DISABLED_VALUES = new Set(["", "0", "false", "off", "none", "disabled", "null", "undefined"]);

class HubCreditError extends Error {
  constructor(message, { statusCode = 503, code = "hub_credit_error", details = null } = {}) {
    super(message);
    this.name = "HubCreditError";
    this.statusCode = statusCode;
    this.status = statusCode;
    this.code = code;
    this.details = details;
  }
}

function normalizeConfigValue(value) {
  const normalized = String(value ?? "").trim();
  return DISABLED_VALUES.has(normalized.toLowerCase()) ? "" : normalized;
}

function creditsMode() {
  const value = String(process.env.HUB_CREDITS_MODE || "monitor").trim().toLowerCase();
  if (["off", "disabled", "legacy"].includes(value)) return "off";
  if (["strict", "enforce", "enabled"].includes(value)) return "enforce";
  return "monitor";
}

function hubConfig() {
  return {
    baseUrl: normalizeConfigValue(process.env.HUB_BASE_URL).replace(/\/+$/, ""),
    token: normalizeConfigValue(process.env.HUB_INTERNAL_TOKEN),
  };
}

async function postHub(pathname, payload) {
  const config = hubConfig();
  if (!config.baseUrl || !config.token) {
    throw new HubCreditError("Hub de creditos nao configurado.", {
      code: "hub_credits_not_configured",
    });
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(500, Number(process.env.HUB_REQUEST_TIMEOUT_MS || DEFAULT_TIMEOUT_MS));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function requestHub(method, pathname, payload = null) {
  const config = hubConfig();
  if (!config.baseUrl || !config.token) {
    throw new HubCreditError("Hub de creditos nao configurado.", {
      code: "hub_credits_not_configured",
    });
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(500, Number(process.env.HUB_REQUEST_TIMEOUT_MS || DEFAULT_TIMEOUT_MS));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}${pathname}`, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${config.token}`,
      },
      body: payload === null ? undefined : JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function getHub(pathname) {
  return requestHub("GET", pathname, null);
}

function billingContext(source = {}) {
  const mlCreds = source.mlCreds || source;
  const account = source.account || mlCreds.billing_account || {};
  const accountId = String(
    account.meli_user_id || mlCreds.meli_user_id || account.external_account_id || "",
  ).trim();
  const tenantId = String(
    account.tenant_id || account.tenant_global_id || mlCreds.tenant_id || mlCreds.tenant_global_id || "",
  ).trim();
  return {
    accountId,
    tenantId,
    label: String(account.label || mlCreds.account_label || accountId).trim() || accountId,
    status: String(account.billing_status || mlCreds.billing_status || "legacy_active").trim(),
    billingMode: String(account.billing_mode || mlCreds.billing_mode || "legacy").trim(),
    usagePolicy: String(account.usage_policy || mlCreds.usage_policy || "metered").trim(),
    rangeEnforcement: Boolean(account.range_enforcement || mlCreds.range_enforcement),
    planCode: account.plan_code || mlCreds.billing_plan_code || null,
    orderRangeCode: account.order_range_code || mlCreds.billing_order_range_code || null,
    localAccountId: account.meli_conta_id || mlCreds.meli_conta_id || null,
  };
}

function bypassReservation({ operationKey, credits, reason, idempotencyKey }) {
  return {
    bypass: true,
    operation_key: operationKey,
    reserved_credits: credits,
    idempotency_key: idempotencyKey,
    reason,
  };
}

function hasUnlimitedAccess(context = {}) {
  const status = String(context.status || "").trim().toLowerCase();
  const billingMode = String(context.billingMode || "").trim().toLowerCase();
  const usagePolicy = String(context.usagePolicy || "").trim().toLowerCase();
  return (
    usagePolicy === "unlimited" ||
    ["internal_unlimited", "courtesy_unlimited"].includes(status) ||
    (status === "legacy_active" && billingMode === "legacy")
  );
}

function normalizeOrderRangeCode(value) {
  const normalized = String(value || "").trim();
  return normalized || "up_to_30";
}

function recommendedRangeForOrders(orderCount) {
  const total = Number(orderCount || 0);
  if (!Number.isFinite(total) || total <= 30) return "up_to_30";
  if (total <= 200) return "from_31_to_200";
  if (total <= 700) return "from_201_to_700";
  if (total <= 1500) return "from_701_to_1500";
  return "above_1500";
}

function buildPlanCheckoutUrl({
  mlCreds = null,
  account = null,
  cycle = "monthly",
  customerEmail = null,
  customerName = null,
  customerPhone = null,
  userId = null,
  documentType = null,
  documentNumber = null,
  successUrl = null,
} = {}) {
  const config = hubConfig();
  if (!config.baseUrl) return null;

  const context = billingContext({ mlCreds: mlCreds || {}, account: account || {} });
  if (!context.tenantId || !context.accountId) return null;

  const selectedCycle = "monthly";
  const orderRangeCode = normalizeOrderRangeCode(
    account?.recommended_range_code ||
      account?.recommendedRangeCode ||
      (Number.isFinite(Number(account?.last_closed_period_orders)) && Number(account.last_closed_period_orders) > 0
        ? recommendedRangeForOrders(account.last_closed_period_orders)
        : context.orderRangeCode),
  );
  const currentRangeCode = normalizeOrderRangeCode(context.orderRangeCode);
  const lastClosedOrders = Number(account?.last_closed_period_orders);

  const params = new URLSearchParams();
  params.set("renewal", "1");
  params.set("cycle", selectedCycle);
  params.set("tenant_id", context.tenantId);
  params.set("modules", "ml");
  params.set("ranges", `ml:${orderRangeCode}`);
  params.set("billing_resource_key", `ml:${context.accountId}`);
  params.set("billing_module_slug", "ml");
  params.set("billing_account_id", context.accountId);
  params.set("recommended_range_code", orderRangeCode);
  params.set("order_range_code", currentRangeCode);
  if (Number.isFinite(lastClosedOrders) && lastClosedOrders >= 0) {
    params.set("last_closed_period_orders", String(Math.round(lastClosedOrders)));
  }
  if (userId) params.set("user_id", String(userId).trim());
  if (customerEmail) params.set("customer_email", String(customerEmail).trim());
  if (customerName) params.set("customer_name", String(customerName).trim());
  if (customerPhone) params.set("customer_phone", String(customerPhone).replace(/[^0-9]/g, ""));
  if (documentType) params.set("document_type", String(documentType).trim().toUpperCase());
  if (documentNumber) params.set("document_number", String(documentNumber).replace(/[^0-9]/g, ""));
  if (account?.empresa_nome || account?.company_name) {
    params.set("company_name", String(account.empresa_nome || account.company_name).trim());
  }
  if (successUrl) params.set("success_url", String(successUrl).trim());

  return `${config.baseUrl}/?${params.toString()}`;
}

async function ensureAccountSynced(context) {
  if (!context.accountId || !context.tenantId) {
    throw new HubCreditError("Conta sem identidade global para cobranca de creditos.", {
      statusCode: 409,
      code: "billing_identity_missing",
    });
  }

  const cacheKey = `${context.tenantId}:${context.accountId}`;
  const cachedAt = Number(syncedAccounts.get(cacheKey) || 0);
  if (Date.now() - cachedAt < SYNC_TTL_MS) return;

  const response = await postHub("/v1/internal/ml/accounts/sync", {
    tenant_id: context.tenantId,
    account_id: context.accountId,
    label: context.label,
    status: context.status,
    billing_mode: context.billingMode,
    usage_policy: context.usagePolicy,
    range_enforcement: context.rangeEnforcement,
    plan_code: context.planCode,
    order_range_code: context.orderRangeCode,
    metadata: { ml_local_account_id: context.localAccountId },
  });
  if (!response.ok) {
    throw responseError(response, "Nao foi possivel sincronizar a conta com o Hub.");
  }
  syncedAccounts.set(cacheKey, Date.now());
}

async function unlinkBillingResource({ account, reason = "Conta ML desvinculada pelo usuario.", actor = "ml_account_unlink" } = {}) {
  const context = billingContext({ account: account || {} });
  if (!context.accountId || !context.tenantId) {
    throw new HubCreditError("Conta sem identidade global para desvincular no Hub.", {
      statusCode: 409,
      code: "billing_identity_missing",
    });
  }

  const response = await postHub("/v1/internal/resources/unlink", {
    tenant_id: context.tenantId,
    module_slug: "ml",
    account_id: context.accountId,
    reason,
    metadata: {
      actor,
      local_account_id: context.localAccountId || null,
      label: context.label || null,
    },
  });
  if (!response.ok) {
    throw responseError(response, "Nao foi possivel desvincular recurso no Hub.");
  }
  syncedAccounts.delete(`${context.tenantId}:${context.accountId}`);
  return response.data;
}

async function getCreditPolicy() {
  const response = await getHub("/v1/internal/ml/credits/policy");
  if (!response.ok) {
    throw responseError(response, "Nao foi possivel carregar a politica de creditos.");
  }
  return response.data;
}

async function getCreditAccountAccess({ mlCreds, account = null } = {}) {
  const context = billingContext({ mlCreds, account });
  await ensureAccountSynced(context);
  const response = await postHub("/v1/internal/ml/accounts/access", {
    account_id: context.accountId,
  });
  if (!response.ok) {
    throw responseError(response, "Nao foi possivel carregar a carteira de creditos.");
  }
  return {
    ...response.data,
    billing_context: context,
    unlimited: hasUnlimitedAccess(context),
  };
}

async function getCreditActivity({ mlCreds, account = null, limit = 50 } = {}) {
  const context = billingContext({ mlCreds, account });
  await ensureAccountSynced(context);
  const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 50)));
  const response = await getHub(
    `/v1/internal/ml/credits/activity?account_id=${encodeURIComponent(context.accountId)}&limit=${safeLimit}`,
  );
  if (!response.ok) {
    throw responseError(response, "Nao foi possivel carregar o extrato de creditos.");
  }
  return {
    ...response.data,
    billing_context: context,
    unlimited: hasUnlimitedAccess(context),
  };
}

async function createCreditTopupCheckout({
  mlCreds,
  account = null,
  packageCode,
  customerEmail = null,
  customerName = null,
  successUrl = null,
} = {}) {
  const context = billingContext({ mlCreds, account });
  await ensureAccountSynced(context);
  const response = await postHub("/v1/internal/ml/credits/topup/checkout", {
    account_id: context.accountId,
    package_code: packageCode,
    customer_email: customerEmail,
    customer_name: customerName,
    success_url: successUrl,
    metadata: {
      source: "davantti_ml",
      tenant_id: context.tenantId,
      local_account_id: context.localAccountId,
    },
  });
  if (!response.ok) {
    throw responseError(response, "Nao foi possivel iniciar a recarga de creditos.");
  }
  return response.data;
}

function responseError(response, fallbackMessage) {
  const code = String(response?.data?.error || "hub_credit_request_failed");
  const messages = {
    insufficient_credits: "Creditos insuficientes para iniciar esta operacao.",
    awaiting_subscription: "Esta conta precisa de uma assinatura ativa.",
    suspended_by_range: "A faixa contratada desta conta precisa ser regularizada.",
    suspended_by_payment: "O pagamento desta conta precisa ser regularizado.",
  };
  return new HubCreditError(messages[code] || fallbackMessage, {
    statusCode: Number(response?.status || 503),
    code,
    details: response?.data || null,
  });
}

async function reserveCredits({
  mlCreds,
  account = null,
  operationKey,
  credits,
  units = 1,
  extras = [],
  idempotencyKey = null,
}) {
  const mode = creditsMode();
  const normalizedOperation = String(operationKey || "").trim().toLowerCase();
  const calculatedCredits = Number.isFinite(Number(credits))
    ? Math.max(0, Math.trunc(Number(credits)))
    : calculateOperationCredits(normalizedOperation, { units, extras });
  const key = String(idempotencyKey || `${normalizedOperation}:${crypto.randomUUID()}`);
  if (mode === "off") {
    return bypassReservation({ operationKey: normalizedOperation, credits: calculatedCredits, reason: "credits_off", idempotencyKey: key });
  }

  const context = billingContext({ mlCreds, account });
  if (hasUnlimitedAccess(context)) {
    return bypassReservation({
      operationKey: normalizedOperation,
      credits: 0,
      reason: "unlimited_account",
      idempotencyKey: key,
    });
  }

  try {
    await ensureAccountSynced(context);
    const response = await postHub("/v1/internal/ml/credits/reserve", {
      account_id: context.accountId,
      operation_key: normalizedOperation,
      idempotency_key: key,
      credits: calculatedCredits,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    if (!response.ok) throw responseError(response, "Nao foi possivel reservar os creditos.");
    return {
      ...response.data.reservation,
      bypass: false,
      wallet: response.data.wallet || null,
      access: response.data.access || null,
    };
  } catch (error) {
    if (mode === "monitor") {
      console.warn("[hub-credits] reserva em modo monitor:", error?.code || error?.message || error);
      return bypassReservation({
        operationKey: normalizedOperation,
        credits: calculatedCredits,
        reason: error?.code || "monitor_bypass",
        idempotencyKey: key,
      });
    }
    if (error instanceof HubCreditError) throw error;
    throw new HubCreditError("Hub indisponivel para validar os creditos.", {
      code: "hub_credits_unreachable",
      details: error?.message || String(error),
    });
  }
}

async function settleCredits(reservation, { release = false, consumedCredits = null } = {}) {
  if (!reservation || reservation.bypass) return reservation || null;
  const idempotencyKey = String(reservation.idempotency_key || "").trim();
  if (!idempotencyKey) return null;
  const reserved = Math.max(0, Number(reservation.reserved_credits || 0));
  try {
    const response = await postHub("/v1/internal/ml/credits/settle", {
      idempotency_key: idempotencyKey,
      consumed_credits: consumedCredits === null ? reserved : Math.max(0, Math.trunc(Number(consumedCredits) || 0)),
      release: Boolean(release),
    });
    if (!response.ok) throw responseError(response, "Nao foi possivel liquidar a reserva de creditos.");
    return response.data.reservation || null;
  } catch (error) {
    console.error("[hub-credits] falha ao liquidar reserva:", idempotencyKey, error?.code || error?.message || error);
    return null;
  }
}

async function reserveAdsFilterCredits({ mlCreds, account = null, filters = {}, idempotencyKey = null }) {
  return reserveCredits({
    mlCreds,
    account,
    operationKey: "ads.filter",
    credits: estimateAdsFilterCredits(filters),
    idempotencyKey,
  });
}

module.exports = {
  buildPlanCheckoutUrl,
  HubCreditError,
  billingContext,
  createCreditTopupCheckout,
  getCreditAccountAccess,
  getCreditActivity,
  getCreditPolicy,
  hasUnlimitedAccess,
  unlinkBillingResource,
  reserveAdsFilterCredits,
  reserveCredits,
  settleCredits,
};
