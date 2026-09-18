"use strict";

/**
 * Public DACHBYTE vocabulary shared by every product family.
 *
 * This module deliberately contains only customer-facing names. Legacy route,
 * cookie, database and integration identifiers stay where they are until a
 * separately planned compatibility migration can replace them safely.
 */
const DACHBYTE_BRAND = Object.freeze({
  name: "DachByte",
  seller: "Dach Seller",
  business: "Dach Business",
  ads: "Dach Ads",
  support: "Suporte DachByte",
  sac: "SAC DachByte",
  products: Object.freeze({
    core: "Dach Core",
    stock: "Dach Stock",
    chat: "Dach Chat",
    price: "Dach Price",
    tracking: "Dach Tracking",
    log: "Dach Log",
    leader: "Dach Leader",
    hub: "Dach Hub",
    ads: "Dach Ads",
  }),
});

module.exports = { DACHBYTE_BRAND };
