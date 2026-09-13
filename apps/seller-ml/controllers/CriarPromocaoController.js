// controllers/CriarPromocaoController.js
const path = require('path');
const TokenService = require('../services/tokenService');
const CriarPromocaoService = require('../services/criarPromocaoService');
const {
  getRequestIp,
  getRequestUserAgent,
  recordAuthEvent,
} = require("../services/authAuditService");

// Registro simples de jobs em memória
const jobs = new Map();

function newJobId() {
  return Math.random().toString(36).slice(2, 10);
}

function safeText(value, max = 500) {
  const text = value == null ? "" : String(value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function buildAuditContext(req, res) {
  return {
    userId: Number(req.user?.uid || req.user?.id) || null,
    email: req.user?.email || null,
    ip: getRequestIp(req),
    userAgent: getRequestUserAgent(req),
    route: req.originalUrl || req.url || null,
    method: req.method,
    accountKey: res.locals?.accountKey || null,
    accountLabel: res.locals?.accountLabel || res.locals?.accountKey || null,
    meli_conta_id: res.locals?.mlCreds?.meli_conta_id || null,
  };
}

async function auditPromotionEvent(context, evento, status, metadata = {}) {
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
      action: "apply",
      ...metadata,
    },
  }).catch((err) => {
    console.error("audit criar promocao erro:", err?.message || err);
  });
}

class CriarPromocaoController {
  // POST /api/criar-promocao/desconto/unico
  static async descontoUnico(req, res) {
    try {
      const { mlb, percent } = req.body || {};
      if (!mlb || !percent || Number(percent) <= 0) {
        return res.status(400).json({ success: false, error: 'Parâmetros inválidos. Informe mlb e percent > 0.' });
      }

      // Passa as credenciais da conta atual (ensureAccount) para o service
      const options = {
        mlCreds: res.locals?.mlCreds || {},
        accountKey: res.locals?.accountKey,
        logger: console,
      };

      const result = await CriarPromocaoService.aplicarDescontoUnico(mlb.trim(), Number(percent), options);
      const requestedPercent = Number(percent);
      const realAppliedPercent = result?.success ? Number(result?.applied_percent ?? requestedPercent) : null;
      await auditPromotionEvent(
        buildAuditContext(req, res),
        "promotion_item_processed",
        result?.success ? "success" : "warn",
        {
          mlb_id: String(mlb || "").trim().toUpperCase(),
          total_items: 1,
          item_index: 1,
          success: !!result?.success,
          defined_percent: requestedPercent,
          requested_percent: requestedPercent,
          estimated_applied_percent: requestedPercent,
          applied_percent: realAppliedPercent,
          real_applied_percent: realAppliedPercent,
          message: safeText(result?.message || result?.error || ""),
          legacy_route: true,
        },
      );
      if (result.success) return res.json(result);
      return res.status(400).json(result);
    } catch (err) {
      console.error('❌ [descontoUnico] Erro:', err?.message || err);
      await auditPromotionEvent(
        buildAuditContext(req, res),
        "promotion_item_processed",
        "error",
        {
          mlb_id: String(req.body?.mlb || "").trim().toUpperCase() || null,
          total_items: 1,
          item_index: 1,
          success: false,
          defined_percent: Number(req.body?.percent || 0) || null,
          requested_percent: Number(req.body?.percent || 0) || null,
          estimated_applied_percent: Number(req.body?.percent || 0) || null,
          applied_percent: null,
          real_applied_percent: null,
          message: safeText(err?.message || String(err)),
          legacy_route: true,
        },
      );
      return res.status(500).json({ success: false, error: err?.message || 'Erro interno' });
    }
  }

  // POST /api/criar-promocao/desconto/lote
  static async descontoLote(req, res) {
    try {
      const { mlbs, percent, delay_ms } = req.body || {};
      if (!mlbs || !percent || Number(percent) <= 0) {
        return res.status(400).json({ success: false, error: 'Parâmetros inválidos. Informe mlbs (texto) e percent > 0.' });
      }
      const list = String(mlbs)
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean);

      if (list.length === 0) {
        return res.status(400).json({ success: false, error: 'Nenhum MLB válido encontrado.' });
      }

      const jobId = newJobId();
      const auditContext = buildAuditContext(req, res);
      const state = {
        id: jobId,
        status: 'processando',
        criado_em: new Date().toISOString(),
        total: list.length,
        processados: 0,
        ok: 0,
        fail: 0,
        progresso_percentual: 0,
        results: [],
        accountKey: res.locals?.accountKey || 'sem-conta',
        auditContext,
      };
      jobs.set(jobId, state);

      // Inicia processamento assíncrono
      setImmediate(async () => {
        try {
          await auditPromotionEvent(auditContext, "promotion_job_processing_started", "success", {
            job_id: jobId,
            total_items: list.length,
            sample_ids: list.slice(0, 20).map((id) => String(id || "").trim().toUpperCase()),
            defined_percent: Number(percent),
            requested_percent: Number(percent),
            estimated_applied_percent: Number(percent),
            applied_percent: null,
            real_applied_percent: null,
            legacy_route: true,
          });
          const options = {
            mlCreds: res.locals?.mlCreds || {},
            accountKey: res.locals?.accountKey,
            logger: console,
          };
          for (let i = 0; i < list.length; i++) {
            const id = list[i];
            try {
              const out = await CriarPromocaoService.aplicarDescontoUnico(id, Number(percent), options);
              state.results.push(out);
              if (out.success) state.ok += 1; else state.fail += 1;
              const requestedPercent = Number(percent);
              const realAppliedPercent = out.success ? Number(out.applied_percent ?? requestedPercent) : null;
              await auditPromotionEvent(auditContext, "promotion_item_processed", out.success ? "success" : "warn", {
                job_id: jobId,
                mlb_id: String(id || "").trim().toUpperCase(),
                item_index: i + 1,
                total_items: list.length,
                success: !!out.success,
                defined_percent: requestedPercent,
                requested_percent: requestedPercent,
                estimated_applied_percent: requestedPercent,
                applied_percent: realAppliedPercent,
                real_applied_percent: realAppliedPercent,
                message: safeText(out.message || out.error || ""),
                legacy_route: true,
              });
            } catch (e) {
              state.fail += 1;
              state.results.push({ success: false, mlb_id: id, error: e?.message || String(e) });
              await auditPromotionEvent(auditContext, "promotion_item_processed", "error", {
                job_id: jobId,
                mlb_id: String(id || "").trim().toUpperCase(),
                item_index: i + 1,
                total_items: list.length,
                success: false,
                defined_percent: Number(percent),
                requested_percent: Number(percent),
                estimated_applied_percent: Number(percent),
                applied_percent: null,
                real_applied_percent: null,
                message: safeText(e?.message || String(e)),
                legacy_route: true,
              });
            }
            state.processados = i + 1;
            state.progresso_percentual = Math.round((state.processados / state.total) * 100);
            if (delay_ms && i < list.length - 1) {
              await new Promise(r => setTimeout(r, Number(delay_ms) || 0));
            }
          }
          state.status = 'concluido';
          state.concluido_em = new Date().toISOString();
          await auditPromotionEvent(auditContext, "promotion_job_completed", state.fail > 0 ? "warn" : "success", {
            job_id: jobId,
            total_items: state.total,
            processed: state.processados,
            success: state.ok,
            failed: state.fail,
            legacy_route: true,
          });
        } catch (err) {
          state.status = 'erro';
          state.error = err?.message || String(err);
          state.concluido_em = new Date().toISOString();
          await auditPromotionEvent(auditContext, "promotion_job_failed", "error", {
            job_id: jobId,
            total_items: state.total,
            processed: state.processados,
            success: state.ok,
            failed: state.fail,
            error: safeText(err?.message || String(err)),
            legacy_route: true,
          });
        }
      });

      return res.json({ success: true, job_id: jobId, total: state.total });
    } catch (err) {
      console.error('❌ [descontoLote] Erro:', err?.message || err);
      return res.status(500).json({ success: false, error: err?.message || 'Erro interno' });
    }
  }

  // GET /api/criar-promocao/status/:jobId
  static async status(req, res) {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ success: false, error: 'Job não encontrado.' });
    return res.json({ success: true, ...job });
  }

  // GET /api/criar-promocao/download/:jobId
  static async download(req, res) {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ success: false, error: 'Job não encontrado.' });
    const rows = [['mlb_id','applied_percent','base_price','deal_price','success','message']];
    for (const r of job.results || []) {
      rows.push([
        r.mlb_id || '',
        r.applied_percent ?? '',
        r.base_price ?? '',
        r.deal_price ?? '',
        r.success ? 'TRUE' : 'FALSE',
        (r.message || r.error || '').toString().replace(/\n/g,' ')
      ]);
    }
    // CSV simples (Excel-friendly)
    const csv = rows.map(cols => cols.map(v => {
      const s = (v==null?'':String(v));
      if (s.includes(';') || s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g,'""') + '"';
      }
      return s;
    }).join(',')).join('\n');

    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="descontos_${job.id}.csv"`);
    return res.status(200).send('\ufeff' + csv); // BOM para Excel PT-BR
  }
}

module.exports = CriarPromocaoController;
