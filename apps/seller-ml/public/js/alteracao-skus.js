"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const stateNames = { ready: "Pronto", invalid: "Inválido", divergent: "Divergente", missing: "Não encontrado", unchanged: "Sem alteração", applied: "Aplicado", stale: "SKU alterado", error: "Erro", unverified: "Verificar no ML" };
  let previewId = "";
  let readyCount = 0;
  let pollTimer = null;
  let busy = false;
  let storageKey = "";
  let previewOffset = 0;
  let previewTotal = 0;
  let currentExportId = "";
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
  function renderPreview(preview, append = false) {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (!append && storageKey) localStorage.removeItem(storageKey);
    previewId = preview.id;
    readyCount = Number(preview.ready_rows || preview.ready || 0);
    previewTotal = Number(preview.previewed_rows || preview.total || 0);
    if (!append) $("confirmCosts").checked = false;
    const body = $("previewRows"); if (!append) body.replaceChildren();
    for (const item of preview.rows) {
      const row = document.createElement("tr");
      cell(row, item.row_number); cell(row, item.mlb); cell(row, item.variation_name || item.nome_variacao || item.variation_id || item.id_variacao || "Produto único", item.variation_id || item.id_variacao ? `ID ${item.variation_id || item.id_variacao}` : "");
      cell(row, item.ean_snapshot ?? item.ean_gtin_atual); cell(row, item.old_sku ?? item.sku_atual); cell(row, item.new_sku ?? item.sku_novo); statusCell(row, item.state, item.message, item.warning);
      body.appendChild(row);
    }
    previewOffset += preview.rows.length;
    $("morePreviewRows").hidden = preview.rows.length < 100;
    $("previewSummary").textContent = `${readyCount} pronto(s) em ${previewTotal} linha(s) conferida(s). Exibindo ${previewOffset} linha(s); somente os prontos serão enviados.`;
    $("confirmButton").disabled = !readyCount || !$("confirmCosts").checked;
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
  async function syncPanel() {
    try {
      const result = await responseJson(await api("/jobs"));
      window.JobsPanel?.setAdapter?.("bulk-sku");
      window.JobsPanel?.setVisibilityFilter?.((job) => String(job?.adapter || "") === "bulk-sku");
      window.JobsPanel?.mergeApiJobs?.(result.jobs, { adapter: "bulk-sku" });
      if (result.jobs.length) window.JobsPanel?.show?.();
    } catch (error) { notice(error.message, "error"); }
  }
  async function pollExport(id) {
    try {
      const { job } = await responseJson(await api(`/exports/${encodeURIComponent(id)}`));
      await syncPanel();
      if (job.status === "finished") { notice(`Planilha pronta: ${job.exported_rows} SKU(s). Baixe-a no painel de jobs.`); return; }
      if (job.status === "failed") { notice(job.error_message || "Falha na exportação.", "error"); return; }
      notice(`Exportando anúncios: ${job.scanned_items} anúncio(s) localizados.`);
      setTimeout(() => pollExport(id), 2500);
    } catch (error) { notice(error.message, "error"); }
  }
  async function pollPreview(id) {
    try {
      const { job } = await responseJson(await api(`/jobs/${encodeURIComponent(id)}`));
      await syncPanel();
      if (job.status === "preview") { previewOffset = 0; renderPreview(job); notice("Conferência concluída. Revise as linhas antes de aplicar."); return; }
      if (job.status === "failed") { notice(job.error_message || "Falha na conferência.", "error"); return; }
      notice(`Conferindo planilha: ${job.previewed_rows || 0} linha(s) verificadas.`);
      setTimeout(() => pollPreview(id), 2500);
    } catch (error) { notice(error.message, "error"); }
  }
  async function withBusy(button, callback) {
    if (busy) return;
    busy = true; button.disabled = true;
    try { notice(""); await callback(); } catch (error) { notice(error.message, "error"); }
    finally { busy = false; button.disabled = false; }
  }
  $("downloadTemplate").addEventListener("click", () => withBusy($("downloadTemplate"), async () => {
    const { job } = await responseJson(await fetch("/api/bulk-sku/exports", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: $("exportStatus").value }) }));
    currentExportId = job.id;
    if (storageKey) localStorage.setItem(`${storageKey}:export`, currentExportId);
    notice("Exportação iniciada. Acompanhe e baixe a planilha no painel de jobs.");
    await syncPanel();
    pollExport(currentExportId);
  }));
  $("previewButton").addEventListener("click", () => withBusy($("previewButton"), async () => {
    const file = $("skuFile").files?.[0];
    if (!file || !/\.xlsx$/i.test(file.name)) throw new Error("Selecione uma planilha .xlsx.");
    if (file.size > 100 * 1024 * 1024) throw new Error("A planilha deve ter até 100 MB.");
    const form = new FormData(); form.append("file", file);
    const result = await responseJson(await fetch("/api/bulk-sku/preview", { method: "POST", credentials: "same-origin", body: form }));
    previewId = result.job.id;
    if (storageKey) localStorage.setItem(`${storageKey}:preview`, previewId);
    notice("Conferência iniciada. Acompanhe o progresso no painel de jobs.");
    await syncPanel();
    pollPreview(previewId);
  }));
  $("morePreviewRows").addEventListener("click", async () => {
    try {
      const { job } = await responseJson(await api(`/jobs/${encodeURIComponent(previewId)}?offset=${previewOffset}&limit=100`));
      renderPreview(job, true);
    } catch (error) { notice(error.message, "error"); }
  });
  $("confirmCosts").addEventListener("change", () => { $("confirmButton").disabled = !readyCount || !$("confirmCosts").checked; });
  $("confirmButton").addEventListener("click", () => withBusy($("confirmButton"), async () => {
    if (!previewId) return;
    const result = await responseJson(await fetch("/api/bulk-sku/jobs", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ previewId }) }));
    $("confirmButton").disabled = true;
    $("previewSection").hidden = true;
    if (storageKey) localStorage.setItem(storageKey, result.job.id);
    if (storageKey) localStorage.removeItem(`${storageKey}:preview`);
    notice("Lote enviado. Você pode acompanhar o resultado abaixo.");
    await poll(result.job.id);
    await syncPanel();
  }));
  api("/context").then(responseJson).then(({ account }) => {
    storageKey = `bulkSku:lastJob:${account.sellerId}`;
    const lastJob = localStorage.getItem(storageKey);
    if (lastJob) poll(lastJob);
    const lastPreview = localStorage.getItem(`${storageKey}:preview`);
    if (lastPreview) pollPreview(lastPreview);
    const lastExport = localStorage.getItem(`${storageKey}:export`);
    if (lastExport) pollExport(lastExport);
  }).catch((error) => { notice(error.message, "error"); });
  window.addEventListener("load", () => { syncPanel(); setInterval(syncPanel, 5000); });
})();
