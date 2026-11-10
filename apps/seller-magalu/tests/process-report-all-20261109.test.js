"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const path = require("node:path");
const ExcelJS = require("exceljs");
const reports = require("../src/services/processReportService");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

const RUN = { started_at: "2026-11-09T12:00:00Z", status: "partial" };

test("sincronização: resultado por SKU (sucesso, não publicado, falha, não lido, removido)", () => {
  const row = (extra) => reports.syncReportRow({ sku: "A", status: "PUBLISHED", is_present: true, last_synced_at: "2026-11-09T12:30:00Z", price: "10.5", quantity: 3, ...extra }, RUN);
  assert.equal(row({}).result, "Sucesso");
  assert.equal(row({}).price, 10.5);
  assert.equal(row({ status: "UNPUBLISHED" }).result, "Lido");
  assert.match(row({ status: "UNPUBLISHED" }).reason, /não publicado/);
  const fail = row({ stock_error: "HTTP 500", stock_synced_at: "2026-11-09T12:31:00Z" });
  assert.equal(fail.result, "Falha parcial");
  assert.match(fail.reason, /Estoque: HTTP 500/);
  assert.equal(row({ stock_error: "antigo", stock_synced_at: "2026-11-01T00:00:00Z" }).result, "Sucesso");
  assert.equal(row({ last_synced_at: "2026-11-01T00:00:00Z" }).result, "Não lido");
  assert.equal(reports.syncReportRow({ sku: "B", last_synced_at: "2026-11-01T00:00:00Z", is_present: true }, { ...RUN, status: "running" }).result, "Pendente");
  assert.equal(row({ is_present: false }).result, "Removido");
});

test("consulta de preços: atualizado, falha, sem preço e não consultado", () => {
  const start = "2026-11-09T12:00:00Z", base = { sku: "A", price: "99.9", price_present: true, price_synced_at: "2026-11-09T12:05:00Z" };
  assert.equal(reports.promoRefreshRow(base, start).result, "Atualizado");
  assert.equal(reports.promoRefreshRow({ ...base, price_error: "HTTP 404" }, start).result, "Falha");
  assert.equal(reports.promoRefreshRow({ ...base, price: null, price_present: false }, start).result, "Sem preço");
  assert.equal(reports.promoRefreshRow({ ...base, price_synced_at: "2026-11-08T00:00:00Z" }, start).result, "Não consultado");
});

test("prévia promocional: elegível com preço sugerido ou excluído com os motivos", () => {
  const excluded = reports.promoPreviewRow({ sku: "100015p", source: { title: "Poltrona", unit_cost: "3611.18", price: "8125.9", list_price: "10833.9", tax_rate: "10" }, result: { eligible: false, issues: ["Frete estimado não informado", "Custo ausente"] } });
  assert.equal(excluded.result, "Excluído");
  assert.equal(excluded.reason, "Frete estimado não informado · Custo ausente");
  assert.equal(excluded.cost, 3611.18);
  const eligible = reports.promoPreviewRow({ sku: "B", source: {}, result: { eligible: true, suggested_price: 199.99, estimated_margin: 17.4 }, price_override: null });
  assert.equal(eligible.result, "Elegível");
  assert.equal(eligible.suggested, 199.99);
  assert.equal(reports.promoPreviewRow({ sku: "C", source: {}, result: { eligible: true, suggested_price: 199.99 }, price_override: "189.90" }).suggested, 189.9);
});

test("gerador genérico pagina por cursor e grava colunas tipadas", async () => {
  const output = new PassThrough(), chunks = [], cursors = [];
  output.on("data", (chunk) => chunks.push(chunk));
  const pages = [[{ sku: "0001", source: {}, result: { eligible: false, issues: ["Custo ausente"] } }], []];
  await reports.streamSheet(output, { columns: reports.PROMO_PREVIEW_COLUMNS, firstCursor: "", fetchPage: async (c) => { cursors.push(c); return pages.shift(); }, nextCursor: (r) => r.sku, mapRow: reports.promoPreviewRow });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.concat(chunks));
  const sheet = workbook.worksheets[0];
  assert.deepEqual(cursors, ["", "0001"]);
  assert.equal(sheet.getRow(2).getCell(1).text, "0001");
  assert.equal(sheet.getRow(2).getCell(12).text, "Excluído");
});

test("endpoint cobre todos os tipos do painel e o painel mostra o botão em todos", () => {
  const controller = read("src/controllers/processPanelController.js"), panel = read("public/js/magalu-process-panel.js"), repo = read("src/repositories/processPanelRepository.js");
  assert.match(controller, /if\(kind==="sync"\)\{/);
  assert.match(controller, /if\(kind==="promo"\)\{/);
  assert.match(controller, /if\(!job\|\|!await promoJobRow\(job,owner\)\)return notFound\(res\);/);
  assert.match(controller, /O relatório fica disponível só para a sincronização mais recente/);
  assert.match(repo, /report_available: index === 0/);
  assert.match(repo, /p\.account_id=\$2 and p\.dach_tenant_id=\$3 and p\.dach_user_id=\$4/);
  assert.match(panel, /if \(row\.kind === "sync"\) return row\.report_available === true/);
  assert.match(panel, /if \(row\.kind === "promo"\) return row\.action === "promo-preview"/);
  assert.match(panel, /<div class="mg-process-card__actions">\$\{reportAction\(row,t\)\}<button type="button" data-process-detail/);
});
