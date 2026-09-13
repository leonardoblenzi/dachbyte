"use strict";

const path = require("path");
const express = require(
  require.resolve("express", {
    paths: [process.cwd(), path.join(process.cwd(), "shopee"), __dirname],
  }),
);
const env = require("../config/env");
const {
  getDashboardOverview,
  getWorkspaceById,
  getWorkspaceIntegrationConfig,
  listActiveWorkspaces,
  queryOne,
  saveWorkspaceIntegrationConfig,
  updateWorkspaceIdentity,
} = require("../services/databaseService");
const { authenticateUser } = require("../services/authService");
const { evaluateHubLoginAccess } = require("../services/hubAccessService");
const { createSuiteModuleAuthMiddleware } = require("../middleware/suiteModuleAuth");
const {
  sendInviteEmail,
  sendPatchNotesEmail,
} = require("../services/inviteEmailService");
const { createMadeiraApiClient } = require("../services/madeiraApiClient");
const {
  buildMarketplaceProductPayload,
  getCatalogOverview,
  getFinanceOverview,
  getFreightOverview,
  getLocalOrder,
  getLocalProduct,
  getMessagingOverview,
  getOrdersOverview,
  listFinancialEntries,
  listFreightQuotes,
  listLocalCategories,
  listLocalOrders,
  listLocalProducts,
  listMessageThreads,
  saveLocalProduct,
} = require("../services/moduleDataService");
const {
  getAnalyticsOverview,
  getAbcCurve,
  getSalesReport,
  getMonthlyProjection,
  buildSalesReportCsv,
} = require("../services/analyticsService");
const {
  listSyncRuns,
  syncAllDomains,
  syncCatalog,
  syncFinance,
  syncMessaging,
  syncOrders,
} = require("../services/syncService");
const {
  MASTER_ADMIN_EMAIL,
  assertAdminAccess,
  activateInvitedUser,
  createInvitedUser,
  findInviteUserByToken,
  listWorkspaceUsers,
  resendUserInvite,
  updateWorkspaceUser,
} = require("../services/userAdminService");
const {
  buildPatchNotesHtml,
  createPatchNoteHistory,
  listPatchNotesHistory,
  listPatchNotesRecipients,
  listUsersByEmailsActive,
  normalizePatchNotesPayload,
} = require("../services/patchNotesService");
const {
  clearAllCache,
  getOrSetCached,
} = require("../services/apiResponseCacheService");

const router = express.Router();
const client = createMadeiraApiClient();
const DASHBOARD_CACHE_TTL_MS = 60 * 1000;
const ANALYTICS_CACHE_TTL_MS = 60 * 1000;
const REPORT_CACHE_TTL_MS = 90 * 1000;
const HUB_BILLING_ALLOW_TTL_MS = 24 * 60 * 60 * 1000;
const HUB_BILLING_NEAR_EXPIRATION_TTL_MS = 60 * 60 * 1000;
const HUB_BILLING_DENY_TTL_MS = 5 * 60 * 1000;
const HUB_BILLING_NEAR_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;
const hubBillingCache = new Map();
const requireSuiteMadeiraAccess = createSuiteModuleAuthMiddleware();

function buildCacheKey(namespace, source = {}) {
  const normalized = Object.entries(source || {})
    .filter(([, value]) => value != null && value !== "")
    .map(([key, value]) => [String(key), Array.isArray(value) ? value.join(",") : String(value)])
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  return `${namespace}:${normalized}`;
}

function invalidateOperationalCaches() {
  clearAllCache();
}

function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function getScopedRequestValue(req, key) {
  return String(req.query?.[key] || req.body?.[key] || "").trim();
}

function getRequestWorkspaceId(req) {
  return (
    getScopedRequestValue(req, "workspaceId") ||
    getScopedRequestValue(req, "targetWorkspaceId")
  );
}

function getRequestActingUserEmail(req) {
  return getScopedRequestValue(req, "actingUserEmail").toLowerCase();
}

function getBillingCacheKey(email, workspaceId) {
  return `${String(email || "").toLowerCase()}::${String(workspaceId || "")}`;
}

function parseHubAccessExpiration(result) {
  const raw = result?.expires_at || result?.ends_at || result?.expiresAt || null;
  if (!raw) return null;
  const time = new Date(raw).getTime();
  return Number.isFinite(time) ? time : null;
}

function getHubBillingCacheTtl(result) {
  if (!result?.allow) return HUB_BILLING_DENY_TTL_MS;
  const expiresAt = parseHubAccessExpiration(result);
  const now = Date.now();
  if (expiresAt && expiresAt <= now) return 0;
  const baseTtl =
    expiresAt && expiresAt - now <= HUB_BILLING_NEAR_EXPIRATION_MS
      ? HUB_BILLING_NEAR_EXPIRATION_TTL_MS
      : HUB_BILLING_ALLOW_TTL_MS;
  return expiresAt ? Math.max(0, Math.min(baseTtl, expiresAt - now)) : baseTtl;
}

function readFreshHubBillingCache(cacheKey) {
  const cached = hubBillingCache.get(cacheKey);
  if (!cached || cached.expiresAt <= Date.now()) return null;
  return { ...cached.result, cached: true };
}

function readStaleAllowedHubBillingCache(cacheKey) {
  const cached = hubBillingCache.get(cacheKey);
  if (!cached?.result?.allow) return null;
  if (cached.subscriptionExpiresAt && cached.subscriptionExpiresAt <= Date.now()) return null;
  return { ...cached.result, cached: true, stale: true };
}

function writeHubBillingCache(cacheKey, result) {
  const ttl = getHubBillingCacheTtl(result);
  if (ttl <= 0) {
    hubBillingCache.delete(cacheKey);
    return;
  }
  hubBillingCache.set(cacheKey, {
    result,
    expiresAt: Date.now() + ttl,
    subscriptionExpiresAt: parseHubAccessExpiration(result),
  });
}

async function evaluateRequestBillingAccess(req) {
  const email = getRequestActingUserEmail(req);
  const workspaceId = getRequestWorkspaceId(req);
  if (!email || !workspaceId) {
    return { checked: false, allow: true, reason: "billing_identity_missing" };
  }

  const cacheKey = getBillingCacheKey(email, workspaceId);
  const cached = readFreshHubBillingCache(cacheKey);
  if (cached) return cached;

  const user = await queryOne(
    `
      select
        "id",
        "workspaceId",
        "name",
        "email",
        "userGlobalId",
        "role",
        "status",
        "isMaster"
      from "MadUser"
      where lower("email") = $1
        and "workspaceId" = $2
      limit 1
    `,
    [email, workspaceId],
  );

  if (!user) {
    return { checked: false, allow: true, reason: "billing_user_not_found" };
  }

  const workspace = await getWorkspaceById(workspaceId);
  let result;
  try {
    result = {
      checked: true,
      ...(await evaluateHubLoginAccess({ user, workspace })),
    };
  } catch (error) {
    const staleAccess = readStaleAllowedHubBillingCache(cacheKey);
    if (staleAccess) return staleAccess;
    return {
      checked: true,
      allow: true,
      reason: "hub_access_check_failed_soft_allow",
      detail: error?.message || String(error),
    };
  }

  if (!result.allow && String(result.reason || "").startsWith("hub_")) {
    const staleAccess = readStaleAllowedHubBillingCache(cacheKey);
    if (staleAccess) return staleAccess;
    return {
      ...result,
      allow: true,
      reason: "hub_access_check_failed_soft_allow",
    };
  }

  writeHubBillingCache(cacheKey, result);

  return result;
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeIdentityDocumentType(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  if (normalized === "CPF" || normalized === "CNPJ") return normalized;
  return null;
}

function normalizeIdentityDocumentNumber(value) {
  return String(value || "").replace(/\D/g, "");
}

function inferIdentityDocumentType(documentNumber) {
  if (documentNumber.length === 11) return "CPF";
  if (documentNumber.length === 14) return "CNPJ";
  return null;
}

function validateIdentityDocument(documentType, documentNumber) {
  if (!documentType && !documentNumber) return null;
  if (!documentType || !documentNumber) {
    return "Informe CPF/CNPJ completo ou deixe os dois campos vazios.";
  }
  if (documentType === "CPF" && documentNumber.length !== 11) {
    return "CPF deve ter 11 numeros.";
  }
  if (documentType === "CNPJ" && documentNumber.length !== 14) {
    return "CNPJ deve ter 14 numeros.";
  }
  return null;
}

function normalizeWorkspaceIdentityPayload(body = {}) {
  const documentNumber = normalizeIdentityDocumentNumber(body?.documentNumber);
  const documentType =
    normalizeIdentityDocumentType(body?.documentType) ||
    inferIdentityDocumentType(documentNumber);

  return {
    sellerName: String(body?.sellerName || "").trim(),
    tenantGlobalId: String(body?.tenantGlobalId || "").trim() || null,
    documentType,
    documentNumber,
  };
}

function validateFreightPayload(payload) {
  const warnings = [];
  const destinationZip = String(payload?.destinationZip || "").trim();
  const volumes = Array.isArray(payload?.volumes) ? payload.volumes : [];

  if (!destinationZip) {
    warnings.push("`destinationZip` e obrigatorio.");
  }

  if (!volumes.length) {
    warnings.push("`volumes` deve conter ao menos um item.");
  }

  const normalizedVolumes = volumes.map((volume, index) => {
    const sku = String(volume?.sku || "").trim();
    const quantity = Number(volume?.quantity || 0);

    if (!sku) warnings.push(`Volume ${index + 1}: \`sku\` e obrigatorio.`);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      warnings.push(`Volume ${index + 1}: \`quantity\` deve ser maior que zero.`);
    }

    return { sku, quantity };
  });

  return {
    ok: warnings.length === 0,
    warnings,
    normalizedPayload: {
      destinationZip,
      volumes: normalizedVolumes,
    },
  };
}

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipartRequest(req, buffer) {
  const contentType = String(req.headers["content-type"] || "");
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/i);

  if (!boundaryMatch) {
    const error = new Error("Multipart/form-data invalido: boundary ausente.");
    error.status = 400;
    throw error;
  }

  const boundary = `--${boundaryMatch[1]}`;
  const raw = buffer.toString("latin1");
  const parts = raw.split(boundary).slice(1, -1);
  const fields = {};
  const files = [];

  for (const part of parts) {
    const cleaned = part.replace(/^\r\n/, "").replace(/\r\n$/, "");
    if (!cleaned) continue;

    const separator = cleaned.indexOf("\r\n\r\n");
    if (separator === -1) continue;

    const rawHeaders = cleaned.slice(0, separator);
    const rawBody = cleaned.slice(separator + 4).replace(/\r\n$/, "");
    const headers = rawHeaders.split("\r\n");
    const disposition = headers.find((line) =>
      line.toLowerCase().startsWith("content-disposition"),
    );

    if (!disposition) continue;

    const nameMatch = disposition.match(/name="([^"]+)"/i);
    const filenameMatch = disposition.match(/filename="([^"]*)"/i);
    const typeHeader = headers.find((line) =>
      line.toLowerCase().startsWith("content-type"),
    );
    const name = nameMatch?.[1];

    if (!name) continue;

    if (filenameMatch && filenameMatch[1]) {
      files.push({
        fieldName: name,
        originalName: filenameMatch[1],
        contentType: typeHeader ? typeHeader.split(":").slice(1).join(":").trim() : "application/octet-stream",
        buffer: Buffer.from(rawBody, "latin1"),
      });
    } else {
      fields[name] = rawBody;
    }
  }

  return { fields, files };
}

async function buildDashboardPayload(period, workspaceId) {
  const [overview, analytics, catalog, orders, freight, finance, messaging] =
    await Promise.all([
      getDashboardOverview({ workspaceId }),
      getAnalyticsOverview({ period, workspaceId }),
      getCatalogOverview({ workspaceId }),
      getOrdersOverview({ workspaceId }),
      getFreightOverview({ workspaceId }),
      getFinanceOverview({ workspaceId }),
      getMessagingOverview({ workspaceId }),
    ]);

  return {
    overview,
    analytics,
    catalog,
    orders,
    freight,
    finance,
    messaging,
  };
}

function inferSellerFromOrderPayload(payload) {
  const data = payload?.data;
  const firstOrder = Array.isArray(data) ? data[0] : data && typeof data === "object" ? data : null;

  if (!firstOrder) {
    return {
      sellerName: null,
      sellerCode: null,
    };
  }

  const sellerName =
    firstOrder?.seller_informacoes?.[0]?.nome ||
    firstOrder?.seller_informacoes?.[0]?.alias ||
    firstOrder?.nome_seller ||
    firstOrder?.seller_alias ||
    firstOrder?.seller_name ||
    null;
  const sellerCode =
    firstOrder?.seller_informacoes?.[0]?.id_seller ||
    firstOrder?.seller_informacoes?.[0]?.codigo ||
    firstOrder?.id_seller ||
    firstOrder?.seller_code ||
    null;

  return {
    sellerName: sellerName ? String(sellerName).trim() : null,
    sellerCode: sellerCode ? String(sellerCode).trim() : null,
  };
}

function buildActivationLink(req, token) {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  return `${baseUrl}/madeiramadeira/ativar?token=${encodeURIComponent(token)}`;
}

async function sendInviteEmailSafe({ email, name, link, expiresAt }) {
  try {
    return await sendInviteEmail({
      toEmail: email,
      toName: name,
      activationLink: link,
      expiresAt,
    });
  } catch (error) {
    return {
      sent: false,
      skipped: false,
      error: error?.message || "Falha ao enviar email.",
    };
  }
}

function buildPatchNotesSubject(patchNotes) {
  const version = String(patchNotes?.version || "").trim();
  const title = String(patchNotes?.title || "").trim();
  if (version && title) return `MadeiraMadeira ${version} | ${title}`;
  if (version) return `MadeiraMadeira ${version} | Ultimas atualizacoes`;
  return "MadeiraMadeira | Ultimas atualizacoes";
}

async function sendPatchNotesEmailSafe({ email, name, subject, htmlContent }) {
  try {
    return await sendPatchNotesEmail({
      toEmail: email,
      toName: name,
      subject,
      htmlContent,
    });
  } catch (error) {
    return {
      sent: false,
      skipped: false,
      error: error?.message || "Falha ao enviar release notes.",
    };
  }
}

async function respondSyncRoute(res, domain, action) {
  try {
    const result = await action();
    invalidateOperationalCaches();
    return res.json(result);
  } catch (error) {
    return res.status(207).json({
      ok: false,
      partial: true,
      domain,
      error: error?.message || `Falha ao sincronizar ${domain}.`,
      details: error?.details || null,
      status: Number(error?.status) || 500,
    });
  }
}

router.get("/", requireSuiteMadeiraAccess, (_req, res) => res.redirect("painel"));
router.get("/login", (_req, res) => res.redirect("/login"));
router.get("/ativar", (_req, res) =>
  res.sendFile(path.join(__dirname, "..", "..", "public", "activate.html")),
);
router.get("/painel", requireSuiteMadeiraAccess, (_req, res) =>
  res.sendFile(path.join(__dirname, "..", "..", "public", "painel.html")),
);

router.get("/status", (_req, res) => {
  return res.json({
    ok: true,
    module: env.moduleName,
    environment: env.runtimeEnvironment,
    timestamp: new Date().toISOString(),
  });
});

router.get(
  "/api/health",
  asyncHandler(async (_req, res) => {
    const overview = await getDashboardOverview();
    return res.json({
      ok: true,
      module: env.moduleName,
      environment: env.runtimeEnvironment,
      connected: overview.database.connected,
      timestamp: new Date().toISOString(),
    });
  }),
);

router.post(
  "/api/auth/login",
  asyncHandler(async (req, res) => {
    const result = await authenticateUser({
      email: req.body?.email,
      password: req.body?.senha || req.body?.password,
    });

    if (!result.ok) {
      return res.status(result.status || 401).json(result);
    }

    const hubAccess = await evaluateHubLoginAccess({
      user: result.user,
      workspace: result.hubIdentity?.workspace || null,
    });
    if (!hubAccess.allow) {
      return res.status(403).json({
        ok: false,
        error: hubAccess.message || "Acesso bloqueado pela politica de assinatura.",
        reason: hubAccess.reason || "hub_denied",
      });
    }

    return res.json({
      ok: true,
      user: result.user,
      timestamp: new Date().toISOString(),
    });
  }),
);

router.get(
  "/api/auth/invite",
  asyncHandler(async (req, res) => {
    const token = String(req.query.token || "").trim();

    if (!token) {
      return res.status(400).json({
        ok: false,
        error: "Token ausente.",
      });
    }

    const invite = await findInviteUserByToken(token);
    if (!invite) {
      return res.status(404).json({
        ok: false,
        error: "Convite invalido.",
      });
    }

    const expiresAt = invite.metadata?.inviteExpiresAt || null;
    if (!expiresAt || new Date(expiresAt).getTime() < Date.now()) {
      return res.status(410).json({
        ok: false,
        error: "Convite expirado.",
      });
    }

    return res.json({
      ok: true,
      invite: {
        name: invite.name,
        email: invite.email,
        role: invite.role,
        expiresAt,
      },
    });
  }),
);

router.post(
  "/api/auth/invite/activate",
  asyncHandler(async (req, res) => {
    const token = String(req.body?.token || "").trim();
    const password = String(req.body?.password || "");
    const name = String(req.body?.name || "").trim();

    if (!token || !password) {
      return res.status(400).json({
        ok: false,
        error: "Informe token e senha.",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        ok: false,
        error: "Senha deve ter pelo menos 6 caracteres.",
      });
    }

    const user = await activateInvitedUser({ token, password, name });

    return res.json({
      ok: true,
      user,
      redirect: "/madeiramadeira/login",
    });
  }),
);

router.use("/api", requireSuiteMadeiraAccess);

router.get("/api/session", (req, res) => {
  const session = req.suiteSession || {};
  return res.json({ ok: true, user: { id: session.user_id || null, workspaceId: session.workspace_id || "", name: session.name || session.email || "Usuario Davantti", email: session.email || "", role: session.role || "viewer", isMaster: session.is_master === true } });
});

router.use(
  "/api",
  asyncHandler(async (req, res, next) => {
    const pathName = String(req.path || "");
    if (
      pathName === "/health" ||
      pathName.startsWith("/auth/")
    ) {
      return next();
    }

    const access = await evaluateRequestBillingAccess(req);
    if (access.checked && !access.allow) {
      return res.status(402).json({
        ok: false,
        error: access.message || "Assinatura inativa para este modulo.",
        code: "PAYMENT_REQUIRED",
        reason: access.reason || null,
        status: access.status || null,
        redirect: "/selecao-plataforma?subscription=expired",
      });
    }

    return next();
  }),
);

router.get(
  "/api/integration/status",
  asyncHandler(async (req, res) => {
    const integration = await getWorkspaceIntegrationConfig(
      req.query.workspaceId,
      req.query.actingUserEmail,
    );

    return res.json({
      ok: true,
      workspace: integration.workspace,
      integration: {
        tokenConfigured: integration.tokenConfigured,
        tokenLast4: integration.tokenLast4,
        configuredAt: integration.configuredAt,
        configuredBy: integration.configuredBy,
        apiBaseUrl: integration.coreBaseUrl,
      },
    });
  }),
);

router.post(
  "/api/integration/connect",
  asyncHandler(async (req, res) => {
    const workspaceId = req.body?.workspaceId;
    const apiToken = String(req.body?.apiToken || req.body?.token || "").trim();
    const coreBaseUrl = String(env.coreBaseUrl || "").trim();
    const actingUserEmail = String(req.body?.actingUserEmail || "").trim().toLowerCase();

    if (!apiToken) {
      return res.status(400).json({
        ok: false,
        error: "Envie `apiToken` para integrar o seller.",
      });
    }

    const validationResult = await client.listOrders(
      { limit: 1, offset: 0 },
      { workspaceId, apiToken, coreBaseUrl },
    );
    const inferred = inferSellerFromOrderPayload(validationResult.data);
    const tokenLast4 = apiToken.slice(-4);

    const workspace = await saveWorkspaceIntegrationConfig({
      workspaceId,
      apiToken,
      coreBaseUrl,
      actingUserEmail,
      sellerName:
        inferred.sellerName ||
        `Seller ${tokenLast4}`,
      sellerCode: inferred.sellerCode,
      configuredBy: req.body?.configuredBy || req.ip,
    });
    invalidateOperationalCaches();

    return res.json({
      ok: true,
      validated: true,
      workspace,
      integration: {
        tokenConfigured: true,
        tokenLast4,
        apiBaseUrl: coreBaseUrl,
        sellerName: workspace.sellerName,
        sellerCode: workspace.sellerCode,
      },
    });
  }),
);

router.get(
  "/api/admin/workspace",
  asyncHandler(async (req, res) => {
    const access = await assertAdminAccess({
      actingUserEmail: req.query.actingUserEmail,
      workspaceId: req.query.workspaceId,
      masterOnly: true,
    });

    return res.json({
      ok: true,
      admin: access.admin,
      workspace: access.workspace,
    });
  }),
);

router.patch(
  "/api/admin/workspace",
  asyncHandler(async (req, res) => {
    const access = await assertAdminAccess({
      actingUserEmail: req.body?.actingUserEmail,
      workspaceId: req.body?.workspaceId,
      masterOnly: true,
    });

    const { sellerName, tenantGlobalId, documentType, documentNumber } =
      normalizeWorkspaceIdentityPayload(req.body);
    const documentError = validateIdentityDocument(documentType, documentNumber);

    if (!sellerName) {
      return res.status(400).json({ ok: false, error: "Informe o nome da empresa." });
    }

    if (documentError) {
      return res.status(400).json({ ok: false, error: documentError });
    }

    const workspace = await updateWorkspaceIdentity({
      workspaceId: access.workspace.id,
      sellerName,
      tenantGlobalId,
      documentType,
      documentNumber,
    });
    invalidateOperationalCaches();

    return res.json({
      ok: true,
      admin: access.admin,
      workspace,
    });
  }),
);

router.get(
  "/api/admin/users",
  asyncHandler(async (req, res) => {
    const access = await assertAdminAccess({
      actingUserEmail: req.query.actingUserEmail,
      workspaceId: req.query.workspaceId,
      masterOnly: true,
    });
    const users = await listWorkspaceUsers(access.workspace.id);

    return res.json({
      ok: true,
      admin: access.admin,
      workspace: users.workspace,
      users: users.items,
      masterAdminEmail: MASTER_ADMIN_EMAIL,
    });
  }),
);

router.post(
  "/api/admin/users/invite",
  asyncHandler(async (req, res) => {
    const targetWorkspaceId = req.body?.targetWorkspaceId || req.body?.workspaceId;
    const access = await assertAdminAccess({
      actingUserEmail: req.body?.actingUserEmail,
      workspaceId: targetWorkspaceId,
      masterOnly: true,
    });

    const created = await createInvitedUser({
      workspaceId: access.workspace.id,
      name: req.body?.name,
      email: req.body?.email,
      role: req.body?.role,
      invitedBy: access.admin.email,
    });
    invalidateOperationalCaches();

    const activationLink = buildActivationLink(req, created.inviteToken);
    const emailDelivery = await sendInviteEmailSafe({
      email: created.user.email,
      name: created.user.name,
      link: activationLink,
      expiresAt: created.inviteExpiresAt.toISOString(),
    });

    return res.status(201).json({
      ok: true,
      workspace: created.workspace,
      user: created.user,
      invite: {
        link: activationLink,
        expiresAt: created.inviteExpiresAt.toISOString(),
      },
      emailDelivery,
    });
  }),
);

router.post(
  "/api/admin/users/:id/invite",
  asyncHandler(async (req, res) => {
    const access = await assertAdminAccess({
      actingUserEmail: req.body?.actingUserEmail,
      workspaceId: req.body?.workspaceId,
      masterOnly: true,
    });

    const invited = await resendUserInvite({
      workspaceId: access.workspace.id,
      userId: req.params.id,
      invitedBy: access.admin.email,
    });
    invalidateOperationalCaches();

    const activationLink = buildActivationLink(req, invited.inviteToken);
    const emailDelivery = await sendInviteEmailSafe({
      email: invited.user.email,
      name: invited.user.name,
      link: activationLink,
      expiresAt: invited.inviteExpiresAt.toISOString(),
    });

    return res.json({
      ok: true,
      workspace: invited.workspace,
      user: invited.user,
      invite: {
        link: activationLink,
        expiresAt: invited.inviteExpiresAt.toISOString(),
      },
      emailDelivery,
    });
  }),
);

router.patch(
  "/api/admin/users/:id",
  asyncHandler(async (req, res) => {
    const access = await assertAdminAccess({
      actingUserEmail: req.body?.actingUserEmail,
      workspaceId: req.body?.workspaceId,
      masterOnly: true,
    });

    const updated = await updateWorkspaceUser({
      workspaceId: access.workspace.id,
      userId: req.params.id,
      role: req.body?.role,
      status: req.body?.status,
    });
    invalidateOperationalCaches();

    return res.json({
      ok: true,
      workspace: updated.workspace,
      user: updated.user,
    });
  }),
);

router.get(
  "/api/patch-notes/history",
  asyncHandler(async (req, res) => {
    const history = await listPatchNotesHistory({
      workspaceId: req.query.workspaceId,
      limit: req.query.limit,
    });

    return res.json({
      ok: true,
      workspace: history.workspace,
      items: history.items,
    });
  }),
);

router.get(
  "/api/admin/patch-notes/recipients",
  asyncHandler(async (req, res) => {
    const access = await assertAdminAccess({
      actingUserEmail: req.query.actingUserEmail,
      workspaceId: req.query.workspaceId,
      masterOnly: true,
    });
    const recipients = await listPatchNotesRecipients(access.workspace.id);

    return res.json({
      ok: true,
      workspace: recipients.workspace,
      totalRecipients: recipients.totalRecipients,
      users: recipients.users,
    });
  }),
);

router.post(
  "/api/admin/patch-notes/preview",
  asyncHandler(async (req, res) => {
    const access = await assertAdminAccess({
      actingUserEmail: req.body?.actingUserEmail,
      workspaceId: req.body?.workspaceId,
      masterOnly: true,
    });
    const patchNotes = normalizePatchNotesPayload(req.body);

    if (!patchNotes.version) {
      return res.status(400).json({ ok: false, error: "Informe a versao do release notes." });
    }

    if (!patchNotes.summary) {
      return res.status(400).json({ ok: false, error: "Informe o resumo principal do release notes." });
    }

    const subject = buildPatchNotesSubject(patchNotes);
    const html = buildPatchNotesHtml({
      nome: access.admin.name || access.admin.email,
      patchNotes,
    });

    return res.json({
      ok: true,
      workspace: access.workspace,
      preview: {
        subject,
        version: patchNotes.version,
        html,
        recipientCount: patchNotes.recipientEmails.length,
      },
    });
  }),
);

router.post(
  "/api/admin/patch-notes/send",
  asyncHandler(async (req, res) => {
    const access = await assertAdminAccess({
      actingUserEmail: req.body?.actingUserEmail,
      workspaceId: req.body?.workspaceId,
      masterOnly: true,
    });
    const patchNotes = normalizePatchNotesPayload(req.body);

    if (!patchNotes.version) {
      return res.status(400).json({ ok: false, error: "Informe a versao do release notes." });
    }

    if (!patchNotes.summary) {
      return res.status(400).json({ ok: false, error: "Informe o resumo principal do release notes." });
    }

    let recipients = [];
    if (patchNotes.recipientEmails.length) {
      recipients = await listUsersByEmailsActive(access.workspace.id, patchNotes.recipientEmails);
    } else {
      const result = await listPatchNotesRecipients(access.workspace.id);
      recipients = result.users || [];
      patchNotes.recipientEmails = recipients.map((user) => user.email);
    }

    if (!recipients.length) {
      return res.status(400).json({ ok: false, error: "Nenhum destinatario ativo encontrado para este workspace." });
    }

    const subject = buildPatchNotesSubject(patchNotes);
    let sentCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let lastError = null;

    for (const recipient of recipients) {
      const html = buildPatchNotesHtml({
        nome: recipient.name || recipient.email,
        patchNotes,
      });
      const delivery = await sendPatchNotesEmailSafe({
        email: recipient.email,
        name: recipient.name,
        subject,
        htmlContent: html,
      });

      if (delivery.sent) {
        sentCount += 1;
      } else if (delivery.skipped) {
        skippedCount += 1;
      } else {
        failedCount += 1;
        lastError = delivery.error || "Falha ao enviar release notes.";
      }
    }

    const storedHtml = buildPatchNotesHtml({
      nome: "time",
      patchNotes,
    });

    const history = await createPatchNoteHistory({
      workspaceId: access.workspace.id,
      version: patchNotes.version,
      title: patchNotes.title,
      summary: patchNotes.summary,
      subject,
      html: storedHtml,
      newFeatures: patchNotes.newFeatures,
      adjustments: patchNotes.adjustments,
      recipientCount: recipients.length,
      sentCount,
      skippedCount,
      failedCount,
      createdByName: access.admin.name,
      createdByEmail: access.admin.email,
    });

    return res.status(failedCount > 0 ? 207 : 200).json({
      ok: failedCount === 0,
      workspace: access.workspace,
      releaseNote: history,
      totals: {
        recipientCount: recipients.length,
        sentCount,
        skippedCount,
        failedCount,
      },
      error: lastError,
    });
  }),
);

router.get(
  "/api/dashboard/overview",
  asyncHandler(async (req, res) => {
    const cacheKey = buildCacheKey("dashboard-overview", req.query);
    const payload = await getOrSetCached(cacheKey, DASHBOARD_CACHE_TTL_MS, () =>
      buildDashboardPayload(
        req.query.period || "30d",
        req.query.workspaceId,
      ),
    );
    return res.json({
      ok: true,
      module: env.moduleName,
      ...payload,
      timestamp: new Date().toISOString(),
    });
  }),
);

router.get(
  "/api/catalog/overview",
  asyncHandler(async (req, res) => {
    const overview = await getCatalogOverview(req.query);
    return res.json({ ok: true, overview });
  }),
);

router.get(
  "/api/catalog/categories",
  asyncHandler(async (req, res) => {
    if (String(req.query.source || "").toLowerCase() === "marketplace") {
      const limit = toPositiveInt(req.query.limit, 100);
      const offset = toPositiveInt(req.query.offset, 0);
      const result = await client.listCategories(
        { limit, offset },
        { workspaceId: req.query.workspaceId },
      );

      return res.json({
        ok: true,
        source: "madeiramadeira",
        limit,
        offset,
        status: result.status,
        data: result.data,
      });
    }

    const categories = await listLocalCategories(req.query);
    return res.json({ ok: true, source: "database", ...categories });
  }),
);

router.get(
  "/api/catalog/products",
  asyncHandler(async (req, res) => {
    const products = await listLocalProducts(req.query);
    return res.json({ ok: true, ...products });
  }),
);

router.get(
  "/api/remote/catalog/products/non-commercialized",
  asyncHandler(async (req, res) => {
    const limit = toPositiveInt(req.query.limit, 100);
    const offset = toPositiveInt(req.query.offset, 0);
    const result = await client.listNonCommercializedProducts(
      { limit, offset },
      { workspaceId: req.query.workspaceId },
    );

    return res.json({
      ok: true,
      status: result.status,
      limit,
      offset,
      data: result.data,
    });
  }),
);

router.get(
  "/api/remote/catalog/products/publishing",
  asyncHandler(async (req, res) => {
    const limit = toPositiveInt(req.query.limit, 100);
    const offset = toPositiveInt(req.query.offset, 0);
    const result = await client.listPublishingProducts(
      { limit, offset },
      { workspaceId: req.query.workspaceId },
    );

    return res.json({
      ok: true,
      status: result.status,
      limit,
      offset,
      data: result.data,
    });
  }),
);

router.get(
  "/api/remote/catalog/products/publishing/:sku",
  asyncHandler(async (req, res) => {
    const result = await client.getPublishingProductBySku(req.params.sku, {
      workspaceId: req.query.workspaceId,
    });
    return res.json({
      ok: true,
      status: result.status,
      sku: req.params.sku,
      data: result.data,
    });
  }),
);

router.get(
  "/api/remote/catalog/products/situation/:situation",
  asyncHandler(async (req, res) => {
    const limit = toPositiveInt(req.query.limit, 100);
    const offset = toPositiveInt(req.query.offset, 0);
    const result = await client.listProductsBySituation({
      situation: req.params.situation,
      limit,
      offset,
    }, {
      workspaceId: req.query.workspaceId,
    });

    return res.json({
      ok: true,
      status: result.status,
      situation: req.params.situation,
      limit,
      offset,
      data: result.data,
    });
  }),
);

router.get(
  "/api/catalog/products/:productId",
  asyncHandler(async (req, res) => {
    const product = await getLocalProduct(req.params.productId, {
      workspaceId: req.query.workspaceId,
    });
    if (!product) {
      return res.status(404).json({ ok: false, error: "Produto nao encontrado." });
    }

    return res.json({ ok: true, product });
  }),
);

router.post(
  "/api/catalog/products",
  asyncHandler(async (req, res) => {
    const product = await saveLocalProduct(req.body, {
      workspaceId: req.body?.workspaceId,
    });
    invalidateOperationalCaches();
    return res.status(201).json({ ok: true, product });
  }),
);

router.put(
  "/api/catalog/products/:productId",
  asyncHandler(async (req, res) => {
    const product = await saveLocalProduct(req.body, {
      productId: req.params.productId,
      workspaceId: req.body?.workspaceId,
    });
    invalidateOperationalCaches();
    return res.json({ ok: true, product });
  }),
);

router.post(
  "/api/catalog/products/:productId/publish",
  asyncHandler(async (req, res) => {
    const workspaceId = req.body?.workspaceId || req.query.workspaceId;
    const product = await getLocalProduct(req.params.productId, { workspaceId });
    if (!product) {
      return res.status(404).json({ ok: false, error: "Produto nao encontrado." });
    }

    const payload = [buildMarketplaceProductPayload(product)];
    const result = await client.sendProducts(payload, { workspaceId });
    invalidateOperationalCaches();

    return res.json({
      ok: true,
      submitted: 1,
      status: result.status,
      payload,
      data: result.data,
    });
  }),
);

router.post(
  "/api/catalog/products/publish-batch",
  asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body?.productIds) ? req.body.productIds : [];
    const explicitProducts = Array.isArray(req.body?.products) ? req.body.products : [];
    const workspaceId = req.body?.workspaceId || req.query.workspaceId;

    let payload = explicitProducts;

    if (!payload.length && ids.length) {
      const found = await Promise.all(
        ids.map((id) => getLocalProduct(id, { workspaceId })),
      );
      payload = found.filter(Boolean).map((product) => buildMarketplaceProductPayload(product));
    }

    if (!payload.length) {
      return res.status(400).json({
        ok: false,
        error: "Envie `products` ou `productIds` para publicar.",
      });
    }

    const result = await client.sendProducts(payload, { workspaceId });
    invalidateOperationalCaches();
    return res.json({
      ok: true,
      submitted: payload.length,
      status: result.status,
      data: result.data,
    });
  }),
);

router.get(
  "/api/orders/overview",
  asyncHandler(async (req, res) => {
    const overview = await getOrdersOverview(req.query);
    return res.json({ ok: true, overview });
  }),
);

router.get(
  "/api/orders",
  asyncHandler(async (req, res) => {
    const orders = await listLocalOrders(req.query);
    return res.json({ ok: true, ...orders });
  }),
);

router.get(
  "/api/remote/orders",
  asyncHandler(async (req, res) => {
    const limit = toPositiveInt(req.query.limit, 50);
    const offset = toPositiveInt(req.query.offset, 0);
    const result = await client.listOrders(
      { limit, offset },
      { workspaceId: req.query.workspaceId },
    );
    return res.json({ ok: true, status: result.status, limit, offset, data: result.data });
  }),
);

router.get(
  "/api/remote/orders/status/:status",
  asyncHandler(async (req, res) => {
    const limit = toPositiveInt(req.query.limit, 50);
    const offset = toPositiveInt(req.query.offset, 0);
    const result = await client.listOrdersByStatus({
      status: req.params.status,
      limit,
      offset,
    }, {
      workspaceId: req.query.workspaceId,
    });

    return res.json({
      ok: true,
      status: result.status,
      orderStatus: req.params.status,
      limit,
      offset,
      data: result.data,
    });
  }),
);

router.get(
  "/api/orders/:orderId",
  asyncHandler(async (req, res) => {
    const order = await getLocalOrder(req.params.orderId, {
      workspaceId: req.query.workspaceId,
    });
    if (!order) {
      return res.status(404).json({ ok: false, error: "Pedido nao encontrado." });
    }

    return res.json({ ok: true, order });
  }),
);

router.get(
  "/api/remote/orders/:orderId",
  asyncHandler(async (req, res) => {
    const result = await client.getOrderById(req.params.orderId, {
      workspaceId: req.query.workspaceId,
    });
    return res.json({
      ok: true,
      status: result.status,
      orderId: req.params.orderId,
      data: result.data,
    });
  }),
);

router.get(
  "/api/freight/overview",
  asyncHandler(async (req, res) => {
    const overview = await getFreightOverview(req.query);
    return res.json({ ok: true, overview });
  }),
);

router.get(
  "/api/freight/quotes",
  asyncHandler(async (req, res) => {
    const quotes = await listFreightQuotes(req.query);
    return res.json({ ok: true, ...quotes });
  }),
);

router.post("/api/freight/quote/validate", (req, res) => {
  return res.json({
    ok: true,
    freightRules: {
      maxResponseMs: env.freightMaxResponseMs,
      requiredAvailability: env.freightRequiredAvailability,
    },
    validation: validateFreightPayload(req.body),
  });
});

router.get(
  "/api/finance/overview",
  asyncHandler(async (req, res) => {
    const overview = await getFinanceOverview(req.query);
    return res.json({ ok: true, overview });
  }),
);

router.get(
  "/api/finance/entries",
  asyncHandler(async (req, res) => {
    const entries = await listFinancialEntries(req.query);
    return res.json({ ok: true, ...entries });
  }),
);

router.get(
  "/api/remote/finance/entries",
  asyncHandler(async (req, res) => {
    const limit = toPositiveInt(req.query.limit, 100);
    const offset = toPositiveInt(req.query.offset, 0);
    const type = req.query.type || 7;
    const dateFrom = String(req.query.dateFrom || "");
    const dateTo = String(req.query.dateTo || "");

    if (!dateFrom || !dateTo) {
      return res.status(400).json({
        ok: false,
        error: "Envie `dateFrom` e `dateTo` para consultar o financeiro remoto.",
      });
    }

    const result = await client.listFinancialLaunches({
      dateFrom,
      dateTo,
      limit,
      offset,
      type,
    }, {
      workspaceId: req.query.workspaceId,
    });

    return res.json({
      ok: true,
      status: result.status,
      limit,
      offset,
      type,
      dateFrom,
      dateTo,
      data: result.data,
    });
  }),
);

router.get(
  "/api/messaging/overview",
  asyncHandler(async (req, res) => {
    const overview = await getMessagingOverview(req.query);
    return res.json({ ok: true, overview });
  }),
);

router.get(
  "/api/messaging/threads",
  asyncHandler(async (req, res) => {
    const threads = await listMessageThreads(req.query);
    return res.json({ ok: true, ...threads });
  }),
);

router.get(
  "/api/remote/messaging/sessions",
  asyncHandler(async (req, res) => {
    const page = toPositiveInt(req.query.page, 1);
    const limit = toPositiveInt(req.query.limit, 20);
    const status = req.query.status;
    const result = await client.listSellerSessionHistoric(
      { page, limit, status },
      { workspaceId: req.query.workspaceId },
    );

    return res.json({
      ok: true,
      status: result.status,
      page,
      limit,
      filterStatus: status || null,
      data: result.data,
    });
  }),
);

router.get(
  "/api/remote/messaging/sessions/:sessionId",
  asyncHandler(async (req, res) => {
    const result = await client.getSessionById(req.params.sessionId, {
      workspaceId: req.query.workspaceId,
    });
    return res.json({
      ok: true,
      status: result.status,
      sessionId: req.params.sessionId,
      data: result.data,
    });
  }),
);

router.get(
  "/api/messaging/awaiting-answer-count",
  asyncHandler(async (req, res) => {
    const result = await client.getAwaitingAnswerCount({
      workspaceId: req.query.workspaceId,
    });
    return res.json({ ok: true, status: result.status, data: result.data });
  }),
);

router.get(
  "/api/messaging/orders-history",
  asyncHandler(async (req, res) => {
    const orders = String(req.query.orders || "").trim();

    if (!orders) {
      return res.status(400).json({
        ok: false,
        error: "Informe o parametro `orders`.",
      });
    }

    const result = await client.getOrderHistory(orders, {
      workspaceId: req.query.workspaceId,
    });
    return res.json({
      ok: true,
      status: result.status,
      orders,
      data: result.data,
    });
  }),
);

router.post(
  "/api/messaging/revoke-token",
  asyncHandler(async (req, res) => {
    const token = String(req.body?.token || "").trim();

    if (!token) {
      return res.status(400).json({
        ok: false,
        error: "Envie `token` no body para revogacao.",
      });
    }

    const result = await client.revokeMessagingToken(token);
    return res.json({ ok: true, status: result.status, data: result.data });
  }),
);

router.post(
  "/api/messaging/uploads",
  asyncHandler(async (req, res) => {
    const bodyBuffer = await readRawBody(req);
    const parsed = parseMultipartRequest(req, bodyBuffer);
    const file = parsed.files[0];

    if (!file) {
      return res.status(400).json({
        ok: false,
        error: "Arquivo nao encontrado no campo `file`.",
      });
    }

    const result = await client.uploadAttachment({
      fileBuffer: file.buffer,
      fileName: file.originalName,
      contentType: file.contentType,
      orderId: parsed.fields.order_id,
      rootPath: parsed.fields.root_path,
    });

    return res.status(201).json({
      ok: true,
      status: result.status,
      data: result.data,
    });
  }),
);

router.get(
  /^\/api\/messaging\/uploads\/download\/(.+)$/,
  asyncHandler(async (req, res) => {
    const s3Key = String(req.params[0] || "").trim();
    if (!s3Key) {
      return res.status(400).json({
        ok: false,
        error: "Informe o `s3_key` do arquivo.",
      });
    }

    const result = await client.getAttachmentDownloadUrl(s3Key);
    return res.json({ ok: true, status: result.status, data: result.data });
  }),
);

router.get(
  "/api/analytics/overview",
  asyncHandler(async (req, res) => {
    const cacheKey = buildCacheKey("analytics-overview", req.query);
    const analytics = await getOrSetCached(cacheKey, ANALYTICS_CACHE_TTL_MS, () => getAnalyticsOverview(req.query));
    return res.json({ ok: true, analytics });
  }),
);

router.get(
  "/api/analytics/revenue-series",
  asyncHandler(async (req, res) => {
    const cacheKey = buildCacheKey("analytics-overview", req.query);
    const analytics = await getOrSetCached(cacheKey, ANALYTICS_CACHE_TTL_MS, () => getAnalyticsOverview(req.query));
    return res.json({ ok: true, period: analytics.period, series: analytics.series.revenue });
  }),
);

router.get(
  "/api/analytics/orders-series",
  asyncHandler(async (req, res) => {
    const cacheKey = buildCacheKey("analytics-overview", req.query);
    const analytics = await getOrSetCached(cacheKey, ANALYTICS_CACHE_TTL_MS, () => getAnalyticsOverview(req.query));
    return res.json({ ok: true, period: analytics.period, series: analytics.series.orders });
  }),
);

router.get(
  "/api/analytics/products-growth",
  asyncHandler(async (req, res) => {
    const cacheKey = buildCacheKey("analytics-overview", req.query);
    const analytics = await getOrSetCached(cacheKey, ANALYTICS_CACHE_TTL_MS, () => getAnalyticsOverview(req.query));
    return res.json({
      ok: true,
      period: analytics.period,
      items: analytics.products.growth,
    });
  }),
);

router.get(
  "/api/analytics/quality",
  asyncHandler(async (req, res) => {
    const cacheKey = buildCacheKey("analytics-overview", req.query);
    const analytics = await getOrSetCached(cacheKey, ANALYTICS_CACHE_TTL_MS, () => getAnalyticsOverview(req.query));
    return res.json({
      ok: true,
      period: analytics.period,
      quality: analytics.quality,
      distributions: analytics.distributions,
    });
  }),
);

router.get(
  "/api/analytics/period-growth",
  asyncHandler(async (req, res) => {
    const cacheKey = buildCacheKey("analytics-overview", req.query);
    const analytics = await getOrSetCached(cacheKey, ANALYTICS_CACHE_TTL_MS, () => getAnalyticsOverview(req.query));
    return res.json({
      ok: true,
      period: analytics.period,
      kpis: analytics.kpis,
    });
  }),
);

router.get(
  "/api/analytics/month-projection",
  asyncHandler(async (req, res) => {
    const cacheKey = buildCacheKey("analytics-projection", req.query);
    const projection = await getOrSetCached(cacheKey, ANALYTICS_CACHE_TTL_MS, () => getMonthlyProjection(req.query));
    return res.json({ ok: true, projection });
  }),
);

router.get(
  "/api/admin/workspaces",
  asyncHandler(async (req, res) => {
    const access = await assertAdminAccess({
      actingUserEmail: req.query.actingUserEmail,
      workspaceId: req.query.workspaceId,
      masterOnly: true,
    });
    const items = await listActiveWorkspaces(req.query.limit || 120);

    return res.json({
      ok: true,
      admin: access.admin,
      selectedWorkspaceId: access.workspace.id,
      items,
    });
  }),
);

router.get(
  "/api/analytics/abc",
  asyncHandler(async (req, res) => {
    const cacheKey = buildCacheKey("analytics-abc", req.query);
    const abc = await getOrSetCached(cacheKey, ANALYTICS_CACHE_TTL_MS, () => getAbcCurve(req.query));
    return res.json({ ok: true, abc });
  }),
);

router.get(
  "/api/reports/sales",
  asyncHandler(async (req, res) => {
    const cacheKey = buildCacheKey("report-sales", req.query);
    const report = await getOrSetCached(cacheKey, REPORT_CACHE_TTL_MS, () => getSalesReport(req.query));
    const format = String(req.query.format || "json").trim().toLowerCase();

    if (format === "csv") {
      const stamp = new Date().toISOString().slice(0, 10);
      const csv = buildSalesReportCsv(report);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename=\"madeiramadeira-sales-report-${stamp}.csv\"`);
      return res.send(`\uFEFF${csv}`);
    }

    return res.json({ ok: true, report });
  }),
);

router.get(
  "/api/sync/runs",
  asyncHandler(async (req, res) => {
    const runs = await listSyncRuns(req.query);
    return res.json({ ok: true, ...runs });
  }),
);

router.post(
  "/api/sync/catalog",
  asyncHandler(async (req, res) => {
    return respondSyncRoute(res, "catalog", () =>
      syncCatalog({
        workspaceId: req.body?.workspaceId,
        actingUserEmail: req.body?.actingUserEmail,
        limit: req.body?.limit,
        offset: req.body?.offset,
        requestedBy: req.body?.requestedBy || req.ip,
      }),
    );
  }),
);

router.post(
  "/api/sync/orders",
  asyncHandler(async (req, res) => {
    return respondSyncRoute(res, "orders", () =>
      syncOrders({
        workspaceId: req.body?.workspaceId,
        actingUserEmail: req.body?.actingUserEmail,
        limit: req.body?.limit,
        offset: req.body?.offset,
        requestedBy: req.body?.requestedBy || req.ip,
      }),
    );
  }),
);

router.post(
  "/api/sync/finance",
  asyncHandler(async (req, res) => {
    return respondSyncRoute(res, "finance", () =>
      syncFinance({
        workspaceId: req.body?.workspaceId,
        actingUserEmail: req.body?.actingUserEmail,
        limit: req.body?.limit,
        offset: req.body?.offset,
        dateFrom: req.body?.dateFrom,
        dateTo: req.body?.dateTo,
        type: req.body?.type,
        requestedBy: req.body?.requestedBy || req.ip,
      }),
    );
  }),
);

router.post(
  "/api/sync/messaging",
  asyncHandler(async (req, res) => {
    return respondSyncRoute(res, "messaging", () =>
      syncMessaging({
        workspaceId: req.body?.workspaceId,
        actingUserEmail: req.body?.actingUserEmail,
        page: req.body?.page,
        limit: req.body?.limit,
        status: req.body?.status,
        requestedBy: req.body?.requestedBy || req.ip,
      }),
    );
  }),
);

router.post(
  "/api/sync/all",
  asyncHandler(async (req, res) => {
    const workspaceId = req.body?.workspaceId;
    return respondSyncRoute(res, "all", () =>
      syncAllDomains({
        includeMessaging: false,
        catalog: {
          workspaceId,
          actingUserEmail: req.body?.actingUserEmail,
          limit: req.body?.catalog?.limit,
          offset: req.body?.catalog?.offset,
          maxPages: req.body?.catalog?.maxPages,
          requestedBy: req.body?.requestedBy || req.ip,
        },
        orders: {
          workspaceId,
          actingUserEmail: req.body?.actingUserEmail,
          limit: req.body?.orders?.limit,
          offset: req.body?.orders?.offset,
          requestedBy: req.body?.requestedBy || req.ip,
        },
        finance: {
          workspaceId,
          actingUserEmail: req.body?.actingUserEmail,
          limit: req.body?.finance?.limit,
          offset: req.body?.finance?.offset,
          dateFrom: req.body?.finance?.dateFrom,
          dateTo: req.body?.finance?.dateTo,
          type: req.body?.finance?.type,
          requestedBy: req.body?.requestedBy || req.ip,
        },
        messaging: {
          workspaceId,
          actingUserEmail: req.body?.actingUserEmail,
          page: req.body?.messaging?.page,
          limit: req.body?.messaging?.limit,
          status: req.body?.messaging?.status,
          requestedBy: req.body?.requestedBy || req.ip,
        },
      }),
    );
  }),
);

module.exports = router;
