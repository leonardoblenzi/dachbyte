"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const path = require("node:path");
const ExcelJS = require("exceljs");
const { streamReport } = require("../src/services/processReportService");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

async function render(resource, pages) {
  const output = new PassThrough(), chunks = [];
  output.on("data", (chunk) => chunks.push(chunk));
  const calls = [];
  const total = await streamReport(output, { resource, fetchPage: async (afterId) => { calls.push(afterId); return pages.shift() || []; } });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.concat(chunks));
  return { sheet: workbook.worksheets[0], total, calls };
}

test("relatório de gestão de SKUs traz uma linha por SKU com resultado e motivo", async () => {
  const { sheet, total, calls } = await render("sku", [[
    { id: 10, sku: "000123", title: "Poltrona", action: "activate", status: "succeeded", batch_label: "Lote 1", before_payload: { active: false, status: "UNPUBLISHED" }, requested_payload: { active: true }, after_payload: { active: true, status: "PUBLISHED" }, response_status: 200, request_id: "req-1", completed_at: "2026-11-09T12:00:00Z" },
    { id: 11, sku: "SKU-2", title: "Sofá", action: "activate", status: "divergent", batch_label: "Lote 1", before_payload: { active: false }, requested_payload: { active: true }, error_code: "MAGALU_SKU_WRITE_NOT_CONVERGED", error_message: "O PATCH foi aceito, mas o estado remoto não convergiu.", response_status: 202 },
  ], [
    { id: 12, sku: "SKU-3", title: "Mesa", action: "deactivate", status: "stale", batch_label: "Lote 2", before_payload: {}, requested_payload: { active: false } },
  ]]);
  assert.deepEqual(sheet.getRow(1).values.slice(1), ["Lote", "SKU", "Produto", "Ação", "Antes", "Solicitado", "Depois", "Resultado", "Motivo", "Código", "HTTP", "Request ID", "Concluído em"]);
  assert.equal(total, 3);
  assert.deepEqual(calls, [0, 11, 12]);
  assert.equal(sheet.getRow(2).getCell(2).text, "000123");
  assert.equal(sheet.getRow(2).getCell(4).text, "Publicar SKU");
  assert.equal(sheet.getRow(2).getCell(7).text, "Ativo (PUBLISHED)");
  assert.equal(sheet.getRow(2).getCell(8).text, "Sucesso");
  assert.equal(sheet.getRow(3).getCell(8).text, "Reverificar");
  assert.match(sheet.getRow(3).getCell(9).text, /aceitou a alteração.*Detalhe: O PATCH foi aceito/);
  assert.equal(sheet.getRow(3).getCell(10).text, "MAGALU_SKU_WRITE_NOT_CONVERGED");
  assert.equal(sheet.getRow(4).getCell(1).text, "Lote 2");
  assert.equal(sheet.getRow(4).getCell(8).text, "Desatualizado");
});

test("relatório de preços e estoque descreve os valores enviados", async () => {
  const { sheet } = await render("write", [[
    { id: 5, sku: "A", resource_type: "price", status: "failed", before_payload: { price: 199.9, list_price: 249.9 }, requested_payload: { price: 189.9 }, error_message: "Preço abaixo do mínimo." },
  ]]);
  assert.equal(sheet.getRow(2).getCell(4).text, "Atualizar preço");
  assert.match(sheet.getRow(2).getCell(5).text, /preço R\$\s?199,90 · preço cheio R\$\s?249,90/);
  assert.equal(sheet.getRow(2).getCell(8).text, "Falha");
  assert.match(sheet.getRow(2).getCell(9).text, /Preço abaixo do mínimo/);
});

test("endpoint do relatório é restrito à conta e o painel oferece o download", () => {
  const routes = read("src/routes/api.routes.js"), repo = read("src/repositories/processPanelRepository.js"), panel = read("public/js/magalu-process-panel.js");
  assert.match(routes, /router\.get\("\/processes\/:kind\/:id\/report\.xlsx", processPanelController\.report\);/);
  assert.match(repo, /where i\.account_id=\$2 and i\.dach_tenant_id=\$3 and i\.id>\$4 order by i\.id limit \$5/);
  assert.match(repo, /where w\.preview_id=\$1 and w\.account_id=\$2 and w\.dach_tenant_id=\$3/);
  assert.match(panel, /t\.pending \? "Baixar relatório parcial" : "Baixar relatório"/);
  assert.match(panel, /O relatório traz o motivo de cada um\./);
  assert.match(panel, /Reverificar itens \(/);
});
