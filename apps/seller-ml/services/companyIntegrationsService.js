"use strict";

const crypto = require("crypto");
const db = require("../db/db");
const { decryptToken, encryptToken } = require("./tokenCrypto");

const _fetch = typeof fetch !== "undefined" ? fetch : require("node-fetch");
const fetchRef = (...args) => _fetch(...args);

const PROVIDERS = [
  {
    key: "markflow",
    label: "MarkFlow",
    category: "Marketing",
    status: "available",
    description: "Envie tarefas de materiais de marketing para uma fila externa e receba fotos, clips e status de volta no Davantti.",
    capabilities: ["tasks", "webhook", "manual_sync"],
    fields: {
      api_base_url: true,
      access_token: true,
      api_key: false,
      webhook: true,
      auto_send: true,
    },
  },
  {
    key: "trello",
    label: "Trello",
    category: "Tarefas",
    status: "available",
    description: "Conector planejado para espelhar cards e checklists em quadros de operação.",
    capabilities: ["tasks", "manual_sync"],
    fields: {
      api_base_url: true,
      access_token: true,
      api_key: true,
      webhook: false,
      auto_send: false,
    },
  },
  {
    key: "generic_webhook",
    label: "Webhook generico",
    category: "Automacao",
    status: "planned",
    description: "Conector base para enviar eventos do Davantti para ferramentas externas no futuro.",
    capabilities: ["webhook"],
    fields: {},
  },
];

const PROVIDER_MAP = new Map(PROVIDERS.map((item) => [item.key, item]));

function normalizeProvider(value) {
  const key = String(value || "").trim().toLowerCase();
  return PROVIDER_MAP.has(key) ? key : "";
}

function normalizeStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  return ["active", "disabled", "error"].includes(status) ? status : "disabled";
}

function normalizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function normalizeBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === "true" || value === "1" || value === 1 || value === "on";
}

function normalizeSectorKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function normalizeSectorList(values = [], fallback = []) {
  const source = Array.isArray(values) ? values : [];
  const normalized = source.map((item) => normalizeSectorKey(item?.key || item?.setor || item)).filter(Boolean);
  if (normalized.length) return [...new Set(normalized)];
  const fallbackList = Array.isArray(fallback) ? fallback : [];
  return [...new Set(fallbackList.map((item) => normalizeSectorKey(item?.key || item?.setor || item)).filter(Boolean))];
}

function normalizeConfig(input = {}, previous = {}) {
  const data = input && typeof input === "object" ? input : {};
  const old = previous && typeof previous === "object" ? previous : {};
  const legacyMarketingEnabled = data.auto_send_marketing_tasks ?? old.auto_send_marketing_tasks;
  const oldSectorFallback = old.auto_send_task_sectors || (old.send_only_marketing_batches === false ? [] : ["marketing"]);
  const sectorFallback = normalizeBool(legacyMarketingEnabled, old.auto_send_tasks === true) ? oldSectorFallback : [];
  const hasSectorInput = Object.prototype.hasOwnProperty.call(data, "auto_send_task_sectors")
    || Object.prototype.hasOwnProperty.call(data, "autoSendTaskSectors");
  const autoSendSectors = normalizeSectorList(data.auto_send_task_sectors || data.autoSendTaskSectors, hasSectorInput ? [] : sectorFallback);
  const autoSendTasks = normalizeBool(data.auto_send_tasks ?? data.autoSendTasks, old.auto_send_tasks === true || old.auto_send_marketing_tasks === true);
  return {
    auto_send_tasks: autoSendTasks,
    auto_send_task_sectors: autoSendTasks ? autoSendSectors : [],
    auto_send_marketing_tasks: autoSendTasks && autoSendSectors.includes("marketing"),
    send_only_marketing_batches: autoSendSectors.length ? autoSendSectors.every((item) => item === "marketing") : false,
    manual_sync_enabled: normalizeBool(data.manual_sync_enabled, old.manual_sync_enabled !== false),
    notes: String(data.notes ?? old.notes ?? "").trim().slice(0, 500),
  };
}

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "••••";
  return `${text.slice(0, 4)}••••${text.slice(-4)}`;
}

function decryptSafe(value) {
  if (!value) return "";
  try {
    return decryptToken(value);
  } catch {
    return "";
  }
}

function defaultBaseUrlForProvider(providerKey) {
  if (providerKey === "trello") return "https://api.trello.com/1";
  return "";
}

function parseProviderCredentials(providerKey, encryptedValue) {
  const decrypted = decryptSafe(encryptedValue);
  if (!decrypted) return { access_token: "", api_key: "" };

  if (providerKey === "trello") {
    try {
      const parsed = JSON.parse(decrypted);
      if (parsed && typeof parsed === "object") {
        return {
          access_token: String(parsed.access_token || "").trim(),
          api_key: String(parsed.api_key || "").trim(),
        };
      }
    } catch {
      // fallback para formato legado (somente token)
    }
  }

  return { access_token: String(decrypted || "").trim(), api_key: "" };
}

function mergeProviderCredentials({ providerKey, previousEncrypted = null, accessToken = "", apiKey = "" } = {}) {
  const previous = parseProviderCredentials(providerKey, previousEncrypted);
  return {
    access_token: String(accessToken || "").trim() || previous.access_token || "",
    api_key: String(apiKey || "").trim() || previous.api_key || "",
  };
}

function encodeProviderCredentials(providerKey, credentials = {}) {
  const accessToken = String(credentials.access_token || "").trim();
  const apiKey = String(credentials.api_key || "").trim();
  if (!accessToken && !apiKey) return null;
  if (providerKey === "trello") {
    return encryptToken(JSON.stringify({ access_token: accessToken, api_key: apiKey }));
  }
  return encryptToken(accessToken);
}

function publicIntegration(row = null, provider) {
  const credentials = parseProviderCredentials(provider.key, row?.credentials_encrypted);
  const secret = decryptSafe(row?.webhook_secret_encrypted);
  return {
    provider: provider.key,
    label: provider.label,
    category: provider.category,
    provider_status: provider.status,
    description: provider.key === "trello"
      ? "Conecte o quadro da empresa para importar cards/listas na criacao de tarefas dos Estrategicos."
      : provider.description,
    capabilities: provider.capabilities || [],
    fields: provider.fields || {},
    configured: !!row,
    id: row?.id ? String(row.id) : null,
    status: row?.status || "disabled",
    api_base_url: row?.api_base_url || defaultBaseUrlForProvider(provider.key) || "",
    has_access_token: !!credentials.access_token,
    access_token_mask: maskSecret(credentials.access_token),
    has_api_key: !!credentials.api_key,
    api_key_mask: maskSecret(credentials.api_key),
    webhook_secret_mask: maskSecret(secret),
    webhook_path: row?.id ? `/api/integrations/${provider.key}/webhook/${row.id}` : `/api/integrations/${provider.key}/webhook`,
    config: normalizeConfig(row?.config || {}),
    last_sync_at: row?.last_sync_at || null,
    last_test_at: row?.last_test_at || null,
    last_error: row?.last_error || "",
    updated_at: row?.atualizado_em || null,
  };
}

async function listCompanyIntegrations({ empresaId, meliContaId = null } = {}) {
  const companyId = Number(empresaId);
  if (!Number.isFinite(companyId) || companyId <= 0) throw new Error("Empresa invalida.");
  const accountId = Number(meliContaId);
  const params = [companyId];
  let accountSql = "and meli_conta_id is null";
  if (Number.isFinite(accountId) && accountId > 0) {
    params.push(accountId);
    accountSql = `and (meli_conta_id is null or meli_conta_id = $${params.length})`;
  }
  const { rows } = await db.query(
    `select *
       from empresa_integracoes
      where empresa_id = $1
        ${accountSql}
      order by provider asc, meli_conta_id nulls first`,
    params,
  );
  const byProvider = new Map(rows.map((row) => [String(row.provider), row]));
  return PROVIDERS.map((provider) => publicIntegration(byProvider.get(provider.key), provider));
}

async function getCompanyIntegration({ empresaId, provider, meliContaId = null } = {}) {
  const companyId = Number(empresaId);
  const cleanProvider = normalizeProvider(provider);
  if (!Number.isFinite(companyId) || companyId <= 0) throw new Error("Empresa invalida.");
  if (!cleanProvider) throw new Error("Integracao invalida.");
  const accountId = Number(meliContaId);
  const params = [companyId, cleanProvider];
  let accountSql = "and meli_conta_id is null";
  if (Number.isFinite(accountId) && accountId > 0) {
    params.push(accountId);
    accountSql = `and (meli_conta_id = $${params.length} or meli_conta_id is null)`;
  }
  const { rows } = await db.query(
    `select *
       from empresa_integracoes
      where empresa_id = $1
        and provider = $2
        ${accountSql}
      order by meli_conta_id nulls last
      limit 1`,
    params,
  );
  return rows[0] || null;
}

async function upsertCompanyIntegration({
  empresaId,
  provider,
  meliContaId = null,
  apiBaseUrl = "",
  accessToken = "",
  apiKey = "",
  status = "disabled",
  config = {},
} = {}) {
  const companyId = Number(empresaId);
  const cleanProvider = normalizeProvider(provider);
  if (!Number.isFinite(companyId) || companyId <= 0) throw new Error("Empresa invalida.");
  if (!cleanProvider) throw new Error("Integracao invalida.");
  const providerInfo = PROVIDER_MAP.get(cleanProvider);
  if (providerInfo.status !== "available") {
    const error = new Error("Este conector ainda nao esta disponivel para configuracao.");
    error.status = 400;
    throw error;
  }
  const accountId = Number(meliContaId);
  const scopedAccountId = Number.isFinite(accountId) && accountId > 0 ? accountId : null;
  const previous = await getCompanyIntegration({ empresaId: companyId, provider: cleanProvider, meliContaId: scopedAccountId });
  const normalizedStatus = normalizeStatus(status);
  const normalizedUrl = normalizeUrl(
    apiBaseUrl || previous?.api_base_url || defaultBaseUrlForProvider(cleanProvider),
  );
  if (normalizedStatus === "active" && providerInfo.fields.api_base_url && !normalizedUrl) {
    const error = new Error("Informe uma URL base valida para ativar a integracao.");
    error.status = 400;
    throw error;
  }

  const mergedCredentials = mergeProviderCredentials({
    providerKey: cleanProvider,
    previousEncrypted: previous?.credentials_encrypted || null,
    accessToken,
    apiKey,
  });
  if (normalizedStatus === "active" && providerInfo.fields.access_token && !mergedCredentials.access_token) {
    const error = new Error("Informe o token de integracao para ativar.");
    error.status = 400;
    throw error;
  }
  if (normalizedStatus === "active" && providerInfo.fields.api_key && !mergedCredentials.api_key) {
    const error = new Error("Informe a chave da API para ativar.");
    error.status = 400;
    throw error;
  }

  const encryptedToken = encodeProviderCredentials(cleanProvider, mergedCredentials) || previous?.credentials_encrypted || null;
  const webhookSecret = previous?.webhook_secret_encrypted || encryptToken(crypto.randomBytes(32).toString("base64url"));
  const mergedConfig = normalizeConfig(config, previous?.config || {});

  const updateParams = [companyId, cleanProvider, scopedAccountId, normalizedStatus, normalizedUrl || null, encryptedToken, webhookSecret, JSON.stringify(mergedConfig)];
  const updated = await db.query(
    `update empresa_integracoes
        set status = $4,
            api_base_url = $5,
            credentials_encrypted = $6,
            webhook_secret_encrypted = coalesce(webhook_secret_encrypted, $7),
            config = $8::jsonb,
            last_error = null,
            atualizado_em = now()
      where empresa_id = $1
        and provider = $2
        and (($3::bigint is null and meli_conta_id is null) or meli_conta_id = $3::bigint)
      returning *`,
    updateParams,
  );
  if (updated.rows[0]) return publicIntegration(updated.rows[0], providerInfo);

  const { rows } = await db.query(
    `insert into empresa_integracoes
       (empresa_id, meli_conta_id, provider, status, api_base_url, credentials_encrypted, webhook_secret_encrypted, config, last_error, atualizado_em)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,null,now())
     returning *`,
    [companyId, scopedAccountId, cleanProvider, normalizedStatus, normalizedUrl || null, encryptedToken, webhookSecret, JSON.stringify(mergedConfig)],
  );
  return publicIntegration(rows[0], providerInfo);
}

async function setIntegrationError(id, errorMessage) {
  await db.query(
    `update empresa_integracoes
        set status = case when status = 'active' then 'error' else status end,
            last_error = $2,
            last_test_at = now(),
            atualizado_em = now()
      where id = $1`,
    [id, String(errorMessage || "Falha ao testar integracao.").slice(0, 1000)],
  );
}

async function markIntegrationTested(id) {
  await db.query(
    `update empresa_integracoes
        set last_error = null,
            last_test_at = now(),
            status = case when status = 'error' then 'active' else status end,
            atualizado_em = now()
      where id = $1`,
    [id],
  );
}

async function testCompanyIntegration({
  empresaId,
  provider,
  meliContaId = null,
  apiBaseUrl = "",
  accessToken = "",
  apiKey = "",
} = {}) {
  const cleanProvider = normalizeProvider(provider);
  const providerInfo = PROVIDER_MAP.get(cleanProvider);
  if (!providerInfo || providerInfo.status !== "available") throw new Error("Integracao indisponivel.");
  const saved = await getCompanyIntegration({ empresaId, provider: cleanProvider, meliContaId });
  const url = normalizeUrl(apiBaseUrl || saved?.api_base_url || defaultBaseUrlForProvider(cleanProvider));
  const credentials = mergeProviderCredentials({
    providerKey: cleanProvider,
    previousEncrypted: saved?.credentials_encrypted || null,
    accessToken,
    apiKey,
  });
  if (!url) throw new Error("Informe uma URL base valida para testar.");
  if (providerInfo.fields.access_token && !credentials.access_token) throw new Error("Informe o token de integracao para testar.");
  if (providerInfo.fields.api_key && !credentials.api_key) throw new Error("Informe a chave da API para testar.");
  if (typeof fetchRef !== "function") throw new Error("Runtime sem suporte a fetch para testar a integracao.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    let endpoint = `${url}/api/integrations/davantti/health`;
    let response;
    if (cleanProvider === "trello") {
      endpoint = `${url}/members/me?key=${encodeURIComponent(credentials.api_key)}&token=${encodeURIComponent(credentials.access_token)}`;
      response = await fetchRef(endpoint, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Trello respondeu HTTP ${response.status}.`);
      const payload = await response.json().catch(() => ({}));
      if (!payload?.id) throw new Error("Trello nao retornou um usuario valido para esta chave/token.");
    } else {
      response = await fetchRef(endpoint, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${credentials.access_token}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`MarkFlow respondeu HTTP ${response.status}.`);
    }
    if (saved?.id) await markIntegrationTested(saved.id);
    return {
      ok: true,
      message: cleanProvider === "trello" ? "Conexao com Trello validada com sucesso." : "Conexao validada com sucesso.",
      checked_url: cleanProvider === "trello" ? `${url}/members/me` : endpoint,
    };
  } catch (error) {
    if (saved?.id) await setIntegrationError(saved.id, error.message);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function rotateWebhookSecret({ empresaId, provider, meliContaId = null } = {}) {
  const cleanProvider = normalizeProvider(provider);
  const row = await getCompanyIntegration({ empresaId, provider: cleanProvider, meliContaId });
  if (!row) throw new Error("Configure a integracao antes de gerar um webhook secret.");
  const secret = crypto.randomBytes(32).toString("base64url");
  const { rows } = await db.query(
    `update empresa_integracoes
        set webhook_secret_encrypted = $2,
            atualizado_em = now()
      where id = $1
      returning *`,
    [row.id, encryptToken(secret)],
  );
  return {
    integration: publicIntegration(rows[0], PROVIDER_MAP.get(cleanProvider)),
    webhook_secret: secret,
  };
}

async function loadWebhookIntegration({ provider, integrationId } = {}) {
  const cleanProvider = normalizeProvider(provider);
  const id = Number(integrationId);
  if (!cleanProvider || !Number.isFinite(id) || id <= 0) return null;
  const { rows } = await db.query(
    `select *
       from empresa_integracoes
      where id = $1
        and provider = $2
        and status = 'active'
      limit 1`,
    [id, cleanProvider],
  );
  const row = rows[0] || null;
  if (!row) return null;
  return {
    row,
    webhookSecret: decryptSafe(row.webhook_secret_encrypted),
  };
}

async function recordIntegrationEvent({ integrationId = null, provider, externalEventId = null, eventType = "", taskId = null, payload = {} } = {}) {
  const cleanProvider = normalizeProvider(provider) || String(provider || "").trim().toLowerCase();
  if (!cleanProvider) throw new Error("Provider invalido.");
  const cleanEventType = String(eventType || "webhook.received").trim().slice(0, 120);
  const { rows } = await db.query(
    `insert into ml_integration_events
       (empresa_integracao_id, provider, external_event_id, task_id, event_type, payload, processed_at)
     values ($1,$2,$3,$4,$5,$6::jsonb,now())
     on conflict (provider, external_event_id)
       where external_event_id is not null and external_event_id <> ''
     do update set
       payload = excluded.payload,
       processed_at = now()
     returning *`,
    [
      Number(integrationId) || null,
      cleanProvider,
      externalEventId ? String(externalEventId).slice(0, 160) : null,
      Number(taskId) || null,
      cleanEventType,
      JSON.stringify(payload || {}),
    ],
  );
  return rows[0] || null;
}

async function listStrategicIntegrationStatus({ empresaId } = {}) {
  const companyId = Number(empresaId);
  if (!Number.isFinite(companyId) || companyId <= 0) {
    return { active: false, integrations: [] };
  }
  const { rows } = await db.query(
    `select id, provider, status, config, last_sync_at, last_error
       from empresa_integracoes
      where empresa_id = $1
        and meli_conta_id is null
        and provider in ('markflow', 'trello')
      order by atualizado_em desc, id desc`,
    [companyId],
  );
  const integrations = rows.map((row) => {
    const cfg = row.config && typeof row.config === "object" ? row.config : {};
    return {
      id: String(row.id),
      provider: row.provider,
      label: PROVIDER_MAP.get(row.provider)?.label || row.provider,
      status: row.status || "disabled",
      active: row.status === "active",
      auto_send_tasks: cfg.auto_send_tasks === true,
      auto_send_task_sectors: normalizeSectorList(cfg.auto_send_task_sectors || []),
      last_sync_at: row.last_sync_at || null,
      last_error: row.last_error || null,
    };
  });
  return {
    active: integrations.some((item) => item.active),
    integrations,
  };
}

async function getActiveProviderCredentials({ empresaId, provider } = {}) {
  const companyId = Number(empresaId);
  const cleanProvider = normalizeProvider(provider);
  if (!Number.isFinite(companyId) || companyId <= 0) throw new Error("Empresa invalida.");
  if (!cleanProvider) throw new Error("Integracao invalida.");
  const row = await getCompanyIntegration({ empresaId: companyId, provider: cleanProvider });
  if (!row || row.status !== "active") {
    const error = new Error(`${PROVIDER_MAP.get(cleanProvider)?.label || cleanProvider} nao esta ativo para esta empresa.`);
    error.statusCode = 400;
    throw error;
  }
  const credentials = parseProviderCredentials(cleanProvider, row.credentials_encrypted);
  const apiBaseUrl = normalizeUrl(row.api_base_url || defaultBaseUrlForProvider(cleanProvider));
  if (!apiBaseUrl) {
    const error = new Error("URL base da integracao nao configurada.");
    error.statusCode = 400;
    throw error;
  }
  return {
    id: row.id,
    provider: cleanProvider,
    api_base_url: apiBaseUrl,
    credentials,
    config: normalizeConfig(row.config || {}),
  };
}

function integrationAcceptsSectors(integration = {}, sectors = []) {
  const config = normalizeConfig(integration.config || {});
  if (!config.auto_send_tasks) return false;
  const triggerSectors = normalizeSectorList(config.auto_send_task_sectors);
  if (!triggerSectors.length) return false;
  const taskSectors = normalizeSectorList(sectors);
  return taskSectors.some((sector) => triggerSectors.includes(sector));
}

function integrationTriggerSectors(integration = {}, sectors = []) {
  const config = normalizeConfig(integration.config || {});
  const triggerSectors = normalizeSectorList(config.auto_send_task_sectors);
  const taskSectors = normalizeSectorList(sectors);
  return taskSectors.filter((sector) => triggerSectors.includes(sector));
}

function allowedRequirementKeysForSectors(sectors = []) {
  const clean = new Set(normalizeSectorList(sectors));
  const keys = new Set();
  if (clean.has("marketing")) {
    keys.add("photo");
    keys.add("clips");
  }
  if (clean.has("cadastro")) {
    ["photo", "clips", "title", "description", "attributes", "model", "stock", "other"].forEach((key) => keys.add(key));
  }
  if (clean.has("ads")) keys.add("ads");
  if (clean.has("logistica")) {
    keys.add("shipping");
    keys.add("lead_time");
  }
  if (clean.has("comercial")) {
    keys.add("price");
    keys.add("promotion");
  }
  return keys;
}

function filterFlagsBySectors(flags = {}, sectors = []) {
  const allowed = allowedRequirementKeysForSectors(sectors);
  return Object.fromEntries(Object.entries(flags || {}).map(([key, value]) => [key, allowed.has(key) ? !!value : false]));
}

function taskListingRequirements(flags = {}, sectors = []) {
  const scoped = filterFlagsBySectors(flags, sectors);
  const canSendCatalogMedia = normalizeSectorList(sectors).includes("cadastro");
  return {
    photos: canSendCatalogMedia && !!scoped.photo,
    clips_video: canSendCatalogMedia && !!scoped.clips,
    title: !!scoped.title,
    description: !!scoped.description,
    attributes: !!scoped.attributes,
    model: !!scoped.model,
    lead_time: !!scoped.lead_time,
    price: !!scoped.price,
    stock: !!scoped.stock,
    promotion: !!scoped.promotion,
    ads: !!scoped.ads,
    shipping: !!scoped.shipping,
    other: !!scoped.other,
  };
}

function taskMaterialRequirements(flags = {}, sectors = []) {
  const scoped = filterFlagsBySectors(flags, sectors);
  return {
    photos: !!scoped.photo,
    clips_video: !!scoped.clips,
  };
}

function buildStrategicTasksPayload({ integration, empresaId, accountKey, accountLabel, batch = {}, tasks = [], sectors = [], taskFlags = {}, taskNotes = "" } = {}) {
  const cleanSectors = normalizeSectorList(sectors);
  const flags = filterFlagsBySectors(taskFlags && typeof taskFlags === "object" ? taskFlags : {}, cleanSectors);
  const batchTags = Array.isArray(batch?.tags)
    ? Array.from(new Set(batch.tags.map((item) => String(item || "").trim()).filter(Boolean))).slice(0, 20)
    : [];
  const batchTagColors = batch?.tag_colors && typeof batch.tag_colors === "object"
    ? Object.fromEntries(Object.entries(batch.tag_colors).filter(([key, value]) => String(key || "").trim() && String(value || "").trim()))
    : {};
  return {
    company_id: Number(empresaId) || null,
    account_id: Number(accountKey) || null,
    account_key: String(accountKey || ""),
    account_label: accountLabel || null,
    integration_id: integration?.id ? String(integration.id) : null,
    batch_id: batch.id || null,
    batch_name: batch.name || "Lote de tarefas",
    priority: batch.priority || "medium",
    due_date: batch.due_date || null,
    batch_tags: batchTags,
    batch_tag_colors: batchTagColors,
    sectors_required: cleanSectors,
    task_flags: flags,
    notes: String(taskNotes || "").trim() || null,
    items: tasks.map((task) => ({
      davantti_task_id: Number(task.id) || null,
      mlb: task.mlb || null,
      sku: task.sku || null,
      title: task.title || task.title_snapshot || task.mlb || "Anuncio",
      thumbnail: task.thumbnail || task.thumbnail_snapshot || null,
      sectors_required: cleanSectors,
      materials_required: taskMaterialRequirements(flags, cleanSectors),
      listing_changes_required: taskListingRequirements(flags, cleanSectors),
      tags: Array.isArray(task.task_tags) ? task.task_tags : batchTags,
      tag_colors: task.task_tag_colors && typeof task.task_tag_colors === "object" ? task.task_tag_colors : batchTagColors,
      notes: String(task.task_notes || taskNotes || "").trim() || null,
    })),
  };
}

async function upsertTaskLink({ integrationId, provider, taskId, sourceEntityId, externalTaskId = null, externalUrl = null, externalStatus = null, payload = {}, lastError = null } = {}) {
  const providerKey = String(provider || "").trim().toLowerCase();
  const normalizedTaskId = Number(taskId) || null;
  if (!externalTaskId && normalizedTaskId) {
    const updated = await db.query(
      `update ml_external_task_links
          set empresa_integracao_id = $3,
              source_entity_id = $4,
              external_url = $5,
              external_status = $6,
              external_payload = $7::jsonb,
              last_sync_at = now(),
              last_error = $8,
              atualizado_em = now()
        where provider = $1
          and task_id = $2
        returning *`,
      [
        providerKey,
        normalizedTaskId,
        Number(integrationId) || null,
        sourceEntityId ? String(sourceEntityId) : String(normalizedTaskId),
        externalUrl ? String(externalUrl).slice(0, 1000) : null,
        externalStatus ? String(externalStatus).slice(0, 80) : null,
        JSON.stringify(payload || {}),
        lastError ? String(lastError).slice(0, 1000) : null,
      ],
    );
    if (updated.rows[0]) return updated.rows[0];
  }
  const { rows } = await db.query(
    `insert into ml_external_task_links
       (empresa_integracao_id, task_id, provider, source_module, source_entity_type, source_entity_id, external_task_id, external_url, external_status, external_payload, last_sync_at, last_error, atualizado_em)
     values ($1,$2,$3,'estrategicos','task',$4,$5,$6,$7,$8::jsonb,now(),$9,now())
     on conflict (provider, external_task_id)
       where external_task_id is not null and external_task_id <> ''
     do update set
       empresa_integracao_id = excluded.empresa_integracao_id,
       task_id = coalesce(excluded.task_id, ml_external_task_links.task_id),
       source_entity_id = excluded.source_entity_id,
       external_url = excluded.external_url,
       external_status = excluded.external_status,
       external_payload = excluded.external_payload,
       last_sync_at = excluded.last_sync_at,
       last_error = excluded.last_error,
       atualizado_em = now()
     returning *`,
    [
      Number(integrationId) || null,
      normalizedTaskId,
      providerKey,
      sourceEntityId ? String(sourceEntityId) : taskId ? String(taskId) : null,
      externalTaskId ? String(externalTaskId).slice(0, 180) : null,
      externalUrl ? String(externalUrl).slice(0, 1000) : null,
      externalStatus ? String(externalStatus).slice(0, 80) : null,
      JSON.stringify(payload || {}),
      lastError ? String(lastError).slice(0, 1000) : null,
    ],
  );
  return rows[0] || null;
}

function normalizeExternalTasksResponse(payload = {}) {
  if (Array.isArray(payload?.tasks)) return payload.tasks;
  if (Array.isArray(payload?.items)) return payload.items;
  if (payload?.task) return [payload.task];
  return [];
}

function normalizeWebhookMaterials(payload = {}) {
  const materials = payload?.materials && typeof payload.materials === "object" ? payload.materials : payload;
  return {
    photos: materials.photos === true || materials.photo === true || !!materials.photos_url || !!materials.photo_url,
    clips_video: materials.clips_video === true || materials.clips === true || !!materials.clips_url || !!materials.clip_url,
  };
}

function normalizeWebhookLocations(payload = {}) {
  const materials = payload?.materials && typeof payload.materials === "object" ? payload.materials : payload;
  const locations = {};
  const photosUrl = String(materials.photos_url || materials.photo_url || "").trim();
  const clipsUrl = String(materials.clips_url || materials.clip_url || materials.clips_video_url || "").trim();
  if (photosUrl) locations.photos = photosUrl.slice(0, 500);
  if (clipsUrl) locations.clips_video = clipsUrl.slice(0, 500);
  return locations;
}

function normalizeWebhookTaskFlags(flags = {}) {
  const source = flags && typeof flags === "object" ? flags : {};
  return {
    photo: source.photo === true || source.photos === true || source.foto === true,
    clips: source.clips === true || source.clips_video === true || source.clip === true,
  };
}

function requiredWebhookMaterials(taskFlags = {}, incomingMaterials = {}) {
  const flags = normalizeWebhookTaskFlags(taskFlags);
  const required = [];
  if (flags.photo) required.push("photos");
  if (flags.clips) required.push("clips_video");
  if (!required.length) {
    if (incomingMaterials?.photos) required.push("photos");
    if (incomingMaterials?.clips_video) required.push("clips_video");
  }
  return required;
}

function materialCompletionFromEntries(entries = [], incomingMaterials = {}) {
  const done = { photos: false, clips_video: false };
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.materials_unset?.photos) done.photos = false;
    if (entry?.materials_unset?.clips_video) done.clips_video = false;
    if (entry?.materials_created?.photos) done.photos = true;
    if (entry?.materials_created?.clips_video) done.clips_video = true;
  }
  if (incomingMaterials?.photos) done.photos = true;
  if (incomingMaterials?.clips_video) done.clips_video = true;
  return done;
}

function missingWebhookMaterials(required = [], completed = {}) {
  return required.filter((key) => !completed[key]);
}

async function syncStrategicTaskStatus(client, taskId) {
  const { rows } = await client.query(
    `select
       count(*)::int as total,
       count(*) filter (where status = 'completed')::int as completed,
       count(*) filter (where status = 'in_progress')::int as in_progress,
       count(*) filter (where status = 'review')::int as review,
       count(*) filter (where status = 'returned')::int as returned
      from ml_strategic_task_sectors
     where task_id = $1`,
    [taskId],
  );
  const row = rows[0] || {};
  let next = null;
  if (Number(row.total || 0) > 0 && Number(row.completed || 0) >= Number(row.total || 0)) next = "review";
  else if (Number(row.returned || 0) > 0) next = "returned";
  else if (Number(row.review || 0) > 0) next = "review";
  else if (Number(row.in_progress || 0) > 0) next = "in_progress";
  if (!next) return;
  await client.query(
    `update ml_strategic_tasks
        set status = case when status in ('completed','canceled') then status else $2 end,
            started_at = case when $2 in ('in_progress','review') then coalesce(started_at, now()) else started_at end,
            updated_at = now()
      where id = $1`,
    [taskId, next],
  );
}

async function sendStrategicTaskReturn({ taskId, materials = {}, reason = "", note = "", user = {} } = {}) {
  const id = Number(taskId);
  if (!Number.isFinite(id) || id <= 0) {
    return { attempted: false, results: [] };
  }
  const { rows } = await db.query(
    `select l.*, i.api_base_url, i.credentials_encrypted, i.status as integration_status, i.provider as integration_provider
       from ml_external_task_links l
       join empresa_integracoes i on i.id = l.empresa_integracao_id
      where l.task_id = $1
        and l.provider = 'markflow'
        and i.status = 'active'
      order by l.atualizado_em desc
      limit 1`,
    [id],
  );
  const link = rows[0] || null;
  if (!link) return { attempted: false, results: [] };

  const baseUrl = normalizeUrl(link.api_base_url);
  const token = decryptSafe(link.credentials_encrypted);
  const endpoint = `${baseUrl}/api/integrations/davantti/events`;
  if (!baseUrl || !token) {
    return { attempted: true, results: [{ provider: "markflow", sent: 0, error: "Integracao incompleta para devolucao." }] };
  }

  const payload = {
    event_type: "task.returned",
    status: "returned",
    external_task_id: link.external_task_id || null,
    davantti_task_id: id,
    materials_returned: {
      photos: materials.photos === true,
      clips_video: materials.clips_video === true,
    },
    reason: String(reason || "").trim().slice(0, 500),
    note: String(note || "").trim().slice(0, 1000) || null,
    returned_by: {
      id: user?.id || null,
      name: user?.name || user?.nome || null,
      email: user?.email || null,
    },
    returned_at: new Date().toISOString(),
  };

  try {
    const response = await fetchRef(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false || body?.success === false) {
      throw new Error(body?.error || body?.message || `MarkFlow respondeu HTTP ${response.status}.`);
    }
    await upsertTaskLink({
      integrationId: link.empresa_integracao_id,
      provider: "markflow",
      taskId: id,
      sourceEntityId: id,
      externalTaskId: link.external_task_id || null,
      externalUrl: link.external_url || null,
      externalStatus: "returned",
      payload: { return_request: payload, response: body },
    });
    await recordIntegrationEvent({
      integrationId: link.empresa_integracao_id,
      provider: "markflow",
      externalEventId: `return-${id}-${Date.now()}`,
      eventType: "task.returned.sent",
      taskId: id,
      payload: { request: payload, response: body },
    });
    return { attempted: true, results: [{ provider: "markflow", sent: 1, endpoint, response: body }] };
  } catch (error) {
    const message = error?.message || "Falha ao devolver tarefa para integracao.";
    await upsertTaskLink({
      integrationId: link.empresa_integracao_id,
      provider: "markflow",
      taskId: id,
      sourceEntityId: id,
      externalTaskId: link.external_task_id || null,
      externalUrl: link.external_url || null,
      externalStatus: "return_error",
      payload,
      lastError: message,
    });
    return { attempted: true, results: [{ provider: "markflow", sent: 0, endpoint, error: message }] };
  }
}

async function processStrategicWebhookEvent({ integrationId = null, provider, eventType = "", payload = {} } = {}) {
  const providerKey = String(provider || "").trim().toLowerCase();
  if (!providerKey || !payload || typeof payload !== "object") return { processed: false };
  const externalTaskId = String(payload.external_task_id || payload.external_id || payload.id || "").trim();
  const taskId = Number(payload.davantti_task_id || payload.task_id) || null;
  const status = String(payload.status || payload.external_status || eventType || "updated").trim().toLowerCase();
  const linkLookup = await db.query(
    `select *
       from ml_external_task_links
      where provider = $1
        and (
          ($2::text <> '' and external_task_id = $2)
          or ($3::bigint is not null and task_id = $3)
        )
      order by atualizado_em desc
      limit 1`,
    [providerKey, externalTaskId, taskId],
  );
  const link = linkLookup.rows[0] || null;
  const resolvedTaskId = Number(taskId || link?.task_id) || null;
  if (link) {
    await db.query(
      `update ml_external_task_links
          set external_task_id = coalesce(nullif($2,''), external_task_id),
              external_status = $3,
              external_payload = $4::jsonb,
              last_sync_at = now(),
              last_error = null,
              atualizado_em = now()
        where id = $1`,
      [link.id, externalTaskId, status.slice(0, 80), JSON.stringify(payload || {})],
    );
  } else if (resolvedTaskId) {
    await upsertTaskLink({
      integrationId,
      provider: providerKey,
      taskId: resolvedTaskId,
      sourceEntityId: resolvedTaskId,
      externalTaskId: externalTaskId || null,
      externalUrl: payload.external_url || payload.url || null,
      externalStatus: status,
      payload,
    });
  }
  if (!resolvedTaskId) return { processed: true, task_updated: false };

  const materials = normalizeWebhookMaterials(payload);
  const hasMaterials = materials.photos || materials.clips_video;
  const isDone = ["completed", "done", "concluido", "task.completed"].includes(status) || String(eventType || "").includes("completed");
  const isProgress = ["in_progress", "progress", "doing", "em_progresso"].includes(status);
  if (!hasMaterials && !isDone && !isProgress) return { processed: true, task_updated: false };

  await db.withClient(async (client) => {
    await client.query("begin");
    try {
      const taskResult = await client.query(`select id, execution_payload, task_flags from ml_strategic_tasks where id = $1 for update`, [resolvedTaskId]);
      const task = taskResult.rows[0];
      if (!task) {
        await client.query("commit");
        return;
      }
      const executionPayload = task.execution_payload && typeof task.execution_payload === "object" ? task.execution_payload : {};
      const entries = Array.isArray(executionPayload.entries) ? executionPayload.entries : [];
      const entryId = `external-${providerKey}-${payload.event_id || externalTaskId || Date.now()}`;
      const requiredMaterials = requiredWebhookMaterials(task.task_flags || {}, materials);
      const completedMaterials = materialCompletionFromEntries(entries, materials);
      const missingMaterials = missingWebhookMaterials(requiredMaterials, completedMaterials);
      const hasRequiredMaterialScope = requiredMaterials.length > 0;
      const marketingMaterialsComplete = hasRequiredMaterialScope ? missingMaterials.length === 0 : isDone;
      const nextSectorStatus = marketingMaterialsComplete ? "completed" : "in_progress";
      const nextTaskStatus = marketingMaterialsComplete ? "review" : "in_progress";
      if (!entries.some((entry) => String(entry.id || "") === entryId)) {
        entries.push({
          id: entryId,
          at: payload.completed_at || payload.updated_at || new Date().toISOString(),
          user_id: null,
          user_name: payload.responsible?.name || payload.user?.name || providerKey,
          user_email: payload.responsible?.email || payload.user?.email || null,
          materials_created: materials,
          listing_changes: {},
          material_locations: normalizeWebhookLocations(payload),
          notes: String(payload.notes || payload.note || "Atualizacao recebida da integracao externa.").slice(0, 2000),
          status_after: nextTaskStatus,
          creates_round: false,
          round_id: null,
          external_provider: providerKey,
          external_task_id: externalTaskId || null,
          required_materials: requiredMaterials,
          completed_materials: completedMaterials,
          missing_materials: missingMaterials,
        });
      }
      await client.query(
        `update ml_strategic_tasks
            set execution_payload = $2::jsonb,
                status = case when status in ('completed','canceled') then status else $3 end,
                started_at = coalesce(started_at, now()),
                updated_at = now()
          where id = $1`,
        [resolvedTaskId, JSON.stringify({ ...executionPayload, entries }), "in_progress"],
      );
      if (hasMaterials || isDone || isProgress) {
        await client.query(
          `update ml_strategic_task_sectors
              set status = $3,
                  completed_at = case when $3 = 'completed' then coalesce(completed_at, now()) else completed_at end,
                  updated_at = now()
            where task_id = $1
              and setor = $2
              and status <> 'canceled'`,
          [resolvedTaskId, "marketing", nextSectorStatus],
        );
        await client.query(
          `insert into ml_strategic_task_sector_events (task_id, setor, user_id, action, note, payload)
           values ($1,'marketing',null,$2,$3,$4::jsonb)`,
          [
            resolvedTaskId,
            nextSectorStatus === "completed" ? "external_sector_completed" : "external_sector_progress",
            payload.notes || null,
            JSON.stringify({
              ...(payload || {}),
              required_materials: requiredMaterials,
              completed_materials: completedMaterials,
              missing_materials: missingMaterials,
            }),
          ],
        );
      }
      await syncStrategicTaskStatus(client, resolvedTaskId);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
  return { processed: true, task_updated: true, task_id: String(resolvedTaskId) };
}

async function sendStrategicTasksToIntegration({ integration, empresaId, accountKey, accountLabel, batch = {}, tasks = [], sectors = [], taskFlags = {}, taskNotes = "" } = {}) {
  const provider = String(integration?.provider || "").trim().toLowerCase();
  const baseUrl = normalizeUrl(integration?.api_base_url);
  const token = decryptSafe(integration?.credentials_encrypted);
  if (!provider || !baseUrl || !token || !Array.isArray(tasks) || !tasks.length) {
    return { provider, sent: 0, skipped: true, error: "Integracao incompleta ou sem tarefas." };
  }

  const endpoint = `${baseUrl}/api/integrations/davantti/tasks`;
  const outboundPayload = buildStrategicTasksPayload({ integration, empresaId, accountKey, accountLabel, batch, tasks, sectors, taskFlags, taskNotes });
  try {
    const response = await fetchRef(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(outboundPayload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false || body?.success === false) {
      const message = body?.error || body?.message || `${provider} respondeu HTTP ${response.status}.`;
      throw new Error(message);
    }

    const responseTasks = normalizeExternalTasksResponse(body);
    const byDavanttiId = new Map(responseTasks.map((item) => [String(item.davantti_task_id || item.task_id || ""), item]));
    for (const task of tasks) {
      const external = byDavanttiId.get(String(task.id)) || {};
      await upsertTaskLink({
        integrationId: integration.id,
        provider,
        taskId: task.id,
        sourceEntityId: task.id,
        externalTaskId: external.external_task_id || external.id || null,
        externalUrl: external.external_url || external.url || null,
        externalStatus: external.status || body.status || "sent",
        payload: { request: outboundPayload.items.find((item) => String(item.davantti_task_id) === String(task.id)) || {}, response: external },
      });
    }

    await db.query(
      `update empresa_integracoes
          set last_sync_at = now(),
              last_error = null,
              status = case when status = 'error' then 'active' else status end,
              atualizado_em = now()
        where id = $1`,
      [integration.id],
    );
    return { provider, sent: tasks.length, endpoint, response: body };
  } catch (error) {
    const message = error?.message || "Falha ao enviar tarefas para integracao.";
    await db.query(
      `update empresa_integracoes
          set last_error = $2,
              atualizado_em = now()
        where id = $1`,
      [integration.id, message.slice(0, 1000)],
    );
    for (const task of tasks) {
      await upsertTaskLink({
        integrationId: integration.id,
        provider,
        taskId: task.id,
        sourceEntityId: task.id,
        externalStatus: "error",
        payload: outboundPayload.items.find((item) => String(item.davantti_task_id) === String(task.id)) || {},
        lastError: message,
      });
    }
    return { provider, sent: 0, endpoint, error: message };
  }
}

async function sendStrategicTasks({ empresaId, accountKey, accountLabel, batch = {}, tasks = [], sectors = [], taskFlags = {}, taskNotes = "" } = {}) {
  const companyId = Number(empresaId);
  if (!Number.isFinite(companyId) || companyId <= 0 || !Array.isArray(tasks) || !tasks.length) {
    return { attempted: false, results: [] };
  }
  const cleanSectors = normalizeSectorList(sectors);
  if (!cleanSectors.length) return { attempted: false, results: [] };
  const { rows } = await db.query(
    `select *
      from empresa_integracoes
      where empresa_id = $1
        and meli_conta_id is null
        and status = 'active'
        and provider = 'markflow'
      order by provider asc`,
    [companyId],
  );
  const targets = rows.filter((row) => integrationAcceptsSectors(row, cleanSectors));
  if (!targets.length) return { attempted: false, results: [] };
  const results = [];
  for (const integration of targets) {
    const scopedSectors = integrationTriggerSectors(integration, cleanSectors);
    if (!scopedSectors.length) continue;
    results.push(await sendStrategicTasksToIntegration({ integration, empresaId: companyId, accountKey, accountLabel, batch, tasks, sectors: scopedSectors, taskFlags, taskNotes }));
  }
  return { attempted: true, results };
}

module.exports = {
  PROVIDERS,
  loadWebhookIntegration,
  listCompanyIntegrations,
  getActiveProviderCredentials,
  recordIntegrationEvent,
  listStrategicIntegrationStatus,
  processStrategicWebhookEvent,
  sendStrategicTaskReturn,
  rotateWebhookSecret,
  sendStrategicTasks,
  testCompanyIntegration,
  upsertCompanyIntegration,
};
