"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const stateNames = { ready: "Pronto", invalid: "Inválido", divergent: "Divergente", missing: "Não encontrado", unchanged: "Sem alteração", applied: "Aplicado", stale: "SKU alterado", error: "Erro", unverified: "Verificar no ML" };
  let previewId = "";
  let readyCount = 0;
  let pollTimer = null;
  let busy = false;
  let storageKey = "";
  const api = (path) => fetch(`/api/bulk-sku${path}`, { credentials: "same-origin" });

  function notice(message, kind = "info") {
    const element = $("skuNotice");
    element.textContent = message;
    element.dataset.kind = kind;
    element.hidden = !message;
  }
  async function responseJson(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) throw new Error(body.error || `Falha na operação (${response.status}).`);
    return body;
  }
  function cell(row, content, small = "") {
    const td = document.createElement("td");
    td.textContent = String(content ?? "");
    if (small) { const detail = document.createElement("small"); detail.textContent = String(small); td.appendChild(detail); }
    row.appendChild(td);
  }
  function statusCell(row, state, message, warning) {
    const td = document.createElement("td");
    const label = document.createElement("span");
    label.className = "sku-state";
    label.dataset.state = state;
    label.textContent = stateNames[state] || state;
    td.appendChild(label);
    for (const note of [message, warning].filter(Boolean)) { const small = document.createElement("small"); small.textContent = note; td.appendChild(small); }
    row.appendChild(td);
  }
  function renderPreview(preview) {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (storageKey) localStorage.removeItem(storageKey);
    previewId = preview.id;
    readyCount = preview.ready;
    $("confirmCosts").checked = false;
    const body = $("previewRows"); body.replaceChildren();
    for (const item of preview.rows) {
      const row = document.createElement("tr");
      cell(row, item.row_number); cell(row, item.mlb); cell(row, item.nome_variacao || item.id_variacao || "Produto único", item.id_variacao ? `ID ${item.id_variacao}` : "");
      cell(row, item.ean_gtin_atual); cell(row, item.sku_atual); cell(row, item.sku_novo); statusCell(row, item.state, item.message, item.warning);
      body.appendChild(row);
    }
    $("previewSummary").textContent = `${preview.ready} pronto(s) para alteração em ${preview.total} linha(s) preenchida(s). Somente os prontos serão enviados.`;
    $("confirmButton").disabled = true;
    $("previewSection").hidden = false;
    $("jobSection").hidden = true;
  }
  function renderJob(job) {
    const finished = ["finished", "failed"].includes(job.status);
    $("jobSection").hidden = false;
    $("jobStatus").textContent = job.status === "finished" ? `Concluído: ${job.processed_rows} de ${job.total_rows} linha(s) processadas.` : job.status === "failed" ? "O processamento foi interrompido. Baixe o relatório e confira as linhas pendentes." : `Processando: ${job.processed_rows} de ${job.total_rows} linha(s).`;
    $("jobProgress").value = job.total_rows ? Math.round((job.processed_rows / job.total_rows) * 100) : 0;
    const body = $("jobRows"); body.replaceChildren();
    for (const item of job.rows || []) {
      const row = document.createElement("tr");
      cell(row, item.row_number); cell(row, item.mlb); cell(row, item.variation_name || item.variation_id || "Produto único", item.variation_id ? `ID ${item.variation_id}` : "");
      cell(row, item.old_sku); cell(row, item.new_sku); statusCell(row, item.state, item.message, item.warning);
      body.appendChild(row);
    }
    $("downloadReport").href = window.mlUrl(`/api/bulk-sku/jobs/${encodeURIComponent(job.id)}/report.csv`);
    $("downloadReport").hidden = !finished;
    if (finished && pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    return finished;
  }
  async function poll(id) {
    try {
      const body = await responseJson(await api(`/jobs/${encodeURIComponent(id)}`));
      if (!renderJob(body.job)) pollTimer = setTimeout(() => poll(id), 2200);
    } catch (error) { notice(error.message, "error"); pollTimer = setTimeout(() => poll(id), 5000); }
  }
  async function withBusy(button, callback) {
    if (busy) return;
    busy = true; button.disabled = true;
    try { notice(""); await callback(); } catch (error) { notice(error.message, "error"); }
    finally { busy = false; button.disabled = false; }
  }
  $("downloadTemplate").addEventListener("click", () => withBusy($("downloadTemplate"), async () => {
    const response = await api("/export.xlsx");
    if (!response.ok) { await responseJson(response); return; }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a"); link.href = url; link.download = "alteracao-skus.xlsx"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    notice("Planilha exportada. Preencha apenas a coluna SKU novo e importe o arquivo.");
  }));
  $("previewButton").addEventListener("click", () => withBusy($("previewButton"), async () => {
    const file = $("skuFile").files?.[0];
    if (!file || !/\.xlsx$/i.test(file.name)) throw new Error("Selecione uma planilha .xlsx.");
    if (file.size > 10 * 1024 * 1024) throw new Error("A planilha deve ter até 10 MB.");
    const form = new FormData(); form.append("file", file);
    const result = await responseJson(await fetch("/api/bulk-sku/preview", { method: "POST", credentials: "same-origin", body: form }));
    renderPreview(result.preview);
    notice("Confira os resultados por linha. Linhas divergentes ou inválidas não serão enviadas.");
  }));
  $("confirmCosts").addEventListener("change", () => { $("confirmButton").disabled = !readyCount || !$("confirmCosts").checked; });
  $("confirmButton").addEventListener("click", () => withBusy($("confirmButton"), async () => {
    if (!previewId) return;
    const result = await responseJson(await fetch("/api/bulk-sku/jobs", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ previewId }) }));
    $("confirmButton").disabled = true;
    $("previewSection").hidden = true;
    if (storageKey) localStorage.setItem(storageKey, result.job.id);
    notice("Lote enviado. Você pode acompanhar o resultado abaixo.");
    await poll(result.job.id);
  }));
  api("/context").then(responseJson).then(({ account }) => {
    $("accountLabel").textContent = account.label || account.sellerId;
    storageKey = `bulkSku:lastJob:${account.sellerId}`;
    const lastJob = localStorage.getItem(storageKey);
    if (lastJob) poll(lastJob);
  }).catch((error) => { $("accountLabel").textContent = "Conta indisponível"; notice(error.message, "error"); });
})();
