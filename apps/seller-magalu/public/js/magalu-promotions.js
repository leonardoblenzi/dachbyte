(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const state = { promotions: [], tab: "available", loadedForAccount: null };

  function selectedAccountId() {
    return Number(window.MagaluSellerShell?.getSelectedAccountId?.() || 0);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  }

  function formatDate(value, { withTime = false } = {}) {
    if (!value) return "Não informado";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return escapeHtml(value);
    return new Intl.DateTimeFormat("pt-BR", withTime ? { dateStyle: "short", timeStyle: "short" } : { dateStyle: "short" }).format(date);
  }

  function participating(promotion) {
    return ["participating", "active", "subscribed", "joined"].includes(String(promotion.participation_status || "").toLowerCase());
  }

  function periodMatches(promotion) {
    const period = $("mg-promotions-period")?.value || "active";
    if (period === "all") return true;
    const now = Date.now();
    const end = Date.parse(promotion.ends_at || "");
    if (period === "ended") return Number.isFinite(end) && end < now;
    return !Number.isFinite(end) || end >= now;
  }

  function visiblePromotions() {
    const query = String($("mg-promotions-search")?.value || "").trim().toLocaleLowerCase("pt-BR");
    const type = $("mg-promotions-type")?.value || "";
    const origin = $("mg-promotions-origin")?.value || "";
    return state.promotions.filter((promotion) => {
      if (state.tab === "participating" && !participating(promotion)) return false;
      if (state.tab === "available" && participating(promotion)) return false;
      if (type && promotion.type !== type) return false;
      if (origin && promotion.origin !== origin) return false;
      if (!periodMatches(promotion)) return false;
      return !query || [promotion.name, promotion.id, promotion.type, promotion.origin, ...(promotion.benefits || [])]
        .join(" ").toLocaleLowerCase("pt-BR").includes(query);
    });
  }

  function renderOptions(id, values) {
    const select = $(id);
    if (!select) return;
    const selected = select.value;
    const label = id.endsWith("type") ? "Todos" : "Todas";
    select.innerHTML = `<option value="">${label}</option>${values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}`;
    select.value = values.includes(selected) ? selected : "";
  }

  function renderSummary() {
    const available = state.promotions.filter((promotion) => !participating(promotion)).length;
    const joined = state.promotions.length - available;
    const deadlines = state.promotions.map((promotion) => Date.parse(promotion.adhesion_deadline_at || "")).filter(Number.isFinite).sort((a, b) => a - b);
    $("mg-promotions-available-count").textContent = String(available);
    $("mg-promotions-participating-count").textContent = String(joined);
    $("mg-promotions-summary-available").textContent = String(available);
    $("mg-promotions-summary-participating").textContent = String(joined);
    $("mg-promotions-summary-deadline").textContent = deadlines.length ? formatDate(deadlines[0], { withTime: true }) : "—";
  }

  function card(promotion) {
    const status = participating(promotion) ? "Participando" : "Disponível";
    const benefits = (promotion.benefits || []).slice(0, 2).map((benefit) => `<li>${escapeHtml(benefit)}</li>`).join("");
    return `<article class="mg-promotion-card">
      <div class="mg-promotion-card__head"><span class="mg-promotion-status ${participating(promotion) ? "is-active" : ""}">${status}</span><span>${escapeHtml(promotion.type || "Campanha")}</span></div>
      <h2>${escapeHtml(promotion.name)}</h2>
      <p>${benefits ? "Benefícios e condições informados pela Magalu." : "Consulte os detalhes e condições disponíveis para esta campanha."}</p>
      ${benefits ? `<ul>${benefits}</ul>` : ""}
      <dl><div><dt>Vigência</dt><dd>${formatDate(promotion.starts_at)} — ${formatDate(promotion.ends_at)}</dd></div><div><dt>Prazo de adesão</dt><dd>${formatDate(promotion.adhesion_deadline_at, { withTime: true })}</dd></div></dl>
      <footer><span>${promotion.seller_contribution != null ? `Investimento do seller: ${escapeHtml(promotion.seller_contribution)}` : "Investimento não informado"}</span><button class="mg-secondary-btn" type="button" data-promotion-detail="${escapeHtml(promotion.id)}">Ver detalhes</button></footer>
    </article>`;
  }

  function render() {
    const rows = visiblePromotions();
    const grid = $("mg-promotions-grid");
    const empty = $("mg-promotions-empty");
    if (!grid || !empty) return;
    grid.innerHTML = rows.map(card).join("");
    grid.hidden = rows.length === 0;
    empty.hidden = rows.length > 0;
  }

  function renderDetail(promotion) {
    const dialog = $("mg-promotions-detail");
    if (!dialog) return;
    $("mg-promotions-detail-title").textContent = promotion.name || "Detalhes da campanha";
    $("mg-promotions-detail-body").innerHTML = `<div class="mg-promotion-detail-grid"><div><span>Status</span><strong>${participating(promotion) ? "Participando" : "Disponível"}</strong></div><div><span>Tipo</span><strong>${escapeHtml(promotion.type || "Não informado")}</strong></div><div><span>Vigência</span><strong>${formatDate(promotion.starts_at, { withTime: true })} — ${formatDate(promotion.ends_at, { withTime: true })}</strong></div><div><span>Prazo de adesão</span><strong>${formatDate(promotion.adhesion_deadline_at, { withTime: true })}</strong></div><div><span>Origem</span><strong>${escapeHtml(promotion.origin || "Não informada")}</strong></div><div><span>Participação</span><strong>${escapeHtml(promotion.participation_status || "Não informada")}</strong></div></div><p class="mg-promotions-dialog__notice">A API atual permite consulta. Ações de adesão, remoção e gestão de SKUs não são exibidas até haver suporte público comprovado da Open API Magalu.</p>`;
    dialog.hidden = false;
  }

  async function load({ force = false } = {}) {
    const accountId = selectedAccountId();
    if (!accountId || location.pathname.replace(/\/$/, "") !== "/magalu/promocoes") return;
    const grid = $("mg-promotions-grid");
    if (grid) { grid.hidden = false; grid.innerHTML = '<div class="mg-empty-state"><strong>Carregando promoções…</strong></div>'; }
    try {
      const suffix = force ? "&refresh=1" : "";
      const response = await fetch(`/magalu/api/promotions?account_id=${encodeURIComponent(accountId)}${suffix}`, { credentials: "include", headers: { Accept: "application/json" } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || payload.error || "Não foi possível consultar promoções.");
      state.promotions = Array.isArray(payload.promotions) ? payload.promotions : [];
      state.loadedForAccount = accountId;
      renderOptions("mg-promotions-type", [...new Set(state.promotions.map((row) => row.type).filter(Boolean))].sort());
      renderOptions("mg-promotions-origin", [...new Set(state.promotions.map((row) => row.origin).filter(Boolean))].sort());
      $("mg-promotions-account").textContent = `Conta ${accountId}`;
      renderSummary();
      render();
    } catch (error) {
      if (grid) grid.innerHTML = `<div class="mg-empty-state"><strong>Não foi possível carregar promoções</strong><p>${escapeHtml(error.message)}</p></div>`;
    }
  }

  function bind() {
    $("mg-promotions-refresh")?.addEventListener("click", () => void load({ force: true }));
    $("mg-promotions-filter")?.addEventListener("click", render);
    $("mg-promotions-clear")?.addEventListener("click", () => {
      ["mg-promotions-search", "mg-promotions-type", "mg-promotions-origin"].forEach((id) => { if ($(id)) $(id).value = ""; });
      if ($("mg-promotions-period")) $("mg-promotions-period").value = "active";
      render();
    });
    ["mg-promotions-search", "mg-promotions-type", "mg-promotions-origin", "mg-promotions-period"].forEach((id) => $(id)?.addEventListener("change", render));
    $("mg-promotions-search")?.addEventListener("input", render);
    document.querySelectorAll("[data-promotions-tab]").forEach((button) => button.addEventListener("click", () => {
      state.tab = button.dataset.promotionsTab;
      document.querySelectorAll("[data-promotions-tab]").forEach((item) => item.classList.toggle("is-active", item === button));
      render();
    }));
    $("mg-promotions-grid")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-promotion-detail]");
      if (!button) return;
      const promotion = state.promotions.find((row) => row.id === button.dataset.promotionDetail);
      if (promotion) renderDetail(promotion);
    });
    $("mg-promotions-detail-close")?.addEventListener("click", () => { $("mg-promotions-detail").hidden = true; });
    window.addEventListener("magalu:accountchange", () => { state.loadedForAccount = null; void load({ force: true }); });
    window.addEventListener("magalu:shellready", () => void load());
  }

  document.addEventListener("DOMContentLoaded", bind);
})();
