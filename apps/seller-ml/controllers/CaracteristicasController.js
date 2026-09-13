"use strict";

const CaracteristicasService = require("../services/caracteristicasService");
const CaracteristicasJobsService = require("../services/caracteristicasJobsService");
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

class CaracteristicasController {
  static async searchCategories(req, res) {
    try {
      const items = await CaracteristicasService.searchCategories(
        res.locals?.mlCreds || {},
        req.query?.q,
      );
      return res.json({ success: true, items });
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error?.message || "Erro ao buscar categorias.",
      });
    }
  }

  static async preview(req, res) {
    try {
      const payload = await CaracteristicasService.preview(
        res.locals?.mlCreds || {},
        {
          item_ids: req.body?.item_ids,
          category_id: req.body?.category_id,
        },
      );
      return res.json(payload);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error?.message || "Erro ao carregar caracteristicas da categoria.",
      });
    }
  }

  static async listAccountCategories(req, res) {
    try {
      const payload = await CaracteristicasService.listAccountCategories(
        res.locals?.mlCreds || {},
        {
          limit: req.query?.limit,
        },
      );
      return res.json({ success: true, ...payload });
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error?.message || "Erro ao carregar categorias da conta.",
      });
    }
  }

  static async exportCategoryWorkbook(req, res) {
    try {
      const job = await CaracteristicasJobsService.enqueueWorkbookExport({
        categoryId: req.query?.category_id,
        mode: req.query?.mode,
        mlCreds: res.locals?.mlCreds || {},
        accountKey: res.locals?.accountKey || null,
        accountLabel: res.locals?.accountLabel || null,
        auditContext: buildAuditContext(req, res),
      });

      return res.status(202).json({
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
        error: error?.message || "Erro ao exportar Excel de caracteristicas.",
      });
    }
  }

  static async validateImport(req, res) {
    try {
      if (!req.file?.buffer) {
        return res.status(400).json({
          success: false,
          error: "Envie um arquivo Excel para validar.",
        });
      }

      const payload = await CaracteristicasService.validateWorkbookImport(
        res.locals?.mlCreds || {},
        {
          category_id: req.body?.category_id,
          buffer: req.file.buffer,
          original_name: req.file.originalname,
        },
      );
      return res.json({ success: true, ...payload });
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error?.message || "Erro ao validar importacao.",
      });
    }
  }

  static async apply(req, res) {
    try {
      const payload = await CaracteristicasService.apply(
        res.locals?.mlCreds || {},
        {
          item_ids: req.body?.item_ids,
          category_id: req.body?.category_id,
          attributes: req.body?.attributes,
          dry_run: req.body?.dry_run,
        },
      );

      const status = payload?.success === false ? 409 : 200;
      return res.status(status).json(payload);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error?.message || "Erro ao aplicar caracteristicas.",
      });
    }
  }

  static async applyExcel(req, res) {
    try {
      const job = await CaracteristicasJobsService.enqueue({
        categoryId: req.body?.category_id,
        rows: req.body?.rows,
        dryRun: req.body?.dry_run,
        mlCreds: res.locals?.mlCreds || {},
        accountKey: res.locals?.accountKey || null,
        accountLabel: res.locals?.accountLabel || null,
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
        error: error?.message || "Erro ao enfileirar importacao de caracteristicas.",
      });
    }
  }

  static async listJobs(_req, res) {
    try {
      return res.json({
        success: true,
        jobs: await CaracteristicasJobsService.listRecent(25, {
          accountKey: res.locals?.accountKey || null,
        }),
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error?.message || "Erro ao listar jobs de caracteristicas.",
      });
    }
  }

  static async jobDetail(req, res) {
    try {
      const job = await CaracteristicasJobsService.jobDetail(req.params?.job_id, {
        accountKey: res.locals?.accountKey || null,
      });
      if (!job) {
        return res.status(404).json({
          success: false,
          error: "Job de caracteristicas nao encontrado.",
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
      const job = await CaracteristicasJobsService.cancelJob(req.params?.job_id, {
        accountKey: res.locals?.accountKey || null,
      });
      if (!job) {
        return res.status(404).json({
          success: false,
          error: "Job de caracteristicas nao encontrado.",
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
      }, { module: "caracteristicas" });
      return res.json({ success: true, status: job.status, id: req.params?.job_id, ...contracted });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error?.message || "Erro ao cancelar job de caracteristicas.",
      });
    }
  }

  static async downloadJobCsv(req, res) {
    try {
      const file = await CaracteristicasJobsService.getJobCsv(req.params?.job_id, {
        accountKey: res.locals?.accountKey || null,
      });
      if (!file) {
        return res.status(404).json({
          success: false,
          error: "CSV do job de caracteristicas nao encontrado.",
        });
      }
      if (file.pending) {
        return res.status(409).json({
          success: false,
          error: "Arquivo do job ainda nao esta pronto para download.",
          status: "processando",
        });
      }

      res.setHeader("Content-Type", file.contentType || "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
      res.status(200);
      await CaracteristicasJobsService.streamJobCsv(req.params?.job_id, res);
      return res.end();
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error?.message || "Erro ao baixar CSV do job.",
      });
    }
  }
}

module.exports = CaracteristicasController;
