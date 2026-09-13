(function () {
  "use strict";

  const state = {
    rows: [],
    filtered: [],
    selected: new Set(),
    page: 1,
    pageSize: 25,
    loading: false,
    currentJobId: null,
    jobsTimer: null,
    jobsPanelTimer: null,
  };

  const $ = (selector) => document.querySelector(selector);
  const tableBody = () => $("#tableBody");
  const pagination = () => $("#pagination");

  function setLoadModeBadge(mode) {
    const badge = $("#loadModeBadge");
    if (!badge) return;

    if (mode === "active") {
      badge.className = "badge badge-safe";
      badge.textContent = "Ativos da conta";
      return;
    }

    if (mode === "specific") {
      badge.className = "badge badge-accent";
      badge.textContent = "MLBs especificos";
      return;
    }

    badge.className = "badge badge-neutral";
    badge.textContent = "Sem carga";
  }

  function setSpecificIdsStatus(message) {
    const host = $("#specificIdsStatus");
    if (!host) return;
    host.textContent = message;
  }

  function parseSpecificItemIds(rawValue) {
    return Array.from(
      new Set(
        String(rawValue || "")
          .split(/[\s,;]+/)
          .map((value) => String(value || "").trim().toUpperCase())
          .filter(Boolean),
      ),
    );
  }

  function updateSpecificIdsStatus() {
    const ids = parseSpecificItemIds($("#specificIdsInput")?.value || "");
    if (!ids.length) {
      setSpecificIdsStatus(
        "A tabela sera preenchida somente com os MLBs informados.",
      );
      return;
    }

    const preview = ids.slice(0, 3).join(", ");
    const extra = ids.length > 3 ? ` e mais ${ids.length - 3}` : "";
    setSpecificIdsStatus(
      `${ids.length} MLB(s) pronto(s) para carregar: ${preview}${extra}.`,
    );
  }

  function normalizePanelJobText(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function readShellAccountLabel() {
    const raw = String(document.getElementById("account-current")?.textContent || "").trim();
    if (!raw) return "";
    if (/carregando|indispon|nao selecionada|nenhuma selecionada/i.test(raw)) return "";
    return raw;
  }

  function isTerminalJobStateText(value) {
    const status = normalizePanelJobText(value);
    return (
      /^conclu/.test(status) ||
      /^finaliz/.test(status) ||
      /^completed$/.test(status) ||
      /^done$/.test(status) ||
      /^success/.test(status) ||
      /^sucesso/.test(status) ||
      /^cancel/.test(status) ||
      /^abort/.test(status) ||
      /^falh/.test(status) ||
      /^failed/.test(status) ||
      /^error$/.test(status) ||
      /^erro$/.test(status) ||
      /^erro ao iniciar/.test(status)
    );
  }

  function looksLikeAtacadoJob(job) {
    const adapter = normalizePanelJobText(job?.adapter || job?.module || "");
    const id = normalizePanelJobText(job?.job_uid || job?.id || "");
    if (adapter === "atacado" || id.startsWith("atacado:")) return true;
    const title = normalizePanelJobText(job?.title || "");
    return title.includes("atacado");
  }

  function applyAtacadoPanelVisibilityFilter() {
    window.JobsPanel?.setAdapter?.("atacado");
    window.JobsPanel?.setVisibilityFilter?.((job) => looksLikeAtacadoJob(job));
  }

  function fmtCurrency(value, currency = "BRL") {
    const num = Number(value || 0);
    if (!Number.isFinite(num) || num <= 0) return "—";
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency,
    }).format(num);
  }

  function fmtPercent(value) {
    const num = Number(value);
    return Number.isFinite(num) ? `${num.toFixed(2)}%` : "—";
  }

  function currentExtraDiscountPercent() {
    const value = Number($("#extraDiscountPercent")?.value || 1);
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  function currentPromoOnly() {
    return Boolean($("#promoOnly")?.checked);
  }

  function currentMinPurchaseUnit() {
    const value = Number($("#minPurchaseUnit")?.value || 2);
    return Number.isInteger(value) && value > 0 ? value : 2;
  }

  function currentExtraTierCount() {
    const value = Number($("#extraTierCount")?.value || 0);
    return Number.isInteger(value) && value >= 0 ? Math.min(value, 4) : 0;
  }

  function collectTierConfigs() {
    const configs = [
      {
        min_purchase_unit: currentMinPurchaseUnit(),
        discount_percent: currentExtraDiscountPercent(),
      },
    ];
    const extraCount = currentExtraTierCount();

    for (let tier = 2; tier <= 5; tier += 1) {
      if (tier - 1 > extraCount) break;
      const minInput = document.querySelector(`[data-tier-min="${tier}"]`);
      const discountInput = document.querySelector(`[data-tier-discount="${tier}"]`);
      const previousMinUnit = configs[configs.length - 1].min_purchase_unit;
      const fallbackMin = previousMinUnit + 1;
      const minValue = Number(minInput?.value || fallbackMin);
      const discountValue = Number(discountInput?.value || tier);

      configs.push({
        min_purchase_unit:
          Number.isInteger(minValue) && minValue > previousMinUnit
            ? minValue
            : fallbackMin,
        discount_percent:
          Number.isFinite(discountValue) && discountValue > 0
            ? discountValue
            : currentExtraDiscountPercent(),
      });
    }

    return configs;
  }

  function validateTierConfigs(configs) {
    for (let index = 1; index < configs.length; index += 1) {
      const previous = configs[index - 1];
      const current = configs[index];
      if (current.min_purchase_unit <= previous.min_purchase_unit) {
        throw new Error(
          `A faixa ${index + 1} precisa ter quantidade minima maior que a faixa ${index}.`,
        );
      }
      if (Number(current.discount_percent) <= Number(previous.discount_percent)) {
        throw new Error(
          `A faixa ${index + 1} precisa ter desconto maior que a faixa ${index}.`,
        );
      }
    }
    return configs;
  }

  function syncTierConfig() {
    const extraCount = currentExtraTierCount();
    const rows = document.querySelectorAll("[data-tier-row]");
    let previousMinUnit = currentMinPurchaseUnit();

    rows.forEach((row) => {
      const tier = Number(row.getAttribute("data-tier-row") || 0);
      const isVisible = tier - 1 <= extraCount;
      row.classList.toggle("is-hidden", !isVisible);

      const input = row.querySelector("input");
      if (!input) return;

      const minimumAllowed = previousMinUnit + 1;
      input.min = String(minimumAllowed);
      const currentValue = Number(input.value || minimumAllowed);
      const normalizedValue =
        Number.isInteger(currentValue) && currentValue >= minimumAllowed
          ? currentValue
          : minimumAllowed;

      if (String(normalizedValue) !== String(input.value)) {
        input.value = String(normalizedValue);
      }

      previousMinUnit = normalizedValue;
    });

    const summary = collectTierConfigs()
      .slice(0, extraCount + 1)
      .map(
        (config, index) =>
          `faixa ${index + 1}: min ${config.min_purchase_unit} / ${Number(config.discount_percent).toFixed(2)}%`,
      );

    $("#tierSummary").textContent =
      extraCount > 0
        ? `Configuracao ativa com ${extraCount + 1} faixas: ${summary.join(" | ")}.`
        : "Cada faixa adicional usa seu proprio desconto sempre sobre o preco vigente atual.";
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char]);
  }

  function recomputeRow(row) {
    const base = Number(row.sale_price || row.item_price || 0);
    const extra = currentExtraDiscountPercent();
    const suggested =
      base > 0
        ? Math.round((base * (1 - extra / 100) + Number.EPSILON) * 100) / 100
        : null;
    return { ...row, suggested_wholesale_price: suggested };
  }

  function updateStats() {
    $("#statLoaded").textContent = String(state.rows.length);
    $("#statPromo").textContent = String(
      state.rows.filter((row) => row.promo_active).length,
    );
    $("#statFiltered").textContent = String(state.filtered.length);
    $("#statSelected").textContent = String(
      state.filtered.filter((row) => state.selected.has(row.id)).length,
    );

    const disabled = state.filtered.length === 0 || state.loading;
    $("#btnExportar").disabled = state.rows.length === 0;
    $("#btnSelectFiltered").disabled = disabled;
    $("#btnApplyFiltered").disabled = disabled;
    $("#btnApplySelected").disabled = state.selected.size === 0 || state.loading;
    $("#checkPage").checked = false;
  }

  function currentPageRows() {
    const start = (state.page - 1) * state.pageSize;
    return state.filtered.slice(start, start + state.pageSize);
  }

  function renderPagination() {
    const host = pagination();
    host.innerHTML = "";

    const totalPages = Math.max(
      1,
      Math.ceil(state.filtered.length / state.pageSize),
    );

    for (let page = 1; page <= totalPages; page += 1) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `page-btn${page === state.page ? " active" : ""}`;
      button.textContent = String(page);
      button.addEventListener("click", () => {
        state.page = page;
        renderTable();
      });
      host.appendChild(button);
    }
  }

  function renderTable() {
    const rows = currentPageRows();
    const tbody = tableBody();
    tbody.innerHTML = "";

    if (!rows.length) {
      tbody.innerHTML =
        '<tr><td colspan="10" class="empty-row">Nenhum anúncio corresponde aos filtros atuais.</td></tr>';
      $("#tableInfo").textContent = "0 resultados";
      renderPagination();
      updateStats();
      return;
    }

    for (const row of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><input type="checkbox" data-id="${row.id}" ${state.selected.has(row.id) ? "checked" : ""}></td>
        <td><a href="${row.permalink || "#"}" target="_blank" rel="noreferrer">${row.id}</a></td>
        <td>${escapeHtml(row.title || "—")}</td>
        <td>${escapeHtml(row.seller_custom_field || "—")}</td>
        <td>${Number(row.available_quantity || 0)}</td>
        <td>${fmtCurrency(row.item_price, row.currency_id)}</td>
        <td>${fmtCurrency(row.sale_price, row.currency_id)}</td>
        <td><span class="promo-pill ${row.promo_active ? "on" : "off"}">${row.promo_active ? "Ativa" : "Sem promo"}</span></td>
        <td>${fmtPercent(row.promo_percent)}</td>
        <td>${fmtCurrency(row.suggested_wholesale_price, row.currency_id)}</td>
      `;

      const checkbox = tr.querySelector('input[type="checkbox"]');
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.selected.add(row.id);
        else state.selected.delete(row.id);
        updateStats();
      });

      tbody.appendChild(tr);
    }

    $("#tableInfo").textContent = `${state.filtered.length} resultado(s) • página ${state.page}`;
    renderPagination();
    updateStats();
  }

  function updateFilterFeedback() {
    if (state.loading) return;

    const search = String($("#searchInput")?.value || "").trim();
    const promoOnly = currentPromoOnly();
    const promoCount = state.rows.filter((row) => row.promo_active).length;

    if (!state.rows.length) {
      $("#loadStatus").textContent = "Nenhum anúncio carregado ainda.";
      return;
    }

    if (promoOnly && promoCount === 0) {
      $("#loadStatus").textContent =
        `Carga concluída. ${state.rows.length} anúncio(s) ativos carregados, mas nenhum está com promoção ativa para o filtro atual.`;
      return;
    }

    if (search && !state.filtered.length) {
      $("#loadStatus").textContent =
        `Carga concluída. ${state.rows.length} anúncio(s) ativos carregados, mas nenhum corresponde à busca atual.`;
      return;
    }

    $("#loadStatus").textContent = `Carga concluída. ${state.rows.length} anúncio(s) ativos carregados.`;
  }

  function applyFilters() {
    const search = String($("#searchInput")?.value || "")
      .trim()
      .toLowerCase();

    state.filtered = state.rows
      .map(recomputeRow)
      .filter((row) => {
        if (currentPromoOnly() && !row.promo_active) return false;
        if (!search) return true;
        return [row.id, row.title, row.seller_custom_field]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(search));
      });

    const totalPages = Math.max(
      1,
      Math.ceil(state.filtered.length / state.pageSize),
    );
    if (state.page > totalPages) state.page = totalPages;

    updateFilterFeedback();
    updateStats();
    renderTable();
  }

  async function fetchJson(url, init) {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.headers || {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    return payload;
  }

  function setLoading(loading, message) {
    state.loading = loading;
    $("#btnCarregar").disabled = loading;
    $("#btnCarregarEspecificos").disabled = loading;
    $("#btnApplyFiltered").disabled = loading || state.filtered.length === 0;
    $("#btnApplySelected").disabled = loading || state.selected.size === 0;
    $("#loadStatus").textContent = message || (loading ? "Processando..." : "Pronto.");
    updateStats();
  }

  function resetTableState() {
    state.rows = [];
    state.filtered = [];
    state.selected.clear();
    state.page = 1;
  }

  async function loadAllActiveItems() {
    resetTableState();
    setLoading(true, "Buscando anúncios ativos...");

    const limit = 50;
    let cursor = "";
    let total = null;

    try {
      for (;;) {
        const params = new URLSearchParams({
          limit: String(limit),
          extra_discount_percent: String(currentExtraDiscountPercent()),
        });
        if (cursor) params.set("cursor", cursor);

        const payload = await fetchJson(
          mlUrl(`/api/atacado/ativos?${params.toString()}`),
        );

        const items = Array.isArray(payload?.items) ? payload.items : [];
        const paging = payload?.paging || {};
        total = Number.isFinite(Number(paging.total))
          ? Number(paging.total)
          : total;

        state.rows.push(...items);
        cursor = String(paging.next_cursor || "");

        $("#loadStatus").textContent =
          total != null
            ? `Carregando anúncios ativos... ${state.rows.length}/${total}`
            : `Carregando anúncios ativos... ${state.rows.length}`;

        if (!paging.has_more || !items.length) break;
      }

      $("#loadStatus").textContent = `Carga concluída. ${state.rows.length} anúncio(s) ativos carregados.`;
      setLoadModeBadge("active");
      state.page = 1;
      applyFilters();
    } catch (error) {
      $("#loadStatus").textContent = `Falha ao carregar anúncios ativos: ${error.message}`;
      renderApplySummary(`Falha ao carregar anúncios ativos: ${error.message}`, "error");
    } finally {
      setLoading(false, $("#loadStatus").textContent);
    }
  }

  async function loadSpecificItems() {
    const itemIds = parseSpecificItemIds($("#specificIdsInput")?.value || "");
    if (!itemIds.length) {
      setSpecificIdsStatus("Informe ao menos um MLB para usar este modo.");
      renderApplySummary(
        "Informe ao menos um MLB para carregar a lista especifica.",
        "error",
      );
      return;
    }

    resetTableState();
    setLoading(true, `Carregando ${itemIds.length} MLB(s) especifico(s)...`);

    try {
      const payload = await fetchJson(mlUrl("/api/atacado/listar-especificos"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_ids: itemIds,
          extra_discount_percent: currentExtraDiscountPercent(),
        }),
      });

      const items = Array.isArray(payload?.items) ? payload.items : [];
      const missingIds = Array.isArray(payload?.missing_ids)
        ? payload.missing_ids
        : [];

      state.rows = items;
      state.page = 1;
      setLoadModeBadge("specific");
      applyFilters();

      if (!items.length) {
        $("#loadStatus").textContent =
          "Nenhum dos MLBs informados foi localizado para a conta atual.";
        setSpecificIdsStatus(
          "Nenhum dos MLBs informados foi localizado para a conta atual.",
        );
      } else if (missingIds.length) {
        const preview = missingIds.slice(0, 8).join(", ");
        const extra =
          missingIds.length > 8 ? ` e mais ${missingIds.length - 8}` : "";
        $("#loadStatus").textContent =
          `Carga concluida via MLBs especificos. ${items.length}/${itemIds.length} encontrado(s).`;
        setSpecificIdsStatus(
          `Foram encontrados ${items.length} MLB(s). Nao localizados: ${preview}${extra}.`,
        );
      } else {
        $("#loadStatus").textContent =
          `Carga concluida via MLBs especificos. ${items.length} MLB(s) encontrado(s).`;
        setSpecificIdsStatus(
          `${items.length} MLB(s) carregado(s) na tabela com sucesso.`,
        );
      }
    } catch (error) {
      $("#loadStatus").textContent =
        `Falha ao carregar MLBs especificos: ${error.message}`;
      setSpecificIdsStatus(
        `Falha ao carregar MLBs especificos: ${error.message}`,
      );
      renderApplySummary(
        `Falha ao carregar MLBs especificos: ${error.message}`,
        "error",
      );
    } finally {
      setLoading(false, $("#loadStatus").textContent);
    }
  }

  function exportCsv() {
    if (!state.filtered.length) return;

    const head = [
      "MLB",
      "Titulo",
      "SKU",
      "Estoque",
      "PrecoAtual",
      "PrecoVigente",
      "PromoAtiva",
      "DescontoPromo",
      "AtacadoSugerido",
    ];

    const lines = state.filtered.map((row) => [
      row.id,
      row.title || "",
      row.seller_custom_field || "",
      row.available_quantity || 0,
      row.item_price || "",
      row.sale_price || "",
      row.promo_active ? "Sim" : "Nao",
      row.promo_percent ?? "",
      row.suggested_wholesale_price ?? "",
    ]);

    const csv = [head, ...lines]
      .map((cols) =>
        cols
          .map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`)
          .join(";"),
      )
      .join("\r\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "atacado_ativos.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function renderApplySummary(message, type = "info") {
    $("#applySummary").className = `apply-summary apply-summary--${type}`;
    $("#applySummary").textContent = message;
  }

  function renderApplyResults(results) {
    const host = $("#applyResults");
    host.innerHTML = "";

    for (const result of results) {
      const item = document.createElement("div");
      item.className = `result-item result-item--${result.status}`;
      item.innerHTML = `
        <strong>${result.id}</strong>
        <span>${escapeHtml(result.reason || "—")}</span>
      `;
      host.appendChild(item);
    }
  }

  function jobIsCompleted(job) {
    if (!job) return false;
    if (job.completed === true) return true;
    return isTerminalJobStateText(job.state || job.status || "");
  }

  function atacadoJobCsvUrl(jobId) {
    return `/api/atacado/jobs/${encodeURIComponent(String(jobId || "").trim())}/download.csv`;
  }

  function resolveAtacadoReviewAction(job, jobId, completed) {
    const explicit =
      job?.review_action && job.review_action.url
        ? {
            label: job.review_action.label || "Baixar CSV",
            url: job.review_action.url,
          }
        : null;
    if (explicit) return explicit;
    const directUrl = String(job?.download_csv_url || "").trim();
    if (directUrl) {
      return {
        label: Number(job?.errors || 0) > 0 ? "Ver e corrigir" : "Baixar CSV",
        url: directUrl,
      };
    }
    if (!completed) return null;
    return {
      label: Number(job?.errors || 0) > 0 ? "Ver e corrigir" : "Baixar CSV",
      url: atacadoJobCsvUrl(jobId),
    };
  }

  function isActiveJob(job) {
    if (!job) return false;
    if (job.completed === true) return false;
    return !isTerminalJobStateText(job.state || job.status || "");
  }

  async function syncJobsPanel() {
    try {
      const payload = await fetchJson(mlUrl("/api/atacado/jobs"));
      if (Array.isArray(payload?.jobs)) {
        window.JobsPanel?.mergeApiJobs?.(payload.jobs);
        window.JobsPanel?.show?.();
        return payload.jobs;
      }
    } catch (error) {
      console.warn("Falha ao sincronizar jobs de atacado:", error.message);
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
      const hasActive = (Array.isArray(list) && list.some(isActiveJob)) ||
        !!window.JobsPanel?.hasRunningJobs?.();
      if (!hasActive) stopJobsPanelSync();
    };
    tick();
    state.jobsPanelTimer = setInterval(tick, 3000);
  }

  async function cancelJobFromPanel(job) {
    if (!job?.id) return false;
    const payload = await fetchJson(
      mlUrl(`/api/atacado/jobs/${encodeURIComponent(job.backendJobId || job.id)}/cancel`),
      { method: "POST" },
    );
    const status = String(payload?.status || "");
    window.JobsPanel?.updateLocalJob?.(job.id, {
      state: /cancelando/i.test(status) ? "cancelando" : "cancelado",
      completed: !/cancelando/i.test(status),
      progress: /cancelando/i.test(status) ? job.progress || 0 : 100,
    });
    return true;
  }

  async function pollCurrentJob() {
    if (!state.currentJobId) return;

    try {
      await syncJobsPanel();
      const payload = await fetchJson(
        mlUrl(`/api/atacado/jobs/${encodeURIComponent(state.currentJobId)}`),
      );
      const job = payload?.job || null;
      if (!job) return;
      const completed = jobIsCompleted(job);
      const reviewAction = resolveAtacadoReviewAction(job, state.currentJobId, completed);
      window.JobsPanel?.updateLocalJob?.(state.currentJobId, {
        progress: Number(job.progress ?? 0),
        processed: Number(job.processed ?? 0),
        total: Number(job.total ?? 0),
        errors: Number(job.errors ?? 0),
        state:
          job.state ||
          (completed
            ? Number(job.errors || 0) > 0
              ? `concluido com ${Number(job.errors || 0)} erro(s)`
              : "concluido"
            : `processando ${Number(job.processed || 0)}/${Number(job.total || 0)}`),
        completed,
        reviewAction,
        downloadCsvUrl: reviewAction?.url || null,
      });

      if (completed) {
        const summaryParts = [
          `Total: ${job.total || 0}`,
          `Aplicados: ${job.applied || 0}`,
          `Ignorados: ${job.skipped || 0}`,
          `Erros: ${job.errors || 0}`,
        ];
        if (job.dry_run) summaryParts.push("Simulação");

        renderApplySummary(summaryParts.join(" • "), job.errors ? "error" : "success");
        renderApplyResults(Array.isArray(job.results) ? job.results : []);
        setLoading(false, "Job finalizado.");
        stopJobsPolling();
      }
    } catch (error) {
      console.warn("Falha ao consultar job atual:", error.message);
    }
  }

  function startJobsPolling() {
    stopJobsPolling();
    startJobsPanelSync();
    state.jobsTimer = setInterval(pollCurrentJob, 2500);
  }

  function stopJobsPolling() {
    if (state.jobsTimer) clearInterval(state.jobsTimer);
    state.jobsTimer = null;
  }

  async function enqueueWholesaleJob(itemIds) {
    const unique = Array.from(
      new Set(
        itemIds
          .map((itemId) => String(itemId || "").trim().toUpperCase())
          .filter(Boolean),
      ),
    );
    if (!unique.length) return;

    const minPurchaseUnit = currentMinPurchaseUnit();
    let tierConfigs;
    try {
      tierConfigs = validateTierConfigs(collectTierConfigs());
    } catch (error) {
      renderApplySummary(error.message, "error");
      return;
    }
    const tierCount = tierConfigs.length;
    const extraDiscountPercent = currentExtraDiscountPercent();
    const promoOnly = currentPromoOnly();
    const dryRun = Boolean($("#dryRun")?.checked);
    const account = window.__ACCOUNT__ || {};
    const accountLabel = readShellAccountLabel() || account.label || null;

    setLoading(true, "Enfileirando job de atacado...");
    renderApplySummary(
      dryRun
        ? "Criando job de simulação do atacado..."
        : "Criando job de aplicação do atacado...",
    );
    $("#applyResults").innerHTML = "";

    const localJobId =
      window.JobsPanel?.addLocalJob?.({
        title: `${dryRun ? "Simular" : "Aplicar"} Atacado • ${unique.length} item(ns)`,
        accountKey: account.key || null,
        accountLabel,
      }) || null;

    try {
      const payload = await fetchJson(mlUrl("/api/atacado/aplicar"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_ids: unique,
          extra_discount_percent: extraDiscountPercent,
          min_purchase_unit: minPurchaseUnit,
          tier_configs: tierConfigs,
          promo_only: promoOnly,
          dry_run: dryRun,
        }),
      });

      state.currentJobId = String(payload?.job_id || "");
      if (localJobId && state.currentJobId) {
        window.JobsPanel?.replaceId?.(localJobId, state.currentJobId);
        window.JobsPanel?.updateLocalJob?.(state.currentJobId, {
          state: `na fila 0/${unique.length}`,
          progress: 0,
          processed: 0,
          total: unique.length,
        });
      }

      renderApplySummary(
        `Job criado para ${unique.length} item(ns) com ${tierCount} faixa(s). Acompanhe o progresso no painel de processos.`,
        "info",
      );
      startJobsPolling();
    } catch (error) {
      if (localJobId) {
        window.JobsPanel?.updateLocalJob?.(localJobId, {
          progress: 100,
          state: "falha ao iniciar",
          completed: true,
        });
      }
      renderApplySummary(`Falha ao iniciar job de atacado: ${error.message}`, "error");
      setLoading(false, "Falha ao criar job.");
    }
  }

  function selectedIds() {
    return Array.from(state.selected).filter((id) =>
      state.rows.some((row) => row.id === id),
    );
  }

  function clearAll() {
    state.rows = [];
    state.filtered = [];
    state.selected.clear();
    state.page = 1;
    state.currentJobId = null;
    stopJobsPolling();
    $("#searchInput").value = "";
    if ($("#specificIdsInput")) $("#specificIdsInput").value = "";
    tableBody().innerHTML =
      '<tr><td colspan="10" class="empty-row">Carregue os anúncios ativos para começar.</td></tr>';
    setSpecificIdsStatus("A tabela sera preenchida somente com os MLBs informados.");
    setLoadModeBadge("none");
    pagination().innerHTML = "";
    $("#tableInfo").textContent = "0 resultados";
    $("#loadStatus").textContent = "Nenhum anúncio carregado ainda.";
    renderApplySummary("Aguardando ação.");
    $("#applyResults").innerHTML = "";
    updateStats();
  }

  function bindEvents() {
    $("#btnCarregar").addEventListener("click", loadAllActiveItems);
    $("#btnCarregarEspecificos").addEventListener("click", loadSpecificItems);
    $("#btnExportar").addEventListener("click", exportCsv);
    $("#btnLimpar").addEventListener("click", clearAll);
    $("#specificIdsInput").addEventListener("input", updateSpecificIdsStatus);
    $("#promoOnly").addEventListener("change", applyFilters);
    $("#extraDiscountPercent").addEventListener("input", () => {
      syncTierConfig();
      applyFilters();
    });
    $("#minPurchaseUnit").addEventListener("input", syncTierConfig);
    $("#extraTierCount").addEventListener("change", syncTierConfig);
    document.querySelectorAll("[data-tier-min]").forEach((input) => {
      input.addEventListener("input", syncTierConfig);
    });
    document.querySelectorAll("[data-tier-discount]").forEach((input) => {
      input.addEventListener("input", syncTierConfig);
    });
    $("#searchInput").addEventListener("input", () => {
      state.page = 1;
      applyFilters();
    });
    $("#checkPage").addEventListener("change", (event) => {
      for (const row of currentPageRows()) {
        if (event.target.checked) state.selected.add(row.id);
        else state.selected.delete(row.id);
      }
      renderTable();
    });
    $("#btnSelectFiltered").addEventListener("click", () => {
      for (const row of state.filtered) state.selected.add(row.id);
      renderTable();
    });
    $("#btnApplySelected").addEventListener("click", async () => {
      const ids = selectedIds();
      if (!ids.length) return;
      if (!window.confirm(`Aplicar atacado em ${ids.length} anúncio(s)?`)) return;
      await enqueueWholesaleJob(ids);
    });
    $("#btnApplyFiltered").addEventListener("click", async () => {
      if (!state.filtered.length) return;
      if (
        !window.confirm(
          `Aplicar atacado em ${state.filtered.length} anúncio(s) filtrados?`,
        )
      ) {
        return;
      }
      await enqueueWholesaleJob(state.filtered.map((row) => row.id));
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindEvents();
    syncTierConfig();
    updateSpecificIdsStatus();
    setLoadModeBadge("none");
    updateStats();
    applyAtacadoPanelVisibilityFilter();
    startJobsPanelSync();
    window.JobsPanel?.setCancelHandler?.(cancelJobFromPanel);
  });

  window.addEventListener("beforeunload", () => {
    stopJobsPolling();
    stopJobsPanelSync();
  });
})();
