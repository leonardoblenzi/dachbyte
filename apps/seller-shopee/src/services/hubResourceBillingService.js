"use strict";

const DEFAULT_TIMEOUT_MS = 5000;
const SYNC_TTL_MS = 5 * 60 * 1000;
const MODULE_SLUG = "shopee";
const DEFAULT_PLAN_CODE = "shopee_pro";
const DEFAULT_RANGE_CODE = "up_to_30";
const DISABLED_VALUES = new Set(["", "0", "false", "off", "none", "disabled", "null", "undefined"]);
const syncedResources = new Map();

class HubBillingError extends Error {
  constructor(message, { statusCode = 503, code = "hub_billing_error", details = null } = {}) {
    super(message);
    this.name = "HubBillingError";
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

function billingMode() {
  const value = String(process.env.HUB_RESOURCE_BILLING_MODE || process.env.HUB_CREDITS_MODE || "monitor")
    .trim()
    .toLowerCase();
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

async function requestHub(method, pathname, payload = null) {
  const config = hubConfig();
  if (!config.baseUrl || !config.token) {
    throw new HubBillingError("Hub de billing nao configurado.", {
      code: "hub_billing_not_configured",
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

function responseError(response, fallbackMessage) {
  const code = String(response?.data?.error || response?.data?.reason || "hub_billing_request_failed");
  const messages = {
    insufficient_credits: "Creditos insuficientes para iniciar esta operacao.",
    awaiting_subscription: "Esta loja precisa de uma assinatura ativa.",
    suspended_by_range: "A faixa contratada desta loja precisa ser regularizada.",
    suspended_by_payment: "O pagamento desta loja precisa ser regularizado.",
  };
  return new HubBillingError(messages[code] || fallbackMessage, {
    statusCode: Number(response?.status || 503),
    code,
    details: response?.data || null,
  });
}

function buildResourceContext({
  auth = null,
  account = null,
  shop = null,
  status = null,
  billingMode = null,
  usagePolicy = null,
  rangeEnforcement = null,
  planCode = null,
  orderRangeCode = null,
} = {}) {
  const tenantId = String(auth?.tenantGlobalId || account?.tenantGlobalId || "").trim();
  const externalAccountId = String(shop?.shopId || shop?.shopeeShopId || shop?.shop_id || "").trim();
  const localShopId = shop?.id == null ? null : Number(shop.id);
  const label = String(shop?.name || account?.name || auth?.accountName || externalAccountId).trim() || externalAccountId;
  return {
    tenantId,
    moduleSlug: MODULE_SLUG,
    accountId: externalAccountId,
    label,
    status: String(status || shop?.billingStatus || "legacy_active").trim(),
    billingMode: String(billingMode || shop?.billingMode || "legacy").trim(),
    usagePolicy: String(usagePolicy || shop?.usagePolicy || "unlimited").trim(),
    rangeEnforcement: rangeEnforcement == null ? Boolean(shop?.rangeEnforcement) : Boolean(rangeEnforcement),
    planCode: planCode || shop?.planCode || DEFAULT_PLAN_CODE,
    orderRangeCode: orderRangeCode || shop?.orderRangeCode || DEFAULT_RANGE_CODE,
    localShopId,
  };
}

function hasUnlimitedAccess(context = {}) {
  const status = String(context.status || "").trim().toLowerCase();
  const billing = String(context.billingMode || "").trim().toLowerCase();
  const usage = String(context.usagePolicy || "").trim().toLowerCase();
  return (
    usage === "unlimited" ||
    ["internal_unlimited", "courtesy_unlimited"].includes(status) ||
    (status === "legacy_active" && billing === "legacy")
  );
}

function buildPlanCheckoutUrl({
  auth = null,
  account = null,
  shop = null,
  cycle = "monthly",
  orderRangeCode = null,
  customerEmail = null,
  customerName = null,
  successUrl = null,
} = {}) {
  const config = hubConfig();
  if (!config.baseUrl) return null;

  const context = buildResourceContext({ auth, account, shop, orderRangeCode });
  if (!context.tenantId || !context.accountId) return null;

  const selectedCycle = ["monthly", "quarterly", "annual"].includes(String(cycle || "").toLowerCase())
    ? String(cycle).toLowerCase()
    : "monthly";
  const rangeCode = String(orderRangeCode || context.orderRangeCode || DEFAULT_RANGE_CODE).trim() || DEFAULT_RANGE_CODE;
  const params = new URLSearchParams();
  params.set("renewal", "1");
  params.set("cycle", selectedCycle);
  params.set("tenant_id", context.tenantId);
  params.set("modules", MODULE_SLUG);
  params.set("ranges", `${MODULE_SLUG}:${rangeCode}`);
  params.set("billing_resource_key", `${MODULE_SLUG}:${context.accountId}`);
  params.set("billing_module_slug", MODULE_SLUG);
  params.set("billing_account_id", context.accountId);
  if (customerEmail) params.set("customer_email", String(customerEmail).trim());
  if (customerName) params.set("customer_name", String(customerName).trim());
  if (account?.name || auth?.accountName) params.set("company_name", String(account?.name || auth?.accountName).trim());
  if (successUrl) params.set("success_url", String(successUrl).trim());
  return `${config.baseUrl}/?${params.toString()}`;
}

async function syncResource(context) {
  if (!context.tenantId || !context.accountId) {
    throw new HubBillingError("Loja sem identidade global para billing.", {
      statusCode: 409,
      code: "billing_identity_missing",
    });
  }

  const cacheKey = `${context.tenantId}:${MODULE_SLUG}:${context.accountId}`;
  const cachedAt = Number(syncedResources.get(cacheKey) || 0);
  if (Date.now() - cachedAt < SYNC_TTL_MS) return null;

  const response = await requestHub("POST", "/v1/internal/resources/sync", {
    tenant_id: context.tenantId,
    module_slug: MODULE_SLUG,
    account_id: context.accountId,
    label: context.label,
    status: context.status,
    billing_mode: context.billingMode,
    usage_policy: context.usagePolicy,
    range_enforcement: context.rangeEnforcement,
    plan_code: context.planCode,
    order_range_code: context.orderRangeCode,
    metadata: { shopee_local_shop_id: context.localShopId },
  });
  if (!response.ok) {
    throw responseError(response, "Nao foi possivel sincronizar a loja com o Hub.");
  }
  syncedResources.set(cacheKey, Date.now());
  return response.data?.resource || response.data?.account || null;
}

async function ensureShopResourceSynced(input = {}) {
  const mode = billingMode();
  if (mode === "off") return { bypass: true, reason: "billing_off" };

  const context = buildResourceContext(input);
  try {
    const resource = await syncResource(context);
    return { context, resource, bypass: false };
  } catch (error) {
    if (mode === "monitor") {
      console.warn("[hub-billing] sync em modo monitor:", error?.code || error?.message || error);
      return { context, bypass: true, reason: error?.code || "monitor_bypass" };
    }
    throw error;
  }
}

async function checkShopResourceAccess(input = {}) {
  const mode = billingMode();
  if (mode === "off") return { allow: true, reason: "billing_off" };

  const context = buildResourceContext(input);
  if (hasUnlimitedAccess(context)) {
    return { allow: true, reason: "unlimited_resource", billing_context: context };
  }

  try {
    await syncResource(context);
    const response = await requestHub("POST", "/v1/internal/resources/access", {
      module_slug: MODULE_SLUG,
      account_id: context.accountId,
    });
    if (!response.ok) throw responseError(response, "Nao foi possivel validar acesso da loja no Hub.");
    const access = response.data?.access || response.data || {};
    if (access.allow === false && mode === "monitor") {
      return { ...access, allow: true, reason: access.reason || "hub_denied_monitor", billing_context: context };
    }
    return { ...access, allow: access.allow !== false, billing_context: context };
  } catch (error) {
    if (mode === "monitor") {
      console.warn("[hub-billing] access em modo monitor:", error?.code || error?.message || error);
      return { allow: true, reason: error?.code || "monitor_bypass", billing_context: context };
    }
    throw error;
  }
}

async function getCreditPolicy() {
  const response = await requestHub("GET", "/v1/internal/resources/credits/policy");
  if (!response.ok) {
    throw responseError(response, "Nao foi possivel carregar a politica de creditos.");
  }
  return response.data || {};
}

async function getShopCreditActivity({ auth = null, account = null, shop = null, limit = 50 } = {}) {
  const context = buildResourceContext({ auth, account, shop });
  const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 50)));

  await syncResource(context);
  const response = await requestHub(
    "GET",
    `/v1/internal/resources/credits/activity?module_slug=${encodeURIComponent(MODULE_SLUG)}&account_id=${encodeURIComponent(context.accountId)}&limit=${safeLimit}`,
  );
  if (!response.ok) {
    throw responseError(response, "Nao foi possivel carregar a carteira de creditos.");
  }

  return {
    ...response.data,
    billing_context: context,
    unlimited: hasUnlimitedAccess(context),
  };
}

async function createCreditTopupCheckout({
  auth = null,
  account = null,
  shop = null,
  packageCode = null,
  customerEmail = null,
  customerName = null,
  successUrl = null,
} = {}) {
  const context = buildResourceContext({ auth, account, shop });
  const normalizedPackageCode = String(packageCode || "").trim();
  if (!normalizedPackageCode) {
    throw new HubBillingError("Informe o pacote de creditos.", {
      statusCode: 400,
      code: "package_code_required",
    });
  }

  await syncResource(context);
  const response = await requestHub("POST", "/v1/internal/resources/credits/topup/checkout", {
    module_slug: MODULE_SLUG,
    account_id: context.accountId,
    package_code: normalizedPackageCode,
    customer_email: customerEmail,
    customer_name: customerName,
    success_url: successUrl,
    metadata: {
      source: "davantti_shopee",
      tenant_id: context.tenantId,
      local_shop_id: context.localShopId,
      shopee_shop_id: context.accountId,
    },
  });
  if (!response.ok) {
    throw responseError(response, "Nao foi possivel iniciar a recarga de creditos.");
  }
  return response.data || {};
}

function bypassReservation({ operationKey, credits, reason, idempotencyKey }) {
  return {
    bypass: true,
    reason,
    operation_key: operationKey,
    idempotency_key: idempotencyKey || null,
    reserved_credits: Math.max(0, Math.trunc(Number(credits) || 0)),
  };
}

async function reserveShopCredits({
  auth = null,
  account = null,
  shop = null,
  operationKey = null,
  credits = 0,
  idempotencyKey = null,
  metadata = null,
} = {}) {
  const mode = billingMode();
  const normalizedOperation = String(operationKey || "").trim();
  const key = String(idempotencyKey || "").trim();
  const calculatedCredits = Math.max(0, Math.trunc(Number(credits) || 0));
  if (!normalizedOperation || !key) {
    throw new HubBillingError("Operacao de creditos invalida.", {
      statusCode: 400,
      code: "credit_reservation_invalid_payload",
    });
  }

  if (mode === "off") {
    return bypassReservation({
      operationKey: normalizedOperation,
      credits: calculatedCredits,
      reason: "billing_off",
      idempotencyKey: key,
    });
  }

  const context = buildResourceContext({ auth, account, shop });
  if (hasUnlimitedAccess(context) || calculatedCredits <= 0) {
    return bypassReservation({
      operationKey: normalizedOperation,
      credits: calculatedCredits,
      reason: calculatedCredits <= 0 ? "zero_cost" : "unlimited_resource",
      idempotencyKey: key,
    });
  }

  try {
    await syncResource(context);
    const response = await requestHub("POST", "/v1/internal/resources/credits/reserve", {
      module_slug: MODULE_SLUG,
      account_id: context.accountId,
      operation_key: normalizedOperation,
      idempotency_key: key,
      credits: calculatedCredits,
      metadata: {
        source: "davantti_shopee",
        tenant_id: context.tenantId,
        local_shop_id: context.localShopId,
        ...(metadata && typeof metadata === "object" ? metadata : {}),
      },
    });
    if (!response.ok) throw responseError(response, "Nao foi possivel reservar os creditos.");
    return {
      ...(response.data?.reservation || {}),
      wallet: response.data?.wallet || null,
      access: response.data?.access || null,
      billing_context: context,
    };
  } catch (error) {
    if (mode === "monitor") {
      console.warn("[hub-billing] reserva em modo monitor:", error?.code || error?.message || error);
      return bypassReservation({
        operationKey: normalizedOperation,
        credits: calculatedCredits,
        reason: error?.code || "monitor_bypass",
        idempotencyKey: key,
      });
    }
    throw error;
  }
}

async function settleShopCredits(reservation, { consumedCredits = null, release = false } = {}) {
  if (!reservation || reservation.bypass) return { bypass: true };
  const idempotencyKey = String(reservation.idempotency_key || reservation.idempotencyKey || "").trim();
  if (!idempotencyKey) return { bypass: true, reason: "missing_idempotency_key" };

  const reserved = Math.max(0, Number(reservation.reserved_credits || reservation.reservedCredits || 0));
  try {
    const response = await requestHub("POST", "/v1/internal/resources/credits/settle", {
      idempotency_key: idempotencyKey,
      consumed_credits:
        consumedCredits === null ? reserved : Math.max(0, Math.trunc(Number(consumedCredits) || 0)),
      release: Boolean(release),
    });
    if (!response.ok) throw responseError(response, "Nao foi possivel liquidar os creditos.");
    return response.data || {};
  } catch (error) {
    console.error("[hub-billing] falha ao liquidar reserva:", idempotencyKey, error?.code || error?.message || error);
    return { ok: false, error: error?.code || "credit_settlement_failed" };
  }
}

module.exports = {
  buildPlanCheckoutUrl,
  HubBillingError,
  buildResourceContext,
  checkShopResourceAccess,
  createCreditTopupCheckout,
  ensureShopResourceSynced,
  getCreditPolicy,
  getShopCreditActivity,
  hasUnlimitedAccess,
  reserveShopCredits,
  settleShopCredits,
};
