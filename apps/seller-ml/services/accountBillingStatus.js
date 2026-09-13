"use strict";

const ACTIVE_STATUSES = new Set([
  "active",
  "legacy_active",
  "courtesy_unlimited",
  "internal_unlimited",
]);

const BLOCKED_STATUSES = new Set([
  "awaiting_subscription",
  "unlinked",
  "suspended_by_range",
  "suspended_by_payment",
  "expired",
  "past_due",
  "refunded",
  "chargeback",
]);

const RANGE_LABELS = {
  up_to_30: "Ate 30 vendas",
  up_to_200: "Ate 200 pedidos",
  from_31_to_200: "31 a 200 vendas",
  from_201_to_700: "201 a 700 vendas",
  from_701_to_1500: "701 a 1.500 vendas",
  above_1500: "Acima de 1.500 vendas",
};

const STATUS_META = {
  active: {
    label: "Assinatura ativa",
    tone: "ok",
    reason: "Conta liberada pelo plano contratado.",
  },
  legacy_active: {
    label: "Legado ilimitado",
    tone: "ok",
    reason: "Conta preservada na migracao, sem bloqueio automatico.",
  },
  courtesy_unlimited: {
    label: "Cortesia ilimitada",
    tone: "ok",
    reason: "Conta marcada como cortesia, sem bloqueio automatico.",
  },
  internal_unlimited: {
    label: "Interna ilimitada",
    tone: "ok",
    reason: "Conta interna Davantti, sem bloqueio automatico.",
  },
  awaiting_subscription: {
    label: "Aguardando assinatura",
    tone: "danger",
    reason: "Esta conta precisa contratar uma assinatura para operar.",
  },
  unlinked: {
    label: "Conta desvinculada",
    tone: "danger",
    reason: "Esta conta foi desvinculada da empresa e precisa ser autorizada novamente.",
  },
  range_exceeded: {
    label: "Faixa excedida",
    tone: "warn",
    reason: "Volume acima da faixa contratada. Regularize para manter operacoes.",
  },
  suspended_by_range: {
    label: "Suspensa por faixa",
    tone: "danger",
    reason: "Prazo de regularizacao encerrado. Atualize a faixa para reativar.",
  },
  suspended_by_payment: {
    label: "Pagamento pendente",
    tone: "danger",
    reason: "Assinatura pendente ou cancelada. Regularize para reativar.",
  },
  expired: {
    label: "Assinatura vencida",
    tone: "danger",
    reason: "Plano vencido. Renove a assinatura desta conta.",
  },
  past_due: {
    label: "Pagamento atrasado",
    tone: "danger",
    reason: "Pagamento em atraso. Regularize para reativar.",
  },
  refunded: {
    label: "Pagamento estornado",
    tone: "danger",
    reason: "Pagamento foi reembolsado. E necessario renovar a conta.",
  },
  chargeback: {
    label: "Pagamento contestado",
    tone: "danger",
    reason: "Pagamento contestado. E necessario revisar a assinatura.",
  },
};

function normalizeBillingStatus(value) {
  return String(value || "legacy_active").trim().toLowerCase();
}

function normalizeBillingMode(value) {
  return String(value || "legacy").trim().toLowerCase();
}

function normalizeUsagePolicy(value) {
  return String(value || "metered").trim().toLowerCase();
}

function isFutureDate(value) {
  if (!value) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() > Date.now();
}

function isUnlimitedAccount(account = {}) {
  const status = normalizeBillingStatus(account.billing_status || account.status);
  const mode = normalizeBillingMode(account.billing_mode);
  const policy = normalizeUsagePolicy(account.usage_policy);

  return (
    policy === "unlimited" ||
    status === "courtesy_unlimited" ||
    status === "internal_unlimited" ||
    (status === "legacy_active" && mode === "legacy")
  );
}

function canOperateAccount(account = {}) {
  const status = normalizeBillingStatus(account.billing_status || account.status);
  if (isUnlimitedAccount(account)) return true;
  if (["range_exceeded", "awaiting_subscription", "suspended_by_payment"].includes(status)) {
    return isFutureDate(account.billing_grace_expires_at);
  }
  if (BLOCKED_STATUSES.has(status)) return false;
  return ACTIVE_STATUSES.has(status);
}

function orderRangeLabel(code) {
  const normalized = String(code || "").trim();
  return RANGE_LABELS[normalized] || normalized || "Faixa nao definida";
}

function recommendedRangeForOrders(orderCount) {
  const total = Number(orderCount || 0);
  if (!Number.isFinite(total) || total <= 30) return "up_to_30";
  if (total <= 200) return "from_31_to_200";
  if (total <= 700) return "from_201_to_700";
  if (total <= 1500) return "from_701_to_1500";
  return "above_1500";
}

function resolveRecommendedRange(account = {}) {
  const explicit = String(account.recommended_range_code || "").trim();
  if (explicit) return explicit;

  const orders = Number(account.last_closed_period_orders);
  if (Number.isFinite(orders) && orders > 0) {
    return recommendedRangeForOrders(orders);
  }

  return String(account.order_range_code || account.billing_order_range_code || "up_to_30").trim();
}

function buildAccountBillingPayload(account = {}, options = {}) {
  const status = normalizeBillingStatus(account.billing_status || account.status);
  const mode = normalizeBillingMode(account.billing_mode);
  const policy = normalizeUsagePolicy(account.usage_policy);
  const graceActive =
    ["awaiting_subscription", "suspended_by_payment"].includes(status) &&
    isFutureDate(account.billing_grace_expires_at);
  const defaultMeta = STATUS_META[status] || {
    label: status || "Status indefinido",
    tone: "neutral",
    reason: "Status comercial ainda nao mapeado.",
  };
  const meta = graceActive
    ? {
        label: "Prazo de regularizacao",
        tone: "warn",
        reason: "Conta liberada temporariamente ate o prazo administrativo informado.",
      }
    : defaultMeta;
  const orderRangeCode = String(account.order_range_code || account.billing_order_range_code || "").trim();
  const recommendedRangeCode = resolveRecommendedRange(account);
  const canOperate = canOperateAccount(account);
  const unlimited = isUnlimitedAccount(account);
  const requiresRegularization = !unlimited && !canOperate;
  const requiresUpgrade = !unlimited && status === "range_exceeded";

  return {
    status,
    billing_mode: mode,
    usage_policy: policy,
    range_enforcement: Boolean(account.range_enforcement),
    label: meta.label,
    tone: canOperate && meta.tone === "danger" ? "warn" : meta.tone,
    reason: meta.reason,
    can_operate: canOperate,
    is_unlimited: unlimited,
    requires_regularization: requiresRegularization,
    requires_upgrade: requiresUpgrade,
    plan_code: account.plan_code || account.billing_plan_code || "ml_pro",
    order_range_code: orderRangeCode || null,
    order_range_label: orderRangeLabel(orderRangeCode),
    recommended_range_code: recommendedRangeCode || null,
    recommended_range_label: orderRangeLabel(recommendedRangeCode),
    last_closed_period_orders:
      account.last_closed_period_orders == null
        ? null
        : Number(account.last_closed_period_orders),
    grace_expires_at: account.billing_grace_expires_at || null,
    review_due_at: account.billing_review_due_at || null,
    renewal_checkout_url: options.renewalCheckoutUrl || account.renewal_checkout_url || null,
  };
}

module.exports = {
  buildAccountBillingPayload,
  canOperateAccount,
  isUnlimitedAccount,
  normalizeBillingStatus,
  orderRangeLabel,
  recommendedRangeForOrders,
};
