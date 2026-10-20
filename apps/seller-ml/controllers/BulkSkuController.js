"use strict";

const service = require("../services/bulkSkuService");
const exportService = require("../services/bulkSkuExportService");
const previewService = require("../services/bulkSkuPreviewJobService");
const fs = require("node:fs");
const { requestContext } = require("../services/anuncioCadastro/helpers");

function context(req, res) {
  const active = requestContext(req, res);
  return {
    ...active,
    accountKey: String(res.locals?.accountKey || "").trim(),
    accountLabel: String(res.locals?.accountLabel || res.locals?.account?.nickname || active.sellerId || "").trim(),
    requestedBy: String(req.user?.uid || req.user?.id || req.user?.usuario_id || "").trim(),
  };
}

function fail(res, error) {
  const status = Number(error?.status || error?.statusCode || 500);
  return res.status(status >= 400 && status < 600 ? status : 500).json({ ok: false, error: error?.message || "Falha na alteracao de SKUs." });
}

module.exports = {
  getContext(req, res) {
    try {
      const active = context(req, res);
      service.assertAccount(active);
      return res.json({ ok: true, account: { label: active.accountLabel || String(active.sellerId), sellerId: String(active.sellerId) } });
    } catch (error) { return fail(res, error); }
  },
  async createExport(req, res) {
    try {
      return res.status(202).json({ ok: true, job: await exportService.createExport(context(req, res), req.body?.status) });
    } catch (error) { return fail(res, error); }
  },
  async getExport(req, res) {
    try {
      const job = await exportService.getExport(String(req.params.id || ""), context(req, res));
      return job ? res.json({ ok: true, job }) : res.status(404).json({ ok: false, error: "Exportacao nao encontrada." });
    } catch (error) { return fail(res, error); }
  },
  async downloadExport(req, res) {
    try {
      const job = await exportService.getExport(String(req.params.id || ""), context(req, res));
      if (!job) return res.status(404).json({ ok: false, error: "Exportacao nao encontrada." });
      if (job.status !== "finished") return res.status(409).json({ ok: false, error: "Exportacao ainda nao concluida." });
      const filename = exportService.exportPath(job.id);
      if (!fs.existsSync(filename)) return res.status(410).json({ ok: false, error: "Arquivo expirado. Gere uma nova exportacao." });
      return res.download(filename, `alteracao-skus-${job.filter_status}.xlsx`);
    } catch (error) { return fail(res, error); }
  },
  async preview(req, res) {
    try {
      if (!req.file?.path) return res.status(400).json({ ok: false, error: "Selecione uma planilha .xlsx." });
      return res.status(202).json({ ok: true, job: await previewService.createPreview(context(req, res), req.file.path) });
    } catch (error) { if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch (_) {} } return fail(res, error); }
  },
  async listJobs(req, res) {
    try { return res.json({ ok: true, jobs: await service.listJobs(context(req, res)) }); }
    catch (error) { return fail(res, error); }
  },
  async createJob(req, res) {
    try { return res.json({ ok: true, job: await service.confirmPreview(String(req.body?.previewId || ""), context(req, res)) }); }
    catch (error) { return fail(res, error); }
  },
  async getJob(req, res) {
    try {
      const job = await service.getJob(String(req.params.id || ""), context(req, res), undefined, {
        limit: Math.min(200, Math.max(1, Number(req.query.limit) || 100)),
        offset: Math.max(0, Number(req.query.offset) || 0),
      });
      return job ? res.json({ ok: true, job }) : res.status(404).json({ ok: false, error: "Lote nao encontrado." });
    } catch (error) { return fail(res, error); }
  },
  async report(req, res) {
    try {
      const active = context(req, res);
      const id = String(req.params.id || "");
      const job = await service.getJob(id, active);
      if (!job) return res.status(404).json({ ok: false, error: "Lote nao encontrado." });
      res.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.set("Content-Disposition", 'attachment; filename="resultado-alteracao-skus.xlsx"');
      await service.reportJob(id, active, res);
      return res;
    } catch (error) {
      if (res.headersSent) { res.destroy(error); return res; }
      return fail(res, error);
    }
  },
};
