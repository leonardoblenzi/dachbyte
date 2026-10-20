"use strict";

const service = require("../services/bulkSkuService");
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
  async exportWorkbook(req, res) {
    try {
      const file = await service.exportRows(context(req, res));
      res.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.set("Content-Disposition", 'attachment; filename="alteracao-skus.xlsx"');
      return res.send(file);
    } catch (error) { return fail(res, error); }
  },
  async preview(req, res) {
    try {
      if (!req.file?.buffer) return res.status(400).json({ ok: false, error: "Selecione uma planilha .xlsx." });
      return res.json({ ok: true, preview: await service.previewWorkbook(req.file.buffer, context(req, res)) });
    } catch (error) { return fail(res, error); }
  },
  async createJob(req, res) {
    try { return res.json({ ok: true, job: await service.confirmPreview(String(req.body?.previewId || ""), context(req, res)) }); }
    catch (error) { return fail(res, error); }
  },
  async getJob(req, res) {
    try {
      const job = await service.getJob(String(req.params.id || ""), context(req, res));
      return job ? res.json({ ok: true, job }) : res.status(404).json({ ok: false, error: "Lote nao encontrado." });
    } catch (error) { return fail(res, error); }
  },
  async report(req, res) {
    try {
      const csv = await service.reportJob(String(req.params.id || ""), context(req, res));
      res.set("Content-Type", "text/csv; charset=utf-8");
      res.set("Content-Disposition", 'attachment; filename="resultado-alteracao-skus.csv"');
      return res.send(csv);
    } catch (error) { return fail(res, error); }
  },
};
