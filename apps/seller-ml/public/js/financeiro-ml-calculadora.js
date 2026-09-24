(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const pct = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rules = window.MLCalculatorRules;

  const state = {
    mode: "listing",
    accountTaxPct: 0,
    lookupQuery: "",
    candidates: [],
    selected: null,
    shippingMode: "mercado_envios",
    busy: false,
    recalculateAfterBusy: false,
    categorySuggestions: [],
    categorySearchRevision: 0,
    categorySearchTimer: null,
  };

  function api(path) {
    if (window.ML?.url) return window.ML.url(path);
    if (typeof window.mlUrl === "function") return window.mlUrl(path);
    return path;
  }

  function n(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function fmtMoney(value) {
    return money.format(n(value));
  }

  function fmtPct(value) {
    return `${pct.format(n(value))}%`;
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  function setFeedback(message, tone = "") {
    const el = $("calc-feedback");
    if (!el) return;
    el.textContent = message || "";
    if (tone) el.dataset.tone = tone;
    else el.removeAttribute("data-tone");
  }

  function setBadge(id, text, tone = "neutral") {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.dataset.tone = tone;
  }

  async function fetchJson(path, options = {}) {
    const response = await fetch(api(path), {
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.success === false) {
      const error = new Error(data?.error || `Falha HTTP ${response.status}`);
      error.details = data?.details || null;
      throw error;
    }
    return data;
  }

  function setBusy(active, message = "Calculando...", { overlay = true, disableControls = overlay } = {}) {
    state.busy = !!active;
    if (disableControls) {
      [$("calc-lookup-button"), $("calc-reset")].filter(Boolean).forEach((button) => {
        button.disabled = state.busy;
      });
    }
    if (state.busy && overlay) {
      window.MLLoadingOverlay?.show({
        context: "Calculadora de margem",
        label: "Precificação",
        message,
        texts: [message, "Consultando comissão e custos...", "Calculando margem e preço-alvo..."],
        initialProgress: 20,
        maxProgress: 91,
      });
    } else if (overlay) {
      window.MLLoadingOverlay?.hide();
    }
  }

  function inputValue(id, fallback = 0) {
    return n($(id)?.value, fallback);
  }

  function setInput(id, value) {
    const el = $(id);
    if (!el) return;
    el.value = value == null ? "" : String(value);
  }

  function syncFeeInputs() {
    const loaded = isLoadedListing();
    const manual = state.mode === "manual";
    if ($("calc-commission-pct")) $("calc-commission-pct").disabled = manual || loaded;
    if ($("calc-commission-fixed")) $("calc-commission-fixed").disabled = manual || loaded;
    const categoryWrap = $("calc-category-wrap");
    if (categoryWrap) categoryWrap.hidden = !manual;
    if ($("calc-category-query")) $("calc-category-query").disabled = loaded;
    if ($("calc-category-id")) $("calc-category-id").disabled = loaded;
    const manualQuote = rules.manualFeeMode({
      price: inputValue("calc-price"),
      categoryId: $("calc-category-id")?.value || "",
      listingTypeId: $("calc-listing-type")?.value || "gold_special",
    });
    setBadge(
      "calc-fee-mode",
      loaded ? "Comissão Mercado Livre" : manual ? manualQuote.quote ? "Consultando comissão…" : "Comissão estimada" : "Comissão manual",
      loaded ? "info" : manual ? manualQuote.quote ? "neutral" : "estimate" : "neutral",
    );
  }

  function applyManualListingFee() {
    if (state.mode !== "manual") return;
    const fee = rules.manualListingFee($("calc-listing-type")?.value);
    setInput("calc-commission-pct", fee.commissionRatePct);
    setInput("calc-commission-fixed", fee.commissionFixed);
  }

  function clearCategorySuggestions() {
    const list = $("calc-category-suggestions");
    if (list) {
      list.replaceChildren();
      list.hidden = true;
    }
    $("calc-category-query")?.setAttribute("aria-expanded", "false");
    state.categorySuggestions = [];
  }

  function selectCategorySuggestion(row) {
    if (!row?.id || state.mode !== "manual") return;
    state.categorySearchRevision += 1;
    setInput("calc-category-query", row.name);
    setInput("calc-category-id", row.id);
    clearCategorySuggestions();
    applyManualListingFee();
    syncFeeInputs();
    scheduleCalculation();
  }

  function renderCategorySuggestions(rows = []) {
    const list = $("calc-category-suggestions");
    if (!list) return;
    state.categorySuggestions = Array.isArray(rows) ? rows : [];
    list.replaceChildren(...state.categorySuggestions.map((row, index) => {
      const option = document.createElement("li");
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      option.dataset.index = String(index);
      option.tabIndex = -1;
      option.textContent = row.domain_name && row.domain_name !== row.name
        ? `${row.name} · ${row.domain_name}`
        : row.name;
      option.addEventListener("click", () => selectCategorySuggestion(row));
      return option;
    }));
    list.hidden = !state.categorySuggestions.length;
    $("calc-category-query")?.setAttribute("aria-expanded", state.categorySuggestions.length ? "true" : "false");
  }

  function scheduleCategorySearch() {
    if (state.categorySearchTimer) window.clearTimeout(state.categorySearchTimer);
    const query = String($("calc-category-query")?.value || "").trim();
    if (query.length < 3) {
      clearCategorySuggestions();
      return;
    }
    state.categorySearchTimer = window.setTimeout(async () => {
      const revision = ++state.categorySearchRevision;
      try {
        const params = new URLSearchParams({ q: query });
        const payload = await fetchJson(`/api/financeiro-ml/calculator/categories?${params.toString()}`);
        if (revision !== state.categorySearchRevision || state.mode !== "manual") return;
        renderCategorySuggestions(payload.categories);
      } catch (_error) {
        if (revision === state.categorySearchRevision) clearCategorySuggestions();
      }
    }, 300);
  }

  function isLoadedListing() {
    return state.mode === "listing" && Boolean(state.selected?.item_id);
  }

  function syncListingTypeControl() {
    const value = $("calc-listing-type")?.value || "gold_special";
    const locked = state.mode !== "manual" || isLoadedListing();
    document.querySelectorAll("[data-listing-type]").forEach((button) => {
      const active = button.dataset.listingType === value;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
      button.disabled = locked;
    });
  }

  function setListingType(value) {
    const select = $("calc-listing-type");
    if (!select || state.mode !== "manual" || isLoadedListing()) return;
    select.value = value === "gold_pro" ? "gold_pro" : "gold_special";
    applyManualListingFee();
    syncListingTypeControl();
    syncFeeInputs();
    scheduleCalculation();
  }

  function syncShippingMode(mode = state.shippingMode) {
    state.shippingMode = mode === "comprador" ? "comprador" : "mercado_envios";
    const visible = rules.shippingVisibility(state.shippingMode);
    if ($("calc-seller-shipping-wrap")) $("calc-seller-shipping-wrap").hidden = !visible.seller;
    if ($("calc-buyer-shipping-wrap")) $("calc-buyer-shipping-wrap").hidden = !visible.buyer;
    document.querySelectorAll("[data-shipping-mode]").forEach((button) => {
      const active = button.dataset.shippingMode === state.shippingMode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function setMode(mode) {
    state.mode = mode === "manual" ? "manual" : "listing";
    document.querySelectorAll("[data-calc-mode]").forEach((button) => {
      const active = button.dataset.calcMode === state.mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll('[data-mode-panel="listing"]').forEach((panel) => {
      panel.hidden = state.mode !== "listing";
    });
    if (state.mode === "manual") {
      state.selected = null;
      setInput("calc-item-id", "");
      setInput("calc-variation-id", "");
      setInput("calc-reference-sku", "");
      setInput("calc-category-query", "");
      setInput("calc-category-id", "");
      clearCategorySuggestions();
      applyManualListingFee();
      setBadge("calc-lookup-badge", "Manual", "neutral");
      syncFeeInputs();
    } else if (state.selected) {
      syncFeeInputs();
    }
    syncListingTypeControl();
    scheduleCalculation();
  }

  async function loadAccountTax() {
    try {
      const payload = await fetchJson("/api/financeiro-ml/settings/tax");
      state.accountTaxPct = n(payload?.config?.aliquota);
      const option = $("calc-tax-preset")?.querySelector('option[value="account"]');
      if (option) option.textContent = `Alíquota da conta (${state.accountTaxPct.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%)`;
      if ($("calc-tax-preset")?.value === "account") setInput("calc-tax-pct", state.accountTaxPct);
    } catch (_error) {
      state.accountTaxPct = 0;
    }
  }

  function applyTaxPreset() {
    const preset = $("calc-tax-preset")?.value || "account";
    const taxInput = $("calc-tax-pct");
    if (!taxInput) return;
    if (preset === "custom") {
      taxInput.disabled = false;
      taxInput.focus();
      return;
    }
    taxInput.disabled = true;
    setInput("calc-tax-pct", preset === "account" ? state.accountTaxPct : n(preset));
  }

  function renderCandidates(candidates = [], selected = null) {
    state.candidates = Array.isArray(candidates) ? candidates : [];
    const wrap = $("calc-variation-wrap");
    const select = $("calc-variation-select");
    if (!wrap || !select) return;
    const needsChoice = state.candidates.length > 1;
    wrap.hidden = !needsChoice;
    select.replaceChildren(...state.candidates.map((row) => {
      const label = [row.variation_label, row.reference_sku, row.price ? fmtMoney(row.price) : ""].filter(Boolean).join(" · ");
      const option = document.createElement("option");
      option.value = String(row.variation_id || "");
      option.textContent = label;
      return option;
    }));
    if (selected && needsChoice) select.value = String(selected.variation_id || "");
  }

  function applyLoadedItem(payload) {
    const row = payload?.selected;
    if (!row) return;
    state.selected = row;
    state.accountTaxPct = n(row.tax_rate_pct, state.accountTaxPct);
    renderCandidates(payload.candidates, row);

    setInput("calc-item-id", row.item_id);
    setInput("calc-variation-id", row.variation_id);
    setInput("calc-reference-sku", row.reference_sku);
    setInput("calc-price", row.price);
    setInput("calc-product-cost", row.product_cost);
    const listingSelect = $("calc-listing-type");
    if (listingSelect && row.listing_type_id && !Array.from(listingSelect.options).some((option) => option.value === row.listing_type_id)) {
      const option = document.createElement("option");
      option.value = row.listing_type_id;
      option.textContent = row.listing_type_label || row.listing_type_id;
      listingSelect.appendChild(option);
    }
    setInput("calc-listing-type", row.listing_type_id || "gold_special");
    setInput("calc-category-query", row.category_id);
    setInput("calc-category-id", row.category_id);
    setInput("calc-commission-pct", row.commission_rate_pct);
    setInput("calc-commission-fixed", row.commission_fixed);
    setInput("calc-seller-shipping", row.seller_shipping);
    setInput("calc-buyer-shipping", 0);
    setInput("calc-tax-pct", row.tax_rate_pct);
    if ($("calc-tax-preset")) $("calc-tax-preset").value = "account";
    applyTaxPreset();

    syncFeeInputs();
    syncListingTypeControl();
    syncShippingMode(row.free_shipping ? "mercado_envios" : "comprador");

    const itemBox = $("calc-loaded-item");
    if (itemBox) itemBox.hidden = false;
    const image = $("calc-item-image");
    if (image) {
      image.src = row.thumbnail || "";
      image.hidden = !row.thumbnail;
    }
    setText("calc-item-title", row.title || row.item_id);
    setText("calc-item-meta", [row.item_id, row.reference_sku || "Sem SKU", row.variation_label || ""].filter(Boolean).join(" · "));
    setText("calc-item-source", `${row.listing_type_label || row.listing_type_id || "Anúncio"} · comissão ${fmtMoney(row.commission)} · frete vendedor ${fmtMoney(row.seller_shipping)}`);
    setBadge("calc-lookup-badge", "Carregado", "positive");
    setFeedback(payload.note || "Anúncio carregado. Os resultados serão atualizados automaticamente.", "ok");
    scheduleCalculation();
  }

  async function lookup(variationId = "") {
    const query = String($("calc-lookup-input")?.value || state.lookupQuery || "").trim();
    if (!query) {
      setFeedback("Informe um MLB ou SKU.", "error");
      return;
    }
    state.lookupQuery = query;
    setBusy(true, "Carregando anúncio e tarifas do Mercado Livre...");
    setBadge("calc-lookup-badge", "Carregando", "info");
    try {
      const params = new URLSearchParams({ q: query });
      if (variationId) params.set("variation_id", variationId);
      const payload = await fetchJson(`/api/financeiro-ml/calculator/lookup?${params.toString()}`);
      applyLoadedItem(payload);
    } catch (error) {
      setBadge("calc-lookup-badge", "Falha", "negative");
      setFeedback(error.message || "Falha ao carregar anúncio.", "error");
    } finally {
      setBusy(false);
    }
  }

  function buildPayload() {
    const loaded = isLoadedListing();
    const categoryId = loaded
      ? state.selected?.category_id || $("calc-category-id")?.value || ""
      : $("calc-category-id")?.value || "";
    const autoFee = loaded || rules.canQuoteMarketplaceFee({
      price: inputValue("calc-price"),
      categoryId,
      listingTypeId: $("calc-listing-type")?.value || "",
    });
    const shippingMode = state.shippingMode;
    return {
      mode: state.mode,
      item_id: $("calc-item-id")?.value || "",
      variation_id: $("calc-variation-id")?.value || "",
      reference_sku: $("calc-reference-sku")?.value || "",
      price: inputValue("calc-price"),
      product_cost: inputValue("calc-product-cost"),
      listing_type_id: $("calc-listing-type")?.value || "",
      category_id: String(categoryId).trim(),
      use_ml_fee: autoFee,
      shipping_mode: state.selected?.shipping_mode || "",
      logistic_type: state.selected?.logistic_type || "",
      shipping_dimensions: state.selected?.shipping_dimensions || "",
      shipping_weight: state.selected?.shipping_weight ?? null,
      commission_rate_pct: inputValue("calc-commission-pct"),
      commission_fixed: inputValue("calc-commission-fixed"),
      tax_rate_pct: inputValue("calc-tax-pct"),
      seller_shipping: shippingMode === "mercado_envios" ? inputValue("calc-seller-shipping") : 0,
      buyer_shipping_taxable: shippingMode === "comprador" ? inputValue("calc-buyer-shipping") : 0,
      operation_cost: inputValue("calc-operation-cost"),
      other_costs: inputValue("calc-other-costs"),
      target_margin_pct: String($("calc-target-margin")?.value || "").trim(),
    };
  }

  function renderResult(payload = {}) {
    const result = payload.result || {};
    const inputs = payload.inputs || {};
    const targetMargin = inputs.target_margin_pct;
    const profit = n(result.profit);
    const positive = profit >= 0;
    const hero = document.querySelector(".calc-result-hero");
    if (hero) hero.dataset.tone = positive ? "positive" : "negative";

    setText("calc-result-profit", fmtMoney(profit));
    setText("calc-result-margin", fmtPct(result.margin_pct));
    setText("calc-result-roi", result.roi_pct == null ? "--" : fmtPct(result.roi_pct));
    setText("calc-result-equilibrium", result.equilibrium_price == null ? "--" : fmtMoney(result.equilibrium_price));
    setText("calc-result-target", result.target_price == null ? "--" : fmtMoney(result.target_price));
    setText("calc-target-label", targetMargin == null ? "Preço para a meta" : `Preço para ${pct.format(targetMargin)}%`);
    setText("calc-result-caption", positive ? "Resultado estimado por unidade vendida." : "A simulação indica prejuízo por unidade neste preço.");

    const statusMap = {
      abaixo: ["Abaixo da meta", "warning"],
      acima: ["Acima da meta", "positive"],
      na_meta: ["Na meta", "positive"],
      sem_meta: [positive ? "Lucro positivo" : "Prejuízo", positive ? "positive" : "negative"],
    };
    const [label, tone] = statusMap[result.target_status] || statusMap.sem_meta;
    setBadge("calc-result-status", label, tone);

    const callout = $("calc-target-callout");
    if (callout) callout.hidden = targetMargin == null || result.target_price == null;
    if (targetMargin != null && result.target_price != null) {
      const delta = n(result.target_delta);
      setText("calc-result-target-delta", `${delta >= 0 ? "+ " : "- "}${fmtMoney(Math.abs(delta))}`);
      setText(
        "calc-result-target-text",
        result.target_status === "abaixo"
          ? `Para atingir ${pct.format(targetMargin)}% de margem, o preço estimado precisa subir para ${fmtMoney(result.target_price)}.`
          : result.target_status === "acima"
            ? `O preço atual já supera a meta de ${pct.format(targetMargin)}%. O valor calculado indica o piso aproximado para essa margem.`
            : `O preço atual está praticamente alinhado à meta de ${pct.format(targetMargin)}%.`,
      );
    }

    setText("calc-breakdown-price", fmtMoney(result.price));
    setText("calc-breakdown-product", fmtMoney(result.product_cost));
    setText("calc-breakdown-commission", `${fmtMoney(result.commission)} (${pct.format(result.commission_rate_pct)}% + ${fmtMoney(result.commission_fixed)})`);
    setText("calc-breakdown-tax", `${fmtMoney(result.taxes)} (${pct.format(result.tax_rate_pct)}%)`);
    setText("calc-breakdown-shipping", fmtMoney(result.seller_shipping));
    setText("calc-breakdown-operation", fmtMoney(result.operation_cost));
    setText("calc-breakdown-other", fmtMoney(result.other_costs));
    setText("calc-breakdown-total", fmtMoney(result.total_costs));
    setText("calc-result-note", payload.note || "Simulação concluída. Nenhum preço foi alterado no Mercado Livre.");
    if (state.mode === "manual") {
      if (payload.fee_mode === "mercado_livre") {
        setInput("calc-commission-pct", payload.commission?.rate_pct);
        setInput("calc-commission-fixed", payload.commission?.fixed);
        setBadge("calc-fee-mode", "Comissão Mercado Livre", "info");
      } else {
        setBadge("calc-fee-mode", "Comissão estimada", "estimate");
      }
    }
  }

  const calculationScheduler = rules.createCalculationScheduler(() => {
    if (state.busy) {
      state.recalculateAfterBusy = true;
      return;
    }
    calculate(null, { automatic: true });
  });

  function scheduleCalculation() {
    if (!(inputValue("calc-price") > 0)) return;
    calculationScheduler.schedule();
  }

  async function calculate(event, { automatic = false } = {}) {
    event?.preventDefault?.();
    if (state.busy) {
      state.recalculateAfterBusy = true;
      return;
    }
    const payload = buildPayload();
    if (!(payload.price > 0)) {
      setFeedback("Informe um preço de venda maior que zero.", "error");
      return;
    }
    if (payload.target_margin_pct !== "" && n(payload.target_margin_pct) >= 95) {
      setFeedback("A margem desejada deve ser menor que 95%.", "error");
      return;
    }
    setBusy(true, "Calculando margem, custos e preço-alvo...", { overlay: !automatic, disableControls: !automatic });
    if (!automatic) setFeedback("Calculando...", "");
    try {
      const result = await fetchJson("/api/financeiro-ml/calculator/calculate", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      renderResult(result);
      setFeedback(automatic ? "Resultados atualizados automaticamente." : "Simulação atualizada.", "ok");
    } catch (error) {
      setFeedback(error.message || "Falha ao calcular.", "error");
    } finally {
      setBusy(false, "", { overlay: !automatic, disableControls: !automatic });
      if (state.recalculateAfterBusy) {
        state.recalculateAfterBusy = false;
        scheduleCalculation();
      }
    }
  }

  function resetForm() {
    state.selected = null;
    state.candidates = [];
    state.lookupQuery = "";
    $("calc-form")?.reset();
    setInput("calc-product-cost", 0);
    setInput("calc-commission-pct", 0);
    setInput("calc-commission-fixed", 0);
    setInput("calc-seller-shipping", 0);
    setInput("calc-buyer-shipping", 0);
    setInput("calc-operation-cost", 0);
    setInput("calc-other-costs", 0);
    setInput("calc-item-id", "");
    setInput("calc-variation-id", "");
    setInput("calc-reference-sku", "");
    setInput("calc-category-query", "");
    setInput("calc-category-id", "");
    clearCategorySuggestions();
    if ($("calc-tax-preset")) $("calc-tax-preset").value = "account";
    applyTaxPreset();
    if ($("calc-loaded-item")) $("calc-loaded-item").hidden = true;
    if ($("calc-variation-wrap")) $("calc-variation-wrap").hidden = true;
    syncShippingMode("mercado_envios");
    setBadge("calc-lookup-badge", state.mode === "manual" ? "Manual" : "Não carregado", "neutral");
    applyManualListingFee();
    syncFeeInputs();
    syncListingTypeControl();
    setText("calc-result-profit", "R$ 0,00");
    setText("calc-result-margin", "0,00%");
    setText("calc-result-roi", "--");
    setText("calc-result-equilibrium", "--");
    setText("calc-result-target", "--");
    setText("calc-target-label", "Preço para a meta");
    setText("calc-result-caption", "Preencha os dados para ver o resultado automaticamente.");
    setBadge("calc-result-status", "Aguardando", "neutral");
    if ($("calc-target-callout")) $("calc-target-callout").hidden = true;
    ["calc-breakdown-price", "calc-breakdown-product", "calc-breakdown-commission", "calc-breakdown-tax", "calc-breakdown-shipping", "calc-breakdown-operation", "calc-breakdown-other", "calc-breakdown-total"].forEach((id) => setText(id, "R$ 0,00"));
    setText("calc-result-note", "A calculadora não altera preços ou estoque da conta.");
    setFeedback("");
  }

  function bindEvents() {
    document.querySelectorAll("[data-calc-mode]").forEach((button) => {
      button.addEventListener("click", () => setMode(button.dataset.calcMode));
    });
    $("calc-lookup-button")?.addEventListener("click", () => lookup());
    $("calc-lookup-input")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        lookup();
      }
    });
    $("calc-variation-select")?.addEventListener("change", (event) => lookup(event.target.value));
    $("calc-tax-preset")?.addEventListener("change", () => {
      applyTaxPreset();
      scheduleCalculation();
    });
    document.querySelectorAll("[data-listing-type]").forEach((button) => {
      button.addEventListener("click", () => setListingType(button.dataset.listingType));
    });
    $("calc-category-query")?.addEventListener("input", () => {
      if (state.mode !== "manual") return;
      state.categorySearchRevision += 1;
      setInput("calc-category-id", "");
      applyManualListingFee();
      syncFeeInputs();
      scheduleCategorySearch();
    });
    $("calc-category-query")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && state.categorySuggestions.length) {
        event.preventDefault();
        selectCategorySuggestion(state.categorySuggestions[0]);
      } else if (event.key === "Escape") {
        clearCategorySuggestions();
      }
    });
    document.querySelectorAll("[data-shipping-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        syncShippingMode(button.dataset.shippingMode);
        scheduleCalculation();
      });
    });
    $("calc-form")?.addEventListener("submit", calculate);
    $("calc-form")?.addEventListener("input", (event) => {
      if (event.target.id === "calc-price" && state.mode === "manual") {
        applyManualListingFee();
        syncFeeInputs();
      }
      if (event.target.matches("input, select")) scheduleCalculation();
    });
    $("calc-form")?.addEventListener("change", (event) => {
      if (event.target.matches("input, select")) scheduleCalculation();
    });
    $("calc-reset")?.addEventListener("click", resetForm);
  }

  document.addEventListener("DOMContentLoaded", async () => {
    bindEvents();
    await loadAccountTax();
    applyTaxPreset();
    syncFeeInputs();
    syncListingTypeControl();
    syncShippingMode();
    setMode("listing");
  });
})();
