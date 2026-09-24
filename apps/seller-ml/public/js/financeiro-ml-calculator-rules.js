(() => {
  "use strict";

  const MANUAL_LISTING_FEES = Object.freeze({
    gold_special: Object.freeze({ commissionRatePct: 11.5, commissionFixed: 0 }),
    gold_pro: Object.freeze({ commissionRatePct: 16.5, commissionFixed: 0 }),
  });

  function manualListingFee(listingType) {
    return MANUAL_LISTING_FEES[listingType] || MANUAL_LISTING_FEES.gold_special;
  }

  function canQuoteMarketplaceFee({ price, categoryId, listingTypeId } = {}) {
    return Number(price) > 0 && Boolean(String(categoryId || "").trim()) &&
      ["gold_special", "gold_pro"].includes(String(listingTypeId || ""));
  }

  function manualFeeMode({ price, categoryId, listingTypeId = "gold_special" } = {}) {
    return canQuoteMarketplaceFee({ price, categoryId, listingTypeId })
      ? { source: "consultando", quote: true }
      : { source: "estimativa", quote: false };
  }

  function shippingVisibility(mode) {
    return mode === "comprador"
      ? { seller: false, buyer: true }
      : { seller: true, buyer: false };
  }

  function createCalculationScheduler(callback, delay = 350) {
    let timer = null;
    return {
      schedule() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          callback();
        }, delay);
      },
      cancel() {
        if (timer) clearTimeout(timer);
        timer = null;
      },
    };
  }

  const api = { manualListingFee, canQuoteMarketplaceFee, manualFeeMode, shippingVisibility, createCalculationScheduler };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.MLCalculatorRules = api;
})();
