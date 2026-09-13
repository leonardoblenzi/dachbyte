const express = require("express");
const bcrypt = require("bcrypt");
const { requireAuth, requireRole } = require("../middlewares/sessionAuth");
const { revokeHubModuleAccess, syncHubIdentity } = require("../../../../lib/hubIdentitySync");
const AdminDbController = require("../controllers/AdminDbController");
const {
  activationExpiryDate,
  buildActivationLink,
  createActivationToken,
  createTemporaryPassword,
  hashToken,
} = require("./authLocal.routes");
const {
  buildPatchNotesHtml,
  sendInviteEmail,
  sendPatchNotesEmail,
} = require("../services/inviteEmailService");
const ShopeePushAdminService = require("../services/ShopeePushAdminService");
const AccountPerformanceReportService = require("../services/AdminAccountPerformanceReportService");
const {
  getRequestIp,
  getRequestUserAgent,
  recordAuthEvent,
} = require("../services/authAuditService");
const {
  controlShopeeWebhookQueue,
  getShopeeWebhookQueuesStatus,
} = require("../config/queue");
const {
  countAdminsByAccountId,
  createAccountAndOwnerInvite,
  createInvitedUser,
  createReleaseNote,
  deleteSessionsByUserId,
  deleteUserById,
  findReleaseNoteById,
  findAccountById,
  findUserByEmail,
  findUserInAccountById,
  listAccountsWithUsersAndShops,
  listPatchNotesRecipientsByAccount,
  listReleaseNotes,
  listUsersByAccountId,
  listUsersByEmailsActive,
  updateAccountIdentityById,
  updateUserInvite,
  updateUserProfile,
  updateUserRole,
} = require("../repositories/authSqlRepository");
const {
  createAdminInformativeNotice,
  deleteAdminInformativeNoticeById,
  listActiveAdminInformativeNotices,
  listAdminInformativeNotices,
  updateAdminInformativeNoticeById,
} = require("../repositories/adminInformativeSqlRepository");
const {
  getProcessExecutionLogById,
  listRecentCompletedProcessLogsForUser,
} = require("../repositories/processExecutionSqlRepository");

const router = express.Router();
router.use(requireAuth);
const { isMasterAdminAuth } = require("../config/masterAdmin");
function isMasterAdmin(auth) {
  return isMasterAdminAuth(auth);
}

function requireMasterAdmin(req, res, next) {
  if (!isMasterAdmin(req.auth)) {
    return res.status(403).json({
      error: "forbidden",
      message: "Acesso restrito ao admin master.",
    });
  }
  return next();
}

async function sendInviteEmailSafe({ email, name, link, expiresAt }) {
  try {
    return await sendInviteEmail({
      toEmail: email,
      toName: name,
      activationLink: link,
      expiresAt,
    });
  } catch (err) {
    console.error("invite email erro:", err?.message || err);
    return {
      sent: false,
      skipped: false,
      error: err?.message || "Falha ao enviar email via Brevo.",
    };
  }
}

function normalizeCompanyDocumentType(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  if (normalized === "CPF" || normalized === "CNPJ") {
    return normalized;
  }
  return null;
}

function normalizeCompanyDocumentNumber(value) {
  return String(value || "").replace(/\D/g, "");
}

async function syncShopeeUserToHub(accountId, user, { explicit = false } = {}) {
  try {
    const account = await findAccountById(accountId);
    if (!account?.tenantGlobalId || !user?.userGlobalId || !user?.email) {
      return { ok: false, skipped: true, reason: "identity_not_ready" };
    }
    return await syncHubIdentity({
      tenant_id: account.tenantGlobalId,
      company_name: account.name || "Davantti Shopee",
      document_type: account.documentType || null,
      document_number: account.documentNumber || null,
      user_id: user.userGlobalId,
      full_name: user.name || user.email,
      email: user.email,
      role: String(user.role || "VIEWER").toUpperCase() === "ADMIN" ? "admin" : "operator",
      module: "shopee",
      modules: ["shopee"],
      access_policy: explicit ? "explicit" : null,
    });
  } catch (error) {
    console.error("shopee hub identity sync erro:", error?.message || error);
    return { ok: false, skipped: false, reason: "hub_identity_sync_failed" };
  }
}

async function revokeShopeeUserFromHub(accountId, user) {
  try {
    const account = await findAccountById(accountId);
    if (!account?.tenantGlobalId || (!user?.userGlobalId && !user?.email)) {
      return { ok: false, skipped: true, reason: "identity_not_ready" };
    }
    return await revokeHubModuleAccess({
      tenant_id: account.tenantGlobalId,
      user_id: user.userGlobalId || null,
      email: user.email || null,
      module: "shopee",
      note: "Usuario removido no modulo Shopee",
    });
  } catch (error) {
    console.error("shopee hub module revoke erro:", error?.message || error);
    return { ok: false, skipped: false, reason: "hub_module_revoke_failed" };
  }
}

function inferCompanyDocumentType(documentNumber) {
  if (documentNumber.length === 11) return "CPF";
  if (documentNumber.length === 14) return "CNPJ";
  return null;
}

function validateCompanyDocument(documentType, documentNumber) {
  if (!documentType && !documentNumber) {
    return null;
  }

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

function normalizeTenantGlobalId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

router.post("/audit/tab-access", async (req, res, next) => {
  try {
    const tab = String(req.body?.tab || "").trim().slice(0, 80);
    if (!tab) {
      return res.status(400).json({
        ok: false,
        error: "tab_required",
        message: "Aba não informada.",
      });
    }

    await recordAuthEvent({
      userId: req.auth?.userId || null,
      email: req.auth?.email || null,
      event: "tab_accessed",
      status: "success",
      ip: getRequestIp(req),
      userAgent: getRequestUserAgent(req),
      metadata: {
        tab,
        accountId: req.auth?.accountId || null,
        activeShopId: req.auth?.activeShopId || null,
      },
    });

    return res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

function normalizeCompanyProfileText(value, maxLength = 255) {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizeCompanyPhotoUrl(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  return normalized.slice(0, 2_000_000);
}

function normalizeGoalCents(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
  }
  const raw = String(value || "").trim();
  if (!raw) return null;
  const sanitized = raw
    .replace(/[R$\s]/gi, "")
    .replace(/[^\d,.-]/g, "");
  const normalized = sanitized.includes(",")
    ? sanitized.replace(/\./g, "").replace(",", ".")
    : sanitized;
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 100);
}

function normalizeCompanyIdentityPayload(body = {}) {
  const documentNumber = normalizeCompanyDocumentNumber(body?.documentNumber);
  const documentType =
    normalizeCompanyDocumentType(body?.documentType) ||
    inferCompanyDocumentType(documentNumber);

  return {
    accountName: String(body?.accountName || body?.name || "").trim(),
    tenantGlobalId: normalizeTenantGlobalId(body?.tenantGlobalId),
    documentType,
    documentNumber,
    companyPhotoUrl: normalizeCompanyPhotoUrl(body?.companyPhotoUrl),
    responsibleName: normalizeCompanyProfileText(body?.responsibleName),
    responsibleContact: normalizeCompanyProfileText(
      body?.responsibleContact,
      500,
    ),
    currentMonthGoalCents: normalizeGoalCents(body?.currentMonthGoal),
    quarterGoalCents: normalizeGoalCents(body?.quarterGoal),
    semesterGoalCents: normalizeGoalCents(body?.semesterGoal),
    annualGoalCents: normalizeGoalCents(body?.annualGoal),
  };
}

function normalizePatchNotesPayload(body = {}) {
  const version = String(body?.version || "").trim();
  const title = String(body?.title || "").trim();
  const summary = String(body?.summary || "").trim();

  const toCleanList = (value) => {
    if (!Array.isArray(value)) return [];
    return Array.from(
      new Set(
        value
          .map((item) => String(item || "").trim())
          .filter(Boolean),
      ),
    );
  };

  return {
    version,
    title,
    summary,
    newFeatures: toCleanList(body?.newFeatures),
    adjustments: toCleanList(body?.adjustments),
    recipientEmails: Array.from(
      new Set(
        toCleanList(body?.recipientEmails).map((email) => email.toLowerCase()),
      ),
    ),
  };
}

function normalizeReleaseNoteList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function normalizeHexColor(value) {
  const raw = String(value || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toUpperCase();
  return "#FF5A00";
}

function normalizeSaoPauloDateTimeInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/[zZ]$/.test(raw) || /[+-]\d{2}:?\d{2}$/.test(raw)) {
    return raw;
  }
  const localDateTime = raw.match(
    /^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/,
  );
  if (localDateTime) {
    return `${localDateTime[1]}T${localDateTime[2]}:${localDateTime[3] || "00"}-03:00`;
  }
  return raw;
}

function normalizeInformativeNoticePayload(body = {}) {
  const rawType = String(body?.noticeType || body?.type || "TAG")
    .trim()
    .toUpperCase();
  const noticeType = rawType === "POPUP" ? "POPUP" : "TAG";
  return {
    title: String(body?.title || "").trim(),
    message: String(body?.message || "").trim(),
    noticeType,
    color: normalizeHexColor(body?.color),
    linkUrl: String(body?.linkUrl || "").trim(),
    imageUrl: String(body?.imageUrl || "").trim(),
    startsAt: normalizeSaoPauloDateTimeInput(body?.startsAt || body?.startAt),
    endsAt: normalizeSaoPauloDateTimeInput(body?.endsAt || body?.endAt),
    enabled: body?.enabled !== false,
    priority: Number(body?.priority || 0),
  };
}

function relayShopeePushError(error, res, fallbackMessage) {
  const statusCode = Number(error?.statusCode || 500);
  if (error?.shopee) {
    return res.status(statusCode).json({
      error: String(error.shopee?.error || "shopee_api_error"),
      message:
        String(error.shopee?.message || error.shopee?.warning || "").trim() ||
        fallbackMessage ||
        "Falha ao consultar Shopee Push.",
      shopee: error.shopee,
    });
  }

  return res.status(statusCode).json({
    error: "push_api_failed",
    message: String(error?.message || fallbackMessage || "Falha no endpoint de Push."),
  });
}

function serializeReleaseNote(note) {
  const newFeatures = normalizeReleaseNoteList(note?.newFeatures);
  const adjustments = normalizeReleaseNoteList(note?.adjustments);

  return {
    id: note.id,
    version: note.version,
    title: note.title,
    summary: note.summary,
    subject: note.subject,
    html: note.html,
    newFeatures,
    adjustments,
    newFeaturesCount: newFeatures.length,
    adjustmentsCount: adjustments.length,
    recipientCount: Number(note.recipientCount || 0),
    sentCount: Number(note.sentCount || 0),
    skippedCount: Number(note.skippedCount || 0),
    failedCount: Number(note.failedCount || 0),
    createdByName: note.createdByName || null,
    createdByEmail: note.createdByEmail || null,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

function serializeShop(shop) {
  return {
    id: shop.id,
    shopId: shop.shopId == null ? null : String(shop.shopId),
    region: shop.region || null,
    status: shop.status || null,
    createdAt: shop.createdAt || null,
  };
}

function buildSingleProcessLogText(entry = {}) {
  const lines = [];
  const statusLabel = entry?.success ? "SUCCESS" : "ERROR";
  lines.push(`Processo #${entry?.id || "-"}`);
  lines.push(`Status: ${statusLabel}`);
  lines.push(`Método: ${entry?.method || "-"}`);
  lines.push(`Rota: ${entry?.path || "-"}`);
  lines.push(`Solicitado em: ${entry?.requestedAt || "-"}`);
  lines.push(`Finalizado em: ${entry?.finishedAt || "-"}`);
  lines.push(`Duração (ms): ${entry?.durationMs == null ? "-" : entry.durationMs}`);
  lines.push(`HTTP: ${entry?.statusCode == null ? "-" : entry.statusCode}`);
  lines.push(`Usuário: ${entry?.userEmail || "-"}`);
  if (!entry?.success) {
    lines.push(`Erro código: ${entry?.errorCode || "-"}`);
    lines.push(`Erro mensagem: ${entry?.errorMessage || "-"}`);
  }

  const responseBody = entry?.responseBody;
  if (responseBody && typeof responseBody === "object") {
    const resultRows = Array.isArray(responseBody?.results)
      ? responseBody.results
      : Array.isArray(responseBody?.logs)
        ? responseBody.logs
        : [];
    if (resultRows.length) {
      lines.push("");
      lines.push("Resultados:");
      resultRows.forEach((row, idx) => {
        const label = row?.itemId
          ? `item ${row.itemId}`
          : row?.id
            ? `id ${row.id}`
            : `linha ${idx + 1}`;
        const message = String(row?.message || row?.status || row?.code || "").trim();
        lines.push(`- ${label}${message ? `: ${message}` : ""}`);
      });
    } else {
      lines.push("");
      lines.push("ResponseBody:");
      lines.push(JSON.stringify(responseBody, null, 2));
    }
  }

  return lines.join("\n");
}

router.get(
  "/patch-notes/history",
  async (req, res, next) => {
    try {
      const releaseNotes = await listReleaseNotes(50);

      return res.json({
        releaseNotes: releaseNotes.map(serializeReleaseNote).map((note) => ({
          id: note.id,
          version: note.version,
          title: note.title,
          summary: note.summary,
          subject: note.subject,
          newFeaturesCount: note.newFeaturesCount,
          adjustmentsCount: note.adjustmentsCount,
          recipientCount: note.recipientCount,
          sentCount: note.sentCount,
          skippedCount: note.skippedCount,
          failedCount: note.failedCount,
          createdByName: note.createdByName,
          createdByEmail: note.createdByEmail,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
        })),
      });
    } catch (e) {
      next(e);
    }
  },
);

router.get("/informativos/active", async (req, res, next) => {
  try {
    const notices = await listActiveAdminInformativeNotices();
    return res.json({
      ok: true,
      notices,
      now: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

router.get(
  "/admin-global/informativos",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const includeExpired =
        String(req.query?.includeExpired || "true").trim().toLowerCase() !== "false";
      const notices = await listAdminInformativeNotices({ includeExpired });
      return res.json({
        ok: true,
        notices,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/admin-global/informativos",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const payload = normalizeInformativeNoticePayload(req.body);
      if (!payload.message) {
        return res.status(400).json({
          error: "bad_request",
          message: "Informe o texto do comunicado.",
        });
      }
      if (payload.noticeType === "POPUP" && !payload.imageUrl) {
        return res.status(400).json({
          error: "bad_request",
          message: "Para comunicado POP-UP, envie uma imagem.",
        });
      }
      if (!payload.startsAt || !payload.endsAt) {
        return res.status(400).json({
          error: "bad_request",
          message: "Informe data/hora de início e término.",
        });
      }
      if (Number.isNaN(new Date(payload.startsAt).getTime()) || Number.isNaN(new Date(payload.endsAt).getTime())) {
        return res.status(400).json({
          error: "bad_request",
          message: "Datas inválidas para início/término.",
        });
      }
      if (new Date(payload.endsAt).getTime() <= new Date(payload.startsAt).getTime()) {
        return res.status(400).json({
          error: "bad_request",
          message: "A data de término deve ser maior que a data de início.",
        });
      }

      const notice = await createAdminInformativeNotice({
        ...payload,
        createdBy: req.auth?.email || null,
      });
      return res.json({
        ok: true,
        notice,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.put(
  "/admin-global/informativos/:id",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({
          error: "bad_request",
          message: "ID inválido.",
        });
      }
      const payload = normalizeInformativeNoticePayload(req.body);
      if (!payload.message) {
        return res.status(400).json({
          error: "bad_request",
          message: "Informe o texto do comunicado.",
        });
      }
      if (payload.noticeType === "POPUP" && !payload.imageUrl) {
        return res.status(400).json({
          error: "bad_request",
          message: "Para comunicado POP-UP, envie uma imagem.",
        });
      }
      if (!payload.startsAt || !payload.endsAt) {
        return res.status(400).json({
          error: "bad_request",
          message: "Informe data/hora de início e término.",
        });
      }
      if (Number.isNaN(new Date(payload.startsAt).getTime()) || Number.isNaN(new Date(payload.endsAt).getTime())) {
        return res.status(400).json({
          error: "bad_request",
          message: "Datas inválidas para início/término.",
        });
      }
      if (new Date(payload.endsAt).getTime() <= new Date(payload.startsAt).getTime()) {
        return res.status(400).json({
          error: "bad_request",
          message: "A data de término deve ser maior que a data de início.",
        });
      }

      const notice = await updateAdminInformativeNoticeById(id, {
        ...payload,
        updatedBy: req.auth?.email || null,
      });
      if (!notice) {
        return res.status(404).json({
          error: "not_found",
          message: "Comunicado não encontrado.",
        });
      }
      return res.json({
        ok: true,
        notice,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  "/admin-global/informativos/:id",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({
          error: "bad_request",
          message: "ID inválido.",
        });
      }
      const deleted = await deleteAdminInformativeNoticeById(id);
      if (!deleted) {
        return res.status(404).json({
          error: "not_found",
          message: "Comunicado não encontrado.",
        });
      }
      return res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/patch-notes/history/:id",
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({
          error: "bad_request",
          message: "ID invalido.",
        });
      }

      const releaseNote = await findReleaseNoteById(id);

      if (!releaseNote) {
        return res.status(404).json({
          error: "not_found",
          message: "Atualizacao nao encontrada.",
        });
      }

      return res.json({
        releaseNote: serializeReleaseNote(releaseNote),
      });
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/admin-global/patch-notes/history",
  async (req, res, next) => {
    try {
      const releaseNotes = await listReleaseNotes(50);

      return res.json({
        releaseNotes: releaseNotes.map(serializeReleaseNote).map((note) => ({
          id: note.id,
          version: note.version,
          title: note.title,
          summary: note.summary,
          subject: note.subject,
          newFeaturesCount: note.newFeaturesCount,
          adjustmentsCount: note.adjustmentsCount,
          recipientCount: note.recipientCount,
          sentCount: note.sentCount,
          skippedCount: note.skippedCount,
          failedCount: note.failedCount,
          createdByName: note.createdByName,
          createdByEmail: note.createdByEmail,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
        })),
      });
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/admin-global/patch-notes/history/:id",
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({
          error: "bad_request",
          message: "ID invalido.",
        });
      }

      const releaseNote = await findReleaseNoteById(id);

      if (!releaseNote) {
        return res.status(404).json({
          error: "not_found",
          message: "Atualizacao nao encontrada.",
        });
      }

      return res.json({
        releaseNote: serializeReleaseNote(releaseNote),
      });
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/admin/db/backup",
  requireMasterAdmin,
  AdminDbController.backup,
);

router.post(
  "/admin/db/restore",
  requireMasterAdmin,
  AdminDbController.uploadMiddleware,
  AdminDbController.restore,
);

router.get(
  "/admin/users",
  requireRole("ADMIN", "SUPER_ADMIN"),
  async (req, res, next) => {
    try {
      const users = await listUsersByAccountId(req.auth.accountId);
      res.json({ users });
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/admin/accounts/invite",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const accountName = String(req.body?.accountName || "").trim();
      const ownerName = String(req.body?.ownerName || "").trim();
      const ownerEmail = String(req.body?.ownerEmail || "")
        .trim()
        .toLowerCase();

      if (!accountName || !ownerName || !ownerEmail) {
        return res.status(400).json({
          error: "bad_request",
          message: "Informe nome da conta, nome e email do responsavel.",
        });
      }

      const exists = await findUserByEmail(ownerEmail);
      if (exists) {
        return res.status(409).json({
          error: "email_in_use",
          message: "Ja existe usuario com este email.",
        });
      }

      const activationToken = createActivationToken();
      const activationExpiresAt = activationExpiryDate();
      const passwordHash = await bcrypt.hash(createTemporaryPassword(), 10);

      const created = await createAccountAndOwnerInvite({
        accountName,
        ownerName,
        ownerEmail,
        passwordHash,
        activationTokenHash: hashToken(activationToken),
        activationExpiresAt,
      });

      const activationLink = buildActivationLink(activationToken);
      const emailDelivery = await sendInviteEmailSafe({
        email: ownerEmail,
        name: ownerName,
        link: activationLink,
        expiresAt: activationExpiresAt.toISOString(),
      });
      const hubSync = await syncShopeeUserToHub(created.account.id, created.user, { explicit: true });

      return res.json({
        ok: true,
        account: created.account,
        user: created.user,
        hub_sync: hubSync,
        invite: {
          link: activationLink,
          expiresAt: activationExpiresAt.toISOString(),
        },
        email_delivery: emailDelivery,
      });
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/admin/users",
  requireRole("ADMIN", "SUPER_ADMIN"),
  async (req, res, next) => {
    try {
      const email = String(req.body?.email || "")
        .trim()
        .toLowerCase();
      const role = String(req.body?.role || "VIEWER").toUpperCase();
      const name = String(req.body?.name || "").trim();
      if (!name || !email) {
        return res.status(400).json({
          error: "bad_request",
          message: "Informe nome e email.",
        });
      }

      const allowed = new Set(["ADMIN", "VIEWER"]);
      if (!allowed.has(role)) {
        return res.status(400).json({
          error: "role_invalid",
          message: "Role invalida. Use ADMIN ou VIEWER.",
        });
      }

      const exists = await findUserByEmail(email);
      if (exists) return res.status(409).json({ error: "email_in_use" });

      const activationToken = createActivationToken();
      const activationExpiresAt = activationExpiryDate();
      const passwordHash = await bcrypt.hash(createTemporaryPassword(), 10);

      const user = await createInvitedUser({
        name,
        email,
        passwordHash,
        role,
        accountId: req.auth.accountId,
        activationTokenHash: hashToken(activationToken),
        activationExpiresAt,
      });

      const activationLink = buildActivationLink(activationToken);
      const emailDelivery = await sendInviteEmailSafe({
        email,
        name,
        link: activationLink,
        expiresAt: activationExpiresAt.toISOString(),
      });

      const hubSync = await syncShopeeUserToHub(req.auth.accountId, user, { explicit: true });

      res.json({
        ok: true,
        user,
        hub_sync: hubSync,
        invite: {
          link: activationLink,
          expiresAt: activationExpiresAt.toISOString(),
        },
        email_delivery: emailDelivery,
      });
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/admin/users/:id/invite",
  requireRole("ADMIN", "SUPER_ADMIN"),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res
          .status(400)
          .json({ error: "bad_request", message: "ID invalido." });
      }

      const target = await findUserInAccountById(id, req.auth.accountId);
      if (!target) return res.status(404).json({ error: "not_found" });

      if (String(target.status || "").toUpperCase() === "ACTIVE") {
        return res.status(409).json({
          error: "already_active",
          message: "O usuario ja esta ativo. Nao e necessario gerar convite.",
        });
      }

      const activationToken = createActivationToken();
      const activationExpiresAt = activationExpiryDate();

      const updated = await updateUserInvite(
        id,
        hashToken(activationToken),
        activationExpiresAt,
      );

      const activationLink = buildActivationLink(activationToken);
      const emailDelivery = await sendInviteEmailSafe({
        email: updated.email,
        name: updated.name,
        link: activationLink,
        expiresAt: activationExpiresAt.toISOString(),
      });
      const hubSync = await syncShopeeUserToHub(req.auth.accountId, target, { explicit: true });

      return res.json({
        ok: true,
        user: updated,
        hub_sync: hubSync,
        invite: {
          link: activationLink,
          expiresAt: activationExpiresAt.toISOString(),
        },
        email_delivery: emailDelivery,
      });
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/admin-global/companies",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const accounts = await listAccountsWithUsersAndShops();
      res.json({
        accounts: accounts.map((account) => ({
          ...account,
          shops: account.shops.map(serializeShop),
        })),
      });
    } catch (e) {
      next(e);
    }
  },
);

router.patch(
  "/admin-global/companies/:id",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({
          error: "bad_request",
          message: "ID invalido.",
        });
      }

      const {
        accountName,
        tenantGlobalId,
        documentType,
        documentNumber,
        companyPhotoUrl,
        responsibleName,
        responsibleContact,
        currentMonthGoalCents,
        quarterGoalCents,
        semesterGoalCents,
        annualGoalCents,
      } = normalizeCompanyIdentityPayload(req.body);
      const documentError = validateCompanyDocument(
        documentType,
        documentNumber,
      );

      if (!accountName) {
        return res.status(400).json({
          error: "bad_request",
          message: "Informe o nome da conta.",
        });
      }

      if (documentError) {
        return res.status(400).json({
          error: "bad_request",
          message: documentError,
        });
      }

      const account = await updateAccountIdentityById(id, {
        name: accountName,
        tenantGlobalId,
        documentType,
        documentNumber,
        companyPhotoUrl,
        responsibleName,
        responsibleContact,
        currentMonthGoalCents,
        quarterGoalCents,
        semesterGoalCents,
        annualGoalCents,
      });

      if (!account) {
        return res.status(404).json({
          error: "not_found",
          message: "Conta nao encontrada.",
        });
      }

      return res.json({ ok: true, account });
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/admin-global/account-reports/accounts",
  requireMasterAdmin,
  async (_req, res, next) => {
    try {
      const accounts = await AccountPerformanceReportService.listAccounts();
      return res.json({ ok: true, accounts });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/admin-global/account-reports/history",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const accountId = req.query?.accountId == null ? null : Number(req.query.accountId);
      const reports = await AccountPerformanceReportService.listReports({
        accountId: Number.isFinite(accountId) ? accountId : null,
        limit: 80,
      });
      return res.json({ ok: true, reports });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/admin-global/account-reports/generate",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const accountId = Number(req.body?.accountId);
      if (!Number.isFinite(accountId) || accountId <= 0) {
        return res.status(400).json({
          error: "bad_request",
          message: "Informe uma empresa/conta valida.",
        });
      }

      const report = await AccountPerformanceReportService.createReport({
        accountId,
        userId: req.auth?.userId || null,
        email: req.auth?.email || null,
        periodDays: req.body?.periodDays,
        periodPreset: req.body?.periodPreset,
        periodMonth: req.body?.periodMonth,
      });

      return res.status(202).json({ ok: true, report });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/admin-global/account-reports/:id/status",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const report = await AccountPerformanceReportService.getReportById(
        Number(req.params.id),
      );
      if (!report) {
        return res.status(404).json({
          error: "not_found",
          message: "Relatorio nao encontrado.",
        });
      }
      return res.json({ ok: true, report });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/admin-global/account-reports/:id/download/:format",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const report = await AccountPerformanceReportService.getReportById(
        Number(req.params.id),
      );
      const file = AccountPerformanceReportService.getDownloadInfo(
        report,
        req.params.format,
      );
      if (!file) {
        return res.status(404).json({
          error: "not_found",
          message: "Arquivo do relatorio ainda nao esta disponivel.",
        });
      }
      res.setHeader("Content-Type", file.contentType);
      return res.download(file.path, file.filename);
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/admin-global/patch-notes/recipients",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const accounts = await listPatchNotesRecipientsByAccount();

      const totalRecipients = accounts.reduce(
        (sum, account) => sum + (Array.isArray(account?.users) ? account.users.length : 0),
        0,
      );

      return res.json({ accounts, totalRecipients });
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/admin-global/patch-notes/preview",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const payload = normalizePatchNotesPayload(req.body);

      if (!payload.version) {
        return res.status(400).json({
          error: "bad_request",
          message: "Informe a versao do release notes.",
        });
      }

      if (!payload.summary) {
        return res.status(400).json({
          error: "bad_request",
          message: "Informe o texto principal do release notes.",
        });
      }

      const html = buildPatchNotesHtml({
        nome: req.auth?.name || "time",
        patchNotes: payload,
      });

      return res.json({
        ok: true,
        subject: `Patch Notes DAVANTTI • Versao ${payload.version}`,
        html,
        summary: {
          version: payload.version,
          title: payload.title || `Atualizacao ${payload.version}`,
          newFeaturesCount: payload.newFeatures.length,
          adjustmentsCount: payload.adjustments.length,
        },
      });
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/admin-global/patch-notes/send",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const payload = normalizePatchNotesPayload(req.body);

      if (!payload.version) {
        return res.status(400).json({
          error: "bad_request",
          message: "Informe a versao do release notes.",
        });
      }

      if (!payload.summary) {
        return res.status(400).json({
          error: "bad_request",
          message: "Informe o texto principal do release notes.",
        });
      }

      if (!payload.recipientEmails.length) {
        return res.status(400).json({
          error: "bad_request",
          message: "Selecione pelo menos um destinatario.",
        });
      }

      const recipients = await listUsersByEmailsActive(payload.recipientEmails);

      const foundEmails = new Set(
        recipients.map((recipient) => String(recipient.email || "").toLowerCase()),
      );
      const missingEmails = payload.recipientEmails.filter(
        (email) => !foundEmails.has(email),
      );

      if (missingEmails.length) {
        return res.status(400).json({
          error: "recipients_invalid",
          message: "Alguns destinatarios nao existem ou estao inativos.",
          missingEmails,
        });
      }

      const subject = `Patch Notes DAVANTTI • Versao ${payload.version}`;
      const historyHtml = buildPatchNotesHtml({
        nome: "time",
        patchNotes: payload,
      });
      const deliveries = await Promise.all(
        recipients.map(async (recipient) => {
          try {
            const result = await sendPatchNotesEmail({
              toEmail: recipient.email,
              toName: recipient.name,
              patchNotes: payload,
              subject,
            });

            return {
              email: recipient.email,
              name: recipient.name,
              ...result,
            };
          } catch (err) {
            return {
              email: recipient.email,
              name: recipient.name,
              sent: false,
              skipped: false,
              error: err?.message || "Falha ao enviar release notes.",
            };
          }
        }),
      );

      const sent = deliveries.filter((item) => item.sent).length;
      const skipped = deliveries.filter((item) => item.skipped).length;
      const failed = deliveries.filter((item) => !item.sent && !item.skipped).length;

      const releaseNote = await createReleaseNote({
        version: payload.version,
        title: payload.title || `Atualizacao ${payload.version}`,
        summary: payload.summary,
        subject,
        html: historyHtml,
        newFeatures: payload.newFeatures,
        adjustments: payload.adjustments,
        recipientCount: deliveries.length,
        sentCount: sent,
        skippedCount: skipped,
        failedCount: failed,
        createdByName: req.auth?.name || null,
        createdByEmail: req.auth?.email || null,
      });

      return res.json({
        ok: failed === 0,
        subject,
        releaseNote: {
          id: releaseNote.id,
          version: releaseNote.version,
        },
        totals: {
          recipients: deliveries.length,
          sent,
          skipped,
          failed,
        },
        deliveries,
      });
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/admin-global/shopee/push/app-config",
  requireMasterAdmin,
  async (req, res) => {
    try {
      const [appConfig, partnerConfig] = await Promise.all([
        ShopeePushAdminService.getAppPushConfig(),
        ShopeePushAdminService.getPushConfig().catch(() => null),
      ]);

      return res.json({
        ok: true,
        appConfig,
        partnerConfig,
      });
    } catch (error) {
      return relayShopeePushError(
        error,
        res,
        "Falha ao obter configuracao de push.",
      );
    }
  },
);

router.post(
  "/admin-global/shopee/push/app-config",
  requireMasterAdmin,
  async (req, res) => {
    try {
      const [appResult, partnerResult] = await Promise.all([
        ShopeePushAdminService.setAppPushConfig(req.body || {}),
        ShopeePushAdminService.setPushConfig(req.body || {}).catch(
          () => null,
        ),
      ]);

      return res.json({
        ok: true,
        appResult,
        partnerResult,
      });
    } catch (error) {
      return relayShopeePushError(
        error,
        res,
        "Falha ao atualizar configuracao de push.",
      );
    }
  },
);

router.get(
  "/admin-global/shopee/push/lost-messages",
  requireMasterAdmin,
  async (req, res) => {
    try {
      const result = await ShopeePushAdminService.getLostPushMessage();
      return res.json({
        ok: true,
        ...result,
      });
    } catch (error) {
      return relayShopeePushError(
        error,
        res,
        "Falha ao buscar lost push messages.",
      );
    }
  },
);

router.post(
  "/admin-global/shopee/push/lost-messages/confirm",
  requireMasterAdmin,
  async (req, res) => {
    try {
      const result = await ShopeePushAdminService.confirmConsumedLostPushMessage(
        req.body?.last_message_id,
      );
      return res.json({
        ok: true,
        ...result,
      });
    } catch (error) {
      return relayShopeePushError(
        error,
        res,
        "Falha ao confirmar lost push messages consumidas.",
      );
    }
  },
);

router.get(
  "/admin-global/shopee/push/queues/status",
  requireMasterAdmin,
  async (req, res) => {
    try {
      const categories = await getShopeeWebhookQueuesStatus();
      return res.json({
        ok: true,
        categories,
      });
    } catch (error) {
      return relayShopeePushError(
        error,
        res,
        "Falha ao obter status das filas de webhook.",
      );
    }
  },
);

router.post(
  "/admin-global/shopee/push/queues/:category/control",
  requireMasterAdmin,
  async (req, res) => {
    try {
      const result = await controlShopeeWebhookQueue(req.params.category, {
        action: req.body?.action,
        limit: req.body?.limit,
      });
      return res.json({
        ok: true,
        ...result,
      });
    } catch (error) {
      return relayShopeePushError(
        error,
        res,
        "Falha ao controlar fila de webhook.",
      );
    }
  },
);

router.patch(
  "/admin/users/:id/role",
  requireRole("ADMIN", "SUPER_ADMIN"),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const role = String(req.body?.role || "").toUpperCase();
      if (!Number.isFinite(id))
        return res
          .status(400)
          .json({ error: "bad_request", message: "ID invalido." });
      if (role !== "ADMIN" && role !== "VIEWER")
        return res.status(400).json({
          error: "role_invalid",
          message: "Role invalida. Use ADMIN ou VIEWER.",
        });

      const target = await findUserInAccountById(id, req.auth.accountId);
      if (!target) return res.status(404).json({ error: "not_found" });

      if (String(target.role) === "ADMIN" && role === "VIEWER") {
        const adminsCount = await countAdminsByAccountId(req.auth.accountId);
        if (adminsCount <= 1)
          return res.status(400).json({
            error: "last_admin",
            message: "Nao e possivel remover o ultimo ADMIN da conta.",
          });
      }

      const updated = await updateUserRole(id, role);
      const hubSync = await syncShopeeUserToHub(req.auth.accountId, updated);
      return res.json({ ok: true, user: updated, hub_sync: hubSync });
    } catch (e) {
      next(e);
    }
  },
);

router.patch(
  "/admin/users/:id",
  requireRole("ADMIN", "SUPER_ADMIN"),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id))
        return res
          .status(400)
          .json({ error: "bad_request", message: "ID invalido." });

      const nameRaw = req.body?.name;
      const emailRaw = req.body?.email;
      const passwordRaw = req.body?.password;

      const target = await findUserInAccountById(id, req.auth.accountId);
      if (!target) return res.status(404).json({ error: "not_found" });

      const data = {};

      if (nameRaw != null) {
        const name = String(nameRaw).trim();
        if (!name)
          return res
            .status(400)
            .json({ error: "bad_request", message: "Nome invalido." });
        data.name = name;
      }

      if (emailRaw != null) {
        const email = String(emailRaw).trim().toLowerCase();
        if (!email || !email.includes("@")) {
          return res
            .status(400)
            .json({ error: "bad_request", message: "E-mail invalido." });
        }

        const exists = await findUserByEmail(email);
        if (exists && exists.id !== id) {
          return res
            .status(409)
            .json({ error: "email_in_use", message: "E-mail ja esta em uso." });
        }

        data.email = email;
      }

      if (passwordRaw != null) {
        const password = String(passwordRaw);
        if (password.length < 6)
          return res.status(400).json({
            error: "bad_request",
            message: "Senha deve ter pelo menos 6 caracteres.",
          });
        data.passwordHash = await bcrypt.hash(password, 10);
      }

      if (Object.keys(data).length === 0) {
        return res
          .status(400)
          .json({ error: "bad_request", message: "Nada para atualizar." });
      }

      const updated = await updateUserProfile(id, data);

      const hubSync = await syncShopeeUserToHub(req.auth.accountId, updated);

      return res.json({ ok: true, user: updated, hub_sync: hubSync });
    } catch (e) {
      next(e);
    }
  },
);

router.delete(
  "/admin/users/:id",
  requireRole("ADMIN", "SUPER_ADMIN"),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id))
        return res
          .status(400)
          .json({ error: "bad_request", message: "ID invalido." });

      const target = await findUserInAccountById(id, req.auth.accountId);
      if (!target) return res.status(404).json({ error: "not_found" });

      if (String(target.role) === "ADMIN") {
        const adminsCount = await countAdminsByAccountId(req.auth.accountId);
        if (adminsCount <= 1)
          return res.status(400).json({
            error: "last_admin",
            message: "Nao e possivel excluir o ultimo ADMIN da conta.",
          });
      }

      const hubSync = await revokeShopeeUserFromHub(req.auth.accountId, target);
      await deleteSessionsByUserId(id);
      await deleteUserById(id);
      return res.json({ ok: true, hub_sync: hubSync });
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/processes/notifications",
  async (req, res, next) => {
    try {
      const lookbackHours = Math.max(
        1,
        Math.min(24 * 30, Number(req.query?.lookbackHours || 72)),
      );
      const limit = Math.max(1, Math.min(300, Number(req.query?.limit || 80)));
      const rows = await listRecentCompletedProcessLogsForUser({
        userId: req.auth?.userId == null ? null : Number(req.auth.userId),
        userEmail: req.auth?.email || "",
        lookbackHours,
        limit,
      });

      const items = rows.map((row) => ({
        id: row.id,
        requestedAt: row.requestedAt,
        finishedAt: row.finishedAt,
        durationMs: row.durationMs,
        method: row.method,
        path: row.path,
        displayName: row.displayName || null,
        statusCode: row.statusCode,
        success: Boolean(row.success),
        errorCode: row.errorCode || null,
        errorMessage: row.errorMessage || null,
        hasDownload: true,
      }));

      return res.json({
        ok: true,
        items,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/processes/:id/logs.txt",
  async (req, res, next) => {
    try {
      const processId = Number(req.params.id);
      if (!Number.isFinite(processId) || processId <= 0) {
        return res.status(400).json({
          error: "bad_request",
          message: "ID do processo inválido.",
        });
      }

      const entry = await getProcessExecutionLogById(processId);
      if (!entry) {
        return res.status(404).json({
          error: "not_found",
          message: "Processo não encontrado.",
        });
      }

      const userId = req.auth?.userId == null ? null : Number(req.auth.userId);
      const userEmail = String(req.auth?.email || "")
        .trim()
        .toLowerCase();
      const ownerByUserId =
        userId != null &&
        entry.userId != null &&
        Number(entry.userId) === Number(userId);
      const ownerByEmail =
        userEmail &&
        String(entry.userEmail || "")
          .trim()
          .toLowerCase() === userEmail;

      if (!ownerByUserId && !ownerByEmail && !isMasterAdmin(req.auth)) {
        return res.status(403).json({
          error: "forbidden",
          message: "Sem permissão para acessar este log.",
        });
      }

      const txt = buildSingleProcessLogText(entry);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="processo_${processId}_${timestamp}.txt"`,
      );
      return res.status(200).send(txt);
    } catch (error) {
      next(error);
    }
  },
);

module.exports = router;


