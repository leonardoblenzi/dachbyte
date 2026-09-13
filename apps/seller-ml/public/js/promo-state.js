// promo-state.js
// Helpers de estado, filtros e calculos da central de promocoes.
(function initPromoState(global) {
  "use strict";

  if (!global || global.PromoStateHelpers) return;

  function normalizeStatus(s) {
    s = String(s || "").toLowerCase();
    if (s === "in_progress") return "pending";
    if (s === "scheduled") return "pending";
    if (s === "programmed") return "pending";
    return s;
  }

  function dedupeByMLB(items, statusFilter) {
    const rank = { started: 3, pending: 2, candidate: 1 };
    const pickRank = (st) => rank[normalizeStatus(st)] ?? 0;

    const map = new Map();
    for (const it of items) {
      const id = String(it?.id || "");
      if (!id) continue;
      const st = normalizeStatus(it.status);
      const cur = map.get(id);
      if (!cur || pickRank(st) > pickRank(cur.status)) {
        map.set(id, { ...it, status: st });
      }
    }

    let arr = [...map.values()];
    if (statusFilter) {
      const want = normalizeStatus(statusFilter);
      arr = arr.filter((x) => normalizeStatus(x.status) === want);
    }
    return arr;
  }

  function qsBuild(params) {
    const entries = Object.entries(params).filter(
      ([, v]) => v !== undefined && v !== null && v !== "",
    );
    return entries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
  }

  function filtroToStatusParam(state) {
    const v = String(state?.filtroParticipacao || "all").toLowerCase();
    if (["yes", "participantes", "participante", "started"].includes(v)) return "started";
    if (["non", "nao", "não", "nao_participantes", "nao-participantes", "candidate"].includes(v)) {
      return "candidate";
    }
    if (["prog", "programados", "agendados", "pending", "scheduled"].includes(v)) {
      return "pending";
    }
    return "";
  }

  function hasDealSuggestionFields(it) {
    return (
      Number(it?.min_discounted_price) > 0 ||
      Number(it?.max_discounted_price) > 0
    );
  }

  function isStrictDealCandidate(it, state) {
    const typeUp = (state?.selectedCard?.type || "").toUpperCase();
    if (typeUp !== "DEAL") return false;
    const st = normalizeStatus(it?.status);
    return (st === "candidate" || st === "pending") && !hasDealSuggestionFields(it);
  }

  function pickRebate(obj, toNum) {
    const b = obj?.benefits || {};
    const meli = toNum(obj?.meli_percentage ?? obj?.meli_percent ?? b?.meli_percent);
    const seller = toNum(obj?.seller_percentage ?? obj?.seller_percent ?? b?.seller_percent);
    const type = b?.type || (meli != null ? "REBATE" : null);
    return { type, meli, seller };
  }

  function resolveDealFinalAndPctFront(raw) {
    const orig = Number(raw.original_price ?? raw.originalPrice ?? raw.price ?? 0);
    const st = String(raw.status || "").toLowerCase();
    const typeUp = String(raw.promotion_type ?? raw.type ?? "").toUpperCase();
    const isSellerCampaign = typeUp === "SELLER_CAMPAIGN";
    const isDeal = typeUp === "DEAL" || typeUp === "LIGHTNING";

    const deal = Number(raw.deal_price ?? raw.new_price ?? 0);
    const minD = Number(raw.min_discounted_price ?? 0);
    const maxD = Number(raw.max_discounted_price ?? 0);
    const px = Number(raw.price ?? 0);
    const mlPct = Number(raw.discount_percentage ?? raw.discountPercent ?? NaN);

    if (!orig || !isFinite(orig) || orig <= 0) {
      return { final: null, pct: null, estimated: false, source: null };
    }

    const GAP = 0.7;
    const PCT_MIN = 5;
    const PCT_MAX = 40;
    const isPlausibleFinal = (v) =>
      isFinite(v) && v > 0 && v < orig && (orig - v) / orig < GAP;
    const isPlausiblePct = (p) => isFinite(p) && p >= PCT_MIN && p <= PCT_MAX;

    const isCandLike = st === "candidate" || st === "pending";
    const noSuggestions =
      !(isFinite(minD) && minD > 0) &&
      !(isFinite(maxD) && maxD > 0);

    let final = null;
    let estimated = false;
    let source = null;

    if (st === "started" && isPlausibleFinal(deal)) {
      final = deal;
      source = "Deal";
    }

    if (!final && isDeal && isCandLike && isPlausibleFinal(maxD)) {
      final = maxD;
      source = "Max";
    }

    if (!final) {
      if (!isDeal && isPlausibleFinal(minD)) {
        final = minD;
        source = "Min";
      }
      if (!final && !isDeal && isPlausibleFinal(maxD)) {
        final = maxD;
        source = "Max";
      }
    }

    if (
      !final &&
      !isDeal &&
      !isSellerCampaign &&
      isCandLike &&
      noSuggestions &&
      isFinite(px) &&
      px > 0
    ) {
      const pctFromPrice = (px / orig) * 100;
      if (isPlausiblePct(pctFromPrice)) {
        const candidateFinal = orig - px;
        if (isPlausibleFinal(candidateFinal)) {
          final = candidateFinal;
          source = "PriceΔR";
          estimated = true;
        }
      }
    }

    if (!final && !isDeal && isCandLike && noSuggestions && isPlausiblePct(mlPct)) {
      const candidateFinal = orig * (1 - mlPct / 100);
      if (isPlausibleFinal(candidateFinal)) {
        final = candidateFinal;
        source = "Pct";
      }
    }

    if (!final && !isCandLike && isFinite(px) && px > 0 && isPlausibleFinal(px)) {
      final = px;
      source = "Price";
    }

    if (!final) return { final: null, pct: null, estimated: false, source: null };

    const pct = Math.max(0, Math.min(100, ((orig - final) / orig) * 100));
    return {
      final: Number(final.toFixed(2)),
      pct: Number(pct.toFixed(2)),
      estimated,
      source,
    };
  }

  function computeDealDiscountRange(raw) {
    const orig = Number(raw?.original_price ?? raw?.originalPrice ?? raw?.price ?? 0);
    if (!isFinite(orig) || orig <= 0) {
      return {
        minPrice: null,
        maxPrice: null,
        minPct: null,
        maxPct: null,
      };
    }

    const typeUp = String(raw?.promotion_type ?? raw?.type ?? "").toUpperCase();
    const minPrice = toNum(raw?.min_discounted_price);
    let maxPrice = toNum(raw?.max_discounted_price);
    const lightningPrice = toNum(raw?.price);

    // LIGHTNING usa `price` como o maior preco permitido (menor desconto)
    // e `min_discounted_price` como o menor preco permitido (maior desconto).
    if (
      typeUp === "LIGHTNING" &&
      maxPrice == null &&
      lightningPrice != null &&
      lightningPrice > 0 &&
      lightningPrice < orig &&
      (minPrice == null || lightningPrice >= minPrice)
    ) {
      maxPrice = lightningPrice;
    }
    const toPct = (price) =>
      price != null && isFinite(price) ? Number((((orig - price) / orig) * 100).toFixed(2)) : null;

    return {
      minPrice,
      maxPrice,
      minPct: toPct(maxPrice),
      maxPct: toPct(minPrice),
    };
  }

  function isDealPercentWithinRange(raw, percent, tolerance = 0.01) {
    const pct = toNum(percent);
    if (pct == null) return false;

    const range = computeDealDiscountRange(raw);
    const lo = range.minPct;
    const hi = range.maxPct;
    if (lo == null || hi == null) return false;

    return pct + tolerance >= lo && pct - tolerance <= hi;
  }

  function computeDescPct(it, benefitsGlobal, { state, toNum }) {
    const typeUp = (state?.selectedCard?.type || "").toUpperCase();
    const original = toNum(it.original_price ?? it.price ?? null);
    const st = String(it.status || "").toLowerCase();

    if (isStrictDealCandidate(it, state)) return null;

    // PRE_NEGOTIATED tem preco base pre-acordado pelo ML. O teto de seguranca
    // deve comparar a reducao real original_price -> price, e nao a soma do
    // rebate ML/vendedor (que e uma informacao economica separada).
    if (typeUp === "PRE_NEGOTIATED") {
      const preOriginal = toNum(
        it.original_price ?? it.item_original_price ?? it.regular_amount ?? it.base_price,
      );
      const prePrice = toNum(
        it.deal_price ?? it.new_price ?? it._resolved_final_price ?? it.price,
      );
      if (
        preOriginal != null &&
        preOriginal > 0 &&
        prePrice != null &&
        prePrice > 0 &&
        prePrice <= preOriginal
      ) {
        return 100 * (1 - prePrice / preOriginal);
      }
      return toNum(it.discount_percentage);
    }

    if (
      ["SMART", "PRICE_MATCHING", "PRICE_MATCHING_MELI_ALL"].includes(typeUp)
    ) {
      if (original != null) {
        const rb = pickRebate(it, toNum);
        const m =
          toNum(it.meli_percentage) ??
          toNum(it.rebate_meli_percent) ??
          toNum(rb.meli) ??
          toNum(benefitsGlobal?.meli_percent);
        const s =
          toNum(it.seller_percentage) ??
          toNum(rb.seller) ??
          toNum(benefitsGlobal?.seller_percent);
        const tot = toNum((m || 0) + (s || 0));
        if (toNum(it.discount_percentage) == null && (m != null || s != null)) return tot;
      }
      return toNum(it.discount_percentage);
    }

    if (["DEAL", "SELLER_CAMPAIGN", "PRICE_DISCOUNT", "DOD", "LIGHTNING"].includes(typeUp)) {
      const { pct } = resolveDealFinalAndPctFront({
        original_price: original,
        promotion_type: typeUp,
        status: it.status,
        deal_price: it.deal_price ?? it.new_price,
        min_discounted_price: it.min_discounted_price,
        max_discounted_price: it.max_discounted_price,
        price: it.price,
        discount_percentage: it.discount_percentage,
      });

      const mlPct = toNum(it.discount_percentage);
      const isCandLike = st === "candidate" || st === "pending";
      if (isCandLike) return pct;
      if (mlPct != null && mlPct > 70 && pct != null && Math.abs(mlPct - pct) > 5) return pct;
      return mlPct != null ? mlPct : pct;
    }

    const deal = toNum(it.deal_price ?? it.new_price ?? it._resolved_final_price ?? null);
    if (original != null && deal != null && original > 0) {
      return (1 - deal / original) * 100;
    }
    return toNum(it.discount_percentage);
  }

  function safeDealPrice(it, original, { state, toNum }) {
    const typeUp = (state?.selectedCard?.type || "").toUpperCase();
    const isDealLike = ["DEAL", "SELLER_CAMPAIGN", "PRICE_DISCOUNT", "DOD", "LIGHTNING"].includes(typeUp);
    if (!isDealLike) return toNum(it.deal_price ?? it.new_price ?? null);
    if (isStrictDealCandidate(it, state)) return null;

    const { final } = resolveDealFinalAndPctFront({
      original_price: toNum(original ?? it.original_price ?? it.price ?? null),
      promotion_type: typeUp,
      status: it.status,
      deal_price: it.deal_price ?? it.new_price,
      min_discounted_price: it.min_discounted_price,
      max_discounted_price: it.max_discounted_price,
      price: it.price,
      discount_percentage: it.discount_percentage,
    });
    return final != null ? final : null;
  }

  global.PromoStateHelpers = {
    normalizeStatus,
    dedupeByMLB,
    qsBuild,
    filtroToStatusParam,
    hasDealSuggestionFields,
    isStrictDealCandidate,
    pickRebate,
    computeDescPct,
    computeDealDiscountRange,
    isDealPercentWithinRange,
    resolveDealFinalAndPctFront,
    safeDealPrice,
  };
})(window);
