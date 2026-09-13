(function (global) {
  "use strict";

  const state = {
    module: "create",
    workspaceOpen: false,
    analysisId: null,
    analysis: null,
    selected: new Set(),
    filter: "safe",
    pollTimer: null,
    polling: false,
    pollFailures: 0,
  };

  const $ = (id) => document.getElementById(id);

  function apiUrl(path) {
    if (typeof global.withBase === "function") return global.withBase(path);
    if (global.ML?.url) return global.ML.url(path);
    return path;
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function pct(value) {
    const n = num(value);
    if (n == null) return "—";
    return `${n.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%`;
  }

  function money(value) {
    const n = num(value);
    if (n == null) return "—";
    return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function pp(value, prefix = true) {
    const n = num(value);
    if (n == null) return "—";
    const text = n.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    return `${prefix && n > 0 ? "+" : ""}${text} p.p.`;
  }

  function formatDate(value) {
    if (!value) return "—";
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return String(value);
    return d.toLocaleDateString("pt-BR");
  }

  function statusLabel(value) {
    const s = String(value || "").toLowerCase();
    if (s === "started") return "Ativa";
    if (s === "pending") return "Pendente";
    if (s === "scheduled" || s === "programmed") return "Programada";
    return s || "—";
  }

  function notify(message, tone) {
    if (typeof global.notifyPromocoes === "function") {
      global.notifyPromocoes(message, tone);
      return;
    }
    if (tone === "error") console.error(message);
    else console.log(message);
  }

  function currentAccount() {
    const acc = global.__ACCOUNT__ || global.AccountBar?.current?.() || {};
    return { key: acc?.key || "", label: acc?.label || acc?.key || "Conta selecionada" };
  }

  async function refreshAccountLabel() {
    try {
      const acc = await (global.AccountBar?.ensure?.() || Promise.resolve(global.__ACCOUNT__ || {}));
      if ($("smartOptimizerAccountLabel")) {
        $("smartOptimizerAccountLabel").textContent = acc?.label || acc?.key || "Conta selecionada";
      }
    } catch {
      const acc = currentAccount();
      if ($("smartOptimizerAccountLabel")) $("smartOptimizerAccountLabel").textContent = acc.label;
    }
  }

  function setModule(module, { updateUrl = true } = {}) {
    const next = module === "intelligence" ? "intelligence" : "create";
    state.module = next;
    $("promoCreateModule")?.classList.toggle("hidden", next !== "create");
    $("promoIntelligenceModule")?.classList.toggle("hidden", next !== "intelligence");

    document.querySelectorAll(".promo-module-nav [data-promo-module]").forEach((link) => {
      const active = link.dataset.promoModule === next;
      link.classList.toggle("is-active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });

    if (next === "intelligence") {
      refreshAccountLabel();
    }

    if (updateUrl) {
      const url = new URL(global.location.href);
      if (next === "intelligence") url.searchParams.set("modulo", "inteligencia");
      else url.searchParams.delete("modulo");
      history.pushState({ promoModule: next }, "", url);
    }
  }

  function setWorkspace(open) {
    state.workspaceOpen = !!open;
    $("promoIntelligenceHub")?.classList.toggle("hidden", !!open);
    $("smartOptimizerWorkspace")?.classList.toggle("hidden", !open);
    if (open) refreshAccountLabel();
  }

  function setStep(step) {
    document.querySelectorAll("[data-smart-step]").forEach((node) => {
      node.classList.toggle("is-active", node.dataset.smartStep === step);
    });
  }

  async function request(url, options = {}) {
    const response = await fetch(apiUrl(url), {
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
      const error = new Error(data?.error || data?.message || `HTTP ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  function stopPolling() {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
    state.polling = false;
  }

  function schedulePoll(delay = 1800) {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(() => pollAnalysis(), delay);
  }

  function renderProgress(data = {}) {
    const progress = Math.max(0, Math.min(100, Number(data.progress || 0)));
    const phaseMap = {
      campaigns: "Buscando campanhas SMART da conta…",
      items: "Lendo anúncios das campanhas SMART…",
      enrichment: "Carregando dados dos anúncios…",
      analysis: "Comparando vigências e participação ML x vendedor…",
      completed: "Análise concluída.",
    };
    $("smartOptimizerProgress")?.classList.remove("hidden");
    if ($("smartOptimizerProgressPct")) $("smartOptimizerProgressPct").textContent = `${Math.round(progress)}%`;
    if ($("smartOptimizerProgressFill")) $("smartOptimizerProgressFill").style.width = `${progress}%`;
    if ($("smartOptimizerProgressText")) {
      $("smartOptimizerProgressText").textContent = phaseMap[data.phase] || "Analisando campanhas SMART…";
    }
    const bits = [];
    if (data.current_campaign) bits.push(`Campanha: ${data.current_campaign}`);
    if (num(data.processed) != null && num(data.total) != null && Number(data.total) > 0) {
      bits.push(`${Number(data.processed).toLocaleString("pt-BR")}/${Number(data.total).toLocaleString("pt-BR")} campanhas`);
    }
    if (Number(data.item_rows_scanned || 0) > 0) {
      bits.push(`${Number(data.item_rows_scanned).toLocaleString("pt-BR")} linhas lidas`);
    }
    if ($("smartOptimizerProgressMeta")) {
      $("smartOptimizerProgressMeta").textContent = bits.join(" · ") || "A análise pode levar alguns minutos em contas com muitas campanhas.";
    }
  }

  async function runAnalysis() {
    stopPolling();
    state.analysisId = null;
    state.analysis = null;
    state.selected.clear();
    state.pollFailures = 0;
    setStep("analyze");
    $("smartOptimizerReview")?.classList.add("hidden");
    $("smartOptimizerConfirm")?.classList.add("hidden");
    $("smartOptimizerProgress")?.classList.remove("hidden");
    if ($("btnRunSmartAnalysis")) $("btnRunSmartAnalysis").disabled = true;
    if ($("smartOptimizerProgressText")) $("smartOptimizerProgressText").textContent = "Enviando análise ao worker…";
    if ($("smartOptimizerProgressPct")) $("smartOptimizerProgressPct").textContent = "0%";
    if ($("smartOptimizerProgressFill")) $("smartOptimizerProgressFill").style.width = "0%";

    try {
      await refreshAccountLabel();
      const data = await request("/api/promocoes/intelligence/smart/analyze", { method: "POST", body: "{}" });
      state.analysisId = data.analysis_id;
      schedulePoll(350);
    } catch (error) {
      notify(error.message || "Falha ao iniciar análise Smart.", "error");
      if ($("smartOptimizerProgressText")) $("smartOptimizerProgressText").textContent = `Falha: ${error.message}`;
      if ($("btnRunSmartAnalysis")) $("btnRunSmartAnalysis").disabled = false;
    }
  }

  async function pollAnalysis() {
    if (!state.analysisId || state.polling) return;
    state.polling = true;
    try {
      const data = await request(`/api/promocoes/intelligence/smart/analyses/${encodeURIComponent(state.analysisId)}`);
      state.pollFailures = 0;
      renderProgress(data);
      if (data.state === "completed" && data.result) {
        stopPolling();
        state.analysis = data.result;
        renderAnalysis(data.result);
        return;
      }
      if (data.state === "failed") {
        stopPolling();
        throw new Error(data.error || "A análise Smart falhou.");
      }
      schedulePoll(1800);
    } catch (error) {
      const status = Number(error?.status || 0);
      const transient = status === 0 || status === 429 || (status >= 500 && status <= 599);
      if (transient && state.analysisId && state.pollFailures < 4) {
        state.pollFailures += 1;
        if ($("smartOptimizerProgressText")) {
          $("smartOptimizerProgressText").textContent = "A análise continua no worker. Reconectando ao progresso…";
        }
        if ($("smartOptimizerProgressMeta")) {
          $("smartOptimizerProgressMeta").textContent = `Tentativa de reconexão ${state.pollFailures}/4.`;
        }
        schedulePoll(Math.min(7000, 1800 * state.pollFailures));
      } else {
        stopPolling();
        if ($("smartOptimizerProgressText")) $("smartOptimizerProgressText").textContent = `Falha: ${error.message}`;
        notify(error.message || "Falha ao acompanhar análise Smart.", "error");
        if ($("btnRunSmartAnalysis")) $("btnRunSmartAnalysis").disabled = false;
      }
    } finally {
      state.polling = false;
    }
  }

  function offerDetailsHtml(offer, title) {
    if (!offer) return "";
    return `<div class="smart-opportunity__offer">
      <strong>${esc(title)}</strong>
      <span>${esc(offer.promotion_name || offer.promotion_id || "SMART")}</span>
      <span>Vigência: ${esc(formatDate(offer.start_date))} a ${esc(formatDate(offer.finish_date))}</span>
      <span>Status: ${esc(statusLabel(offer.status))}</span>
      <span>Desconto: ${esc(pct(offer.total_discount_percentage))} · ML ${esc(pct(offer.meli_percentage))} · Seller ${esc(pct(offer.seller_percentage))}</span>
      <span>Preço final: ${esc(money(offer.final_price))}</span>
      <span>Offer: ${esc(offer.offer_id || "—")}</span>
    </div>`;
  }

  function groupSafeOpportunities(rows = []) {
    const groups = new Map();
    for (const opp of rows) {
      const itemId = String(opp?.item_id || "").trim().toUpperCase();
      if (!itemId) continue;
      if (!groups.has(itemId)) groups.set(itemId, []);
      groups.get(itemId).push(opp);
    }
    return [...groups.entries()].map(([itemId, opportunities]) => ({
      itemId,
      opportunities,
      first: opportunities[0] || {},
    }));
  }

  function safeGroupCard(group) {
    const opportunities = group?.opportunities || [];
    const first = group?.first || opportunities[0] || {};
    const ids = opportunities.map((opp) => String(opp.id));
    const selectedCount = ids.filter((id) => state.selected.has(id)).length;
    const checked = ids.length > 0 && selectedCount === ids.length;
    const title = first.title || group.itemId;
    const sku = first.sku || null;
    const removalsLabel = opportunities.length === 1 ? "1 Smart redundante" : `${opportunities.length} Smart redundantes`;
    const maxMeliGain = Math.max(...opportunities.map((opp) => num(opp.meli_gain_pp) || 0));
    const maxSellerGain = Math.max(...opportunities.map((opp) => num(opp.seller_gain_pp) || 0));

    return `<article class="smart-opportunity is-safe" data-smart-item="${esc(group.itemId)}">
      <div class="smart-opportunity__top">
        <input class="smart-opportunity__check" type="checkbox" data-smart-item-check="${esc(group.itemId)}" ${checked ? "checked" : ""} aria-label="Selecionar otimizações de ${esc(group.itemId)}">
        <div class="smart-opportunity__identity">
          <strong>${esc(group.itemId)} · ${esc(title)}</strong>
          <span>${sku ? `SKU ${esc(sku)} · ` : ""}${esc(removalsLabel)} podem ser removidas mantendo condições Smart equivalentes mais vantajosas.</span>
        </div>
        <span class="smart-opportunity__badge">Otimização segura</span>
      </div>
      <div class="smart-opportunity__summary">
        <div class="smart-opportunity__metric"><span>Smart a remover</span><strong>${opportunities.length.toLocaleString("pt-BR")}</strong></div>
        <div class="smart-opportunity__metric"><span>Maior ganho ML</span><strong class="is-positive">${esc(pp(maxMeliGain))}</strong></div>
        <div class="smart-opportunity__metric"><span>Maior redução vendedor</span><strong class="is-positive">${esc(pp(maxSellerGain))}</strong></div>
        <div class="smart-opportunity__metric"><span>Seleção</span><strong>${selectedCount}/${ids.length}</strong></div>
      </div>
      <details>
        <summary>Ver ${opportunities.length === 1 ? "comparação e vigência" : "comparações e vigências"}</summary>
        <div class="smart-opportunity__group-list">
          ${opportunities.map((opp, index) => `<div class="smart-opportunity__group-entry">
            <div class="smart-opportunity__group-entry-head">
              <strong>Otimização ${index + 1}</strong>
              <span>ML ${esc(pp(opp.meli_gain_pp))} · vendedor ${esc(pp(opp.seller_gain_pp))}</span>
            </div>
            <div class="smart-opportunity__compare">
              ${offerDetailsHtml(opp.current, "Remover")}
              ${offerDetailsHtml(opp.recommended, "Manter")}
            </div>
          </div>`).join("")}
        </div>
      </details>
    </article>`;
  }

  function reviewCard(review) {
    const offers = Array.isArray(review.offers) ? review.offers.slice(0, 8) : [];
    return `<article class="smart-opportunity is-review">
      <div class="smart-opportunity__top">
        <span></span>
        <div class="smart-opportunity__identity">
          <strong>${esc(review.item_id)} · ${esc(review.title || review.item_id)}</strong>
          <span>${review.sku ? `SKU ${esc(review.sku)}` : "Cenário não será alterado automaticamente."}</span>
        </div>
        <span class="smart-opportunity__badge">Revisar</span>
      </div>
      <ul class="smart-opportunity__reasons">${(review.reasons || []).map((reason) => `<li>${esc(reason)}</li>`).join("")}</ul>
      <details>
        <summary>Ver promoções sobrepostas</summary>
        <div class="smart-opportunity__compare">${offers.map((offer, index) => offerDetailsHtml(offer, `Smart ${index + 1}`)).join("")}</div>
      </details>
    </article>`;
  }

  function renderCurrentFilter() {
    const container = $("smartOptimizerResults");
    if (!container || !state.analysis) return;
    document.querySelectorAll("[data-smart-filter]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.smartFilter === state.filter);
    });
    $("smartSelectAllSafe")?.closest("label")?.classList.toggle("hidden", state.filter !== "safe");

    if (state.filter === "review") {
      const rows = Array.isArray(state.analysis.reviews) ? state.analysis.reviews : [];
      container.innerHTML = rows.length ? rows.map(reviewCard).join("") : '<div class="smart-optimizer-empty">Nenhum cenário pendente de revisão nesta análise.</div>';
      return;
    }

    const rows = Array.isArray(state.analysis.opportunities) ? state.analysis.opportunities : [];
    const groups = groupSafeOpportunities(rows);
    container.innerHTML = groups.length ? groups.map(safeGroupCard).join("") : '<div class="smart-optimizer-empty">Nenhuma otimização automática segura foi encontrada. Nenhuma promoção será removida.</div>';
  }

  function updateSelectedUi() {
    const totalSafe = Array.isArray(state.analysis?.opportunities) ? state.analysis.opportunities.length : 0;
    const selected = state.selected.size;
    if ($("smartOptimizerSelectedCount")) $("smartOptimizerSelectedCount").textContent = `${selected.toLocaleString("pt-BR")} selecionada${selected === 1 ? "" : "s"}`;
    if ($("btnPrepareSmartOptimization")) $("btnPrepareSmartOptimization").disabled = selected === 0;
    if ($("smartSelectAllSafe")) {
      $("smartSelectAllSafe").checked = totalSafe > 0 && selected === totalSafe;
      $("smartSelectAllSafe").indeterminate = selected > 0 && selected < totalSafe;
    }
  }

  function renderAnalysis(result) {
    state.analysis = result;
    state.filter = "safe";
    state.selected = new Set((result.opportunities || []).map((opp) => String(opp.id)));
    const summary = result.summary || {};
    if ($("smartStatCampaigns")) $("smartStatCampaigns").textContent = Number(summary.campaigns_analyzed || 0).toLocaleString("pt-BR");
    if ($("smartStatItems")) $("smartStatItems").textContent = Number(summary.items_analyzed || 0).toLocaleString("pt-BR");
    if ($("smartStatSafe")) $("smartStatSafe").textContent = Number(summary.safe_opportunities || 0).toLocaleString("pt-BR");
    if ($("smartStatReview")) $("smartStatReview").textContent = Number(summary.review_items || 0).toLocaleString("pt-BR");
    if ($("smartFilterSafeCount")) $("smartFilterSafeCount").textContent = Number(summary.safe_opportunities || 0).toLocaleString("pt-BR");
    if ($("smartFilterReviewCount")) $("smartFilterReviewCount").textContent = Number(summary.review_items || 0).toLocaleString("pt-BR");
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    if (warnings.length) {
      notify(
        `Análise concluída com ${warnings.length} campanha${warnings.length === 1 ? "" : "s"} ignorada${warnings.length === 1 ? "" : "s"} por resposta indisponível/incompatível do Mercado Livre.`,
        "warn",
      );
    }
    $("smartOptimizerReview")?.classList.remove("hidden");
    $("smartOptimizerConfirm")?.classList.add("hidden");
    setStep("review");
    renderCurrentFilter();
    updateSelectedUi();
    if ($("btnRunSmartAnalysis")) $("btnRunSmartAnalysis").disabled = false;
    $("smartOptimizerReview")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }

  function prepareOptimization() {
    if (!state.analysis || !state.selected.size) return;
    const count = state.selected.size;
    const selectedRows = (state.analysis.opportunities || []).filter((opp) => state.selected.has(String(opp.id)));
    const itemCount = new Set(selectedRows.map((opp) => String(opp.item_id || "").toUpperCase()).filter(Boolean)).size;
    if ($("smartOptimizerConfirmTitle")) {
      $("smartOptimizerConfirmTitle").textContent = `Otimizar ${count.toLocaleString("pt-BR")} Smart em ${itemCount.toLocaleString("pt-BR")} anúncio${itemCount === 1 ? "" : "s"}?`;
    }
    if ($("smartOptimizerConfirmText")) {
      $("smartOptimizerConfirmText").textContent = `${count.toLocaleString("pt-BR")} Smart menos vantajosa${count === 1 ? " será" : "s serão"} removida${count === 1 ? "" : "s"} de ${itemCount.toLocaleString("pt-BR")} anúncio${itemCount === 1 ? "" : "s"}, somente se cada condição recomendada continuar equivalente e mais vantajosa no momento da execução.`;
    }
    $("smartOptimizerConfirm")?.classList.remove("hidden");
    setStep("optimize");
    $("smartOptimizerConfirm")?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }

  async function confirmOptimization() {
    if (!state.analysisId || !state.selected.size) return;
    const button = $("btnConfirmSmartOptimization");
    if (button) button.disabled = true;
    try {
      const data = await request("/api/promocoes/intelligence/smart/optimize", {
        method: "POST",
        body: JSON.stringify({
          analysis_id: state.analysisId,
          opportunity_ids: [...state.selected],
        }),
      });
      const jobId = data.job_id;
      if (jobId && global.PromoJobTitleCache?.set) {
        global.PromoJobTitleCache.set(jobId, "Otimizando SMART por rebate");
      }
      global.JobsPanel?.show?.();
      global.PromoJobsWatcher?.start?.();
      notify(`Otimização Smart iniciada${jobId ? ` (${jobId})` : ""}. Acompanhe no painel de Processos.`, "success");
      $("smartOptimizerConfirm")?.classList.add("hidden");
      setStep("review");
      if ($("smartOptimizerAnalyzeHint")) {
        $("smartOptimizerAnalyzeHint").textContent = "Job de otimização iniciado. O painel lateral mostrará progresso, cancelamento e XLSX.";
      }
    } catch (error) {
      notify(error.message || "Falha ao iniciar otimização Smart.", "error");
    } finally {
      if (button) button.disabled = false;
    }
  }

  function bindEvents() {
    document.querySelectorAll(".promo-module-nav [data-promo-module]").forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        setModule(link.dataset.promoModule);
      });
    });

    $("btnOpenSmartOptimizer")?.addEventListener("click", () => {
      setWorkspace(true);
      setStep(state.analysis ? "review" : "analyze");
      if (state.analysis) renderAnalysis(state.analysis);
    });
    $("btnBackIntelligenceHub")?.addEventListener("click", () => setWorkspace(false));
    $("btnRunSmartAnalysis")?.addEventListener("click", runAnalysis);
    $("btnRerunSmartAnalysis")?.addEventListener("click", runAnalysis);

    document.querySelectorAll("[data-smart-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        state.filter = button.dataset.smartFilter === "review" ? "review" : "safe";
        renderCurrentFilter();
      });
    });

    $("smartOptimizerResults")?.addEventListener("change", (event) => {
      const itemInput = event.target?.closest?.("[data-smart-item-check]");
      if (itemInput) {
        const itemId = String(itemInput.dataset.smartItemCheck || "").toUpperCase();
        const itemRows = (state.analysis?.opportunities || []).filter((opp) => String(opp.item_id || "").toUpperCase() === itemId);
        for (const opp of itemRows) {
          const id = String(opp.id || "");
          if (!id) continue;
          if (itemInput.checked) state.selected.add(id);
          else state.selected.delete(id);
        }
        renderCurrentFilter();
        updateSelectedUi();
        return;
      }

      const input = event.target?.closest?.("[data-smart-opportunity-check]");
      if (!input) return;
      const id = String(input.dataset.smartOpportunityCheck || "");
      if (!id) return;
      if (input.checked) state.selected.add(id);
      else state.selected.delete(id);
      updateSelectedUi();
    });

    $("smartSelectAllSafe")?.addEventListener("change", (event) => {
      const rows = Array.isArray(state.analysis?.opportunities) ? state.analysis.opportunities : [];
      if (event.target.checked) state.selected = new Set(rows.map((opp) => String(opp.id)));
      else state.selected.clear();
      renderCurrentFilter();
      updateSelectedUi();
    });

    $("btnPrepareSmartOptimization")?.addEventListener("click", prepareOptimization);
    $("btnCancelSmartOptimization")?.addEventListener("click", () => {
      $("smartOptimizerConfirm")?.classList.add("hidden");
      setStep("review");
    });
    $("btnConfirmSmartOptimization")?.addEventListener("click", confirmOptimization);

    global.addEventListener("popstate", () => {
      const params = new URL(global.location.href).searchParams;
      setModule(params.get("modulo") === "inteligencia" ? "intelligence" : "create", { updateUrl: false });
    });
  }

  function init() {
    if (!$("promoIntelligenceModule")) return;
    bindEvents();
    const params = new URL(global.location.href).searchParams;
    setModule(params.get("modulo") === "inteligencia" ? "intelligence" : "create", { updateUrl: false });
    refreshAccountLabel();
  }

  document.addEventListener("DOMContentLoaded", init);
  global.PromoIntelligence = { setModule, runAnalysis };
})(window);
