// promo-seller-campaign.js
// Fluxo isolado de seller campaign: modal, percentual manual, criacao e edicao.
(function initPromoSellerCampaign(global) {
  "use strict";

  if (!global || global.PromoSellerCampaign) return;
  global.PROMO_MANUAL_MAX_PERCENT = Number(global.PROMO_MANUAL_MAX_PERCENT || 60);

  function isValidManualPromoPercent(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 && n <= global.PROMO_MANUAL_MAX_PERCENT;
  }

  function manualPromoPercentMessage(prefix = "Informe uma % valida") {
    return `${prefix} entre 0,01 e ${global.PROMO_MANUAL_MAX_PERCENT}%.`;
  }

  function sellerCampaignModal() {
    return document.getElementById("sellerCampaignModal");
  }

  function sellerCampaignModalTitle() {
    return document.getElementById("sellerCampaignModalTitle");
  }

  function sellerCampaignModalDesc() {
    return document.querySelector("#sellerCampaignModal .modal-desc");
  }

  function sellerCampaignSubmitButton() {
    return document.getElementById("btnCreateSellerCampaign");
  }

  function sellerCampaignHintEl() {
    return document.getElementById("sellerCampaignModalHint");
  }

  function toDateInputValue(value) {
    if (!value) return "";
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) return "";
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function sellerManualPercentInput() {
    return document.getElementById("sellerManualPercentInput");
  }

  function sellerFilterBadgeEl() {
    return document.getElementById("sellerCampaignFilterBadge");
  }

  function sellerApplyBadgeEl() {
    return document.getElementById("sellerCampaignApplyBadge");
  }

  function setBadgeState(el, text, variant = "default") {
    if (!el) return;
    el.textContent = text;
    el.classList.remove(
      "manual-flow__badge--active",
      "manual-flow__badge--success",
      "manual-flow__badge--warn",
    );
    if (variant === "active") el.classList.add("manual-flow__badge--active");
    if (variant === "success") el.classList.add("manual-flow__badge--success");
    if (variant === "warn") el.classList.add("manual-flow__badge--warn");
  }

  function isSellerCampaignSelected(state) {
    return String(state?.selectedCard?.type || "").toUpperCase() === "SELLER_CAMPAIGN";
  }

  function getSellerManualPercent(state) {
    const n = Number(state?.sellerManualPercent);
    if (!isValidManualPromoPercent(n)) return null;
    return n;
  }

  function getDiscountTarget(state) {
    const n = Number(state?.maxDesc);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function computeRange(item, toNum, round2) {
    const original = toNum(item?.original_price ?? item?.price ?? null);
    const minPrice = toNum(item?.min_discounted_price);
    const maxPrice = toNum(item?.max_discounted_price);
    const toPct = (price) =>
      original != null && original > 0 && price != null
        ? round2(((original - price) / original) * 100)
        : null;
    return {
      minPct: toPct(maxPrice),
      maxPct: toPct(minPrice),
    };
  }

  function isWithinRange(item, percent, toNum, round2) {
    const pct = toNum(percent);
    if (pct == null) return false;
    const range = computeRange(item, toNum, round2);
    const lo = range.minPct;
    const hi = range.maxPct;
    if (lo == null || hi == null) return false;
    return pct + 0.01 >= lo && pct - 0.01 <= hi;
  }

  function updateControls({ state }) {
    const host = document.getElementById("sellerCampaignControls");
    const hint = document.getElementById("sellerCampaignPercentHint");
    const input = sellerManualPercentInput();
    const filterBadge = sellerFilterBadgeEl();
    const applyBadge = sellerApplyBadgeEl();
    if (!host) return;

    if (!isSellerCampaignSelected(state)) {
      host.classList.add("hidden");
      return;
    }

    host.classList.remove("hidden");
    const pct = getSellerManualPercent(state);
    const target = getDiscountTarget(state);
    if (input && document.activeElement !== input) {
      input.value = pct != null ? String(pct) : "";
      const maxAllowed =
        target != null
          ? Math.min(Number(target), global.PROMO_MANUAL_MAX_PERCENT)
          : global.PROMO_MANUAL_MAX_PERCENT;
      input.max = String(maxAllowed);
    }

    if (hint) {
      const pct = getSellerManualPercent(state);
      const target = getDiscountTarget(state);
      hint.textContent =
        pct != null && target != null
          ? `Lista filtrada em ${target.toFixed(2)}%. O lote vai tentar aplicar ${pct.toFixed(2)}% nos itens selecionados.`
          : pct != null
            ? `Desconto pronto para envio: ${pct.toFixed(2)}%. Se quiser reduzir a lista antes, use o filtro acima.`
            : target != null
              ? `Lista filtrada em ${target.toFixed(2)}%. Agora defina o desconto a aplicar no lote.`
              : "Primeiro filtre a lista acima. Depois salve o desconto que sera aplicado na seller.";
    }
    setBadgeState(
      filterBadge,
      target != null
        ? `Filtro da lista: ${target.toFixed(2)}%`
        : "Filtro da lista: nao definido",
      target != null ? "active" : "warn",
    );
    setBadgeState(
      applyBadge,
      pct != null
        ? `Aplicar no ML: ${pct.toFixed(2)}%`
        : "Aplicar no ML: nao definido",
      pct != null ? "success" : "warn",
    );
  }

  function setManualPercentFromUi({ state, round2 }) {
    const raw = sellerManualPercentInput()?.value?.trim();
    const n =
      raw === "" || raw == null ? null : Number(String(raw).replace(",", "."));
    if (n == null) {
      state.sellerManualPercent = null;
      updateControls({ state });
      return true;
    }
    if (!isValidManualPromoPercent(n)) {
      window.notifyPromocoes(manualPromoPercentMessage("Informe um desconto a aplicar valido"));
      return false;
    }
    const target = getDiscountTarget(state);
    if (target != null && n > target) {
      window.notifyPromocoes(`O desconto da seller nao pode ser maior que o filtro da lista (${round2(target)}%).`);
      return false;
    }
    state.sellerManualPercent = round2(n);
    updateControls({ state });
    return true;
  }

  function resolveDealPrice(item, { state, toNum, round2, computeDealPriceFromPercent, silent = false }) {
    const original = toNum(item?.original_price ?? item?.price ?? null);
    let percent = getSellerManualPercent(state);

    if (percent == null && !silent) {
      const suggested = toNum(item?.discount_percentage);
      const input = prompt(
        `Informe a % de desconto para ${item?.id || "o item"}:`,
        suggested != null ? String(round2(suggested)) : "",
      );
      if (!input) return null;
      const parsed = Number(String(input).replace(",", "."));
      if (!isValidManualPromoPercent(parsed)) {
        window.notifyPromocoes(manualPromoPercentMessage());
        return null;
      }
      const target = getDiscountTarget(state);
      if (target != null && parsed > target) {
        window.notifyPromocoes(`A % informada nao pode ser maior que o filtro da lista (${round2(target)}%).`);
        return null;
      }
      state.sellerManualPercent = round2(parsed);
      updateControls({ state });
      percent = getSellerManualPercent(state);
    }

    if (percent == null) return null;
    if (!isWithinRange(item, percent, toNum, round2)) {
      const range = computeRange(item, toNum, round2);
      if (!silent) {
        window.notifyPromocoes(
          `O item ${item?.id || ""} aceita apenas descontos entre ${range.minPct != null ? range.minPct.toFixed(2) : "â€”"}% e ${range.maxPct != null ? range.maxPct.toFixed(2) : "â€”"}%.`,
        );
      }
      return null;
    }
    return computeDealPriceFromPercent(original, percent);
  }

  function openModal({ state, campaign = null } = {}) {
    const modal = sellerCampaignModal();
    if (!modal) return;
    const nameInput = document.getElementById("sellerCampaignNameInput");
    const startInput = document.getElementById("sellerCampaignStartInput");
    const finishInput = document.getElementById("sellerCampaignFinishInput");
    const titleEl = sellerCampaignModalTitle();
    const descEl = sellerCampaignModalDesc();
    const submitBtn = sellerCampaignSubmitButton();
    const hintEl = sellerCampaignHintEl();
    const fmtDate = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    };
    const today = new Date();
    const finish = new Date(today);
    finish.setDate(finish.getDate() + 6);
    if (state) {
      state.sellerCampaignEditor = campaign
        ? {
            id: String(campaign.id || ""),
            type: String(campaign.type || "SELLER_CAMPAIGN").toUpperCase(),
            status: String(campaign.status || "").toLowerCase(),
          }
        : null;
    }

    if (campaign) {
      if (titleEl) titleEl.textContent = "Editar seller campaign";
      if (descEl) {
        descEl.textContent =
          "Atualize o nome e a vigÃªncia da campanha. As alteraÃ§Ãµes continuam sendo aplicadas manualmente nos itens elegÃ­veis.";
      }
      if (submitBtn) submitBtn.textContent = "Salvar alteraÃ§Ãµes";
      if (hintEl) {
        hintEl.textContent =
          "A seller campaign pode ter vigÃªncia de atÃ© 31 dias. Revise o perÃ­odo antes de salvar.";
      }
      if (nameInput) nameInput.value = String(campaign.name || "");
      if (startInput) startInput.value = toDateInputValue(campaign.start_date);
      if (finishInput) finishInput.value = toDateInputValue(campaign.finish_date);
    } else {
      if (titleEl) titleEl.textContent = "Criar seller campaign";
      if (descEl) {
        descEl.textContent =
          "A campanha Ã© criada primeiro. Depois ela aparece nos cards para vocÃª clicar, filtrar os elegÃ­veis e aplicar o desconto manualmente.";
      }
      if (submitBtn) submitBtn.textContent = "Criar campanha";
      if (hintEl) {
        hintEl.textContent =
          "A duraÃ§Ã£o mÃ¡xima agora Ã© de atÃ© 31 dias. A aplicaÃ§Ã£o do desconto continua sendo feita depois, diretamente nos itens elegÃ­veis da campanha.";
      }
      if (nameInput) nameInput.value = "Nova seller campaign";
      if (startInput) startInput.value = fmtDate(today);
      if (finishInput) finishInput.value = fmtDate(finish);
    }
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    nameInput?.focus();
  }

  function closeModal({ state } = {}) {
    const modal = sellerCampaignModal();
    if (!modal) return;
    if (state) state.sellerCampaignEditor = null;
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  }

  function buildDates(startDate, finishDate) {
    return {
      start_date: `${startDate}T00:00:00`,
      finish_date: `${finishDate}T00:00:00`,
    };
  }

  async function submitCreation({ state, withBase, setLoading, carregarCards, selecionarCard }) {
    const name = (document.getElementById("sellerCampaignNameInput")?.value || "").trim();
    const startDate = document.getElementById("sellerCampaignStartInput")?.value || "";
    const finishDate = document.getElementById("sellerCampaignFinishInput")?.value || "";
    if (!name) {
      window.notifyPromocoes("Informe o nome da campanha.");
      return false;
    }
    if (!startDate || !finishDate) {
      window.notifyPromocoes("Informe as datas de inicio e fim.");
      return false;
    }
    const start = new Date(`${startDate}T00:00:00`);
    const finish = new Date(`${finishDate}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(finish.getTime())) {
      window.notifyPromocoes("Datas invalidas.");
      return false;
    }
    if (finish < start) {
      window.notifyPromocoes("A data final nao pode ser menor que a inicial.");
      return false;
    }
    const diffDays = Math.floor((finish - start) / 86400000) + 1;
    if (diffDays > 31) {
      window.notifyPromocoes("A seller campaign permite no maximo 31 dias.");
      return false;
    }

    const editing = state?.sellerCampaignEditor || null;
    setLoading(
      true,
      editing ? "Salvando seller campaign..." : "Criando seller campaign...",
    );
    const endpoint = editing
      ? withBase(`/api/promocoes/promotions/${encodeURIComponent(editing.id)}`)
      : withBase("/api/promocoes/promotions");
    const res = await fetch(endpoint, {
      method: editing ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        promotion_type: "SELLER_CAMPAIGN",
        promotion_status: editing?.status || null,
        name,
        sub_type: "FLEXIBLE_PERCENTAGE",
        ...buildDates(startDate, finishDate),
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) {
      const msg =
        data?.error ||
        (editing
          ? "Falha ao editar seller campaign."
          : "Falha ao criar seller campaign.");
      setLoading(false, msg);
      window.notifyPromocoes(msg);
      return false;
    }

    closeModal({ state });
    state.activeTypeTab = "SELLER_CAMPAIGN";
    await carregarCards();
    const createdId = String(data?.campaign?.id || data?.id || editing?.id || "");
    const created = state.cards.find((c) => String(c.id) === createdId) || null;
    if (created) await selecionarCard(created);
    setLoading(
      false,
      editing
        ? `Seller campaign ${name} atualizada com sucesso.`
        : `Seller campaign ${name} criada com sucesso.`,
    );
    return true;
  }

  global.PromoSellerCampaign = {
    sellerCampaignModal,
    sellerManualPercentInput,
    isSellerCampaignSelected,
    getSellerManualPercent,
    updateControls,
    setManualPercentFromUi,
    resolveDealPrice,
    openModal,
    closeModal,
    buildDates,
    submitCreation,
  };
})(window);
