"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const PAGE_SIZE = 50;
  const state = {
    workspace: "analysis",
    rows: [],
    filtered: [],
    selected: new Set(),
    page: 1,
    search: "",
    filter: "all",
    loading: false,
    source: null,
    lastPreview: null,
    currentJobId: null,
    jobsTimer: null,
    jobsPanelTimer: null,
    jobSubmitting: false,
    lastJobDetail: null,
  };

  function api(path) {
    if (window.ML?.url) return window.ML.url(path);
    if (typeof window.withBase === "function") return window.withBase(path);
    return path;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    }[ch]));
  }

  function toInt(value, fallback = null) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.trunc(n);
  }

  function fmtNum(value) {
    return new Intl.NumberFormat("pt-BR").format(Number(value || 0));
  }

  function fmtStock(value) {
    const n = Number(value);
    return Number.isFinite(n) ? fmtNum(n) : "-";
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  function setFeedback(text, tone = "") {
    const el = $("stockUpdateFeedback");
    if (!el) return;
    el.textContent = text || "";
    if (tone) el.dataset.tone = tone;
    else el.removeAttribute("data-tone");
  }

  function setLoadBadge(text, tone = "neutral") {
    const badge = $("stockLoadBadge");
    if (!badge) return;
    badge.textContent = text;
    badge.dataset.tone = tone;
  }

  function showLoading(message) {
    state.loading = true;
    window.MLLoadingOverlay?.show?.({
      context: "Estoque",
      label: "Carregando anúncios",
      message,
      texts: [
        message,
        "Consultando anúncios e variações da conta...",
        "Conferindo estoque atual no Mercado Livre...",
      ],
      initialProgress: 14,
      maxProgress: 90,
    });
    ["btnStockLoadActive", "btnStockLoadSpecific", "btnStockReviewChanges"].forEach((id) => {
      const button = $(id);
      if (button) button.disabled = true;
    });
  }

  function hideLoading() {
    state.loading = false;
    window.MLLoadingOverlay?.hide?.();
    updateControls();
  }

  async function fetchJson(path, options = {}) {
    const response = await fetch(api(path), {
      credentials: "include",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      ...options,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.error || `Falha HTTP ${response.status}`);
    }
    return payload;
  }

  function currentPathWithoutHash() {
    return `${window.location.pathname}${window.location.search || ""}`;
  }

  function setWorkspace(value, { syncHash = true } = {}) {
    const workspace = value === "update" ? "update" : "analysis";
    state.workspace = workspace;

    document.querySelectorAll("[data-stock-workspace-tab]").forEach((button) => {
      const active = button.dataset.stockWorkspaceTab === workspace;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });

    document.querySelectorAll("[data-stock-workspace-view]").forEach((panel) => {
      panel.hidden = panel.dataset.stockWorkspaceView !== workspace;
    });

    document.querySelectorAll("[data-stock-analysis-only]").forEach((node) => {
      node.hidden = workspace !== "analysis";
    });

    if (syncHash && window.history?.replaceState) {
      const hash = workspace === "update" ? "#atualizar-estoque" : "#analise-estoque";
      window.history.replaceState(null, "", `${currentPathWithoutHash()}${hash}`);
    }
  }

  function rowIsChanged(row) {
    const next = toInt(row?.new_stock, null);
    const current = toInt(row?.current_stock, 0);
    return next != null && next >= 0 && next !== current;
  }

  function normalizeLoadedRows(rows = []) {
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      ...row,
      row_key: String(row.row_key || `${row.mlb}:${row.variation_id || "item"}`),
      current_stock: Math.max(0, toInt(row.current_stock, 0)),
      new_stock: Math.max(0, toInt(row.current_stock, 0)),
    }));
  }

  function matchesSearch(row, query) {
    const needle = String(query || "").trim().toUpperCase();
    if (!needle) return true;
    return [
      row.mlb,
      row.title,
      row.sku,
      row.variation_label,
      row.variation_id,
    ].some((value) => String(value || "").toUpperCase().includes(needle));
  }

  function matchesFilter(row, filter) {
    const stock = Number(row.current_stock || 0);
    switch (filter) {
      case "zero":
        return stock <= 0;
      case "low":
        return stock > 0 && stock <= 5;
      case "positive":
        return stock > 0;
      case "changed":
        return rowIsChanged(row);
      case "all":
      default:
        return true;
    }
  }

  function applyFilters({ resetPage = false } = {}) {
    if (resetPage) state.page = 1;
    state.filtered = state.rows.filter(
      (row) => matchesSearch(row, state.search) && matchesFilter(row, state.filter),
    );
    const pageCount = Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));
    state.page = Math.min(state.page, pageCount);
    renderAll();
  }

  function pageRows() {
    const start = (state.page - 1) * PAGE_SIZE;
    return state.filtered.slice(start, start + PAGE_SIZE);
  }

  function selectedRows({ changedOnly = false } = {}) {
    return state.rows.filter((row) => {
      if (!state.selected.has(row.row_key)) return false;
      return changedOnly ? rowIsChanged(row) : true;
    });
  }

  function changedRows() {
    return state.rows.filter(rowIsChanged);
  }

  function updateStats() {
    const zero = state.rows.filter((row) => Number(row.current_stock || 0) <= 0).length;
    const changed = changedRows().length;
    const selected = selectedRows().length;
    setText("stockStatLoaded", fmtNum(state.rows.length));
    setText("stockStatZero", fmtNum(zero));
    setText("stockStatChanged", fmtNum(changed));
    setText("stockStatSelected", fmtNum(selected));

    const actionbar = $("stockUpdateActionbar");
    if (actionbar) actionbar.hidden = selected <= 0 && changed <= 0;
    setText(
      "stockActionbarTitle",
      `${fmtNum(selected)} ${selected === 1 ? "selecionado" : "selecionados"}`,
    );
    setText(
      "stockActionbarSubtitle",
      changed > 0
        ? `${fmtNum(changed)} ${changed === 1 ? "linha com alteração preparada" : "linhas com alterações preparadas"}.`
        : "Selecione anúncios e informe o novo estoque.",
    );
  }

  function updateControls() {
    const hasRows = state.rows.length > 0;
    const hasSelection = selectedRows().length > 0;
    const hasSelectedChanges = selectedRows({ changedOnly: true }).length > 0;

    const loadActive = $("btnStockLoadActive");
    const loadSpecific = $("btnStockLoadSpecific");
    if (loadActive) loadActive.disabled = state.loading;
    if (loadSpecific) loadSpecific.disabled = state.loading;

    const bulk = $("btnStockApplyBulk");
    if (bulk) bulk.disabled = state.loading || !hasSelection;
    const selectFiltered = $("btnStockSelectFiltered");
    if (selectFiltered) selectFiltered.disabled = state.loading || !state.filtered.length;
    const clearSelection = $("btnStockClearSelection");
    if (clearSelection) clearSelection.disabled = state.loading || !state.selected.size;
    const review = $("btnStockReviewChanges");
    if (review) review.disabled = state.loading || state.jobSubmitting || !hasSelectedChanges;
    const confirm = $("btnStockConfirmUpdate");
    if (confirm) {
      const ready = Number(state.lastPreview?.summary?.ready || 0);
      confirm.disabled = state.loading || state.jobSubmitting || ready <= 0 || state.lastPreview?.write_enabled === false;
    }
    const reset = $("btnStockResetChanges");
    if (reset) reset.disabled = state.loading || !changedRows().length;

    const checkPage = $("stockCheckPage");
    if (checkPage) {
      const visible = pageRows();
      const selectedVisible = visible.filter((row) => state.selected.has(row.row_key));
      checkPage.disabled = !hasRows || !visible.length;
      checkPage.checked = Boolean(visible.length && selectedVisible.length === visible.length);
      checkPage.indeterminate = Boolean(
        selectedVisible.length > 0 && selectedVisible.length < visible.length,
      );
    }
  }

  function typeLabel(row = {}) {
    return row.target_type === "variation" ? "Variação" : "Simples";
  }

  function renderTable() {
    const body = $("stockUpdateTableBody");
    if (!body) return;

    const rows = pageRows();
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="7" class="stock-update-empty">${state.rows.length ? "Nenhum anúncio encontrado para o filtro atual." : "Carregue anúncios para começar."}</td></tr>`;
      setText("stockTableInfo", `${fmtNum(state.filtered.length)} resultados`);
      return;
    }

    body.innerHTML = rows.map((row) => {
      const selected = state.selected.has(row.row_key);
      const changed = rowIsChanged(row);
      const title = escapeHtml(row.title || row.mlb || "Produto");
      const mlb = escapeHtml(row.mlb || "-");
      const sku = escapeHtml(row.sku || "Sem SKU");
      const variation = row.variation_label
        ? escapeHtml(row.variation_label)
        : row.variation_id
          ? `Variação ${escapeHtml(row.variation_id)}`
          : "Anúncio simples";
      const href = row.permalink ? escapeHtml(row.permalink) : "";
      const mlbMarkup = href
        ? `<a class="stock-mlb-link" href="${href}" target="_blank" rel="noopener noreferrer">${mlb}</a>`
        : `<span class="stock-mlb-link">${mlb}</span>`;
      return `
        <tr class="${selected ? "is-selected" : ""} ${changed ? "is-changed" : ""}" data-stock-row="${escapeHtml(row.row_key)}">
          <td class="stock-update-check">
            <input type="checkbox" data-stock-select="${escapeHtml(row.row_key)}" ${selected ? "checked" : ""} aria-label="Selecionar ${mlb}" />
          </td>
          <td>${mlbMarkup}</td>
          <td class="stock-product-cell"><strong>${title}</strong><small>${escapeHtml(row.item_status || "-")}</small></td>
          <td class="stock-sku-cell"><strong>${sku}</strong><small>${variation}</small></td>
          <td><span class="stock-current-value">${fmtNum(row.current_stock)}</span></td>
          <td>
            <input class="stock-row-stock-input" type="number" min="0" step="1" inputmode="numeric" value="${escapeHtml(row.new_stock)}" data-stock-new="${escapeHtml(row.row_key)}" aria-label="Novo estoque de ${mlb}" />
          </td>
          <td><span class="stock-type-pill" data-type="${escapeHtml(row.target_type || "item")}">${typeLabel(row)}</span></td>
        </tr>
      `;
    }).join("");

    const start = (state.page - 1) * PAGE_SIZE + 1;
    const end = Math.min(state.page * PAGE_SIZE, state.filtered.length);
    setText(
      "stockTableInfo",
      `${fmtNum(start)}–${fmtNum(end)} de ${fmtNum(state.filtered.length)} resultados`,
    );
  }

  function renderPagination() {
    const slot = $("stockPagination");
    if (!slot) return;
    const pages = Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));
    if (pages <= 1) {
      slot.innerHTML = "";
      return;
    }

    const wanted = new Set([1, pages, state.page - 1, state.page, state.page + 1]);
    const pageNumbers = Array.from(wanted)
      .filter((page) => page >= 1 && page <= pages)
      .sort((a, b) => a - b);
    const html = [];
    let previous = 0;
    for (const page of pageNumbers) {
      if (previous && page - previous > 1) html.push(`<span>…</span>`);
      html.push(
        `<button type="button" data-stock-page="${page}" class="${page === state.page ? "is-active" : ""}">${page}</button>`,
      );
      previous = page;
    }
    slot.innerHTML = html.join("");
  }

  function renderAll() {
    renderTable();
    renderPagination();
    updateStats();
    updateControls();
  }

  function buildLoadSummary(payload = {}) {
    const summary = payload.summary || {};
    const rows = Number(summary.rows ?? payload.total ?? 0);
    const items = Number(summary.items || 0);
    const variations = Number(summary.variations || 0);
    const missing = Number(payload?.meta?.missing_or_foreign_items || 0);
    const parts = [
      `${fmtNum(rows)} ${rows === 1 ? "linha carregada" : "linhas carregadas"}`,
      `${fmtNum(items)} MLB${items === 1 ? "" : "s"}`,
    ];
    if (variations > 0) parts.push(`${fmtNum(variations)} variações`);
    if (missing > 0) parts.push(`${fmtNum(missing)} não localizado(s)`);
    return parts.join(" · ");
  }

  async function loadRows(source) {
    if (state.loading) return;
    const manual = source === "manual";
    const query = manual ? String($("stockSpecificInput")?.value || "").trim() : "";
    if (manual && !query) {
      setFeedback("Informe ao menos um MLB ou SKU para carregar a lista.", "error");
      $("stockSpecificInput")?.focus();
      return;
    }

    showLoading(
      manual
        ? "Localizando os MLBs e SKUs informados..."
        : "Carregando todos os anúncios ativos da conta...",
    );
    setLoadBadge("Carregando", "loading");
    setFeedback("");

    try {
      const payload = await fetchJson("/api/estoque/atualizacao/carregar", {
        method: "POST",
        body: JSON.stringify({ source, query }),
      });
      state.rows = normalizeLoadedRows(payload.rows);
      state.filtered = [...state.rows];
      state.selected.clear();
      state.page = 1;
      state.source = source;
      state.lastPreview = null;
      state.search = "";
      state.filter = "all";
      if ($("stockSearchInput")) $("stockSearchInput").value = "";
      if ($("stockFilterSelect")) $("stockFilterSelect").value = "all";

      const summary = buildLoadSummary(payload);
      setLoadBadge(`${fmtNum(state.rows.length)} carregados`, state.rows.length ? "success" : "warning");
      setFeedback(summary, state.rows.length ? "ok" : "");
      if (manual && payload?.meta?.requested_skus?.length) {
        setText(
          "stockSpecificHint",
          `${summary}. SKUs são resolvidos somente dentro dos anúncios ativos da conta.`,
        );
      } else if (manual) {
        setText("stockSpecificHint", summary);
      }
      applyFilters();
    } catch (error) {
      setLoadBadge("Falha na carga", "warning");
      setFeedback(error.message || "Falha ao carregar anúncios.", "error");
    } finally {
      hideLoading();
    }
  }

  function applyBulkValue() {
    const value = toInt($("stockBulkValue")?.value, null);
    if (value == null || value < 0) {
      setFeedback("Informe um estoque inteiro maior ou igual a zero.", "error");
      $("stockBulkValue")?.focus();
      return;
    }

    const selected = selectedRows();
    if (!selected.length) {
      setFeedback("Selecione ao menos uma linha antes de preencher o estoque em massa.", "error");
      return;
    }

    selected.forEach((row) => {
      row.new_stock = value;
    });
    state.lastPreview = null;
    setFeedback(
      `Novo estoque ${fmtNum(value)} preparado para ${fmtNum(selected.length)} ${selected.length === 1 ? "linha" : "linhas"}.`,
      "ok",
    );
    applyFilters();
  }

  function setRowStock(key, value) {
    const row = state.rows.find((item) => item.row_key === key);
    if (!row) return;
    const parsed = toInt(value, null);
    if (parsed == null || parsed < 0) return;
    row.new_stock = parsed;
    state.selected.add(row.row_key);
    state.lastPreview = null;

    const tr = document.querySelector(`[data-stock-row="${CSS.escape(row.row_key)}"]`);
    if (tr) {
      tr.classList.add("is-selected");
      tr.classList.toggle("is-changed", rowIsChanged(row));
      const checkbox = tr.querySelector(`[data-stock-select="${CSS.escape(row.row_key)}"]`);
      if (checkbox) checkbox.checked = true;
    }

    if (state.filter === "changed") {
      applyFilters({ resetPage: false });
      return;
    }
    updateStats();
    updateControls();
  }

  function setRowSelected(key, checked) {
    if (checked) state.selected.add(key);
    else state.selected.delete(key);
    renderAll();
  }

  function selectPage(checked) {
    pageRows().forEach((row) => {
      if (checked) state.selected.add(row.row_key);
      else state.selected.delete(row.row_key);
    });
    renderAll();
  }

  function selectFiltered() {
    state.filtered.forEach((row) => state.selected.add(row.row_key));
    renderAll();
    setFeedback(`${fmtNum(state.filtered.length)} linhas filtradas selecionadas.`, "ok");
  }

  function clearSelection() {
    state.selected.clear();
    renderAll();
  }

  function resetChanges() {
    state.rows.forEach((row) => {
      row.new_stock = row.current_stock;
    });
    state.selected.clear();
    state.lastPreview = null;
    renderAll();
    setFeedback("Alterações locais desfeitas.", "ok");
  }

  function openReviewModal() {
    const modal = $("stockReviewModal");
    if (!modal) return;
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
  }

  function closeReviewModal() {
    const modal = $("stockReviewModal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  }

  function previewStatusLabel(status) {
    const labels = {
      ready: "Pronto",
      stale: "Estoque mudou",
      unchanged: "Sem alteração",
      blocked: "Bloqueado",
      blocked_multi_origin: "Multi-origem",
      blocked_fulfillment: "Full",
      blocked_capability: "Validação pendente",
      blocked_up_conflict: "Conflito de UP",
      invalid: "Inválido",
      not_found: "Não localizado",
    };
    return labels[status] || status || "-";
  }

  function renderPreview(payload = {}) {
    const summary = payload.summary || {};
    const summarySlot = $("stockReviewSummary");
    const rowsSlot = $("stockReviewRows");
    if (summarySlot) {
      summarySlot.innerHTML = `
        <article><strong>${fmtNum(summary.total || 0)}</strong><span>revisados</span></article>
        <article><strong>${fmtNum(summary.ready || 0)}</strong><span>prontos</span></article>
        <article><strong>${fmtNum(summary.stale || 0)}</strong><span>mudaram desde a carga</span></article>
        <article><strong>${fmtNum((summary.blocked || 0) + (summary.invalid || 0) + (summary.not_found || 0))}</strong><span>com bloqueio</span></article>
      `;
    }

    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    if (rowsSlot) {
      rowsSlot.innerHTML = rows.length
        ? rows.map((row) => `
            <article class="stock-review-row">
              <div class="stock-review-row__main">
                <strong>${escapeHtml(row.title || row.mlb || "Produto")}</strong>
                <small>${escapeHtml(row.mlb || "-")} · ${escapeHtml(row.sku || row.variation_label || "Sem SKU")}</small>
              </div>
              <div class="stock-review-row__change">
                <strong>${fmtNum(row.actual_current_stock ?? row.expected_current_stock ?? 0)} → ${fmtNum(row.new_stock ?? 0)}</strong>
                <small>${escapeHtml(row.message || "")}</small>
              </div>
              <span class="stock-preview-status" data-status="${escapeHtml(row.status || "")}">${escapeHtml(previewStatusLabel(row.status))}</span>
            </article>
          `).join("")
        : `<article class="inventory-empty">Nenhuma alteração retornada para revisão.</article>`;
    }
    const confirm = $("btnStockConfirmUpdate");
    if (confirm) {
      confirm.disabled = state.loading || state.jobSubmitting || Number(summary.ready || 0) <= 0 || payload.write_enabled === false;
      confirm.textContent = Number(summary.ready || 0) > 0
        ? `Confirmar ${fmtNum(summary.ready)} ${Number(summary.ready || 0) === 1 ? "alteração" : "alterações"}`
        : "Confirmar atualização";
    }

    setText(
      "stockReviewModalSubtitle",
      payload.multi_origin === true
        ? "A conta usa estoque multi-origem. As linhas ficam bloqueadas para evitar sobrescrever depósitos."
        : summary.ready > 0
          ? `${fmtNum(summary.ready)} ${summary.ready === 1 ? "alteração está pronta" : "alterações estão prontas"} para envio ao worker.`
          : "Nenhuma alteração está pronta para envio neste momento.",
    );
  }

  async function reviewChanges() {
    const rows = selectedRows({ changedOnly: true });
    if (!rows.length) {
      setFeedback("Selecione ao menos uma linha com estoque alterado para revisar.", "error");
      return;
    }

    showLoading(`Revalidando ${rows.length} alteração(ões) com o Mercado Livre...`);
    setFeedback("");
    try {
      const payload = await fetchJson("/api/estoque/atualizacao/preview", {
        method: "POST",
        body: JSON.stringify({
          changes: rows.map((row) => ({
            row_key: row.row_key,
            mlb: row.mlb,
            variation_id: row.variation_id || null,
            current_stock: row.current_stock,
            expected_current_stock: row.current_stock,
            new_stock: row.new_stock,
          })),
        }),
      });
      state.lastPreview = payload;
      renderPreview(payload);
      openReviewModal();
      const ready = Number(payload?.summary?.ready || 0);
      const stale = Number(payload?.summary?.stale || 0);
      setFeedback(
        stale > 0
          ? `${fmtNum(ready)} prontos e ${fmtNum(stale)} com estoque alterado desde o carregamento.`
          : `${fmtNum(ready)} alterações validadas para revisão final.`,
        stale > 0 ? "error" : "ok",
      );
    } catch (error) {
      setFeedback(error.message || "Falha ao revisar alterações.", "error");
    } finally {
      hideLoading();
    }
  }

  function normalizePanelText(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function looksLikeStockUpdateJob(job) {
    const adapter = normalizePanelText(job?.adapter || job?.module || "");
    const id = normalizePanelText(job?.job_uid || job?.id || "");
    const title = normalizePanelText(job?.title || "");
    return (
      adapter === "estoque-atualizacao" ||
      id.startsWith("estoque-atualizacao:") ||
      title.includes("estoque - atualizar") ||
      title.includes("estoque - nova tentativa")
    );
  }

  function configureJobsPanel() {
    window.JobsPanel?.setAdapter?.("estoque-atualizacao");
    window.JobsPanel?.setVisibilityFilter?.((job) => looksLikeStockUpdateJob(job));
    window.JobsPanel?.setCancelHandler?.(cancelJobFromPanel);
  }

  function jobIsTerminal(job = {}) {
    if (job.completed === true) return true;
    const stateText = normalizePanelText(job.state || job.status || "");
    return /conclu|finaliz|completed|cancel|failed|falh|erro/.test(stateText);
  }

  function setJobSummary(text, tone = "neutral") {
    const el = $("stockJobSummary");
    if (!el) return;
    el.textContent = text || "";
    el.dataset.tone = tone || "neutral";
  }

  function jobStatusLabel(status) {
    const map = {
      applied: "Atualizado",
      unchanged: "Sem alteração",
      stale: "Estoque mudou",
      blocked: "Bloqueado",
      blocked_multi_origin: "Multi-origem",
      blocked_fulfillment: "Full",
      blocked_up_conflict: "Conflito de UP",
      divergent: "Divergência",
      error: "Erro",
      invalid: "Inválido",
      not_found: "Não localizado",
      canceled: "Cancelado",
    };
    return map[status] || status || "-";
  }

  function renderJobResults(rows = []) {
    const slot = $("stockJobResults");
    if (!slot) return;
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      slot.innerHTML = '<article class="inventory-empty">Nenhum detalhe disponível para este job.</article>';
      return;
    }

    slot.innerHTML = list.map((row) => {
      const before = row.actual_current_stock ?? row.expected_current_stock ?? "-";
      const requested = row.requested_stock ?? "-";
      const confirmed = row.confirmed_stock;
      const confirmedText = confirmed == null ? "não confirmado" : fmtNum(confirmed);
      return `
        <article class="stock-job-result" data-status="${escapeHtml(row.status || "")}">
          <div class="stock-job-result__main">
            <strong>${escapeHtml(row.title || row.mlb || "Produto")}</strong>
            <small>${escapeHtml(row.mlb || "-")} · ${escapeHtml(row.sku || row.variation_label || "Sem SKU")}</small>
          </div>
          <div class="stock-job-result__numbers">
            <strong>${fmtStock(before)} → ${fmtStock(requested)}</strong>
            <small>confirmado: ${escapeHtml(confirmedText)}</small>
          </div>
          <div class="stock-job-result__status">
            <span>${escapeHtml(jobStatusLabel(row.status))}</span>
            <small>${escapeHtml(row.message || "")}</small>
          </div>
        </article>
      `;
    }).join("");
  }

  function updateLocalRowsFromJob(rows = []) {
    const byKey = new Map(state.rows.map((row) => [row.row_key, row]));
    for (const result of Array.isArray(rows) ? rows : []) {
      const key = String(result.row_key || `${result.mlb}:${result.variation_id || "item"}`);
      const local = byKey.get(key);
      if (!local) continue;

      if (result.status === "applied" && Number.isFinite(Number(result.confirmed_stock))) {
        const confirmed = Math.max(0, toInt(result.confirmed_stock, 0));
        local.current_stock = confirmed;
        local.new_stock = confirmed;
        state.selected.delete(local.row_key);
      } else if (result.status === "stale" && Number.isFinite(Number(result.actual_current_stock))) {
        local.current_stock = Math.max(0, toInt(result.actual_current_stock, 0));
        local.new_stock = toInt(result.requested_stock, local.new_stock);
        state.selected.add(local.row_key);
      } else if (result.status === "divergent" && Number.isFinite(Number(result.confirmed_stock))) {
        local.current_stock = Math.max(0, toInt(result.confirmed_stock, 0));
        local.new_stock = toInt(result.requested_stock, local.new_stock);
        state.selected.add(local.row_key);
      }
    }
    applyFilters({ resetPage: false });
  }

  function renderJobDetail(job = {}) {
    state.lastJobDetail = job;
    const summary = job.summary || job.result?.summary || {};
    const total = Number(summary.total ?? job.total ?? 0);
    const processed = Number(summary.processed ?? job.processed ?? 0);
    const applied = Number(summary.applied ?? job.applied ?? 0);
    const blocked = Number(summary.blocked ?? job.blocked ?? 0);
    const stale = Number(summary.stale ?? job.stale ?? 0);
    const divergent = Number(summary.divergent ?? job.divergent ?? 0);
    const errors = Number(summary.errors ?? job.errors ?? 0);
    const retryable = Number(summary.retryable ?? job.retryable ?? 0);
    const completed = jobIsTerminal(job);

    const tone = errors > 0 || divergent > 0
      ? "error"
      : blocked > 0 || stale > 0
        ? "warning"
        : completed
          ? "success"
          : "info";
    setJobSummary(
      completed
        ? `Total ${fmtNum(total)} · atualizados ${fmtNum(applied)} · bloqueados ${fmtNum(blocked)} · estoque mudou ${fmtNum(stale)} · divergências ${fmtNum(divergent)} · erros ${fmtNum(errors)}`
        : `Processando ${fmtNum(processed)} de ${fmtNum(total)} linhas. ${job.current_mlb ? `MLB atual: ${job.current_mlb}.` : ""}`,
      tone,
    );

    const download = $("stockDownloadCsv");
    const csvUrl = String(job.download_csv_url || job.review_action?.url || "").trim();
    if (download) {
      download.hidden = !completed || !csvUrl;
      if (csvUrl) download.href = api(csvUrl);
    }

    const retry = $("btnStockRetryErrors");
    if (retry) {
      retry.hidden = !completed || retryable <= 0;
      retry.disabled = state.jobSubmitting;
      retry.textContent = retryable > 0
        ? `Tentar ${fmtNum(retryable)} ${retryable === 1 ? "erro" : "erros"} novamente`
        : "Tentar erros novamente";
    }

    if (completed && Array.isArray(job.rows)) {
      renderJobResults(job.rows);
      updateLocalRowsFromJob(job.rows);
    }
  }

  async function syncJobsPanel() {
    try {
      const payload = await fetchJson("/api/estoque/atualizacao/jobs");
      if (Array.isArray(payload?.jobs)) {
        window.JobsPanel?.mergeApiJobs?.(payload.jobs, { adapter: "estoque-atualizacao" });
        window.JobsPanel?.show?.();
        return payload.jobs;
      }
    } catch (error) {
      console.warn("[Estoque] Falha ao sincronizar jobs de atualização:", error.message);
    }
    return [];
  }

  function stopJobsPanelSync() {
    if (state.jobsPanelTimer) clearInterval(state.jobsPanelTimer);
    state.jobsPanelTimer = null;
  }

  function startJobsPanelSync() {
    if (state.jobsPanelTimer) return;
    const tick = async () => {
      const list = await syncJobsPanel();
      const active = (Array.isArray(list) && list.some((job) => !jobIsTerminal(job))) ||
        Boolean(window.JobsPanel?.hasRunningJobs?.());
      if (!active) stopJobsPanelSync();
    };
    tick();
    state.jobsPanelTimer = setInterval(tick, 3000);
  }

  async function cancelJobFromPanel(job) {
    if (!job || !looksLikeStockUpdateJob(job)) return false;
    const backendId = job.backendJobId || String(job.id || "").split(":").pop();
    if (!backendId) return false;
    const payload = await fetchJson(
      `/api/estoque/atualizacao/jobs/${encodeURIComponent(backendId)}/cancel`,
      { method: "POST" },
    );
    window.JobsPanel?.updateLocalJob?.(job.id, {
      state: payload.status || "cancelando",
      completed: payload.status === "cancelado",
      progress: payload.status === "cancelado" ? 100 : job.progress || 0,
    });
    if (String(state.currentJobId || "") === String(backendId)) {
      setJobSummary(
        payload.status === "cancelado"
          ? "Job cancelado antes de iniciar."
          : "Cancelamento solicitado. O worker concluirá o MLB atual e interromperá o restante.",
        "warning",
      );
    }
    return true;
  }

  function stopCurrentJobPolling() {
    if (state.jobsTimer) clearInterval(state.jobsTimer);
    state.jobsTimer = null;
  }

  async function pollCurrentJob() {
    if (!state.currentJobId) return;
    try {
      await syncJobsPanel();
      const payload = await fetchJson(
        `/api/estoque/atualizacao/jobs/${encodeURIComponent(state.currentJobId)}`,
      );
      const job = payload?.job || null;
      if (!job) return;
      renderJobDetail(job);

      window.JobsPanel?.updateLocalJob?.(state.currentJobId, {
        progress: Number(job.progress || 0),
        processed: Number(job.processed || 0),
        total: Number(job.total || 0),
        errors: Number(job.errors || 0),
        state: job.state || job.status || "processando",
        completed: jobIsTerminal(job),
        reviewAction: job.review_action || null,
        downloadCsvUrl: job.download_csv_url || null,
      });

      if (jobIsTerminal(job)) {
        stopCurrentJobPolling();
        state.jobSubmitting = false;
        updateControls();
      }
    } catch (error) {
      console.warn("[Estoque] Falha ao consultar job atual:", error.message);
    }
  }

  function startCurrentJobPolling() {
    stopCurrentJobPolling();
    startJobsPanelSync();
    pollCurrentJob();
    state.jobsTimer = setInterval(pollCurrentJob, 2500);
  }

  function readyPreviewChanges() {
    return (Array.isArray(state.lastPreview?.rows) ? state.lastPreview.rows : [])
      .filter((row) => row.status === "ready")
      .map((row) => ({
        mlb: row.mlb,
        variation_id: row.variation_id || null,
        expected_current_stock: row.actual_current_stock,
        new_stock: row.new_stock,
      }));
  }

  async function enqueueStockUpdate() {
    if (state.jobSubmitting) return;
    const changes = readyPreviewChanges();
    if (!changes.length) {
      setFeedback("Nenhuma linha pronta para confirmação. Revise as alterações novamente.", "error");
      return;
    }

    state.jobSubmitting = true;
    updateControls();
    const confirm = $("btnStockConfirmUpdate");
    if (confirm) confirm.textContent = "Enviando para a fila...";
    const account = window.__ACCOUNT__ || {};
    const accountLabel = document.querySelector("#account-current")?.textContent?.trim() || account.label || null;
    const localJobId = window.JobsPanel?.addLocalJob?.({
      title: `Estoque - atualizar ${changes.length} ${changes.length === 1 ? "linha" : "linhas"}`,
      accountKey: account.key || null,
      accountLabel,
    }) || null;

    try {
      const payload = await fetchJson("/api/estoque/atualizacao/aplicar", {
        method: "POST",
        body: JSON.stringify({ changes }),
      });
      state.currentJobId = String(payload.job_id || payload.process_id || "");
      if (!state.currentJobId) throw new Error("O backend não retornou o ID do job.");
      state.lastPreview = null;

      if (localJobId) {
        window.JobsPanel?.replaceId?.(localJobId, state.currentJobId);
        window.JobsPanel?.updateLocalJob?.(state.currentJobId, {
          state: `na fila 0/${changes.length}`,
          progress: 0,
          processed: 0,
          total: changes.length,
        });
      }

      closeReviewModal();
      setJobSummary(
        `Job ${state.currentJobId} criado para ${fmtNum(changes.length)} ${changes.length === 1 ? "linha" : "linhas"}. Acompanhe o processamento abaixo ou no painel de processos.`,
        "info",
      );
      setFeedback("Atualização enviada para o worker. Você pode continuar usando o sistema enquanto o lote processa.", "ok");
      startCurrentJobPolling();
    } catch (error) {
      if (localJobId) {
        window.JobsPanel?.updateLocalJob?.(localJobId, {
          progress: 100,
          state: "falha ao iniciar",
          completed: true,
        });
      }
      state.jobSubmitting = false;
      setFeedback(error.message || "Falha ao enviar a atualização para a fila.", "error");
      setJobSummary(`Falha ao iniciar o lote: ${error.message || error}`, "error");
    } finally {
      if (!state.currentJobId) state.jobSubmitting = false;
      if (confirm) confirm.textContent = "Confirmar atualização";
      updateControls();
    }
  }

  async function retryCurrentJobErrors() {
    if (!state.currentJobId || state.jobSubmitting) return;
    state.jobSubmitting = true;
    updateControls();
    const button = $("btnStockRetryErrors");
    if (button) button.disabled = true;
    try {
      const payload = await fetchJson(
        `/api/estoque/atualizacao/jobs/${encodeURIComponent(state.currentJobId)}/retry-errors`,
        { method: "POST" },
      );
      const previous = state.currentJobId;
      state.currentJobId = String(payload.job_id || payload.process_id || "");
      if (!state.currentJobId) throw new Error("Nova tentativa criada sem identificador de job.");
      state.lastJobDetail = null;
      setJobSummary(
        `Nova tentativa ${state.currentJobId} criada a partir do job ${previous} para ${fmtNum(payload.total || 0)} erro(s) seguro(s) para reenvio.`,
        "info",
      );
      startCurrentJobPolling();
    } catch (error) {
      setJobSummary(error.message || "Falha ao criar nova tentativa.", "error");
    } finally {
      state.jobSubmitting = false;
      if (button) button.disabled = false;
      updateControls();
    }
  }

  function bindWorkspace() {
    document.querySelectorAll("[data-stock-workspace-tab]").forEach((button) => {
      button.addEventListener("click", () => setWorkspace(button.dataset.stockWorkspaceTab));
    });
  }

  function bindUpdateEvents() {
    $("btnStockLoadActive")?.addEventListener("click", () => loadRows("active"));
    $("btnStockLoadSpecific")?.addEventListener("click", () => loadRows("manual"));
    $("btnStockApplyBulk")?.addEventListener("click", applyBulkValue);
    $("btnStockSelectFiltered")?.addEventListener("click", selectFiltered);
    $("btnStockClearSelection")?.addEventListener("click", clearSelection);
    $("btnStockResetChanges")?.addEventListener("click", resetChanges);
    $("btnStockReviewChanges")?.addEventListener("click", reviewChanges);
    $("btnStockConfirmUpdate")?.addEventListener("click", enqueueStockUpdate);
    $("btnStockRetryErrors")?.addEventListener("click", retryCurrentJobErrors);

    $("stockSearchInput")?.addEventListener("input", (event) => {
      state.search = event.target.value || "";
      applyFilters({ resetPage: true });
    });

    $("stockFilterSelect")?.addEventListener("change", (event) => {
      state.filter = event.target.value || "all";
      applyFilters({ resetPage: true });
    });

    $("stockCheckPage")?.addEventListener("change", (event) => {
      selectPage(Boolean(event.target.checked));
    });

    $("stockSpecificInput")?.addEventListener("input", (event) => {
      const count = String(event.target.value || "")
        .split(/[\s,;\n\r\t]+/)
        .map((value) => value.trim())
        .filter(Boolean).length;
      setText(
        "stockSpecificHint",
        count
          ? `${fmtNum(count)} ${count === 1 ? "identificador informado" : "identificadores informados"}.`
          : "A tabela será preenchida somente com itens da conta atual.",
      );
    });

    document.addEventListener("change", (event) => {
      const checkbox = event.target.closest("[data-stock-select]");
      if (checkbox) {
        setRowSelected(checkbox.dataset.stockSelect, Boolean(checkbox.checked));
      }
    });

    document.addEventListener("input", (event) => {
      const input = event.target.closest("[data-stock-new]");
      if (!input) return;
      setRowStock(input.dataset.stockNew, input.value);
    });

    document.addEventListener("click", (event) => {
      const page = event.target.closest("[data-stock-page]");
      if (page) {
        state.page = Math.max(1, Number(page.dataset.stockPage || 1));
        renderAll();
      }
      if (event.target.closest("[data-close-stock-review]")) closeReviewModal();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeReviewModal();
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindWorkspace();
    bindUpdateEvents();
    configureJobsPanel();
    const startInUpdate = window.location.hash === "#atualizar-estoque";
    setWorkspace(startInUpdate ? "update" : "analysis", { syncHash: false });
    state.filtered = [];
    renderAll();
    startJobsPanelSync();
  });

  window.addEventListener("beforeunload", () => {
    stopCurrentJobPolling();
    stopJobsPanelSync();
  });
})();
