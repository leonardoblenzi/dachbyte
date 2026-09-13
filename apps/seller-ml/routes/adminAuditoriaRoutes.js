"use strict";

const express = require("express");
const {
  cleanupAuthAudit,
  ensureDefaultRetentionRules,
  exportAuthEventsCsv,
  exportAuthEventsXlsx,
  getRequestIp,
  getRequestUserAgent,
  listAuthEvents,
  listRetentionRules,
  recordAuthEvent,
  updateRetentionRules,
} = require("../services/authAuditService");

const router = express.Router();
const AUDIT_EXPORT_TZ = "America/Sao_Paulo";

function auditExportDateStamp() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: AUDIT_EXPORT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(new Date())
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function ensureMasterOnly(req, res, next) {
  const u = req.user || res.locals.user;
  const nivel = String(u?.nivel || "")
    .trim()
    .toLowerCase();
  const isMaster = nivel === "admin_master" || u?.is_master === true;

  if (isMaster) return next();
  return res.status(403).json({ ok: false, error: "Acesso nao autorizado." });
}

router.use(ensureMasterOnly);

function auditAdminAction(req, payload) {
  return recordAuthEvent({
    userId: Number(req.user?.uid) || null,
    email: req.user?.email || null,
    ip: getRequestIp(req),
    userAgent: getRequestUserAgent(req),
    ...payload,
  }).catch((err) => {
    console.error("admin audit log erro:", err?.message || err);
  });
}

router.get("/auditoria/eventos", async (req, res) => {
  try {
    const data = await listAuthEvents({
      search: req.query?.search,
      mlb_ids: req.query?.mlb_ids,
      promotion_ids: req.query?.promotion_ids,
      evento: req.query?.evento,
      status: req.query?.status,
      date_from: req.query?.date_from,
      date_to: req.query?.date_to,
      page: req.query?.page,
      limit: req.query?.limit,
    });

    return res.json({ ok: true, ...data });
  } catch (err) {
    console.error("GET /api/admin/auditoria/eventos erro:", err);
    return res
      .status(Number(err?.statusCode) || 500)
      .json({
        ok: false,
        error:
          Number(err?.statusCode) === 400
            ? err.message
            : "Erro ao listar eventos de auditoria.",
      });
  }
});

router.get("/auditoria/eventos/export.csv", async (req, res) => {
  try {
    const result = await exportAuthEventsCsv({
      search: req.query?.search,
      mlb_ids: req.query?.mlb_ids,
      promotion_ids: req.query?.promotion_ids,
      evento: req.query?.evento,
      status: req.query?.status,
      date_from: req.query?.date_from,
      date_to: req.query?.date_to,
      export_limit: req.query?.limit,
    });

    const stamp = auditExportDateStamp();
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="auditoria_${stamp}_${result.exported || 0}.csv"`,
    );
    return res.status(200).send(`\ufeff${result.csv}`);
  } catch (err) {
    console.error("GET /api/admin/auditoria/eventos/export.csv erro:", err);
    return res
      .status(Number(err?.statusCode) || 500)
      .json({
        ok: false,
        error:
          Number(err?.statusCode) === 400
            ? err.message
            : "Erro ao exportar eventos de auditoria.",
      });
  }
});

router.get("/auditoria/eventos/export.xlsx", async (req, res) => {
  try {
    const result = await exportAuthEventsXlsx({
      search: req.query?.search,
      mlb_ids: req.query?.mlb_ids,
      promotion_ids: req.query?.promotion_ids,
      evento: req.query?.evento,
      status: req.query?.status,
      date_from: req.query?.date_from,
      date_to: req.query?.date_to,
      export_limit: req.query?.limit,
    });

    const stamp = auditExportDateStamp();
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="auditoria_${stamp}_${result.exported || 0}.xlsx"`,
    );
    return res.status(200).send(result.buffer);
  } catch (err) {
    console.error("GET /api/admin/auditoria/eventos/export.xlsx erro:", err);
    return res
      .status(Number(err?.statusCode) || 500)
      .json({
        ok: false,
        error:
          Number(err?.statusCode) === 400
            ? err.message
            : "Erro ao exportar eventos de auditoria.",
      });
  }
});

router.get("/auditoria/retencao", async (_req, res) => {
  try {
    await ensureDefaultRetentionRules();
    const rules = await listRetentionRules();
    return res.json({ ok: true, rules });
  } catch (err) {
    console.error("GET /api/admin/auditoria/retencao erro:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Erro ao carregar regras de retencao." });
  }
});

router.put(
  "/auditoria/retencao",
  express.json({ limit: "1mb" }),
  async (req, res) => {
    try {
      const rules = Array.isArray(req.body?.rules) ? req.body.rules : [];
      const saved = await updateRetentionRules(rules);

      await auditAdminAction(req, {
        evento: "admin_audit_retention_updated",
        status: "success",
        metadata: {
          rules: saved.map((rule) => ({
            evento: rule.evento,
            retention_days: Number(rule.retention_days),
          })),
        },
      });

      return res.json({ ok: true, rules: saved });
    } catch (err) {
      const message = err?.message || "Erro ao salvar regras de retencao.";
      const status = /regra|retencao|evento/i.test(message) ? 400 : 500;

      if (status === 500) {
        console.error("PUT /api/admin/auditoria/retencao erro:", err);
      }

      return res.status(status).json({ ok: false, error: message });
    }
  },
);

router.post("/auditoria/cleanup", async (req, res) => {
  try {
    const result = await cleanupAuthAudit({ force: true });

    await auditAdminAction(req, {
      evento: "admin_audit_cleanup",
      status: "success",
      metadata: result,
    });

    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("POST /api/admin/auditoria/cleanup erro:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Erro ao executar a limpeza da auditoria." });
  }
});

module.exports = router;
