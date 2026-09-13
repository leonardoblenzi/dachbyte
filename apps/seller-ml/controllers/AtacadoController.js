"use strict";

const AtacadoService = require("../services/atacadoService");
const AtacadoJobsService = require("../services/atacadoJobsService");
const { attachJobContract } = require("../services/jobContract");
const {
  getRequestIp,
  getRequestUserAgent,
} = require("../services/authAuditService");

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

class AtacadoController {
  static async listActive(req, res) {
    try {
      const data = await AtacadoService.listActiveItems(res.locals?.mlCreds || {}, {
        cursor: req.query.cursor,
        limit: req.query.limit,
        extra_discount_percent: req.query.extra_discount_percent,
      });

      return res.json({ success: true, ...data });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error?.message || "Erro ao listar anúncios ativos.",
      });
    }
  }

  static async listSpecific(req, res) {
    try {
      const data = await AtacadoService.listSpecificItems(
        res.locals?.mlCreds || {},
        {
          item_ids: req.body?.item_ids,
          extra_discount_percent: req.body?.extra_discount_percent,
        },
      );

      return res.json({ success: true, ...data });
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error?.message || "Erro ao listar MLBs especificos.",
      });
    }
  }

  static async apply(req, res) {
    try {
      const job = await AtacadoJobsService.enqueue({
        itemIds: req.body?.item_ids,
        extraDiscountPercent: req.body?.extra_discount_percent,
        minPurchaseUnit: req.body?.min_purchase_unit,
        tierConfigs: req.body?.tier_configs,
        promoOnly: req.body?.promo_only,
        dryRun: req.body?.dry_run,
        mlCreds: res.locals?.mlCreds || {},
        accountKey: res.locals?.accountKey || null,
        accountLabel: res.locals?.accountLabel || null,
        auditContext: buildAuditContext(req, res),
      });

      return res.json({
        success: true,
        job_id: job.id,
        job_uid: job.job_uid,
        backend_job_id: job.backend_job_id,
        lifecycle_status: job.lifecycle_status,
        job_contract: job.job_contract,
        job,
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error?.message || "Erro ao aplicar preço de atacado.",
      });
    }
  }

  static async listJobs(_req, res) {
    try {
      return res.json({
        success: true,
        jobs: AtacadoJobsService.listRecent(25, {
          accountKey: res.locals?.accountKey || null,
        }),
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error?.message || "Erro ao listar jobs de atacado.",
      });
    }
  }

  static async jobDetail(req, res) {
    try {
      const job = AtacadoJobsService.jobDetail(req.params?.job_id, {
        accountKey: res.locals?.accountKey || null,
      });
      if (!job) {
        return res.status(404).json({
          success: false,
          error: "Job de atacado não encontrado.",
        });
      }
      return res.json({ success: true, job });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error?.message || "Erro ao obter detalhes do job.",
      });
    }
  }

  static async cancelJob(req, res) {
    try {
      const job = AtacadoJobsService.cancelJob(req.params?.job_id, {
        accountKey: res.locals?.accountKey || null,
      });
      if (!job) {
        return res.status(404).json({
          success: false,
          error: "Job de atacado nao encontrado.",
        });
      }
      if (!job.ok) {
        return res.status(409).json({
          success: false,
          error: job.error || "Nao foi possivel cancelar o job.",
          status: job.status || null,
        });
      }
      const contracted = attachJobContract({
        id: req.params?.job_id,
        status: job.status,
        completed: job.status === "cancelado",
      }, { module: "atacado" });
      return res.json({ success: true, status: job.status, id: req.params?.job_id, ...contracted });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error?.message || "Erro ao cancelar job de atacado.",
      });
    }
  }

  static async downloadCsv(req, res) {
    try {
      const file = AtacadoJobsService.getJobCsv(req.params?.job_id, {
        accountKey: res.locals?.accountKey || null,
      });
      if (!file?.csv) {
        return res.status(404).json({
          success: false,
          error: "CSV do job de atacado nao encontrado.",
        });
      }

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
      return res.send(file.csv);
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error?.message || "Erro ao baixar CSV do job.",
      });
    }
  }
}

module.exports = AtacadoController;
