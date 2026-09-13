// controllers/ExcluirAnuncioController.js
const ExclusaoService = require('../services/excluirAnuncioService');
const ExclusaoLoteJobService = require('../services/exclusaoLoteJobService');
const { attachJobContract } = require('../services/jobContract');
const {
  getRequestIp,
  getRequestUserAgent,
  recordAuthEvent,
} = require("../services/authAuditService");

function actor(req) {
  return {
    userId: Number(req.user?.uid) || null,
    email: req.user?.email || null,
  };
}

function audit(req, evento, status, metadata) {
  const a = actor(req);
  return recordAuthEvent({
    userId: a.userId,
    email: a.email,
    evento,
    status,
    ip: getRequestIp(req),
    userAgent: getRequestUserAgent(req),
    metadata,
  }).catch((err) => {
    console.error("audit excluir anuncio erro:", err?.message || err);
  });
}

function auditContext(req, res) {
  const a = actor(req);
  return {
    userId: a.userId,
    email: a.email,
    ip: getRequestIp(req),
    userAgent: getRequestUserAgent(req),
    route: req.originalUrl || req.url || null,
    method: req.method,
    accountKey: res.locals?.accountKey || null,
    accountLabel: res.locals?.accountLabel || null,
    meli_conta_id: res.locals?.mlCreds?.meli_conta_id || null,
  };
}

/**
 * DELETE /anuncios/excluir/:mlb_id
 * Usa o excluirAnuncioService.excluirUnico, que:
 *  - fecha o anuncio (status=closed) se necessario
 *  - envia deleted=true
 *  - retorna log detalhado (steps, status_inicial, etc.)
 */
class ExcluirAnuncioController {
  static normalizeOperation(value) {
    const operation = String(value || '').trim().toUpperCase();
    const allowed = new Set(['ACTIVATE', 'PAUSE', 'CLOSE', 'DELETE', 'CLOSE_RELIST', 'PAUSE_RELIST']);
    return allowed.has(operation) ? operation : null;
  }

  static operationEvent(operation) {
    if (operation === 'ACTIVATE') return 'listing_activated_bulk_started';
    if (operation === 'PAUSE') return 'listing_paused_bulk_started';
    if (operation === 'CLOSE') return 'listing_closed_bulk_started';
    if (operation === 'CLOSE_RELIST') return 'listing_relisted_bulk_started';
    if (operation === 'PAUSE_RELIST') return 'listing_pause_relisted_bulk_started';
    return 'listing_deleted_bulk_started';
  }

  static async excluirUnico(req, res) {
    try {
      const mlbId = (req.params.mlb_id || req.body.mlb_id || '').trim().toUpperCase();

      if (!mlbId || !/^MLB\d{5,}$/.test(mlbId)) {
        return res
          .status(400)
          .json({ success: false, error: 'MLB ID e obrigatorio e deve ser valido (ex: MLB123456789).' });
      }

      const resultado = await ExclusaoService.excluirUnico(mlbId, {
        mlCreds: res.locals?.mlCreds || {},
        accountKey: res.locals?.accountKey || null,
      });

      await audit(
        req,
        "listing_deleted_single",
        resultado.success ? "success" : "warn",
        {
          mlb_id: mlbId,
          accountKey: res.locals?.accountKey || null,
          accountLabel: res.locals?.accountLabel || null,
          result: {
            success: !!resultado.success,
            status_inicial: resultado.status_inicial || null,
            status_final: resultado.status_final || null,
          },
        },
      );

      const statusCode = resultado.success ? 200 : 400;
      return res.status(statusCode).json(resultado);
    } catch (err) {
      console.error('[ERRO excluirUnico]', err);
      return res.status(500).json({
        success: false,
        error: err.message || 'Erro interno ao excluir anuncio',
      });
    }
  }

  static async excluirLote(req, res) {
    try {
      const { mlb_ids, delay_entre_remocoes = 2500 } = req.body;

      if (!Array.isArray(mlb_ids) || mlb_ids.length === 0) {
        return res
          .status(400)
          .json({ success: false, error: 'Informe uma lista de MLB IDs em "mlb_ids".' });
      }

      const jobId = await ExclusaoLoteJobService.enqueueJob({
        mlbIds: mlb_ids,
        delayMs: delay_entre_remocoes,
        operation: 'DELETE',
        mlCreds: res.locals?.mlCreds || {},
        accountKey: res.locals?.accountKey || null,
        accountLabel: res.locals?.accountLabel || res.locals?.accountKey || null,
        auditContext: auditContext(req, res),
      });
      const jobContract = attachJobContract({
        id: jobId,
        status: "aguardando",
        completed: false,
        progress: 0,
      }, { module: "gestao-anuncios", kind: "DELETE" });

      await audit(req, "listing_deleted_bulk_started", "success", {
        process_id: jobId,
        total_items: mlb_ids.length,
        delay_ms: Number(delay_entre_remocoes) || 0,
        sample_ids: mlb_ids.slice(0, 20),
        accountKey: res.locals?.accountKey || null,
        accountLabel: res.locals?.accountLabel || null,
      });

      return res.json({
        success: true,
        message: 'Processamento de exclusao em lote iniciado.',
        process_id: jobId,
        job_id: jobId,
        job_uid: jobContract.job_uid,
        backend_job_id: jobContract.backend_job_id,
        lifecycle_status: jobContract.lifecycle_status,
        job_contract: jobContract.job_contract,
        account: {
          key: res.locals?.accountKey || null,
          label: res.locals?.accountLabel || res.locals?.accountKey || null,
        },
      });
    } catch (err) {
      console.error('[ERRO excluirLote]', err);
      return res.status(500).json({
        success: false,
        error: err.message || 'Erro interno ao iniciar exclusao em lote',
      });
    }
  }

  static async operarLote(req, res) {
    try {
      const { mlb_ids, delay_ms, delay_entre_remocoes } = req.body;
      const operation = ExcluirAnuncioController.normalizeOperation(req.body?.operation);

      if (!operation) {
        return res.status(400).json({
          success: false,
          error: 'Operacao invalida. Use ACTIVATE, PAUSE, CLOSE, DELETE, CLOSE_RELIST ou PAUSE_RELIST.',
        });
      }

      if (!Array.isArray(mlb_ids) || mlb_ids.length === 0) {
        return res
          .status(400)
          .json({ success: false, error: 'Informe uma lista de MLB IDs em "mlb_ids".' });
      }

      const delayMs = Number(delay_ms ?? delay_entre_remocoes ?? 250) || 250;
      const jobId = await ExclusaoLoteJobService.enqueueJob({
        mlbIds: mlb_ids,
        delayMs,
        operation,
        mlCreds: res.locals?.mlCreds || {},
        accountKey: res.locals?.accountKey || null,
        accountLabel: res.locals?.accountLabel || res.locals?.accountKey || null,
        auditContext: auditContext(req, res),
      });
      const jobContract = attachJobContract({
        id: jobId,
        status: "aguardando",
        completed: false,
        progress: 0,
      }, { module: "gestao-anuncios", kind: operation });

      await audit(req, ExcluirAnuncioController.operationEvent(operation), "success", {
        operation,
        process_id: jobId,
        total_items: mlb_ids.length,
        delay_ms: delayMs,
        sample_ids: mlb_ids.slice(0, 20),
        accountKey: res.locals?.accountKey || null,
        accountLabel: res.locals?.accountLabel || null,
      });

      return res.json({
        success: true,
        message: 'Processamento de gestao de anuncios iniciado.',
        operation,
        process_id: jobId,
        job_id: jobId,
        job_uid: jobContract.job_uid,
        backend_job_id: jobContract.backend_job_id,
        lifecycle_status: jobContract.lifecycle_status,
        job_contract: jobContract.job_contract,
        account: {
          key: res.locals?.accountKey || null,
          label: res.locals?.accountLabel || res.locals?.accountKey || null,
        },
      });
    } catch (err) {
      console.error('[ERRO operarLote]', err);
      return res.status(500).json({
        success: false,
        error: err.message || 'Erro interno ao iniciar operacao em lote',
      });
    }
  }

  static async status(req, res) {
    const proc = await ExclusaoLoteJobService.getJobStatus(req.params.id, {
      accountKey: res.locals?.accountKey || null,
    });
    if (!proc) {
      return res
        .status(404)
        .json({ success: false, error: 'Processo nao encontrado', id: req.params.id });
    }
    return res.json(proc);
  }

  static async listJobs(_req, res) {
    try {
      const jobs = await ExclusaoLoteJobService.listJobs(25, {
        accountKey: res.locals?.accountKey || null,
      });
      res.json({ success: true, jobs });
    } catch (error) {
      console.error('Erro ao listar jobs de gestao de anuncios:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  static async jobDetail(req, res) {
    try {
      const proc = await ExclusaoLoteJobService.getJobDetail(req.params.id, {
        accountKey: res.locals?.accountKey || null,
      });
      if (!proc) {
        return res.status(404).json({ success: false, error: 'Processo nao encontrado' });
      }

      return res.json({
        success: true,
        job: proc,
      });
    } catch (error) {
      console.error('Erro ao detalhar job de gestao de anuncios:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  static async cancelJob(req, res) {
    try {
      const result = await ExclusaoLoteJobService.cancelJob(req.params.id, {
        accountKey: res.locals?.accountKey || null,
        auditContext: auditContext(req, res),
      });
      if (!result) {
        return res.status(404).json({ success: false, error: "Processo nao encontrado" });
      }
      if (!result.ok) {
        return res.status(409).json({ success: false, error: result.error, status: result.status });
      }
      const contracted = attachJobContract({
        id: req.params.id,
        status: result.status,
        completed: result.status === "cancelado",
      }, { module: "gestao-anuncios" });
      return res.json({ success: true, id: req.params.id, status: result.status, ...contracted });
    } catch (error) {
      console.error("Erro ao cancelar job de gestao de anuncios:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  static async downloadCsv(req, res) {
    try {
      const file = await ExclusaoLoteJobService.getJobCsv(req.params.id, {
        accountKey: res.locals?.accountKey || null,
      });
      if (!file) {
        return res
          .status(404)
          .json({ success: false, error: "CSV do processo nao encontrado" });
      }

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${file.filename}"`,
      );
      res.status(200);
      await ExclusaoLoteJobService.streamJobCsv(req.params.id, res);
      return res.end();
    } catch (error) {
      console.error("Erro ao baixar CSV do job de gestao de anuncios:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  }
}

module.exports = ExcluirAnuncioController;
