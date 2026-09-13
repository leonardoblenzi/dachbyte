const ValidarDimensoesService = require("../services/validarDimensoesService");
const ValidarDimensoesJobService = require("../services/validarDimensoesJobService");
const { attachJobReview } = require("../services/jobReviewHelper");
const { attachJobContract } = require("../services/jobContract");
const {
  getRequestIp,
  getRequestUserAgent,
  recordAuthEvent,
} = require("../services/authAuditService");

const ENABLE_INLINE_VALIDAR_DIMENSOES_WORKER =
  String(process.env.VALIDAR_DIMENSOES_INLINE_WORKER || "").trim() === "1";

if (ENABLE_INLINE_VALIDAR_DIMENSOES_WORKER) {
  ValidarDimensoesJobService.iniciarWorker();
}

function getAccountMeta(res) {
  return {
    key: res?.locals?.accountKey || null,
    label: res?.locals?.accountLabel || null,
  };
}

function getCreds(res) {
  return res?.locals?.mlCreds || {};
}

function buildAuditContext(req, res) {
  return {
    userId: Number(req.user?.uid || res.locals?.user?.uid || res.locals?.user?.id) || null,
    email: req.user?.email || res.locals?.user?.email || null,
    ip: getRequestIp(req),
    userAgent: getRequestUserAgent(req),
    accountKey: res.locals?.accountKey || null,
    accountLabel: res.locals?.accountLabel || res.locals?.accountKey || null,
    meli_conta_id: res.locals?.mlCreds?.meli_conta_id || null,
    route: req.originalUrl || req.path || null,
    method: req.method || null,
  };
}

function auditDimensoes(req, res, evento, status, metadata = {}) {
  const context = buildAuditContext(req, res);
  return recordAuthEvent({
    userId: context.userId,
    email: context.email,
    evento,
    status,
    ip: context.ip,
    userAgent: context.userAgent,
    metadata: {
      accountKey: context.accountKey,
      accountLabel: context.accountLabel,
      meli_conta_id: context.meli_conta_id,
      route: context.route,
      method: context.method,
      action: "validate_or_update_dimensions",
      ...metadata,
    },
  }).catch((err) => {
    console.error("audit validar dimensoes erro:", err?.message || err);
  });
}

class ValidarDimensoesController {
  static async analisarItem(req, res) {
    try {
      const {
        mlb,
        fill_dimensions: fillDimensions,
        autofill_from_item: autoFillFromItem,
        force_overwrite: forceOverwrite,
      } = req.body || {};
      if (!mlb) {
        return res
          .status(400)
          .json({ success: false, error: "Informe o MLB.", account: getAccountMeta(res) });
      }

      const result = await ValidarDimensoesService.analisarUm(String(mlb).trim(), {
        mlCreds: getCreds(res),
        accountKey: res?.locals?.accountKey || "conta",
        ...(fillDimensions ? { fillDimensions } : {}),
        ...(autoFillFromItem ? { autoFillFromItem: true } : {}),
        ...(forceOverwrite ? { forceOverwrite: true } : {}),
      });

      await auditDimensoes(
        req,
        res,
        "dimensions_validation_item_processed",
        result?.success ? (result?.updated ? "success" : "warn") : "error",
        {
          mlb_id: result?.mlb || String(mlb).trim().toUpperCase(),
          item_id: result?.mlb || String(mlb).trim().toUpperCase(),
          sku: result?.sku || "",
          mode: fillDimensions ? "manual" : autoFillFromItem ? "auto" : "analyze",
          source: "single",
          updated: result?.updated === true,
          updated_target: result?.updated_target || null,
          previous_value: result?.debug_update?.before_update || null,
          requested_value: result?.debug_update?.requested_fill || fillDimensions || null,
          applied_value: result?.debug_update?.immediate_read || null,
          update_payload: result?.debug_update?.update_payload || null,
          ml_body: result?.debug_update?.update_response || null,
          message: result?.updated_message || result?.message || "",
        },
      );

      return res.json({
        success: true,
        data: result,
        account: getAccountMeta(res),
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error?.message || "Erro ao validar dimensoes",
        account: getAccountMeta(res),
      });
    }
  }

  static async analisarLote(req, res) {
    try {
      const {
        mlbs = [],
        mode = "analyze",
        fill_dimensions: fillDimensions,
        force_overwrite: forceOverwrite,
        delay_ms: delayMs,
        source = "manual_list",
      } = req.body || {};
      const normalizedSource =
        String(source || "").trim().toLowerCase() === "active_items"
          ? "active_items"
          : "manual_list";
      if (normalizedSource !== "active_items" && (!Array.isArray(mlbs) || !mlbs.length)) {
        return res
          .status(400)
          .json({ success: false, error: "Informe pelo menos um MLB.", account: getAccountMeta(res) });
      }

      const normalizedMode = ["analyze", "auto", "manual"].includes(String(mode || "").toLowerCase())
        ? String(mode || "").toLowerCase()
        : "analyze";

      if (normalizedMode === "manual" && !fillDimensions) {
        return res.status(400).json({
          success: false,
          error: "Preencha as dimensoes para o modo manual.",
          account: getAccountMeta(res),
        });
      }

      ValidarDimensoesJobService.iniciarWorker?.();

      const created = await ValidarDimensoesJobService.criarJob(mlbs, {
        accountKey: res?.locals?.accountKey || "conta",
        mlCreds: getCreds(res),
        mode: normalizedMode,
        fillDimensions: fillDimensions || null,
        forceOverwrite: forceOverwrite === true,
        delayMs: Math.max(0, Number(delayMs || 0) || 0),
        source: normalizedSource,
        auditContext: buildAuditContext(req, res),
      });
      const contracted = attachJobContract({
        id: created.jobId,
        status: "aguardando",
        completed: false,
        progress: 0,
      }, { module: "validar-dimensoes", kind: normalizedSource });

      return res.json({
        success: true,
        job_id: created.jobId,
        job_uid: contracted.job_uid,
        backend_job_id: contracted.backend_job_id,
        lifecycle_status: contracted.lifecycle_status,
        job_contract: contracted.job_contract,
        account: getAccountMeta(res),
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error?.message || "Erro ao iniciar o job de validar dimensoes",
        account: getAccountMeta(res),
      });
    }
  }

  static async listarJobs(req, res) {
    try {
      const jobs = await ValidarDimensoesJobService.listarJobs(25, {
        accountKey: res?.locals?.accountKey || null,
      });
      const normalizedJobs = jobs.map((job) =>
        attachJobReview(job, {
          basePath: "/api/validar-dimensoes/jobs",
          hasCsv: true,
        }),
      );
      return res.json({ success: true, jobs: normalizedJobs, account: getAccountMeta(res) });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error?.message || "Erro ao listar jobs",
        account: getAccountMeta(res),
      });
    }
  }

  static async obterJob(req, res) {
    try {
      const job = await ValidarDimensoesJobService.obterStatus(req.params.job_id, {
        accountKey: res?.locals?.accountKey || null,
      });
      if (!job) {
        return res.status(404).json({ success: false, error: "Job nao encontrado" });
      }
      return res.json({
        success: true,
        job: attachJobReview(job, {
          basePath: "/api/validar-dimensoes/jobs",
          hasCsv: true,
        }),
        account: getAccountMeta(res),
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error?.message || "Erro ao obter job",
        account: getAccountMeta(res),
      });
    }
  }

  static async obterResultados(req, res) {
    try {
      const results = await ValidarDimensoesJobService.obterResultados(req.params.job_id, {
        accountKey: res?.locals?.accountKey || null,
      });
      if (results == null) {
        return res.status(404).json({ success: false, error: "Resultados nao encontrados" });
      }
      return res.json({ success: true, results, account: getAccountMeta(res) });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error?.message || "Erro ao obter resultados do job",
        account: getAccountMeta(res),
      });
    }
  }

  static async obterPaginaResultados(req, res) {
    try {
      const page = Math.max(1, Number(req.query?.page || 1) || 1);
      const limit = Math.max(10, Math.min(200, Number(req.query?.limit || 50) || 50));
      const offset = (page - 1) * limit;
      const payload = await ValidarDimensoesJobService.obterPaginaResultados(req.params.job_id, {
        accountKey: res?.locals?.accountKey || null,
        offset,
        limit,
      });
      if (payload == null) {
        return res.status(404).json({ success: false, error: "Resultados nao encontrados" });
      }
      return res.json({
        success: true,
        job_id: String(req.params.job_id || ""),
        page,
        limit,
        total: Number(payload.total || 0),
        data: Array.isArray(payload.rows) ? payload.rows : [],
        account: getAccountMeta(res),
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error?.message || "Erro ao obter pagina de resultados do job",
        account: getAccountMeta(res),
      });
    }
  }

  static async baixarCsv(req, res) {
    try {
      const file = await ValidarDimensoesJobService.obterCsv(req.params.job_id, {
        accountKey: res?.locals?.accountKey || null,
      });
      if (!file?.csv) {
        return res.status(404).json({ success: false, error: "CSV nao encontrado" });
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
      return res.send(file.csv);
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error?.message || "Erro ao baixar CSV do job",
        account: getAccountMeta(res),
      });
    }
  }

  static async cancelarJob(req, res) {
    try {
      const result = await ValidarDimensoesJobService.cancelarJob(req.params.job_id, {
        accountKey: res?.locals?.accountKey || null,
      });
      if (!result) {
        return res.status(404).json({ success: false, error: "Job nao encontrado" });
      }
      if (!result.ok) {
        return res.status(409).json({ success: false, error: result.error, status: result.status });
      }
      const contracted = attachJobContract({
        id: req.params.job_id,
        status: result.status,
        completed: result.status === "cancelado",
      }, { module: "validar-dimensoes" });
      return res.json({ success: true, status: result.status, id: req.params.job_id, ...contracted });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error?.message || "Erro ao cancelar job",
        account: getAccountMeta(res),
      });
    }
  }
}

module.exports = ValidarDimensoesController;
