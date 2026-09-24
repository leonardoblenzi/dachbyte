(() => {
  "use strict";

  const MANUAL_LISTING_FEES = Object.freeze({
    gold_special: Object.freeze({ commissionRatePct: 12, commissionFixed: 0 }),
    gold_pro: Object.freeze({ commissionRatePct: 17, commissionFixed: 0 }),
  });

  function manualListingFee(listingType) {
    return MANUAL_LISTING_FEES[listingType] || MANUAL_LISTING_FEES.gold_special;
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

  const api = { manualListingFee, shippingVisibility, createCalculationScheduler };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.MLCalculatorRules = api;
})();
