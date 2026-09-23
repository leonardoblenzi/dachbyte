(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const pct = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const state = {
    mode: "listing",
    accountTaxPct: 0,
    lookupQuery: "",
    candidates: [],
    selected: null,
    busy: false,
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

  function setBusy(active, message = "Calculando...") {
    state.busy = !!active;
    [$("calc-lookup-button"), $("calc-submit"), $("calc-reset")].filter(Boolean).forEach((button) => {
      button.disabled = state.busy;
    });
    if (state.busy) {
      window.MLLoadingOverlay?.show({
        context: "Calculadora de margem",
        label: "Precificação",
        message,
        texts: [message, "Consultando comissão e custos...", "Calculando margem e preço-alvo..."],
        initialProgress: 20,
        maxProgress: 91,
      });
    } else {
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
    const auto = !!$("calc-use-ml-fee")?.checked;
    const hasSource = Boolean($("calc-category")?.value && $("calc-listing-type")?.value);
    if ($("calc-use-ml-fee")) $("calc-use-ml-fee").disabled = !hasSource;
    const locked = auto && hasSource;
    if ($("calc-commission-pct")) $("calc-commission-pct").disabled = locked;
    if ($("calc-commission-fixed")) $("calc-commission-fixed").disabled = locked;
    setBadge("calc-fee-mode", locked ? "Comissão Mercado Livre" : "Comissão manual", locked ? "info" : "neutral");
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
      setInput("calc-item-id", "");
      setInput("calc-variation-id", "");
      setInput("calc-reference-sku", "");
      $("calc-use-ml-fee").checked = false;
      setBadge("calc-lookup-badge", "Manual", "neutral");
      syncFeeInputs();
    } else if (state.selected) {
      $("calc-use-ml-fee").checked = true;
      syncFeeInputs();
    }
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
    setInput("calc-category", row.category_id);
    setInput("calc-commission-pct", row.commission_rate_pct);
    setInput("calc-commission-fixed", row.commission_fixed);
    setInput("calc-seller-shipping", row.seller_shipping);
    setInput("calc-buyer-shipping", 0);
    setInput("calc-tax-pct", row.tax_rate_pct);
    if ($("calc-tax-preset")) $("calc-tax-preset").value = "account";
    applyTaxPreset();

    if ($("calc-use-ml-fee")) $("calc-use-ml-fee").checked = true;
    syncFeeInputs();

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
    setFeedback(payload.note || "Anúncio carregado. Revise os campos e calcule.", "ok");
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
    const autoFee = !!$("calc-use-ml-fee")?.checked;
    return {
      mode: state.mode,
      item_id: $("calc-item-id")?.value || "",
      variation_id: $("calc-variation-id")?.value || "",
      reference_sku: $("calc-reference-sku")?.value || "",
      price: inputValue("calc-price"),
      product_cost: inputValue("calc-product-cost"),
      listing_type_id: $("calc-listing-type")?.value || "",
      category_id: String($("calc-category")?.value || "").trim(),
      use_ml_fee: autoFee,
      shipping_mode: state.selected?.shipping_mode || "",
      logistic_type: state.selected?.logistic_type || "",
      shipping_dimensions: state.selected?.shipping_dimensions || "",
      shipping_weight: state.selected?.shipping_weight ?? null,
      commission_rate_pct: inputValue("calc-commission-pct"),
      commission_fixed: inputValue("calc-commission-fixed"),
      tax_rate_pct: inputValue("calc-tax-pct"),
      seller_shipping: inputValue("calc-seller-shipping"),
      buyer_shipping_taxable: inputValue("calc-buyer-shipping"),
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
  }

  async function calculate(event) {
    event?.preventDefault?.();
    const payload = buildPayload();
    if (!(payload.price > 0)) {
      setFeedback("Informe um preço de venda maior que zero.", "error");
      return;
    }
    if (payload.target_margin_pct !== "" && n(payload.target_margin_pct) >= 95) {
      setFeedback("A margem desejada deve ser menor que 95%.", "error");
      return;
    }
    setBusy(true, "Calculando margem, custos e preço-alvo...");
    setFeedback("Calculando...", "");
    try {
      const result = await fetchJson("/api/financeiro-ml/calculator/calculate", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      renderResult(result);
      setFeedback("Simulação atualizada.", "ok");
    } catch (error) {
      setFeedback(error.message || "Falha ao calcular.", "error");
    } finally {
      setBusy(false);
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
    if ($("calc-tax-preset")) $("calc-tax-preset").value = "account";
    applyTaxPreset();
    if ($("calc-loaded-item")) $("calc-loaded-item").hidden = true;
    if ($("calc-variation-wrap")) $("calc-variation-wrap").hidden = true;
    setBadge("calc-lookup-badge", state.mode === "manual" ? "Manual" : "Não carregado", "neutral");
    syncFeeInputs();
    setText("calc-result-profit", "R$ 0,00");
    setText("calc-result-margin", "0,00%");
    setText("calc-result-roi", "--");
    setText("calc-result-equilibrium", "--");
    setText("calc-result-target", "--");
    setText("calc-target-label", "Preço para a meta");
    setText("calc-result-caption", "Preencha os dados e calcule para ver o resultado.");
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
    $("calc-tax-preset")?.addEventListener("change", applyTaxPreset);
    $("calc-use-ml-fee")?.addEventListener("change", syncFeeInputs);
    $("calc-category")?.addEventListener("input", syncFeeInputs);
    $("calc-listing-type")?.addEventListener("change", syncFeeInputs);
    $("calc-form")?.addEventListener("submit", calculate);
    $("calc-reset")?.addEventListener("click", resetForm);
  }

  document.addEventListener("DOMContentLoaded", async () => {
    bindEvents();
    await loadAccountTax();
    applyTaxPreset();
    syncFeeInputs();
    setMode("listing");
  });
})();
