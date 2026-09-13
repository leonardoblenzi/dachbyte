// promo-cards.js
// Renderizacao e destaque dos cards de campanha.
(function initPromoCards(global) {
  "use strict";

  if (!global || global.PromoCards) return;

  function toNumberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function firstNumber(...values) {
    for (const value of values) {
      const n = toNumberOrNull(value);
      if (n !== null) return n;
    }
    return null;
  }

  function formatCount(value) {
    const n = toNumberOrNull(value);
    return n === null ? "-" : n.toLocaleString("pt-BR");
  }

  function hasMetric(value) {
    return toNumberOrNull(value) !== null;
  }

  function parseDate(value) {
    if (!value) return null;
    const raw = String(value).trim();
    const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (dateOnly) {
      return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatDateShort(value) {
    const date = parseDate(value);
    if (!date) return "";
    return date
      .toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })
      .replace(".", "")
      .toUpperCase();
  }

  function formatDateRange(card) {
    const start = card?.start_date || card?.valid_from || card?.begin_date || card?.date_from;
    const finish =
      card?.finish_date ||
      card?.valid_to ||
      card?.end_date ||
      card?.deadline_date ||
      card?.date_to;
    const startText = formatDateShort(start);
    const finishText = formatDateShort(finish);
    if (startText && finishText) return `DE ${startText} A ${finishText}`;
    if (finishText) return `ATE ${finishText}`;
    if (startText) return `A PARTIR DE ${startText}`;
    return "PERIODO NAO INFORMADO";
  }

  function getCardMetric(card, kind) {
    if (kind === "eligible") {
      return firstNumber(
        card?.eligible_items,
        card?.eligible_items_count,
        card?.eligible,
        card?.candidate_items,
        card?.candidate_items_count,
        card?.candidate_count,
        card?.candidates_count,
        card?.candidates,
        card?.metrics?.eligible,
        card?.metrics?.candidate,
        card?.items?.candidate,
      );
    }
    return firstNumber(
      card?.participating_items,
      card?.participating_items_count,
      card?.participating,
      card?.started_items,
      card?.started_items_count,
      card?.started_count,
      card?.participants_count,
      card?.participants,
      card?.metrics?.participating,
      card?.metrics?.started,
      card?.items?.started,
    );
  }

  function renderCards({
    mount,
    state,
    getCardsByActiveType,
    updateTabsCounts,
    normalizeCardTypeForTabs,
    typeLabels,
    esc,
    onSelectCard,
  }) {
    if (!mount) return [];
    mount.classList.add("promo-campaign-grid");

    const allCards = Array.isArray(state?.cards) ? state.cards : [];
    const filteredIds = state?.cardsFilteredIds || null;
    const baseList = filteredIds
      ? allCards.filter((c) => filteredIds.has(c.id))
      : allCards;

    updateTabsCounts(baseList);

    const list = getCardsByActiveType(baseList).filter(
      (c) => normalizeCardTypeForTabs(c.type) !== "REMOVED",
    );

    if (!list.length) {
      const label = typeLabels[state.activeTypeTab] || state.activeTypeTab;
      const msg = state.mlbFilter
        ? `Nenhuma campanha (${label}) oferece promoção para o item ${esc(
            state.mlbFilter,
          )}.`
        : `Nenhuma promoção em ${label}.`;
      mount.innerHTML = `<div class="promo-empty-state"><h3>${msg}</h3></div>`;
      return list;
    }

    const frag = document.createDocumentFragment();
    list.forEach((c) => {
      const div = document.createElement("div");
      const isSellerCreated =
        String(c.type || "").toUpperCase() === "SELLER_CAMPAIGN";
      div.className = `promo-campaign-card${isSellerCreated ? " promo-campaign-card--seller" : ""}`;
      div.tabIndex = 0;

      const benefits = c.benefits || null;
      const benefitsStr = benefits
        ? `Rebate MELI: ${benefits.meli_percent ?? "—"}% • Seller: ${
            benefits.seller_percent ?? "—"
          }%`
        : "";

      const isRebate =
        benefits?.type === "REBATE" ||
        ["SMART", "PRE_NEGOTIATED", "PRICE_MATCHING", "PRICE_MATCHING_MELI_ALL"].includes(
          (c.type || "").toUpperCase(),
        );
      const rebateTag = isRebate
        ? '<span class="badge badge-rebate">REBATE</span>'
        : "";

      const cardMenu = isSellerCreated
        ? `<div class="promo-campaign-card__menu">
            <button class="promo-campaign-card__menu-toggle" type="button" data-card-menu-toggle="${esc(
              c.id,
            )}" aria-label="Abrir ações da campanha">⋮</button>
            ${
              state.openCardMenuId === String(c.id)
                ? `<div class="promo-campaign-card__menu-popover">
                    <button type="button" data-card-edit="${esc(c.id)}">Editar</button>
                    <button type="button" data-card-delete="${esc(c.id)}">Excluir</button>
                  </div>`
                : ""
            }
          </div>`
        : "";
      const sellerBadge = isSellerCreated
        ? '<span class="promo-campaign-card__eyebrow">Criada por voce</span>'
        : "";
      const cardTitleClass = isSellerCreated
        ? "promo-campaign-card__title promo-campaign-card__title--seller"
        : "promo-campaign-card__title";
      const dateRange = formatDateRange(c);
      const eligible = getCardMetric(c, "eligible");
      const participating = getCardMetric(c, "participating");
      const typeLabel = esc(c.type || "");
      const hasCounts = hasMetric(eligible) || hasMetric(participating);
      const countBlock = hasCounts
        ? `<div class="promo-campaign-card__counts">
            <span><strong>${formatCount(eligible)}</strong> elegiveis</span>
            <span><strong>${formatCount(participating)}</strong> participando</span>
          </div>`
        : c.__countsError
        ? '<div class="promo-campaign-card__counts promo-campaign-card__counts--muted">Contagem indisponivel</div>'
        : '<div class="promo-campaign-card__counts promo-campaign-card__counts--loading" aria-label="Carregando contagem"></div>';

      div.innerHTML = `${cardMenu}
        <div class="promo-campaign-card__date">${esc(dateRange)}</div>
        <h3 class="${cardTitleClass}">${esc(c.name || c.id || "Campanha")} ${rebateTag}</h3>
        <div class="promo-campaign-card__meta">
          ${sellerBadge}
          ${typeLabel ? `<span class="promo-campaign-card__type">${typeLabel}</span>` : ""}
        </div>
        ${countBlock}
        ${
          benefitsStr
            ? `<div class="promo-campaign-card__benefits">${benefitsStr}</div>`
            : ""
        }`;

      div.addEventListener("click", (ev) => {
        if (ev.target?.closest?.(".promo-campaign-card__menu")) return;
        onSelectCard(c);
      });
      frag.appendChild(div);
    });

    mount.innerHTML = "";
    mount.appendChild(frag);
    return list;
  }

  function highlightSelected({ mount, state, getCardsByActiveType }) {
    if (!mount) return;
    mount
      .querySelectorAll(".promo-campaign-card")
      .forEach((n) => n.classList.remove("promo-campaign-card--active"));

    const allCards = Array.isArray(state?.cards) ? state.cards : [];
    const filteredIds = state?.cardsFilteredIds || null;
    const baseList = filteredIds
      ? allCards.filter((c) => filteredIds.has(c.id))
      : allCards;
    const list = getCardsByActiveType(baseList);
    const idx = list.findIndex((c) => c.id === state?.selectedCard?.id);
    if (idx >= 0 && mount.children[idx]) {
      mount.children[idx].classList.add("promo-campaign-card--active");
    }
  }

  function updateSelectedCampaignName({ state, element }) {
    if (!element) return;
    if (state?.selectedCard) {
      const name = state.selectedCard.name || state.selectedCard.id;
      element.textContent = `Campanha: "${name}"`;
      element.title = name;
      return;
    }
    element.textContent = "";
    element.removeAttribute("title");
  }

  global.PromoCards = {
    renderCards,
    highlightSelected,
    updateSelectedCampaignName,
  };
})(window);
