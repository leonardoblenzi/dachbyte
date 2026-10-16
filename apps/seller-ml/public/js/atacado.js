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
    currentJobKind: null,
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

    if (mode === "active-partial") {
      badge.className = "badge badge-neutral";
      badge.textContent = "Ativos parciais";
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

  function activeLoadStorageKey() {
    const account = window.__ACCOUNT__ || {};
    const accountKey = String(
      account.key || account.meli_conta_id || account.meli_user_id || "default",
    ).trim() || "default";
    return `ml:atacado:active-load:${accountKey}`;
  }

  function persistActiveLoadJob(jobId) {
    const normalized = String(jobId || "").trim();
    if (!normalized) return;
    try {
      window.sessionStorage?.setItem(activeLoadStorageKey(), normalized);
    } catch {}
  }

  function readPersistedActiveLoadJob() {
    try {
      return String(
        window.sessionStorage?.getItem(activeLoadStorageKey()) || "",
      ).trim();
    } catch {
      return "";
    }
  }

  function clearPersistedActiveLoadJob() {
    try {
      window.sessionStorage?.removeItem(activeLoadStorageKey());
    } catch {}
  }

  function isActiveLoadJobPayload(job) {
    const kind = String(
      job?.kind ||
        job?.job_kind ||
        job?.job_contract?.kind ||
        "",
    ).trim();
    return kind === "atacado-load-active";
  }

  function jobLifecycle(job) {
    return normalizePanelJobText(
      job?.lifecycle_status ||
        job?.job_contract?.status ||
        job?.status ||
        job?.state ||
        "",
    );
  }

  function jobWasCanceled(job) {
    const lifecycle = jobLifecycle(job);
    return lifecycle === "canceled" || /^cancel/.test(lifecycle) || /^abort/.test(lifecycle);
  }

  function jobFailed(job) {
    const lifecycle = jobLifecycle(job);
    return lifecycle === "failed" || /^erro/.test(lifecycle) || /^falh/.test(lifecycle);
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
    const firstDiscount = Number($("#extraDiscountPercent")?.value);
    const firstMinUnit = Number($("#minPurchaseUnit")?.value);
    if (!Number.isFinite(firstDiscount) || firstDiscount <= 0 || firstDiscount >= 100) {
      throw new Error("A faixa 1 precisa ter desconto maior que 0% e menor que 100%.");
    }
    if (!Number.isInteger(firstMinUnit) || firstMinUnit < 1 || firstMinUnit > 100) {
      throw new Error("A faixa 1 precisa ter quantidade entre 1 e 100.");
    }
    for (let index = 1; index < configs.length; index += 1) {
      const previous = configs[index - 1];
      const current = configs[index];
      const tier = index + 1;
      const rawDiscount = Number(document.querySelector(`[data-tier-discount="${tier}"]`)?.value);
      if (!Number.isInteger(current.min_purchase_unit) || current.min_purchase_unit > 100) {
        throw new Error(`A faixa ${tier} precisa ter quantidade entre 1 e 100.`);
      }
      if (!Number.isFinite(rawDiscount) || rawDiscount <= 0 || rawDiscount >= 100) {
        throw new Error(`A faixa ${tier} precisa ter desconto maior que 0% e menor que 100%.`);
      }
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

  function notifyCreditWalletChanged({ settlePending = false } = {}) {
    window.dispatchEvent(new CustomEvent("ml:credits-changed"));
    if (settlePending) {
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent("ml:credits-changed"));
      }, 1500);
    }
  }

  function renderPagination() {
    const host = pagination();
    host.innerHTML = "";

    const model = window.CompactPagination?.buildCompactPagination?.({
      currentPage: state.page,
      totalPages: Math.ceil(state.filtered.length / state.pageSize),
    });
    if (!model || model.totalPages <= 1) return;
    state.page = model.currentPage;

    const addPageButton = (label, page, { active = false, direction = false } = {}) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `page-btn${active ? " active" : ""}${direction ? " page-btn--direction" : ""}`;
      button.textContent = label;
      button.disabled = !page;
      if (!page) button.setAttribute("aria-disabled", "true");
      button.addEventListener("click", () => {
        if (!page) return;
        state.page = page;
        renderTable();
      });
      host.appendChild(button);
    };

    addPageButton("Anterior", model.previousPage, { direction: true });
    for (const item of model.items) {
      if (item.type === "ellipsis") {
        const ellipsis = document.createElement("span");
        ellipsis.className = "pagination-ellipsis";
        ellipsis.setAttribute("aria-hidden", "true");
        ellipsis.textContent = "…";
        host.appendChild(ellipsis);
        continue;
      }
      addPageButton(String(item.page), item.page, {
        active: item.page === model.currentPage,
      });
    }
    addPageButton("Próxima", model.nextPage, { direction: true });
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

    const totalPages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
    $("#tableInfo").textContent = `${state.filtered.length} resultado(s) • página ${state.page} de ${totalPages}`;
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

  async function fetchWholesaleCreditQuote(itemIds) {
    return fetchJson(mlUrl("/api/atacado/credits/quote"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        item_ids: itemIds,
      }),
    });
  }

  async function confirmWholesaleCreditQuote(quote, quantity) {
    if (!window.CreditOperationModal?.confirm) {
      renderApplySummary("Não foi possível abrir a confirmação de créditos. Recarregue a página.", "error");
      return false;
    }
    return window.CreditOperationModal.confirm({
      title: "Confirmar aplicação de atacado",
      description: "As faixas configuradas serão enviadas ao Mercado Livre.",
      quantity,
      unitLabel: "anúncios",
      quote,
      confirmLabel: "Confirmar e aplicar",
    });
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
    setLoading(true, "Enfileirando carga dos anúncios ativos...");

    const account = window.__ACCOUNT__ || {};
    const accountLabel = readShellAccountLabel() || account.label || null;
    const localJobId =
      window.JobsPanel?.addLocalJob?.({
        title: "Carregar ativos do Atacado",
        accountKey: account.key || null,
        accountLabel,
      }) || null;

    try {
      const payload = await fetchJson(mlUrl("/api/atacado/ativos/jobs"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          extra_discount_percent: currentExtraDiscountPercent(),
        }),
      });

      state.currentJobId = String(payload?.job_id || "");
      state.currentJobKind = "atacado-load-active";
      if (!state.currentJobId) {
        throw new Error("Backend nao retornou o identificador do job.");
      }

      persistActiveLoadJob(state.currentJobId);

      if (localJobId) {
        window.JobsPanel?.replaceId?.(localJobId, state.currentJobId);
        window.JobsPanel?.updateLocalJob?.(state.currentJobId, {
          state: "na fila - aguardando worker",
          progress: 0,
          processed: 0,
          total: 0,
        });
      }

      $("#loadStatus").textContent =
        "Carga enviada para o backend. Acompanhe o progresso no painel de processos.";
      renderApplySummary(
        "Os anúncios ativos estão sendo carregados em segundo plano. A tabela será preenchida quando o job terminar.",
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
      clearPersistedActiveLoadJob();
      state.currentJobId = null;
      state.currentJobKind = null;
      $("#loadStatus").textContent =
        `Falha ao iniciar carga dos anúncios ativos: ${error.message}`;
      renderApplySummary(
        `Falha ao iniciar carga dos anúncios ativos: ${error.message}`,
        "error",
      );
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

  function atacadoJobXlsxUrl(jobId) {
    return `/api/atacado/jobs/${encodeURIComponent(String(jobId || "").trim())}/download.xlsx`;
  }

  function resolveAtacadoReviewAction(job, jobId, completed) {
    if (isActiveLoadJobPayload(job)) return null;

    const explicit =
      job?.review_action && job.review_action.url
        ? {
            label: "Baixar XLSX",
            url: job.review_action.url,
          }
        : null;
    if (explicit) return explicit;
    if (!completed || Number(job?.result_total || 0) <= 0) return null;
    return {
      label: "Baixar XLSX",
      url: atacadoJobXlsxUrl(jobId),
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

  async function recoverActiveLoadJob() {
    let jobId = readPersistedActiveLoadJob();

    if (jobId) {
      try {
        const payload = await fetchJson(
          mlUrl(
            `/api/atacado/jobs/${encodeURIComponent(jobId)}?include_results=0`,
          ),
        );
        if (!isActiveLoadJobPayload(payload?.job)) {
          throw new Error("stored_job_is_not_active_load");
        }
      } catch {
        clearPersistedActiveLoadJob();
        jobId = "";
      }
    }

    if (!jobId) {
      const jobs = await syncJobsPanel();
      const runningLoad = jobs.find(
        (job) => isActiveLoadJobPayload(job) && isActiveJob(job),
      );
      jobId = String(
        runningLoad?.backend_job_id ||
          runningLoad?.backendJobId ||
          runningLoad?.id ||
          "",
      ).trim();
    }

    if (!jobId) return false;

    state.currentJobId = jobId;
    state.currentJobKind = "atacado-load-active";
    persistActiveLoadJob(jobId);
    setLoading(true, "Retomando carga dos anúncios ativos...");
    renderApplySummary(
      "Carga de ativos em andamento no backend. Retomando acompanhamento após recarregar a página.",
      "info",
    );
    startJobsPolling();
    await pollCurrentJob();
    return true;
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
      reviewAction: null,
      downloadCsvUrl: null,
    });

    const backendId = String(job.backendJobId || job.backend_job_id || job.id || "");
    if (
      state.currentJobId &&
      backendId === state.currentJobId &&
      !/cancelando/i.test(status)
    ) {
      await pollCurrentJob();
    }
    return true;
  }

  async function pollCurrentJob() {
    if (!state.currentJobId) return;

    try {
      await syncJobsPanel();
      const payload = await fetchJson(
        mlUrl(
          `/api/atacado/jobs/${encodeURIComponent(state.currentJobId)}?include_results=0`,
        ),
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
        downloadCsvUrl: null,
      });

      if (completed) {
        const finalPayload = await fetchJson(
          mlUrl(
            `/api/atacado/jobs/${encodeURIComponent(state.currentJobId)}?include_results=1`,
          ),
        );
        const finalJob = finalPayload?.job || job;
        const kind = String(finalJob?.kind || state.currentJobKind || "");

        if (kind === "atacado-load-active") {
          const rows = Array.isArray(finalJob?.results) ? finalJob.results : [];
          const canceled = jobWasCanceled(finalJob);
          const failed = jobFailed(finalJob);

          state.rows = rows;
          state.page = 1;
          setLoadModeBadge(
            canceled || failed
              ? rows.length
                ? "active-partial"
                : "none"
              : "active",
          );
          applyFilters();

          if (canceled) {
            $("#loadStatus").textContent =
              `Carga cancelada. ${rows.length} anúncio(s) recuperado(s) antes do cancelamento.`;
            renderApplySummary(
              `Carga de ativos cancelada. ${rows.length} anúncio(s) foram recuperados e a lista exibida é parcial.`,
              "info",
            );
          } else if (failed) {
            $("#loadStatus").textContent =
              `Carga finalizada com falha. ${rows.length} anúncio(s) recuperado(s) antes da interrupção.`;
            renderApplySummary(
              finalJob?.error ||
                `A carga dos ativos falhou após recuperar ${rows.length} anúncio(s).`,
              "error",
            );
          } else {
            $("#loadStatus").textContent =
              `Carga concluída. ${rows.length} anúncio(s) ativos carregados.`;
            renderApplySummary(
              `Carga de ativos concluída pelo backend: ${rows.length} anúncio(s) carregado(s)${Number(finalJob?.errors || 0) ? ` • ${Number(finalJob.errors)} detalhe(s) não retornado(s) pelo Mercado Livre` : ""}.`,
              Number(finalJob?.errors || 0) ? "error" : "success",
            );
          }

          clearPersistedActiveLoadJob();
        } else {
          const summaryParts = [
            `Total: ${finalJob.total || 0}`,
            `Aplicados: ${finalJob.applied || 0}`,
            `Ignorados: ${finalJob.skipped || 0}`,
            `Erros: ${finalJob.errors || 0}`,
          ];

          renderApplySummary(
            summaryParts.join(" • "),
            finalJob.errors ? "error" : "success",
          );
          renderApplyResults(
            Array.isArray(finalJob.results) ? finalJob.results : [],
          );
        }

        state.currentJobId = null;
        state.currentJobKind = null;
        setLoading(false, "Job finalizado.");
        stopJobsPolling();
        notifyCreditWalletChanged({ settlePending: true });
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
    const account = window.__ACCOUNT__ || {};
    const accountLabel = readShellAccountLabel() || account.label || null;

    try {
      const creditQuote = await fetchWholesaleCreditQuote(unique);
      const confirmed = await confirmWholesaleCreditQuote(creditQuote, unique.length);
      if (confirmed === false) {
        renderApplySummary("Aplicação cancelada antes de criar o job.", "info");
        return;
      }
    } catch (error) {
      console.warn("[atacado] prévia de créditos indisponível:", error?.message || error);
      renderApplySummary("Falha ao consultar o custo dos créditos. Atualize a página e tente novamente.", "error");
      return;
    }

    setLoading(true, "Enfileirando job de atacado...");
    renderApplySummary("Criando job de aplicação do atacado...");
    $("#applyResults").innerHTML = "";

    const localJobId =
      window.JobsPanel?.addLocalJob?.({
        title: `Aplicar Atacado • ${unique.length} item(ns)`,
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
        }),
      });

      state.currentJobId = String(payload?.job_id || "");
      state.currentJobKind = "atacado";
      notifyCreditWalletChanged();
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
    state.currentJobKind = null;
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
      await enqueueWholesaleJob(ids);
    });
    $("#btnApplyFiltered").addEventListener("click", async () => {
      if (!state.filtered.length) return;
      await enqueueWholesaleJob(state.filtered.map((row) => row.id));
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    bindEvents();
    syncTierConfig();
    updateSpecificIdsStatus();
    setLoadModeBadge("none");
    updateStats();
    applyAtacadoPanelVisibilityFilter();
    window.JobsPanel?.setCancelHandler?.(cancelJobFromPanel);

    try {
      const recovered = await recoverActiveLoadJob();
      if (!recovered) startJobsPanelSync();
    } catch (error) {
      console.warn("Falha ao recuperar carga ativa do atacado:", error.message);
      clearPersistedActiveLoadJob();
      state.currentJobId = null;
      state.currentJobKind = null;
      setLoading(false, "Pronto.");
      startJobsPanelSync();
    }
  });

  window.addEventListener("beforeunload", () => {
    stopJobsPolling();
    stopJobsPanelSync();
  });
})();
