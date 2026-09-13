"use strict";

const ModeloMassaService = require("../services/modeloMassaService");
const ModeloMassaJobsService = require("../services/modeloMassaJobsService");
const { attachJobContract } = require("../services/jobContract");
const ModeloMassaPadraoService = require("../services/modeloMassaPadraoService");
const {
  getRequestIp,
  getRequestUserAgent,
} = require("../services/authAuditService");

function currentEmpresaId(res) {
  const id = Number(res.locals?.empresaId || res.locals?.account?.empresa_id || res.locals?.mlCreds?.empresa_id);
  return Number.isFinite(id) && id > 0 ? id : null;
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

class ModeloMassaController {
  static async listPadroes(req, res) {
    try {
      const modelos = await ModeloMassaPadraoService.list({
        empresaId: currentEmpresaId(res),
        search: req.query?.q,
      });

      return res.json({ success: true, modelos });
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error?.message || "Erro ao listar modelos padrao.",
      });
    }
  }

  static async createPadrao(req, res) {
    try {
      const modelo = await ModeloMassaPadraoService.create({
        empresaId: currentEmpresaId(res),
        modelo: req.body?.modelo,
        user: req.user || res.locals?.user || {},
      });

      return res.status(201).json({ success: true, modelo });
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error?.message || "Erro ao salvar modelo padrao.",
      });
    }
  }

  static async updatePadrao(req, res) {
    try {
      const modelo = await ModeloMassaPadraoService.update({
        empresaId: currentEmpresaId(res),
        id: req.params?.padrao_id,
        modelo: req.body?.modelo,
        user: req.user || res.locals?.user || {},
      });

      return res.json({ success: true, modelo });
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error?.message || "Erro ao atualizar modelo padrao.",
      });
    }
  }

  static async deletePadrao(req, res) {
    try {
      const removed = await ModeloMassaPadraoService.remove({
        empresaId: currentEmpresaId(res),
        id: req.params?.padrao_id,
        user: req.user || res.locals?.user || {},
      });

      return res.json({ success: true, removed });
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error?.message || "Erro ao remover modelo padrao.",
      });
    }
  }

  static async createPadraoValor(req, res) {
    try {
      const valor = await ModeloMassaPadraoService.createValue({
        empresaId: currentEmpresaId(res),
        modeloPadraoId: req.params?.padrao_id,
        valor: req.body?.valor,
        user: req.user || res.locals?.user || {},
      });

      return res.status(201).json({ success: true, valor });
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error?.message || "Erro ao salvar valor do modelo padrao.",
      });
    }
  }

  static async updatePadraoValor(req, res) {
    try {
      const valor = await ModeloMassaPadraoService.updateValue({
        empresaId: currentEmpresaId(res),
        modeloPadraoId: req.params?.padrao_id,
        id: req.params?.valor_id,
        valor: req.body?.valor,
        user: req.user || res.locals?.user || {},
      });

      return res.json({ success: true, valor });
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error?.message || "Erro ao atualizar valor do modelo padrao.",
      });
    }
  }

  static async deletePadraoValor(req, res) {
    try {
      const removed = await ModeloMassaPadraoService.removeValue({
        empresaId: currentEmpresaId(res),
        modeloPadraoId: req.params?.padrao_id,
        id: req.params?.valor_id,
        user: req.user || res.locals?.user || {},
      });

      return res.json({ success: true, removed });
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error?.message || "Erro ao remover valor do modelo padrao.",
      });
    }
  }

  static async preview(req, res) {
    try {
      const rows = await ModeloMassaService.buildPreviewRows(
        res.locals?.mlCreds || {},
        req.body?.item_ids,
        req.body?.target_model,
      );

      return res.json({ success: true, items: rows });
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error?.message || "Erro ao analisar anúncios para o modelo em massa.",
      });
    }
  }

  static async apply(req, res) {
    try {
      const job = await ModeloMassaJobsService.enqueue({
        itemIds: req.body?.item_ids,
        targetModel: req.body?.target_model,
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
        error: error?.message || "Erro ao iniciar o job de modelo em massa.",
      });
    }
  }

  static async listJobs(_req, res) {
    try {
      return res.json({
        success: true,
        jobs: ModeloMassaJobsService.listRecent(25, {
          accountKey: res.locals?.accountKey || null,
        }),
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error?.message || "Erro ao listar jobs de modelo em massa.",
      });
    }
  }

  static async jobDetail(req, res) {
    try {
      const job = ModeloMassaJobsService.jobDetail(req.params?.job_id, {
        accountKey: res.locals?.accountKey || null,
      });
      if (!job) {
        return res.status(404).json({
          success: false,
          error: "Job de modelo em massa não encontrado.",
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
      const job = ModeloMassaJobsService.cancelJob(req.params?.job_id, {
        accountKey: res.locals?.accountKey || null,
      });
      if (!job) {
        return res.status(404).json({
          success: false,
          error: "Job de modelo em massa nao encontrado.",
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
      }, { module: "modelo-massa" });
      return res.json({ success: true, status: job.status, id: req.params?.job_id, ...contracted });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error?.message || "Erro ao cancelar job de modelo em massa.",
      });
    }
  }

  static async downloadCsv(req, res) {
    try {
      const file = ModeloMassaJobsService.getJobCsv(req.params?.job_id, {
        accountKey: res.locals?.accountKey || null,
      });
      if (!file?.csv) {
        return res.status(404).json({
          success: false,
          error: "CSV do job de modelo em massa nao encontrado.",
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

module.exports = ModeloMassaController;
