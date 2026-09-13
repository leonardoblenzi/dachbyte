const CHANNEL_LOGISTICS_CARRIER_LABELS = [
  "Retirada Normal Na Agência",
  "Retirada Normal Na Agencia",
];

function normalizeCarrierName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isChannelLogisticsCarrier(value) {
  return normalizeCarrierName(value) === "retirada normal na agencia";
}

function buildExcludeChannelLogisticsWhere(fieldName = "shippingCarrier") {
  return {
    NOT: CHANNEL_LOGISTICS_CARRIER_LABELS.map((label) => ({
      [fieldName]: {
        equals: label,
        mode: "insensitive",
      },
    })),
  };
}

function withExcludedChannelLogistics(where = {}, fieldName = "shippingCarrier") {
  return {
    AND: [where, buildExcludeChannelLogisticsWhere(fieldName)],
  };
}

module.exports = {
  CHANNEL_LOGISTICS_CARRIER_LABELS,
  isChannelLogisticsCarrier,
  buildExcludeChannelLogisticsWhere,
  withExcludedChannelLogistics,
};
