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

// Gerador genérico: colunas [cabeçalho, chave, largura, tipo], páginas por cursor, uma linha por item.
// tipo: "text" (preserva zeros à esquerda), "money", "percent" (valor em %), "date", "int" ou vazio.
async function streamSheet(output, { sheetName = "Resultado", columns, fetchPage, nextCursor, mapRow, firstCursor = 0 }) {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: output, useStyles: true });
  const sheet = workbook.addWorksheet(sheetName);
  const fmt = { text: { numFmt: "@" }, money: { numFmt: '"R$" #,##0.00' }, percent: { numFmt: '0.00"%"' }, date: { numFmt: "dd/mm/yyyy hh:mm" }, int: { numFmt: "0" } };
  sheet.columns = columns.map(([header, key, width, type]) => ({ header, key, width, style: fmt[type] || {} }));
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).commit();
  let cursor = firstCursor, total = 0;
  for (;;) {
    const rows = await fetchPage(cursor);
    if (!rows.length) break;
    for (const item of rows) { sheet.addRow(mapRow(item)).commit(); total += 1; }
    cursor = nextCursor(rows[rows.length - 1]);
  }
  sheet.commit();
  await workbook.commit();
  return total;
}

// Lotes de SKU e alterações de preço/estoque (fetchPage(afterId) -> linhas ordenadas por id).
async function streamReport(output, { resource, fetchPage }) {
  const columns = COLUMNS.map(([header, key, width]) => [header, key, width, key === "sku" || key === "request_id" ? "text" : key === "completed_at" ? "date" : ""]);
  return streamSheet(output, { columns, fetchPage, nextCursor: (row) => Number(row.id), mapRow: (item) => reportRow(item, resource) });
}

const num = (v) => v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
const when = (v) => (v ? new Date(v) : null);

// Sincronização do catálogo: estado de cada SKU depois da execução (vale para a execução mais recente).
const SYNC_COLUMNS = [["SKU", "sku", 22, "text"], ["Produto", "title", 46], ["Status na Magalu", "status", 16], ["Preço", "price", 14, "money"],
  ["Preço cheio", "list_price", 14, "money"], ["Estoque", "quantity", 10, "int"], ["Lido em", "read_at", 18, "date"],
  ["Resultado", "result", 18], ["Motivo", "reason", 70]];
function syncReportRow(item, run) {
  const start = new Date(run.started_at).getTime(), inRun = (v) => v && new Date(v).getTime() >= start;
  const published = String(item.status || "").toUpperCase() === "PUBLISHED";
  const errors = [inRun(item.price_synced_at) && item.price_error ? `Preço: ${item.price_error}` : "", inRun(item.stock_synced_at) && item.stock_error ? `Estoque: ${item.stock_error}` : ""].filter(Boolean);
  let result, reason;
  if (!item.is_present && inRun(item.last_synced_at)) { result = "Removido"; reason = "SKU não encontrado no Portfólio Magalu."; }
  else if (!inRun(item.last_synced_at)) { result = run.status === "running" ? "Pendente" : "Não lido"; reason = run.status === "running" ? "Ainda não lido nesta sincronização." : "O SKU não apareceu nesta sincronização (limite de paginação da Magalu ou SKU removido)."; }
  else if (errors.length) { result = "Falha parcial"; reason = errors.join(" · "); }
  else if (!published) { result = "Lido"; reason = "SKU não publicado: preço e estoque não são consultados para economizar chamadas."; }
  else { result = "Sucesso"; reason = "SKU, preço e estoque atualizados."; }
  return { sku: String(item.sku || ""), title: item.title || "", status: item.status || "", price: num(item.price), list_price: num(item.list_price),
    quantity: num(item.quantity), read_at: when(item.last_synced_at), result, reason };
}

// "Consultar preços Magalu": cada SKU do recorte do job, com o resultado da consulta de preço.
const PROMO_REFRESH_COLUMNS = [["SKU", "sku", 22, "text"], ["EAN", "ean", 16, "text"], ["Produto", "title", 46], ["Preço", "price", 14, "money"],
  ["Preço cheio", "list_price", 14, "money"], ["Consultado em", "synced_at", 18, "date"], ["Resultado", "result", 16], ["Motivo", "reason", 70]];
function promoRefreshRow(item, startedAt) {
  const start = startedAt ? new Date(startedAt).getTime() : 0, inJob = item.price_synced_at && new Date(item.price_synced_at).getTime() >= start;
  let result, reason;
  if (!inJob) { result = "Não consultado"; reason = "O SKU não foi consultado neste processo (processo interrompido ou recorte alterado)."; }
  else if (item.price_error) { result = "Falha"; reason = String(item.price_error); }
  else if (item.price_present === false || num(item.price) == null) { result = "Sem preço"; reason = "A Magalu não retornou preço para este SKU."; }
  else { result = "Atualizado"; reason = "Preço consultado na Magalu."; }
  return { sku: String(item.sku || ""), ean: item.ean || "", title: item.title || "", price: num(item.price), list_price: num(item.list_price),
    synced_at: when(item.price_synced_at), result, reason };
}

// "Calcular preços promocionais": cada SKU da prévia com o preço sugerido ou o motivo da exclusão.
const PROMO_PREVIEW_COLUMNS = [["SKU", "sku", 22, "text"], ["Produto", "title", 46], ["Custo", "cost", 13, "money"], ["Preço cheio", "list_price", 14, "money"],
  ["Preço atual", "price", 14, "money"], ["Imposto (%)", "tax", 11, "percent"], ["Preço sugerido", "suggested", 15, "money"],
  ["Desconto (%)", "discount", 12, "percent"], ["Margem sem Pix (%)", "margin", 16, "percent"], ["Preço Pix", "pix_price", 13, "money"],
  ["Margem no Pix (%)", "pix_margin", 16, "percent"], ["Resultado", "result", 14], ["Motivo", "reason", 70]];
function promoPreviewRow(item) {
  const source = item.source || {}, result = item.result || {};
  const issues = Array.isArray(result.issues) ? result.issues.filter(Boolean) : [];
  return { sku: String(item.sku || ""), title: source.title || "", cost: num(source.unit_cost), list_price: num(source.list_price), price: num(source.price),
    tax: num(source.tax_rate), suggested: num(item.price_override) ?? num(result.suggested_price), discount: num(result.discount_pct),
    margin: num(result.estimated_margin), pix_price: num(result.pix_price), pix_margin: num(result.pix_margin),
    result: result.eligible ? "Elegível" : "Excluído", reason: result.eligible ? (item.price_override != null ? "Preço ajustado manualmente na revisão." : "Preço sugerido atende às margens.") : (issues.join(" · ") || "Não atende às margens informadas.") };
}

module.exports = { streamReport, streamSheet, reportRow, describe, RESULT, COLUMNS,
  SYNC_COLUMNS, syncReportRow, PROMO_REFRESH_COLUMNS, promoRefreshRow, PROMO_PREVIEW_COLUMNS, promoPreviewRow };
