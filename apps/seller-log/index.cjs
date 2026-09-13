"use strict";

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const {
  createIntelipostClient,
  normalizeInvoiceKey,
  safeString,
} = require("./src/intelipostClient.cjs");
const davanttiLogDb = require("./src/db.cjs");
const reconciliationEngine = require("./src/reconciliationEngine.cjs");

const MODULE_ID = "davanttilog";
const MODULE_ALIASES = new Set([
  "davanttilog",
  "davantti-log",
  "davantti_log",
  "davanlog",
]);
const ADMIN_EMAIL = "admin@davanlog.com";
const ADMIN_PASSWORD = "Alfenas@172839";

const JWT_SECRET =
  String(process.env.DAVANTTILOG_JWT_SECRET || "").trim() ||
  String(process.env.SUITE_JWT_SECRET || "").trim() ||
  String(process.env.ML_JWT_SECRET || "").trim() ||
  String(process.env.JWT_SECRET || "").trim() ||
  "davanttilog-dev-secret";

const SUITE_JWT_SECRET =
  String(process.env.SUITE_JWT_SECRET || "").trim() ||
  String(process.env.ML_JWT_SECRET || "").trim() ||
  String(process.env.JWT_SECRET || "").trim();

const HUB_BASE_URL = String(process.env.HUB_BASE_URL || "")
  .trim()
  .replace(/\/+$/, "");
const HUB_INTERNAL_TOKEN = String(process.env.HUB_INTERNAL_TOKEN || "").trim();

const demoItems = [
  {
    id: "DL-1001",
    batch_id: "BAT-2026-06",
    order_id: "MLB-94012001",
    marketplace_order_number: "2000014927",
    intelipost_order_number: "IP-882910",
    sales_channel: "Mercado Livre",
    customer_name: "Pedido marketplace",
    carrier_name: "Jadlog",
    delivery_service: "Package",
    destination_uf: "SP",
    destination_zipcode: "13010-101",
    order_amount: 489.9,
    customer_paid_shipping_amount: 79.9,
    tms_expected_amount: 74.35,
    carrier_charged_amount: 88.4,
    rule: {
      id: "rule-shipping-minus-10",
      name: "Cliente -10%",
      version: 3,
      operation: "percent_decrease",
      value: 10,
      source: "snapshot_regra_davantti",
      captured_at: "2026-06-28T12:10:00.000Z",
    },
    cte_key: "35260600000000000000570010000001234567890123",
    invoice_key: "35260600000000000000550010000003331000003331",
    billing_document: "FAT-JAD-0626",
    evidence: [
      { type: "Intelipost", label: "Cotacao IP-882910", captured_at: "2026-06-28T12:08:00.000Z" },
      { type: "CT-e", label: "CT-e vinculado", captured_at: "2026-06-28T18:22:00.000Z" },
      { type: "Regra", label: "Snapshot regra v3", captured_at: "2026-06-28T12:10:00.000Z" },
    ],
    status: "aguardando_conciliacao",
  },
  {
    id: "DL-1002",
    batch_id: "BAT-2026-06",
    order_id: "SHP-883001",
    marketplace_order_number: "250629AA77",
    intelipost_order_number: "IP-882933",
    sales_channel: "Shopee",
    customer_name: "Pedido Shopee",
    carrier_name: "Total Express",
    delivery_service: "Standard",
    destination_uf: "PR",
    destination_zipcode: "80420-090",
    order_amount: 329.0,
    customer_paid_shipping_amount: 41.9,
    tms_expected_amount: 42.1,
    carrier_charged_amount: 42.45,
    rule: {
      id: "rule-use-tms",
      name: "Usar valor TMS",
      version: 1,
      operation: "use_tms",
      value: 0,
      source: "snapshot_regra_davantti",
      captured_at: "2026-06-27T09:30:00.000Z",
    },
    cte_key: "41260600000000000000570010000001234567890123",
    invoice_key: "41260600000000000000550010000003331000003331",
    billing_document: "FAT-TEX-0626",
    evidence: [
      { type: "Intelipost", label: "Pedido IP-882933", captured_at: "2026-06-27T09:28:00.000Z" },
      { type: "Fatura", label: "Linha 118", captured_at: "2026-06-29T08:15:00.000Z" },
    ],
    status: "dentro_tolerancia",
  },
  {
    id: "DL-1003",
    batch_id: "BAT-2026-06",
    order_id: "TRAY-55109",
    marketplace_order_number: "55109",
    intelipost_order_number: null,
    sales_channel: "Tray",
    customer_name: "Pedido e-commerce",
    carrier_name: "Braspress",
    delivery_service: "Rodoviario",
    destination_uf: "MG",
    destination_zipcode: "37130-001",
    order_amount: 1299.99,
    customer_paid_shipping_amount: 0,
    tms_expected_amount: null,
    carrier_charged_amount: 126.7,
    rule: {
      id: "rule-free-shipping-review",
      name: "Frete gratis exige revisao",
      version: 2,
      operation: "manual_review",
      value: 0,
      source: "snapshot_regra_davantti",
      captured_at: "2026-06-26T16:00:00.000Z",
    },
    cte_key: null,
    invoice_key: "31260600000000000000550010000003331000003331",
    billing_document: "FAT-BRA-0626",
    evidence: [
      { type: "Fatura", label: "Linha 42", captured_at: "2026-06-29T08:15:00.000Z" },
      { type: "Canal", label: "Exportacao Tray", captured_at: "2026-06-26T15:54:00.000Z" },
    ],
    status: "dados_incompletos",
  },
  {
    id: "DL-1004",
    batch_id: "BAT-2026-06",
    order_id: "MLB-94013418",
    marketplace_order_number: "2000015120",
    intelipost_order_number: "IP-883101",
    sales_channel: "Mercado Livre",
    customer_name: "Pedido marketplace",
    carrier_name: "Loggi",
    delivery_service: "Express",
    destination_uf: "RJ",
    destination_zipcode: "20040-020",
    order_amount: 212.5,
    customer_paid_shipping_amount: 32.9,
    tms_expected_amount: 31.8,
    carrier_charged_amount: 31.8,
    rule: {
      id: "rule-use-customer",
      name: "Usar valor cliente",
      version: 4,
      operation: "use_customer",
      value: 0,
      source: "snapshot_regra_davantti",
      captured_at: "2026-06-25T11:20:00.000Z",
    },
    cte_key: "33260600000000000000570010000001234567890123",
    invoice_key: "33260600000000000000550010000003331000003331",
    billing_document: "FAT-LOG-0626",
    evidence: [
      { type: "Intelipost", label: "Cotacao IP-883101", captured_at: "2026-06-25T11:18:00.000Z" },
      { type: "CT-e", label: "CT-e vinculado", captured_at: "2026-06-25T19:40:00.000Z" },
    ],
    status: "sem_divergencia",
  },
];

const auditLog = [
  {
    id: "ACT-9001",
    item_id: "DL-1001",
    action_type: "divergencia_detectada",
    old_status: "nao_sincronizado",
    new_status: "aguardando_conciliacao",
    reason: "Transportadora acima da regra Davantti",
    created_by: "job:intelipost-sync",
    created_at: "2026-06-29T08:18:00.000Z",
  },
  {
    id: "ACT-9002",
    item_id: "DL-1002",
    action_type: "tolerancia_aplicada",
    old_status: "aguardando_conciliacao",
    new_status: "dentro_tolerancia",
    reason: "Diferenca inferior a R$ 1,00",
    created_by: "job:invoice-import",
    created_at: "2026-06-29T08:21:00.000Z",
  },
];

const integrationConfig = {
  intelipost_client_id: String(process.env.INTELIPOST_CLIENT_ID || "").trim(),
  api_key_configured: Boolean(String(process.env.INTELIPOST_API_KEY || "").trim()),
  sync_enabled: String(process.env.INTELIPOST_SYNC_ENABLED || "").toLowerCase() === "true",
  last_sync_at: null,
  docs_url: "https://docs.intelipost.com.br/",
  rest_base_url: String(process.env.INTELIPOST_REST_BASE_URL || "https://api.intelipost.com.br/api/v1").trim(),
  tracking_graphql_url: String(process.env.INTELIPOST_TRACKING_GRAPHQL_URL || "https://tracking-graphql.intelipost.com.br/").trim(),
  shipment_search_path: String(process.env.INTELIPOST_SHIPMENT_SEARCH_PATH || "/shipment_order").trim(),
  supported_sources: ["Intelipost API", "XLSX", "CSV", "XML CT-e", "TXT PROCEDA", "JSON"],
};
let intelipostApiKey = String(process.env.INTELIPOST_API_KEY || "").trim();
const tenantStores = new Map();

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function parseCookies(req) {
  if (req.cookies) return req.cookies;
  const header = String(req.headers.cookie || "");
  return header.split(";").reduce((acc, part) => {
    const index = part.indexOf("=");
    if (index < 0) return acc;
    const key = part.slice(0, index).trim();
    if (!key) return acc;
    acc[key] = decodeURIComponent(part.slice(index + 1).trim());
    return acc;
  }, {});
}

function moduleMatches(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return MODULE_ALIASES.has(normalized);
}

function hasModuleAccess(payload) {
  const modules = [
    ...(Array.isArray(payload?.allowed_modules) ? payload.allowed_modules : []),
    ...(Array.isArray(payload?.visible_modules) ? payload.visible_modules : []),
  ];
  return modules.some(moduleMatches);
}

function roleFromSuitePayload(payload = {}) {
  const email = normalizeEmail(payload.email);
  const role = String(payload.role || payload.nivel || payload.account_role || "")
    .trim()
    .toLowerCase();
  if (email === ADMIN_EMAIL) return "admin_master";
  if (["admin_master", "super_admin", "owner"].includes(role)) return "admin_master";
  if (["admin", "administrador", "manager"].includes(role)) return "admin";
  return "analyst";
}

function makeToken(user) {
  return jwt.sign(
    {
      module: MODULE_ID,
      sub: String(user.id),
      email: normalizeEmail(user.email),
      name: user.name,
      role: user.role,
      tenant_id: user.tenant_id || null,
      user_global_id: user.user_global_id || null,
    },
    JWT_SECRET,
    { expiresIn: "12h" },
  );
}

function readBearer(req) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  return String(parseCookies(req).davanttilog_token || "").trim();
}

function authenticate(req, res, next) {
  const token = readBearer(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: "Sessao Davantti Log ausente." });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!moduleMatches(payload.module)) {
      return res.status(403).json({ ok: false, error: "Token de modulo invalido." });
    }
    req.davanttiLogUser = payload;
    return next();
  } catch (_error) {
    return res.status(401).json({ ok: false, error: "Sessao Davantti Log expirada." });
  }
}

function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: String(process.env.NODE_ENV || "").toLowerCase() === "production",
    maxAge: maxAgeMs,
    path: "/",
  };
}

function sessionFromSuite(req) {
  const token = String(parseCookies(req).suite_auth_token || "").trim();
  if (!token || !SUITE_JWT_SECRET) return null;

  try {
    const payload = jwt.verify(token, SUITE_JWT_SECRET);
    if (!hasModuleAccess(payload)) return null;
    const email = normalizeEmail(payload.email);
    if (!email) return null;
    return {
      id: String(payload.user_id || email),
      email,
      name: String(payload.name || payload.full_name || email).trim(),
      role: roleFromSuitePayload(payload),
      tenant_id: String(payload.tenant_id || "").trim() || null,
      user_global_id: String(payload.user_id || "").trim() || null,
      source: "suite",
    };
  } catch (_error) {
    return null;
  }
}

async function verifyHubCredentials(email, password) {
  if (!HUB_BASE_URL || !HUB_INTERNAL_TOKEN) return null;
  const response = await fetch(`${HUB_BASE_URL}/v1/internal/auth/verify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${HUB_INTERNAL_TOKEN}`,
    },
    body: JSON.stringify({ email, password, module: MODULE_ID }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.allow) return null;
  return {
    id: String(payload.user_id || email),
    email: normalizeEmail(payload.email || email),
    name: String(payload.name || payload.full_name || email).trim(),
    role: roleFromSuitePayload(payload),
    tenant_id: String(payload.tenant_id || "").trim() || null,
    user_global_id: String(payload.user_id || "").trim() || null,
    source: "hub",
  };
}

function adminUser() {
  return {
    id: "davanttilog-admin",
    email: ADMIN_EMAIL,
    name: "Admin Davantti Log",
    role: "admin_master",
    tenant_id: "davanlog-admin",
    user_global_id: "davanlog-admin",
    source: "local_admin",
  };
}

function cloneDeep(value) {
  return JSON.parse(JSON.stringify(value));
}

function tenantKeyFromUser(user = {}) {
  const tenantId = safeString(user.tenant_id);
  if (tenantId) return tenantId;
  const accountId = safeString(user.account_id);
  if (accountId) return `account:${accountId}`;
  const email = normalizeEmail(user.email);
  if (email) return `email:${email}`;
  return "tenant:anonymous";
}

function accountKeyFromUser(user = {}) {
  return safeString(user.account_id) || safeString(user.tenant_id) || tenantKeyFromUser(user);
}

function createTenantStore(user = {}) {
  const tenantKey = tenantKeyFromUser(user);
  const accountKey = accountKeyFromUser(user);
  const now = new Date().toISOString();
  return {
    tenantKey,
    accountKey,
    items: cloneDeep(demoItems).map((item) => ({
      ...item,
      company_id: tenantKey,
      account_id: accountKey,
      created_at: item.created_at || now,
      updated_at: item.updated_at || now,
    })),
    auditLog: cloneDeep(auditLog).map((entry) => ({
      ...entry,
      tenant_id: tenantKey,
    })),
    integrationConfig: {
      ...cloneDeep(integrationConfig),
      tenant_id: tenantKey,
      account_id: accountKey,
      storage: davanttiLogDb.isDbEnabled() ? "postgres" : "memory",
    },
    intelipostApiKey,
    integrationHydrated: false,
  };
}

function getTenantStore(user = {}) {
  const tenantKey = tenantKeyFromUser(user);
  if (!tenantStores.has(tenantKey)) {
    tenantStores.set(tenantKey, createTenantStore(user));
  }
  return tenantStores.get(tenantKey);
}

function getTenantStoreFromReq(req) {
  return getTenantStore(req.davanttiLogUser || {});
}

async function hydrateTenantIntegration(store) {
  if (!store || store.integrationHydrated) return store;
  store.integrationHydrated = true;
  if (!davanttiLogDb.isDbEnabled()) return store;

  const saved = await davanttiLogDb
    .getIntelipostIntegration(store.tenantKey, store.accountKey)
    .catch(() => null);
  if (!saved) return store;

  store.integrationConfig = {
    ...store.integrationConfig,
    tenant_id: store.tenantKey,
    account_id: store.accountKey,
    intelipost_client_id: saved.intelipost_client_id || "",
    api_key_configured: saved.api_key_configured === true,
    sync_enabled: saved.sync_enabled === true,
    last_sync_at: saved.last_sync_at,
    rest_base_url: saved.rest_base_url || store.integrationConfig.rest_base_url,
    tracking_graphql_url:
      saved.tracking_graphql_url || store.integrationConfig.tracking_graphql_url,
    shipment_search_path:
      saved.shipment_search_path || store.integrationConfig.shipment_search_path,
    storage: saved.storage || "postgres",
    updated_at: saved.updated_at || null,
  };
  if (saved.api_key) {
    store.intelipostApiKey = saved.api_key;
  }
  return store;
}

function publicIntegrationConfig(store) {
  const tenantStore = store || getTenantStore({});
  return {
    ...tenantStore.integrationConfig,
    api_key_configured:
      Boolean(tenantStore.intelipostApiKey) ||
      tenantStore.integrationConfig.api_key_configured === true,
    api_key: undefined,
  };
}

function getIntelipostClient(store) {
  const tenantStore = store || getTenantStore({});
  return createIntelipostClient({
    apiKey: tenantStore.intelipostApiKey,
    clientId: tenantStore.integrationConfig.intelipost_client_id,
    restBaseUrl: tenantStore.integrationConfig.rest_base_url,
    trackingGraphqlUrl: tenantStore.integrationConfig.tracking_graphql_url,
    shipmentSearchPath: tenantStore.integrationConfig.shipment_search_path,
    timeoutMs: Number(process.env.INTELIPOST_TIMEOUT_MS || 20000),
  });
}

async function loadTenantItems(store) {
  const tenantStore = store || getTenantStore({});
  if (!davanttiLogDb.isDbEnabled()) return tenantStore.items;
  const items = await davanttiLogDb.listReconciliationItems(tenantStore.tenantKey);
  tenantStore.items = items;
  return items;
}

function filterItemList(items, query = {}) {
  const status = String(query.status || "").trim();
  const channel = String(query.channel || "").trim().toLowerCase();
  const carrier = String(query.carrier || "").trim().toLowerCase();
  const q = String(query.q || "").trim().toLowerCase();

  return (Array.isArray(items) ? items : [])
    .map((item) => reconciliationEngine.enrichItem(item))
    .filter((item) => {
      if (status && item.status !== status) return false;
      if (channel && String(item.sales_channel || "").toLowerCase() !== channel) return false;
      if (carrier && String(item.carrier_name || "").toLowerCase() !== carrier) return false;
      if (q) {
        const haystack = [
          item.order_id,
          item.marketplace_order_number,
          item.intelipost_order_number,
          item.tracking_code,
          item.invoice_key,
          item.cte_key,
          item.billing_document,
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
}

async function filterItemsAsync(store, query) {
  return filterItemList(await loadTenantItems(store), query);
}

async function upsertReconciliationItems(store, items, source, userEmail) {
  const tenantStore = store || getTenantStore({});
  const now = new Date().toISOString();
  const incoming = Array.isArray(items) ? items.filter(Boolean) : [];
  const touched = [];

  incoming.forEach((rawItem) => {
    const key = safeString(rawItem.id) ||
      safeString(rawItem.invoice_key) ||
      safeString(rawItem.order_id) ||
      crypto.randomUUID();
    const nextItem = reconciliationEngine.enrichItem({
      ...rawItem,
      id: key,
      company_id: tenantStore.tenantKey,
      account_id: tenantStore.accountKey,
      updated_at: now,
      created_at: rawItem.created_at || now,
    });
    touched.push(nextItem);
  });

  if (davanttiLogDb.isDbEnabled()) {
    const saved = await davanttiLogDb.upsertReconciliationItems({
      company_id: tenantStore.tenantKey,
      account_id: tenantStore.accountKey,
      items: touched,
      source,
      created_by: userEmail || "system",
    });
    tenantStore.items = await davanttiLogDb.listReconciliationItems(tenantStore.tenantKey);
    return reconciliationEngine.conciliateItems(saved);
  }

  const memoryTouched = [];
  touched.forEach((nextItem) => {
    const key = safeString(nextItem.id);
    const index = tenantStore.items.findIndex((item) =>
      safeString(item.id) === key ||
      (safeString(nextItem.invoice_key) && safeString(item.invoice_key) === safeString(nextItem.invoice_key)) ||
      (safeString(nextItem.order_id) && safeString(item.order_id) === safeString(nextItem.order_id))
    );

    if (index >= 0) {
      tenantStore.items[index] = {
        ...tenantStore.items[index],
        ...nextItem,
        evidence: [
          ...(Array.isArray(tenantStore.items[index].evidence) ? tenantStore.items[index].evidence : []),
          ...(Array.isArray(nextItem.evidence) ? nextItem.evidence : []),
        ],
      };
      memoryTouched.push(tenantStore.items[index]);
    } else {
      tenantStore.items.unshift(nextItem);
      memoryTouched.push(nextItem);
    }
  });

  if (memoryTouched.length) {
    tenantStore.auditLog.unshift({
      id: `ACT-${crypto.randomUUID()}`,
      item_id: null,
      tenant_id: tenantStore.tenantKey,
      action_type: "upsert_reconciliation_items",
      old_status: null,
      new_status: null,
      reason: `${memoryTouched.length} item(ns) importado(s) de ${source}.`,
      created_by: userEmail || "system",
      created_at: now,
    });
  }

  return reconciliationEngine.conciliateItems(memoryTouched);
}

function serializeIntelipostError(error) {
  return {
    code: error?.code || null,
    status: error?.status || null,
    message: error?.message || "Falha na Intelipost.",
    payload: error?.payload || null,
  };
}

function applyRule(item) {
  const customer = Number(item.customer_paid_shipping_amount);
  const tms = Number(item.tms_expected_amount);
  const rule = item.rule || {};
  const value = Number(rule.value || 0);
  if (rule.operation === "percent_decrease" && Number.isFinite(customer)) {
    return roundMoney(customer * (1 - value / 100));
  }
  if (rule.operation === "percent_increase" && Number.isFinite(customer)) {
    return roundMoney(customer * (1 + value / 100));
  }
  if (rule.operation === "fixed_decrease" && Number.isFinite(customer)) {
    return roundMoney(customer - value);
  }
  if (rule.operation === "fixed_increase" && Number.isFinite(customer)) {
    return roundMoney(customer + value);
  }
  if (rule.operation === "use_tms" && Number.isFinite(tms)) return roundMoney(tms);
  if (rule.operation === "use_customer" && Number.isFinite(customer)) return roundMoney(customer);
  return null;
}

function roundMoney(value) {
  if (!Number.isFinite(Number(value))) return null;
  return Math.round(Number(value) * 100) / 100;
}

function enrichItem(item) {
  const davanttiExpected = applyRule(item);
  const carrier = roundMoney(item.carrier_charged_amount);
  const tms = roundMoney(item.tms_expected_amount);
  const customer = roundMoney(item.customer_paid_shipping_amount);
  const tmsDifference =
    carrier === null || tms === null ? null : roundMoney(carrier - tms);
  const davanttiDifference =
    carrier === null || davanttiExpected === null ? null : roundMoney(carrier - davanttiExpected);
  const freightMargin =
    customer === null || carrier === null ? null : roundMoney(customer - carrier);

  return {
    ...item,
    davantti_expected_amount: davanttiExpected,
    tms_difference_amount: tmsDifference,
    davantti_difference_amount: davanttiDifference,
    freight_margin_amount: freightMargin,
    audit_formula: {
      carrier_charged_amount: {
        value: carrier,
        source: item.cte_key ? "CT-e/fatura transportadora" : "Fatura importada",
        captured_at: "2026-06-29T08:15:00.000Z",
      },
      tms_expected_amount: {
        value: tms,
        source: item.intelipost_order_number ? "Intelipost/TMS" : "nao_disponivel",
        captured_at: item.intelipost_order_number ? "2026-06-29T08:10:00.000Z" : null,
      },
      customer_paid_shipping_amount: {
        value: customer,
        source: item.sales_channel,
        captured_at: "2026-06-29T08:05:00.000Z",
      },
      davantti_expected_amount: {
        value: davanttiExpected,
        source: `${item.rule?.name || "Regra Davantti"} v${item.rule?.version || 1}`,
        captured_at: item.rule?.captured_at || null,
      },
      formulas: {
        divergencia_tms: "carrier_charged_amount - tms_expected_amount",
        divergencia_davantti: "carrier_charged_amount - davantti_expected_amount",
        margem_frete: "customer_paid_shipping_amount - carrier_charged_amount",
      },
    },
  };
}

function dashboardFromItems(items) {
  const enriched = items.map(enrichItem);
  const totals = enriched.reduce(
    (acc, item) => {
      acc.total_orders += 1;
      if (["sem_divergencia", "dentro_tolerancia", "fechado"].includes(item.status)) {
        acc.reconciled_orders += 1;
      }
      if (["aguardando_conciliacao", "divergencia_aprovada", "divergencia_contestada"].includes(item.status)) {
        acc.divergent_orders += 1;
      }
      if (item.status === "aguardando_conciliacao") acc.pending_review += 1;
      acc.total_carrier_amount += item.carrier_charged_amount || 0;
      acc.total_tms_amount += item.tms_expected_amount || 0;
      acc.total_customer_amount += item.customer_paid_shipping_amount || 0;
      acc.total_davantti_expected_amount += item.davantti_expected_amount || 0;
      acc.total_tms_difference += item.tms_difference_amount || 0;
      acc.total_davantti_difference += item.davantti_difference_amount || 0;
      acc.total_margin += item.freight_margin_amount || 0;
      if ((item.freight_margin_amount || 0) < 0) acc.total_loss += Math.abs(item.freight_margin_amount);
      if ((item.freight_margin_amount || 0) > 0) acc.total_gain += item.freight_margin_amount;
      if ((item.davantti_difference_amount || 0) > 1) acc.contestable_amount += item.davantti_difference_amount;
      return acc;
    },
    {
      total_orders: 0,
      reconciled_orders: 0,
      divergent_orders: 0,
      pending_review: 0,
      total_carrier_amount: 0,
      total_tms_amount: 0,
      total_customer_amount: 0,
      total_davantti_expected_amount: 0,
      total_tms_difference: 0,
      total_davantti_difference: 0,
      total_margin: 0,
      total_loss: 0,
      total_gain: 0,
      contestable_amount: 0,
    },
  );

  Object.keys(totals).forEach((key) => {
    if (typeof totals[key] === "number") totals[key] = roundMoney(totals[key]);
  });

  return {
    totals,
    alerts: [
      {
        id: "alert-carrier-over-tms",
        level: "critical",
        text: "Jadlog cobrou 18,9% acima do previsto no lote atual.",
        source: "calculo: carrier_charged_amount x tms_expected_amount",
      },
      {
        id: "alert-missing-cte",
        level: "warning",
        text: "Existe pedido com fatura sem CT-e vinculado.",
        source: "validacao: cte_key ausente",
      },
      {
        id: "alert-free-shipping-loss",
        level: "warning",
        text: "Frete gratis com custo real detectado em pedido Tray.",
        source: "calculo: customer_paid_shipping_amount - carrier_charged_amount",
      },
    ],
    charts: {
      by_carrier: aggregate(enriched, "carrier_name", "davantti_difference_amount"),
      by_channel: aggregate(enriched, "sales_channel", "freight_margin_amount"),
      by_status: countBy(enriched, "status"),
    },
  };
}

function aggregate(items, key, valueKey) {
  const map = new Map();
  items.forEach((item) => {
    const label = String(item[key] || "Nao informado");
    map.set(label, roundMoney((map.get(label) || 0) + (Number(item[valueKey]) || 0)));
  });
  return Array.from(map.entries()).map(([label, value]) => ({ label, value }));
}

function countBy(items, key) {
  const map = new Map();
  items.forEach((item) => {
    const label = String(item[key] || "Nao informado");
    map.set(label, (map.get(label) || 0) + 1);
  });
  return Array.from(map.entries()).map(([label, value]) => ({ label, value }));
}

function filterItems(store, query) {
  const tenantStore = store || getTenantStore({});
  const status = String(query.status || "").trim();
  const channel = String(query.channel || "").trim().toLowerCase();
  const carrier = String(query.carrier || "").trim().toLowerCase();
  const q = String(query.q || "").trim().toLowerCase();

  return tenantStore.items
    .map((item) => reconciliationEngine.enrichItem(item))
    .filter((item) => {
      if (status && item.status !== status) return false;
      if (channel && String(item.sales_channel || "").toLowerCase() !== channel) return false;
      if (carrier && String(item.carrier_name || "").toLowerCase() !== carrier) return false;
      if (q) {
        const haystack = [
          item.order_id,
          item.marketplace_order_number,
          item.intelipost_order_number,
          item.tracking_code,
          item.invoice_key,
          item.cte_key,
          item.billing_document,
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
}

function createCsv(items) {
  const headers = [
    "status",
    "pedido",
    "canal",
    "transportadora",
    "frete_cliente",
    "frete_tms",
    "frete_transportadora",
    "frete_davantti",
    "diferenca_tms",
    "diferenca_davantti",
    "margem_frete",
    "regra",
    "cte",
    "nf",
    "fatura",
  ];
  const rows = items.map((item) => [
    item.status,
    item.order_id,
    item.sales_channel,
    item.carrier_name,
    item.customer_paid_shipping_amount,
    item.tms_expected_amount,
    item.carrier_charged_amount,
    item.davantti_expected_amount,
    item.tms_difference_amount,
    item.davantti_difference_amount,
    item.freight_margin_amount,
    `${item.rule?.name || ""} v${item.rule?.version || ""}`.trim(),
    item.cte_key || "",
    item.invoice_key || "",
    item.billing_document || "",
  ]);
  return [headers, ...rows]
    .map((row) => row.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");
}

async function createDavanttiLogApp() {
  const app = express();

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, module: MODULE_ID, time: new Date().toISOString() });
  });

  app.post("/api/auth/session", (req, res) => {
    const user = sessionFromSuite(req);
    if (!user) {
      return res.status(401).json({
        ok: false,
        error: "Acesso nao autorizado pelo hub para o Davantti Log.",
        redirect: "/go/davanttilog",
      });
    }
    const token = makeToken(user);
    res.cookie("davanttilog_token", token, cookieOptions(12 * 60 * 60 * 1000));
    return res.json({ ok: true, token, user });
  });

  app.post("/api/auth/login", async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || req.body?.senha || "");

    let user = null;
    if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
      user = adminUser();
    } else {
      user = await verifyHubCredentials(email, password).catch(() => null);
    }

    if (!user) {
      return res.status(401).json({ ok: false, error: "Credenciais invalidas." });
    }

    const token = makeToken(user);
    res.cookie("davanttilog_token", token, cookieOptions(12 * 60 * 60 * 1000));
    return res.json({ ok: true, token, user });
  });

  app.get("/api/me", authenticate, (req, res) => {
    const store = getTenantStoreFromReq(req);
    res.json({
      ok: true,
      user: req.davanttiLogUser,
      tenant: { id: store.tenantKey },
    });
  });

  app.get("/api/dashboard", authenticate, async (req, res) => {
    const store = getTenantStoreFromReq(req);
    const items = await loadTenantItems(store);
    res.json({ ok: true, tenant: { id: store.tenantKey }, ...reconciliationEngine.dashboardFromItems(items) });
  });

  app.get("/api/reconciliation/items", authenticate, async (req, res) => {
    const store = getTenantStoreFromReq(req);
    res.json({ ok: true, tenant: { id: store.tenantKey }, items: await filterItemsAsync(store, req.query) });
  });

  app.get("/api/reconciliation/items/:id", authenticate, async (req, res) => {
    const store = getTenantStoreFromReq(req);
    const item = (await filterItemsAsync(store, {})).find((entry) => entry.id === req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: "Item nao encontrado." });
    const actions = davanttiLogDb.isDbEnabled()
      ? await davanttiLogDb.listActions(store.tenantKey, item.id)
      : store.auditLog.filter((entry) => entry.item_id === item.id);
    return res.json({
      ok: true,
      tenant: { id: store.tenantKey },
      item,
      actions,
    });
  });

  app.post("/api/reconciliation/items/:id/action", authenticate, async (req, res) => {
    const store = getTenantStoreFromReq(req);
    await loadTenantItems(store);
    const item = store.items.find((entry) => entry.id === req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: "Item nao encontrado." });
    const action = String(req.body?.action || "").trim();
    const statusByAction = {
      approve: "divergencia_aprovada",
      contest: "divergencia_contestada",
      resolve: "fechado",
      reprocess: "aguardando_conciliacao",
    };
    const nextStatus = statusByAction[action];
    if (!nextStatus) {
      return res.status(400).json({ ok: false, error: "Acao invalida." });
    }
    const oldStatus = item.status;
    item.status = nextStatus;
    if (davanttiLogDb.isDbEnabled()) {
      await davanttiLogDb.updateReconciliationItemStatus({
        company_id: store.tenantKey,
        item_id: item.id,
        status: nextStatus,
      });
      await davanttiLogDb.recordAction({
        company_id: store.tenantKey,
        item_id: item.id,
        action_type: action,
        old_status: oldStatus,
        new_status: nextStatus,
        reason: String(req.body?.reason || "").trim() || "Acao manual",
        created_by: req.davanttiLogUser.email,
      });
    } else {
      store.auditLog.unshift({
      id: `ACT-${crypto.randomUUID()}`,
      item_id: item.id,
      tenant_id: store.tenantKey,
      action_type: action,
      old_status: oldStatus,
      new_status: nextStatus,
      reason: String(req.body?.reason || "").trim() || "Acao manual",
      created_by: req.davanttiLogUser.email,
      created_at: new Date().toISOString(),
      });
    }
    return res.json({ ok: true, tenant: { id: store.tenantKey }, item: reconciliationEngine.enrichItem(item) });
  });

  app.get("/api/rules", authenticate, async (req, res) => {
    const store = getTenantStoreFromReq(req);
    if (davanttiLogDb.isDbEnabled()) {
      const rules = await davanttiLogDb.seedDefaultBillingRules(store.tenantKey, req.davanttiLogUser.email);
      return res.json({ ok: true, tenant: { id: store.tenantKey }, rules });
    }
    res.json({
      ok: true,
      tenant: { id: store.tenantKey },
      rules: [
        {
          id: "rule-shipping-minus-10",
          name: "Cliente -10%",
          version: 3,
          active: true,
          priority: 40,
          operation: "percent_decrease",
          value_type: "percent",
          value: 10,
          tolerance: { fixed: 1, percent: 2 },
          conditions_json: { channel: "Mercado Livre", category: "Moveis" },
        },
        {
          id: "rule-use-tms",
          name: "Usar valor TMS",
          version: 1,
          active: true,
          priority: 20,
          operation: "use_tms",
          value_type: "reference",
          value: "tms_expected_amount",
          tolerance: { fixed: 1, percent: 0 },
          conditions_json: { channel: "Shopee" },
        },
      ],
    });
  });

  app.get("/api/intelipost/config", authenticate, async (req, res) => {
    const store = await hydrateTenantIntegration(getTenantStoreFromReq(req));
    res.json({ ok: true, tenant: { id: store.tenantKey }, config: publicIntegrationConfig(store) });
  });

  app.post("/api/intelipost/config", authenticate, async (req, res) => {
    const store = await hydrateTenantIntegration(getTenantStoreFromReq(req));
    const clientId = String(req.body?.intelipost_client_id || "").trim();
    store.integrationConfig.intelipost_client_id = clientId;
    if (String(req.body?.api_key || "").trim()) {
      store.intelipostApiKey = String(req.body.api_key).trim();
      store.integrationConfig.api_key_configured = true;
    }
    store.integrationConfig.sync_enabled = req.body?.sync_enabled === true;
    if (String(req.body?.rest_base_url || "").trim()) {
      store.integrationConfig.rest_base_url = String(req.body.rest_base_url).trim().replace(/\/+$/, "");
    }
    if (String(req.body?.shipment_search_path || "").trim()) {
      store.integrationConfig.shipment_search_path = String(req.body.shipment_search_path).trim();
    }
    if (String(req.body?.tracking_graphql_url || "").trim()) {
      store.integrationConfig.tracking_graphql_url = String(req.body.tracking_graphql_url).trim();
    }

    if (davanttiLogDb.isDbEnabled()) {
      const saved = await davanttiLogDb.upsertIntelipostIntegration({
        company_id: store.tenantKey,
        account_id: store.accountKey,
        client_id: store.integrationConfig.intelipost_client_id,
        api_key: String(req.body?.api_key || "").trim(),
        rest_base_url: store.integrationConfig.rest_base_url,
        tracking_graphql_url: store.integrationConfig.tracking_graphql_url,
        shipment_search_path: store.integrationConfig.shipment_search_path,
        sync_enabled: store.integrationConfig.sync_enabled,
        updated_by: req.davanttiLogUser.email,
      });
      if (saved) {
        store.integrationHydrated = false;
        await hydrateTenantIntegration(store);
      }
    }

    return res.json({
      ok: true,
      tenant: { id: store.tenantKey },
      config: publicIntegrationConfig(store),
      message: "Configuracao Intelipost atualizada.",
    });
  });

  app.get("/api/intelipost/endpoints", authenticate, async (req, res) => {
    const store = await hydrateTenantIntegration(getTenantStoreFromReq(req));
    res.json({
      ok: true,
      tenant: { id: store.tenantKey },
      endpoints: {
        docs: "https://docs.intelipost.com.br/",
        rest_base_url: store.integrationConfig.rest_base_url,
        shipment_order_by_invoice_key: "/shipment_order/invoice_key/{invoice_key}",
        shipment_order_search: store.integrationConfig.shipment_search_path,
        tracking_graphql_url: store.integrationConfig.tracking_graphql_url,
      },
      local_endpoints: {
        config: "GET/POST /davanttilog/api/intelipost/config",
        endpoints: "GET /davanttilog/api/intelipost/endpoints",
        invoice_key: "GET /davanttilog/api/intelipost/shipment-order/invoice-key/:invoiceKey",
        tracking: "GET /davanttilog/api/intelipost/tracking/:orderNumber",
        sync: "POST /davanttilog/api/intelipost/sync",
        import_invoice_rows: "POST /davanttilog/api/import/invoice-rows",
        run_conciliation: "POST /davanttilog/api/conciliation/run",
      },
    });
  });

  app.get("/api/intelipost/shipment-order/invoice-key/:invoiceKey", authenticate, async (req, res) => {
    const store = await hydrateTenantIntegration(getTenantStoreFromReq(req));
    try {
      const client = getIntelipostClient(store);
      const result = await client.getShipmentOrderByInvoiceKey(req.params.invoiceKey);
      const items = result.item
        ? await upsertReconciliationItems(store, [result.item], "intelipost_invoice_key", req.davanttiLogUser.email)
        : [];
      store.integrationConfig.last_sync_at = new Date().toISOString();
      await davanttiLogDb
        .updateIntelipostLastSync(store.tenantKey, store.accountKey, store.integrationConfig.last_sync_at)
        .catch(() => {});
      return res.json({ ok: true, tenant: { id: store.tenantKey }, item: items[0] || null, raw: result.payload });
    } catch (error) {
      return res.status(error?.code === "INTELIPOST_API_KEY_MISSING" ? 400 : 502).json({
        ok: false,
        error: serializeIntelipostError(error),
      });
    }
  });

  app.get("/api/intelipost/tracking/:orderNumber", authenticate, async (req, res) => {
    const store = await hydrateTenantIntegration(getTenantStoreFromReq(req));
    try {
      const client = getIntelipostClient(store);
      const result = await client.getTrackingByOrderNumber(req.params.orderNumber);
      const items = result.item
        ? await upsertReconciliationItems(store, [result.item], "intelipost_tracking", req.davanttiLogUser.email)
        : [];
      store.integrationConfig.last_sync_at = new Date().toISOString();
      await davanttiLogDb
        .updateIntelipostLastSync(store.tenantKey, store.accountKey, store.integrationConfig.last_sync_at)
        .catch(() => {});
      return res.json({ ok: true, tenant: { id: store.tenantKey }, item: items[0] || null, raw: result.payload });
    } catch (error) {
      return res.status(502).json({ ok: false, error: serializeIntelipostError(error) });
    }
  });

  app.post("/api/intelipost/sync", authenticate, async (req, res) => {
    const store = await hydrateTenantIntegration(getTenantStoreFromReq(req));
    const startedAt = new Date().toISOString();
    const syncLog = {
      id: `SYNC-${crypto.randomUUID()}`,
      type: String(req.body?.type || "period").trim(),
      status: "running",
      parameters: req.body || {},
      processed: 0,
      success: 0,
      errors: [],
      created_by: req.davanttiLogUser.email,
      created_at: startedAt,
    };
    const client = getIntelipostClient(store);

    try {
      const type = syncLog.type;
      let pulledItems = [];

      if (type === "invoice_key") {
        const invoiceKeys = Array.isArray(req.body?.invoice_keys)
          ? req.body.invoice_keys
          : [req.body?.invoice_key].filter(Boolean);
        for (const invoiceKey of invoiceKeys) {
          try {
            const result = await client.getShipmentOrderByInvoiceKey(invoiceKey);
            syncLog.processed += 1;
            if (result.item) {
              pulledItems.push(result.item);
              syncLog.success += 1;
            }
          } catch (error) {
            syncLog.processed += 1;
            syncLog.errors.push({ invoice_key: normalizeInvoiceKey(invoiceKey) || invoiceKey, error: serializeIntelipostError(error) });
          }
        }
      } else if (type === "order_numbers" || type === "tracking") {
        const orderNumbers = Array.isArray(req.body?.order_numbers)
          ? req.body.order_numbers
          : [req.body?.order_number].filter(Boolean);
        for (const orderNumber of orderNumbers) {
          try {
            const result = await client.getTrackingByOrderNumber(orderNumber);
            syncLog.processed += 1;
            if (result.item) {
              pulledItems.push(result.item);
              syncLog.success += 1;
            }
          } catch (error) {
            syncLog.processed += 1;
            syncLog.errors.push({ order_number: orderNumber, error: serializeIntelipostError(error) });
          }
        }
      } else {
        const result = await client.searchShipmentOrders({
          start_date: req.body?.start_date,
          end_date: req.body?.end_date,
          order_number: req.body?.order_number,
          page: req.body?.page || 1,
          limit: req.body?.limit || 50,
        });
        pulledItems = result.items;
        syncLog.processed = pulledItems.length;
        syncLog.success = pulledItems.length;
      }

      const items = await upsertReconciliationItems(store, pulledItems, `intelipost_${type}`, req.davanttiLogUser.email);
      syncLog.status = syncLog.errors.length && syncLog.success === 0 ? "finished_with_errors" : "finished";
      syncLog.finished_at = new Date().toISOString();
      store.integrationConfig.last_sync_at = syncLog.finished_at;
      await davanttiLogDb
        .updateIntelipostLastSync(store.tenantKey, store.accountKey, syncLog.finished_at)
        .catch(() => {});
      if (davanttiLogDb.isDbEnabled()) {
        await davanttiLogDb.recordSyncRun({
          ...syncLog,
          company_id: store.tenantKey,
          account_id: store.accountKey,
          sync_type: syncLog.type,
        }).catch(() => {});
      } else {
        store.auditLog.unshift({
        id: `ACT-${crypto.randomUUID()}`,
        item_id: null,
        tenant_id: store.tenantKey,
        action_type: "intelipost_sync",
        old_status: null,
        new_status: syncLog.status,
        reason: `${syncLog.success}/${syncLog.processed} registro(s) sincronizado(s).`,
        created_by: req.davanttiLogUser.email,
        created_at: syncLog.finished_at,
        });
      }
      return res.json({ ok: true, tenant: { id: store.tenantKey }, sync: syncLog, items });
    } catch (error) {
      syncLog.status = "failed";
      syncLog.finished_at = new Date().toISOString();
      syncLog.errors.push(serializeIntelipostError(error));
      if (davanttiLogDb.isDbEnabled()) {
        await davanttiLogDb.recordSyncRun({
          ...syncLog,
          company_id: store.tenantKey,
          account_id: store.accountKey,
          sync_type: syncLog.type,
        }).catch(() => {});
      }
      return res.status(error?.code === "INTELIPOST_API_KEY_MISSING" ? 400 : 502).json({
        ok: false,
        sync: syncLog,
        error: serializeIntelipostError(error),
      });
    }
  });

  app.post("/api/import/invoice-rows", authenticate, async (req, res) => {
    const store = getTenantStoreFromReq(req);
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const items = reconciliationEngine.normalizeInvoiceRows(rows, {
      carrier_name: req.body?.carrier_name,
      sales_channel: req.body?.sales_channel,
      billing_document: req.body?.billing_document,
    });
    const upserted = await upsertReconciliationItems(store, items, "invoice_rows", req.davanttiLogUser.email);
    if (davanttiLogDb.isDbEnabled()) {
      await davanttiLogDb.recordImportFile({
        company_id: store.tenantKey,
        file_name: req.body?.file_name || req.body?.billing_document || "invoice-rows.json",
        file_type: req.body?.file_type || "json",
        source: "invoice_rows",
        status: "processed",
        total_rows: rows.length,
        processed_rows: upserted.length,
        error_rows: Math.max(0, rows.length - upserted.length),
        mapping_json: req.body?.mapping || {},
        rows,
        created_by: req.davanttiLogUser.email,
      }).catch(() => {});
    }
    return res.json({
      ok: true,
      tenant: { id: store.tenantKey },
      imported: upserted.length,
      items: upserted,
    });
  });

  app.post("/api/conciliation/run", authenticate, async (req, res) => {
    const store = getTenantStoreFromReq(req);
    await loadTenantItems(store);
    const ids = Array.isArray(req.body?.ids) ? new Set(req.body.ids.map(String)) : null;
    let changed = 0;
    const changedItems = [];
    store.items.forEach((item, index) => {
      if (ids && !ids.has(String(item.id))) return;
      const before = item.status;
      const enriched = reconciliationEngine.enrichItem(item, {
        defaultTolerance: req.body?.tolerance || { fixed: 1, percent: 0 },
      });
      store.items[index] = {
        ...item,
        ...enriched,
        company_id: store.tenantKey,
        account_id: store.tenantKey,
        updated_at: new Date().toISOString(),
      };
      if (before !== store.items[index].status) changed += 1;
      changedItems.push(store.items[index]);
    });
    if (davanttiLogDb.isDbEnabled()) {
      for (const item of changedItems) {
        await davanttiLogDb.updateReconciliationItem(store.tenantKey, item);
      }
      await davanttiLogDb.recordAction({
        company_id: store.tenantKey,
        item_id: null,
        action_type: "conciliation_run",
        reason: `${changed} item(ns) tiveram status recalculado.`,
        created_by: req.davanttiLogUser.email,
      });
      store.items = await davanttiLogDb.listReconciliationItems(store.tenantKey);
    } else {
      store.auditLog.unshift({
      id: `ACT-${crypto.randomUUID()}`,
      item_id: null,
      tenant_id: store.tenantKey,
      action_type: "conciliation_run",
      old_status: null,
      new_status: null,
      reason: `${changed} item(ns) tiveram status recalculado.`,
      created_by: req.davanttiLogUser.email,
      created_at: new Date().toISOString(),
      });
    }
    return res.json({
      ok: true,
      tenant: { id: store.tenantKey },
      changed,
      dashboard: reconciliationEngine.dashboardFromItems(store.items),
      items: reconciliationEngine.conciliateItems(store.items),
    });
  });

  app.get("/api/export/reconciliation.csv", authenticate, async (req, res) => {
    const store = getTenantStoreFromReq(req);
    const items = await filterItemsAsync(store, req.query);
    if (davanttiLogDb.isDbEnabled()) {
      await davanttiLogDb.recordAction({
        company_id: store.tenantKey,
        item_id: null,
        action_type: "export_csv",
        reason: "Exportacao de relatorio de conciliacao",
        created_by: req.davanttiLogUser.email,
      });
    } else {
      store.auditLog.unshift({
      id: `ACT-${crypto.randomUUID()}`,
      item_id: null,
      tenant_id: store.tenantKey,
      action_type: "export_csv",
      old_status: null,
      new_status: null,
      reason: "Exportacao de relatorio de conciliacao",
      created_by: req.davanttiLogUser.email,
      created_at: new Date().toISOString(),
      });
    }
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", 'attachment; filename="davantti-log-conciliacao.csv"');
    return res.send(createCsv(items));
  });

  app.get("/api/audit/actions", authenticate, async (_req, res) => {
    const store = getTenantStoreFromReq(_req);
    const actions = davanttiLogDb.isDbEnabled()
      ? await davanttiLogDb.listActions(store.tenantKey)
      : store.auditLog;
    res.json({ ok: true, tenant: { id: store.tenantKey }, actions });
  });

  app.use(express.static(path.join(__dirname, "public")));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  return app;
}

module.exports = createDavanttiLogApp;
