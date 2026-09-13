"use strict";

const {
  PRODUCT_KINDS,
  getCommercialPlan,
  getCommercialProduct,
  products: productCatalog,
} = require("./productCatalog");

const ACCESSIBLE_STATUSES = new Set(["contracted", "configuring", "active"]);
const ACTIVE_STATUSES = new Set(["active"]);

function isoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function currentPeriod(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

function normalizeSubscription(subscription = {}) {
  return {
    id: subscription.id || null,
    productKey: String(subscription.productKey || subscription.product_key || "").trim(),
    planKey: String(subscription.planKey || subscription.plan_key || "").trim().toLowerCase() || null,
    status: String(subscription.status || "").trim().toLowerCase() || "available",
    contractedAt: isoDate(subscription.contractedAt || subscription.contracted_at),
    activatedAt: isoDate(subscription.activatedAt || subscription.activated_at),
    suspendedAt: isoDate(subscription.suspendedAt || subscription.suspended_at),
    metadata: subscription.metadata && typeof subscription.metadata === "object" ? { ...subscription.metadata } : {},
    updatedAt: isoDate(subscription.updatedAt || subscription.updated_at),
  };
}

function buildDefaultSubscriptionRows({ segmentKey = "general", corePlanKey = "starter" } = {}) {
  const rows = [
    { productKey: "core", planKey: corePlanKey, status: "active", metadata: { source: "core" } },
  ];
  if (String(segmentKey).toLowerCase() === "optical") {
    rows.push({ productKey: "vertical.optical", planKey: "standard", status: "active", metadata: { source: "segment_template" } });
  }
  return rows;
}

function buildCommercialSnapshot({
  segmentKey = "general",
  corePlanKey = "starter",
  subscriptions,
  usageRows = [],
  now = new Date(),
} = {}) {
  const sourceRows = Array.isArray(subscriptions)
    ? subscriptions
    : buildDefaultSubscriptionRows({ segmentKey, corePlanKey });
  const subscriptionMap = new Map(sourceRows.map((row) => {
    const normalized = normalizeSubscription(row);
    return [normalized.productKey, normalized];
  }));
  if (!subscriptionMap.has("core")) {
    subscriptionMap.set("core", normalizeSubscription({ productKey: "core", planKey: corePlanKey, status: "active", metadata: { source: "core_virtual" } }));
  }

  const period = currentPeriod(now);
  const usageMap = new Map((usageRows || []).map((row) => [
    `${row.productKey || row.product_key}:${row.metricKey || row.metric_key}`,
    Number(row.usedCount ?? row.used_count ?? 0),
  ]));

  const catalog = productCatalog.map((product) => {
    const subscription = subscriptionMap.get(product.key) || null;
    const status = product.alwaysActive
      ? "active"
      : product.comingSoon && !subscription
        ? "coming_soon"
        : subscription?.status || "available";
    const planKey = product.key === "core"
      ? String(corePlanKey || subscription?.planKey || "starter").toLowerCase()
      : subscription?.planKey || product.defaultPlanKey || null;
    const selectedPlan = getCommercialPlan(product, planKey);
    const limit = selectedPlan?.limits?.[product.usageLimitKey] ?? null;
    const used = product.usageMetricKey
      ? Number(usageMap.get(`${product.key}:${product.usageMetricKey}`) || 0)
      : 0;
    const remaining = limit === null ? null : Math.max(0, Number(limit) - used);
    const percent = limit && Number(limit) > 0 ? Math.min(100, Math.round((used / Number(limit)) * 100)) : 0;
    return {
      key: product.key,
      kind: product.kind,
      name: product.name,
      shortName: product.shortName,
      description: product.description,
      status,
      comingSoon: Boolean(product.comingSoon),
      accessible: product.alwaysActive || ACCESSIBLE_STATUSES.has(status),
      active: product.alwaysActive || ACTIVE_STATUSES.has(status),
      planKey,
      selectedPlan: selectedPlan ? { ...selectedPlan, limits: { ...(selectedPlan.limits || {}) } } : null,
      plans: (product.plans || []).map((plan) => ({ ...plan, limits: { ...(plan.limits || {}) } })),
      usage: product.usageMetricKey ? {
        metricKey: product.usageMetricKey,
        unit: product.usageUnit || "itens",
        used,
        limit,
        remaining,
        percent,
        periodStart: period.start,
        periodEnd: period.end,
      } : null,
      subscription,
    };
  });

  const active = catalog.filter((product) => product.active);
  return {
    products: catalog,
    subscriptions: [...subscriptionMap.values()],
    summary: {
      corePlanKey: String(corePlanKey || "starter").toLowerCase(),
      verticals: active.filter((product) => product.kind === PRODUCT_KINDS.VERTICAL).length,
      services: active.filter((product) => product.kind === PRODUCT_KINDS.SERVICE).length,
      channels: active.filter((product) => product.kind === PRODUCT_KINDS.CHANNEL).length,
    },
  };
}

function productsForConfiguration(configuration = {}) {
  if (Array.isArray(configuration?.commercial?.products)) return configuration.commercial.products;
  return buildCommercialSnapshot({
    segmentKey: configuration.segmentKey,
    corePlanKey: configuration.planKey,
  }).products;
}

function productState(configuration, productKey) {
  return productsForConfiguration(configuration).find((product) => product.key === productKey) || null;
}

function commercialModuleGrants(configuration = {}) {
  const result = new Set();
  for (const state of productsForConfiguration(configuration)) {
    if (!state.accessible) continue;
    const definition = getCommercialProduct(state.key);
    for (const moduleKey of definition?.moduleKeys || []) result.add(moduleKey);
  }
  return [...result];
}

function commercialScreenGrants(configuration = {}) {
  const result = new Set();
  for (const state of productsForConfiguration(configuration)) {
    if (!state.accessible) continue;
    const definition = getCommercialProduct(state.key);
    for (const screenKey of definition?.screenKeys || []) result.add(screenKey);
  }
  return [...result];
}

function commercialCapabilities(configuration = {}) {
  const result = new Set();
  for (const state of productsForConfiguration(configuration)) {
    const definition = getCommercialProduct(state.key);
    if (!definition) continue;
    if (state.accessible) for (const capability of definition.capabilities || []) result.add(capability);
    if (state.active) for (const capability of definition.activeCapabilities || []) result.add(capability);
  }
  return [...result];
}

function commercialLimits(configuration = {}) {
  const limits = {};
  for (const state of productsForConfiguration(configuration)) {
    if (!state.accessible || !state.selectedPlan?.limits) continue;
    Object.assign(limits, state.selectedPlan.limits);
  }
  return limits;
}

function ownersFor(kind, key) {
  return productCatalog.filter((product) => (product[kind] || []).includes(key));
}

function isCommerciallyAllowedModule(configuration = {}, moduleKey) {
  const owners = ownersFor("ownedModuleKeys", moduleKey);
  if (!owners.length) return true;
  return owners.some((owner) => Boolean(productState(configuration, owner.key)?.accessible));
}

function isCommerciallyAllowedScreen(configuration = {}, screenKey) {
  const owners = ownersFor("ownedScreenKeys", screenKey);
  if (!owners.length) return true;
  return owners.some((owner) => Boolean(productState(configuration, owner.key)?.accessible));
}

function isCommercialProductActive(configuration = {}, productKey) {
  return Boolean(productState(configuration, productKey)?.active);
}

module.exports = {
  ACCESSIBLE_STATUSES,
  ACTIVE_STATUSES,
  buildCommercialSnapshot,
  buildDefaultCommercialSnapshot: (input) => buildCommercialSnapshot({ ...input, subscriptions: undefined }),
  buildDefaultSubscriptionRows,
  commercialCapabilities,
  commercialLimits,
  commercialModuleGrants,
  commercialScreenGrants,
  currentPeriod,
  isCommerciallyAllowedModule,
  isCommerciallyAllowedScreen,
  isCommercialProductActive,
  normalizeSubscription,
  productState,
  productsForConfiguration,
};
