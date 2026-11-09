"use strict";
// Relatório XLSX de um processo do painel (lotes de SKU e alterações de preço/estoque):
// uma linha por SKU com o resultado final e o motivo, no padrão do relatório de jobs do ML.
const ExcelJS = require("exceljs");

const RESULT = {
  succeeded: ["Sucesso", "Alteração confirmada na Magalu."],
  failed: ["Falha", "A Magalu recusou a alteração."],
  stale: ["Desatualizado", "O SKU mudou na Magalu depois da revisão; a alteração não foi enviada."],
  divergent: ["Reverificar", "A Magalu aceitou a alteração, mas o SKU ainda não aparece com o novo estado. Use Reverificar mais tarde."],
  uncertain: ["Reverificar", "Não foi possível confirmar se a Magalu aplicou a alteração. Use Reverificar antes de tentar de novo."],
  canceled: ["Cancelado", "Item cancelado antes do envio."],
  queued: ["Pendente", "Aguardando processamento."],
  running: ["Pendente", "Em processamento."],
  dispatching: ["Pendente", "Enviando para a Magalu."],
  accepted: ["Pendente", "Aceito pela Magalu; aguardando confirmação."],
};
const ACTION = { activate: "Publicar SKU", deactivate: "Despublicar SKU", price: "Atualizar preço", stock: "Atualizar estoque" };

function describe(payload, resource) {
  const p = payload && typeof payload === "object" ? payload : {};
  if (resource === "sku") {
    if (typeof p.active === "boolean") return `${p.active ? "Ativo" : "Inativo"}${p.status ? ` (${p.status})` : ""}`;
    return p.status ? String(p.status) : "";
  }
  const money = (v) => v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const parts = [];
  if (money(p.price) != null) parts.push(`preço ${money(p.price)}`);
  if (money(p.list_price) != null) parts.push(`preço cheio ${money(p.list_price)}`);
  if (p.quantity != null && Number.isFinite(Number(p.quantity))) parts.push(`estoque ${Number(p.quantity)}`);
  return parts.length ? parts.join(" · ") : (Object.keys(p).length ? JSON.stringify(p).slice(0, 300) : "");
}

function reportRow(item, resource) {
  const [result, defaultReason] = RESULT[item.status] || [String(item.status || ""), ""];
  return {
    batch: item.batch_label || "",
    sku: String(item.sku || ""),
    title: item.title || "",
    action: ACTION[item.action] || ACTION[item.resource_type] || String(item.action || item.resource_type || ""),
    before: describe(item.before_payload, resource),
    requested: describe(item.requested_payload, resource),
    after: describe(item.after_payload, resource),
    result,
    reason: item.status === "succeeded" ? defaultReason : (defaultReason + (item.error_message ? ` Detalhe: ${item.error_message}` : "")).trim(),
    code: item.error_code || "",
    http: item.response_status == null ? "" : Number(item.response_status),
    request_id: item.request_id || "",
    completed_at: item.completed_at ? new Date(item.completed_at) : null,
  };
}

const COLUMNS = [
  ["Lote", "batch", 14], ["SKU", "sku", 22], ["Produto", "title", 46], ["Ação", "action", 18],
  ["Antes", "before", 24], ["Solicitado", "requested", 24], ["Depois", "after", 24],
  ["Resultado", "result", 14], ["Motivo", "reason", 70], ["Código", "code", 30],
  ["HTTP", "http", 8], ["Request ID", "request_id", 38], ["Concluído em", "completed_at", 18],
];

// Escreve o XLSX direto na resposta, página a página (fetchPage(afterId) -> linhas ordenadas por id).
async function streamReport(output, { resource, fetchPage }) {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: output, useStyles: true });
  const sheet = workbook.addWorksheet("Resultado");
  sheet.columns = COLUMNS.map(([header, key, width]) => ({ header, key, width,
    style: key === "sku" || key === "request_id" ? { numFmt: "@" } : key === "completed_at" ? { numFmt: "dd/mm/yyyy hh:mm" } : {} }));
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).commit();
  let afterId = 0, total = 0;
  for (;;) {
    const rows = await fetchPage(afterId);
    if (!rows.length) break;
    for (const item of rows) { sheet.addRow(reportRow(item, resource)).commit(); total += 1; }
    afterId = Number(rows[rows.length - 1].id);
  }
  sheet.commit();
  await workbook.commit();
  return total;
}

module.exports = { streamReport, reportRow, describe, RESULT, COLUMNS };
