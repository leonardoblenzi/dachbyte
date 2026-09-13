"use strict";

const express = require("express");
const db = require("../db/db");
const companyAccess = require("../services/companyAccessService");
const AutomationReportService = require("../services/automationReportService");
const AutomationReportRunner = require("../services/automationReportRunnerService");
const { createAuditAction } = require("../middleware/auditAction");

const router = express.Router();

function parsePositiveInt(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.trunc(num) : null;
}

async function resolveContext(req, res) {
  const userId = companyAccess.getUserId(req) || parsePositiveInt(req.user?.uid);
  const meliContaId =
    parsePositiveInt(res.locals?.mlCreds?.meli_conta_id) ||
    parsePositiveInt(req.cookies?.meli_conta_id);

  if (!userId) {
    const error = new Error("Usuario nao autenticado.");
    error.status = 401;
    throw error;
  }

  if (!meliContaId) {
    const error = new Error("Selecione uma conta Mercado Livre.");
    error.status = 400;
    throw error;
  }

  const localEmpresaId = parsePositiveInt(res.locals?.empresaId);
  if (localEmpresaId) {
    return { userId, empresaId: localEmpresaId, meliContaId };
  }

  const { rows } = await db.query(
    `select mc.empresa_id
       from meli_contas mc
       join empresa_usuarios eu
         on eu.empresa_id = mc.empresa_id
        and eu.usuario_id = $2
      where mc.id = $1
      limit 1`,
    [meliContaId, userId],
  );

  const empresaId = parsePositiveInt(rows[0]?.empresa_id);
  if (!empresaId) {
    const error = new Error("Conta Mercado Livre nao permitida para este usuario.");
    error.status = 403;
    throw error;
  }

  return { userId, empresaId, meliContaId };
}

function userSnapshot(req) {
  return {
    id: parsePositiveInt(req.user?.uid || req.user?.id),
    name: req.user?.nome || req.user?.name || req.user?.email || "",
    email: req.user?.email || "",
  };
}

function sendError(res, error, fallback = "Falha ao processar automacao.") {
  const status = Number(error?.status || error?.statusCode || 500);
  return res.status(status).json({
    ok: false,
    error: error?.message || fallback,
  });
}

router.use(express.json({ limit: "1mb" }));
router.use(companyAccess.requireNivelAdmin());

router.get("/", async (req, res) => {
  try {
    const ctx = await resolveContext(req, res);
    const automations = await AutomationReportService.listAutomations(ctx);
    return res.json({
      ok: true,
      automations,
      limits: {
        max_daily_reports: AutomationReportService.MAX_DAILY_REPORTS,
        max_enrichments_per_report: 1,
      },
    });
  } catch (error) {
    return sendError(res, error, "Falha ao listar automacoes.");
  }
});

router.post(
  "/",
  createAuditAction({
    evento: "report_automation_created",
    metadata: (req) => ({ name: req.body?.name || null }),
  }),
  async (req, res) => {
    try {
      const ctx = await resolveContext(req, res);
      const automation = await AutomationReportService.createAutomation({
        empresaId: ctx.empresaId,
        meliContaId: ctx.meliContaId,
        userId: ctx.userId,
        user: userSnapshot(req),
        payload: req.body || {},
      });
      return res.status(201).json({ ok: true, automation });
    } catch (error) {
      return sendError(res, error, "Falha ao criar automacao.");
    }
  },
);

router.get("/:id", async (req, res) => {
  try {
    const ctx = await resolveContext(req, res);
    const automation = await AutomationReportService.getAutomation({
      id: parsePositiveInt(req.params.id),
      empresaId: ctx.empresaId,
      meliContaId: ctx.meliContaId,
    });
    if (!automation) return res.status(404).json({ ok: false, error: "Automacao nao encontrada." });
    return res.json({ ok: true, automation });
  } catch (error) {
    return sendError(res, error, "Falha ao carregar automacao.");
  }
});

router.put(
  "/:id",
  createAuditAction({
    evento: "report_automation_updated",
    metadata: (req) => ({ id: Number(req.params?.id) || null, name: req.body?.name || null }),
  }),
  async (req, res) => {
    try {
      const ctx = await resolveContext(req, res);
      const automation = await AutomationReportService.updateAutomation({
        id: parsePositiveInt(req.params.id),
        empresaId: ctx.empresaId,
        meliContaId: ctx.meliContaId,
        user: userSnapshot(req),
        payload: req.body || {},
      });
      if (!automation) return res.status(404).json({ ok: false, error: "Automacao nao encontrada." });
      return res.json({ ok: true, automation });
    } catch (error) {
      return sendError(res, error, "Falha ao atualizar automacao.");
    }
  },
);

router.post("/:id/pause", async (req, res) => {
  try {
    const ctx = await resolveContext(req, res);
    const automation = await AutomationReportService.setAutomationActive({
      id: parsePositiveInt(req.params.id),
      empresaId: ctx.empresaId,
      meliContaId: ctx.meliContaId,
      active: false,
    });
    if (!automation) return res.status(404).json({ ok: false, error: "Automacao nao encontrada." });
    return res.json({ ok: true, automation });
  } catch (error) {
    return sendError(res, error, "Falha ao pausar automacao.");
  }
});

router.post("/:id/resume", async (req, res) => {
  try {
    const ctx = await resolveContext(req, res);
    const automation = await AutomationReportService.setAutomationActive({
      id: parsePositiveInt(req.params.id),
      empresaId: ctx.empresaId,
      meliContaId: ctx.meliContaId,
      active: true,
    });
    if (!automation) return res.status(404).json({ ok: false, error: "Automacao nao encontrada." });
    return res.json({ ok: true, automation });
  } catch (error) {
    return sendError(res, error, "Falha ao reativar automacao.");
  }
});

router.post("/:id/run-now", async (req, res) => {
  try {
    const ctx = await resolveContext(req, res);
    const automation = await AutomationReportService.getAutomation({
      id: parsePositiveInt(req.params.id),
      empresaId: ctx.empresaId,
      meliContaId: ctx.meliContaId,
    });
    if (!automation) return res.status(404).json({ ok: false, error: "Automacao nao encontrada." });

    const run = await AutomationReportService.createRunForAutomation({
      automation,
      scheduledFor: new Date(),
    });
    AutomationReportRunner.initWorker();
    const runner_job_id = await AutomationReportRunner.enqueueRun(run.id);
    return res.status(202).json({ ok: true, run, runner_job_id });
  } catch (error) {
    return sendError(res, error, "Falha ao iniciar envio manual.");
  }
});

router.get("/:id/runs", async (req, res) => {
  try {
    const ctx = await resolveContext(req, res);
    const automationId = parsePositiveInt(req.params.id);
    const automation = await AutomationReportService.getAutomation({
      id: automationId,
      empresaId: ctx.empresaId,
      meliContaId: ctx.meliContaId,
    });
    if (!automation) return res.status(404).json({ ok: false, error: "Automacao nao encontrada." });
    const runs = await AutomationReportService.listRuns({
      automationId,
      empresaId: ctx.empresaId,
      meliContaId: ctx.meliContaId,
      limit: req.query.limit,
    });
    return res.json({ ok: true, runs });
  } catch (error) {
    return sendError(res, error, "Falha ao listar execucoes.");
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const ctx = await resolveContext(req, res);
    const deleted = await AutomationReportService.deleteAutomation({
      id: parsePositiveInt(req.params.id),
      empresaId: ctx.empresaId,
      meliContaId: ctx.meliContaId,
    });
    if (!deleted) return res.status(404).json({ ok: false, error: "Automacao nao encontrada." });
    return res.json({ ok: true, deleted: true });
  } catch (error) {
    return sendError(res, error, "Falha ao excluir automacao.");
  }
});

module.exports = router;
