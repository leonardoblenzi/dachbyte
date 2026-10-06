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

  function shippingVisibility(mode, { split = false } = {}) {
    if (split) return { seller: true, buyer: true };
    return mode === "comprador"
      ? { seller: false, buyer: true }
      : { seller: true, buyer: false };
  }

  function listingShippingContext(item = {}) {
    const mode = String(item.shipping_mode || "").trim().toLowerCase();
    const logistic = String(item.logistic_type || "").trim().toLowerCase();
    const agreed = ["me1", "not_specified", "to_be_agreed"].includes(mode);
    const split = mode === "me2" && item.free_shipping === false;
    const simulationMode = agreed ? "comprador" : item.free_shipping ? "mercado_envios" : "comprador";
    const modeLabel = ({
      me2: "Mercado Envios 2 (ME2)",
      me1: "ME1 · logística própria",
      custom: "Envio personalizado",
      not_specified: "Entrega a combinar",
      to_be_agreed: "Entrega a combinar",
    })[mode] || "Modo não informado";
    const logisticLabel = ({
      cross_docking: "Coleta",
      xd_drop_off: "Agência",
      drop_off: "Ponto de envio",
      fulfillment: "Full",
      self_service: "Flex",
      turbo: "Turbo",
    })[logistic] || "";
    const paymentLabel = agreed
      ? "Frete a definir na simulação"
      : item.free_shipping ? "Frete grátis para o comprador" : "Comprador paga o frete";
    const quoteStatus = simulationMode !== "mercado_envios" && !split
      ? "not_applicable"
      : ["users_shipping_options_free", "items_shipping_options_free"].includes(item.shipping_source)
        ? "estimated"
        : "unavailable";
    return { modeLabel, logisticLabel, paymentLabel, simulationMode, quoteStatus, ...(split ? { split: true } : {}) };
  }

  function normalizeShippingInputs(mode, { sellerShipping = 0, buyerShipping = 0 } = {}, { split = false } = {}) {
    if (split) return { sellerShipping: Number(sellerShipping) || 0, buyerShipping: Number(buyerShipping) || 0 };
    return mode === "comprador"
      ? { sellerShipping: 0, buyerShipping: Number(buyerShipping) || 0 }
      : { sellerShipping: Number(sellerShipping) || 0, buyerShipping: 0 };
  }

  function costConfidence(productCost) {
    return Number(productCost) > 0
      ? { state: "ready", roiAvailable: true }
      : { state: "missing", roiAvailable: false };
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

  const api = { manualListingFee, canQuoteMarketplaceFee, manualFeeMode, shippingVisibility, listingShippingContext, normalizeShippingInputs, costConfidence, createCalculationScheduler };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.MLCalculatorRules = api;
})();
