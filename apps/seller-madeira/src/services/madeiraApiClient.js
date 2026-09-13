"use strict";

const env = require("../config/env");
const { getWorkspaceIntegrationConfig } = require("./databaseService");

function createConfigurationError(message, details) {
  const error = new Error(message);
  error.status = 503;
  error.details = details;
  return error;
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

function parseResponseBody(rawText, contentType) {
  if (!rawText) return null;

  if (
    String(contentType || "").includes("application/json") ||
    rawText.startsWith("{") ||
    rawText.startsWith("[")
  ) {
    try {
      return JSON.parse(rawText);
    } catch {
      return rawText;
    }
  }

  return rawText;
}

async function requestApi({
  baseUrl,
  path,
  method = "GET",
  headers = {},
  body,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.requestTimeoutMs);

  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
      method,
      headers,
      body,
      signal: controller.signal,
    });

    const rawText = await response.text();
    const contentType = response.headers.get("content-type");
    const data = parseResponseBody(rawText, contentType);

    if (!response.ok) {
      const error = new Error(
        `API MadeiraMadeira respondeu com status ${response.status}`,
      );
      error.status = response.status;
      error.details = data;
      throw error;
    }

    return {
      ok: true,
      status: response.status,
      data,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw createConfigurationError(
        "Timeout ao chamar a API da MadeiraMadeira",
        {
          timeoutMs: env.requestTimeoutMs,
          baseUrl,
          path,
        },
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function requestJson(options) {
  return requestApi({
    ...options,
    body:
      options.body == null || options.body instanceof FormData
        ? options.body
        : JSON.stringify(options.body),
  });
}

function ensureCoreReady() {
  const missing = [];
  if (!env.coreBaseUrl) missing.push("MADEIRA_API_BASE_URL");
  if (!env.apiToken) missing.push("MADEIRA_API_TOKEN");

  if (missing.length) {
    throw createConfigurationError(
      "Credenciais da API principal nao configuradas",
      { missing },
    );
  }
}

function ensureMessagingReady() {
  const missing = [];
  if (!env.coreBaseUrl) missing.push("MADEIRA_API_BASE_URL");
  if (!env.apiToken) missing.push("TOKENMM do workspace");

  if (missing.length) {
    throw createConfigurationError(
      "Credenciais do workspace nao configuradas para mensageria",
      { missing },
    );
  }
}

function ensureMessagingReadReady() {
  const missing = [];
  if (!env.coreBaseUrl) missing.push("MADEIRA_API_BASE_URL");
  if (!env.apiToken) missing.push("TOKENMM do workspace");

  if (missing.length) {
    throw createConfigurationError(
      "Credenciais do workspace nao configuradas para mensageria GET",
      { missing },
    );
  }
}

function getCoreHeaders() {
  return {
    "Content-Type": "application/json",
    TOKENMM: env.apiToken,
    Authorization: `Bearer ${env.apiToken}`,
  };
}

function getMessagingHeaders(options = {}) {
  const headers = {
    TOKENMM: env.apiToken,
    Authorization: `Bearer ${env.apiToken}`,
  };

  if (options.includeContentType !== false) {
    headers["Content-Type"] = "application/json";
  }

  return headers;
}

function getMessagingReadHeaders() {
  return {
    TOKENMM: env.apiToken,
    Authorization: `Bearer ${env.apiToken}`,
  };
}

function getMessagingReadBaseUrl() {
  return env.coreBaseUrl;
}

async function resolveCoreConfig(overrides = {}) {
  const integration = await getWorkspaceIntegrationConfig(
    overrides.workspaceId,
    overrides.actingUserEmail,
  );

  const coreBaseUrl =
    overrides.coreBaseUrl ||
    integration?.coreBaseUrl ||
    env.coreBaseUrl;
  const apiToken = overrides.apiToken || integration?.apiToken || env.apiToken;

  const missing = [];
  if (!coreBaseUrl) missing.push("MADEIRA_API_BASE_URL");
  if (!apiToken) missing.push("MADEIRA_API_TOKEN");

  if (missing.length) {
    throw createConfigurationError(
      "Credenciais da API principal nao configuradas",
      { missing },
    );
  }

  return {
    coreBaseUrl,
    headers: {
      "Content-Type": "application/json",
      TOKENMM: apiToken,
      Authorization: `Bearer ${apiToken}`,
    },
    workspace: integration?.workspace || null,
  };
}

async function resolveMessagingReadConfig(overrides = {}) {
  const integration = await getWorkspaceIntegrationConfig(
    overrides.workspaceId,
    overrides.actingUserEmail,
  );

  const messagingBaseUrl =
    overrides.messagingBaseUrl ||
    integration?.coreBaseUrl ||
    getMessagingReadBaseUrl();
  const apiToken = overrides.apiToken || integration?.apiToken || env.apiToken;

  const missing = [];
  if (!messagingBaseUrl) missing.push("MADEIRA_API_BASE_URL");
  if (!apiToken) missing.push("TOKENMM do workspace");

  if (missing.length) {
    throw createConfigurationError(
      "Credenciais do workspace nao configuradas para mensageria GET",
      { missing },
    );
  }

  return {
    messagingBaseUrl,
    headers: {
      TOKENMM: apiToken,
      Authorization: `Bearer ${apiToken}`,
    },
    workspace: integration?.workspace || null,
  };
}

function normalizeS3Key(s3Key) {
  return String(s3Key || "")
    .trim()
    .replace(/^\/+/, "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function toPtBrDate(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  const matchIso = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (matchIso) {
    const [, year, month, day] = matchIso;
    return `${day}/${month}/${year}`;
  }
  return normalized;
}

function createMadeiraApiClient() {
  return {
    async listCategories({ limit = 100, offset = 0 }, overrides = {}) {
      const config = await resolveCoreConfig(overrides);
      return requestJson({
        baseUrl: config.coreBaseUrl,
        path: `/v1/categoria/limit=${limit}&offset=${offset}`,
        headers: config.headers,
      });
    },

    async sendProducts(products, overrides = {}) {
      const config = await resolveCoreConfig(overrides);
      return requestJson({
        baseUrl: config.coreBaseUrl,
        path: "/v1/produto",
        method: "POST",
        headers: config.headers,
        body: products,
      });
    },

    async listNonCommercializedProducts({ limit = 100, offset = 0 }, overrides = {}) {
      const config = await resolveCoreConfig(overrides);
      return requestJson({
        baseUrl: config.coreBaseUrl,
        path: `/v1/produto/naocomercializado/limit=${limit}&offset=${offset}`,
        headers: config.headers,
      });
    },

    async getPublishingProductBySku(sku, overrides = {}) {
      const config = await resolveCoreConfig(overrides);
      const normalizedSku = encodeURIComponent(String(sku || "").trim());
      return requestJson({
        baseUrl: config.coreBaseUrl,
        path: `/v1/produto/empublicacao/${normalizedSku}`,
        headers: config.headers,
      });
    },

    async listPublishingProducts({ limit = 100, offset = 0 }, overrides = {}) {
      const config = await resolveCoreConfig(overrides);
      return requestJson({
        baseUrl: config.coreBaseUrl,
        path: `/v1/produto/empublicacao/limit=${limit}&offset=${offset}`,
        headers: config.headers,
      });
    },

    async listProductsBySituation(
      { situation = "publicados", limit = 100, offset = 0 },
      overrides = {},
    ) {
      const config = await resolveCoreConfig(overrides);
      const normalizedSituation = String(situation || "publicados")
        .trim()
        .toLowerCase();

      return requestJson({
        baseUrl: config.coreBaseUrl,
        path: `/v1/produto/situacao/${encodeURIComponent(normalizedSituation)}/limit=${limit}&offset=${offset}`,
        headers: config.headers,
      });
    },

    async getOrderById(orderId, overrides = {}) {
      const config = await resolveCoreConfig(overrides);
      const normalizedOrderId = encodeURIComponent(String(orderId || "").trim());
      return requestJson({
        baseUrl: config.coreBaseUrl,
        path: `/v1/pedido/id/${normalizedOrderId}`,
        headers: config.headers,
      });
    },

    async listOrders({ limit = 50, offset = 0 }, overrides = {}) {
      const config = await resolveCoreConfig(overrides);
      return requestJson({
        baseUrl: config.coreBaseUrl,
        path: `/v1/pedido/limit=${limit}&offset=${offset}`,
        headers: config.headers,
      });
    },

    async listOrdersByStatus({ status, limit = 50, offset = 0 }, overrides = {}) {
      const config = await resolveCoreConfig(overrides);
      const normalizedStatus = encodeURIComponent(String(status || "").trim().toLowerCase());
      return requestJson({
        baseUrl: config.coreBaseUrl,
        path: `/v1/pedido/${normalizedStatus}/limit=${limit}&offset=${offset}`,
        headers: config.headers,
      });
    },

    async listFinancialLaunches(
      { dateFrom, dateTo, limit = 100, offset = 0, type = 7 },
      overrides = {},
    ) {
      const config = await resolveCoreConfig(overrides);
      const rawDateFrom = String(dateFrom || "").trim();
      const rawDateTo = String(dateTo || "").trim();
      const normalizedType = encodeURIComponent(String(type || 7).trim());
      const attempts = [
        {
          dateFrom: rawDateFrom,
          dateTo: rawDateTo,
          withType: true,
        },
        {
          dateFrom: toPtBrDate(rawDateFrom),
          dateTo: toPtBrDate(rawDateTo),
          withType: true,
        },
        {
          dateFrom: rawDateFrom,
          dateTo: rawDateTo,
          withType: false,
        },
        {
          dateFrom: toPtBrDate(rawDateFrom),
          dateTo: toPtBrDate(rawDateTo),
          withType: false,
        },
      ];

      let lastError = null;
      for (const attempt of attempts) {
        const normalizedDateFrom = encodeURIComponent(String(attempt.dateFrom || "").trim());
        const normalizedDateTo = encodeURIComponent(String(attempt.dateTo || "").trim());
        const typeChunk = attempt.withType ? `&type=${normalizedType}` : "";
        try {
          return await requestJson({
            baseUrl: config.coreBaseUrl,
            path:
              `/v1/financeiro/lancamento/date_from=${normalizedDateFrom}` +
              `&date_to=${normalizedDateTo}` +
              `&limit=${limit}` +
              `&offset=${offset}` +
              typeChunk,
            headers: config.headers,
          });
        } catch (error) {
          lastError = error;
          if (![400, 404].includes(Number(error?.status || 0))) {
            throw error;
          }
        }
      }

      throw lastError || new Error("Falha ao consultar lancamentos financeiros.");
    },

    async listSellerSessionHistoric({ page = 1, limit = 20, status }, overrides = {}) {
      const config = await resolveMessagingReadConfig(overrides);
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });

      if (status != null && status !== "") {
        params.set("status", String(status));
      }

      return requestJson({
        baseUrl: config.messagingBaseUrl,
        path: `/v1/mensageria/seller/historic?${params.toString()}`,
        headers: config.headers,
      });
    },

    async getSessionById(sessionId, overrides = {}) {
      const config = await resolveMessagingReadConfig(overrides);
      const normalizedSessionId = encodeURIComponent(String(sessionId || "").trim());
      return requestJson({
        baseUrl: config.messagingBaseUrl,
        path: `/v1/mensageria/session/${normalizedSessionId}`,
        headers: config.headers,
      });
    },

    async getAwaitingAnswerCount(overrides = {}) {
      const config = await resolveCoreConfig(overrides);
      return requestJson({
        baseUrl: config.coreBaseUrl,
        path: "/api/v1/session/awaiting_answer_seller/count",
        headers: config.headers,
      });
    },

    async getOrderHistory(orders, overrides = {}) {
      const config = await resolveCoreConfig(overrides);
      const search = encodeURIComponent(String(orders || "").trim());

      return requestJson({
        baseUrl: config.coreBaseUrl,
        path: `/api/v1/orders/historic?orders=${search}`,
        headers: config.headers,
      });
    },

    async revokeMessagingToken(token) {
      ensureMessagingReady();
      return requestJson({
        baseUrl: env.messagingBaseUrl,
        path: "/api/v1/auth/revoke-token",
        method: "POST",
        headers: getMessagingHeaders(),
        body: { token },
      });
    },

    async uploadAttachment({ fileBuffer, fileName, contentType, orderId, rootPath }) {
      ensureMessagingReady();

      const form = new FormData();
      form.append(
        "file",
        new Blob([fileBuffer], {
          type: contentType || "application/octet-stream",
        }),
        fileName || "arquivo.bin",
      );

      if (orderId) {
        form.append("order_id", String(orderId));
      }

      if (rootPath) {
        form.append("root_path", String(rootPath));
      }

      return requestApi({
        baseUrl: env.messagingBaseUrl,
        path: "/api/v1/uploads",
        method: "POST",
        headers: getMessagingHeaders({ includeContentType: false }),
        body: form,
      });
    },

    async getAttachmentDownloadUrl(s3Key) {
      ensureMessagingReady();
      const normalizedKey = normalizeS3Key(s3Key);

      return requestJson({
        baseUrl: env.messagingBaseUrl,
        path: `/api/v1/uploads/download/${normalizedKey}`,
        headers: getMessagingHeaders({ includeContentType: false }),
      });
    },
  };
}

module.exports = {
  createMadeiraApiClient,
};
