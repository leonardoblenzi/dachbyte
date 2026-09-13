function extractLogistics(raw) {
  if (typeof raw === "string") {
    try {
      return extractLogistics(JSON.parse(raw));
    } catch (_) {
      return [];
    }
  }

  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.logistic_info)) return raw.logistic_info;
  if (Array.isArray(raw?.logistics)) return raw.logistics;

  if (raw && typeof raw === "object") {
    const values = Object.values(raw).filter(
      (value) => value && typeof value === "object",
    );
    if (values.length) return values;
  }

  return [];
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

const SPX_LOGISTICS_CHANNEL_IDS = new Set(["80012", "91003", "91006"]);

function isHeavyChannelName(value) {
  const normalized = normalizeText(value);
  return (
    (normalized.includes("grande") && normalized.includes("pesado")) ||
    normalized.includes("item grande") ||
    normalized.includes("large and bulky") ||
    normalized.includes("bulky delivery")
  );
}

function isGenericStandardDeliveryName(value) {
  const normalized = normalizeText(value);
  return (
    normalized === "entrega padrao" ||
    normalized === "standard delivery" ||
    normalized === "entrega standard"
  );
}

function getChannelSignature(channel) {
  try {
    return normalizeText(JSON.stringify(channel));
  } catch (_) {
    return normalizeText(channel);
  }
}

function getChannelId(channel) {
  const value =
    channel?.logistic_id ??
    channel?.logistics_channel_id ??
    channel?.channel_id ??
    channel?.id;

  return value == null ? null : String(value);
}

function getChannelName(channel) {
  return String(
    channel?.logistic_name ??
      channel?.logistics_name ??
      channel?.logistics_channel_name ??
      channel?.channel_name ??
      channel?.channel ??
      channel?.name ??
      "",
  ).trim();
}

function getEnabled(channel) {
  if (typeof channel?.enabled === "boolean") return channel.enabled;
  if (typeof channel?.is_enabled === "boolean") return channel.is_enabled;
  if (typeof channel?.selected === "boolean") return channel.selected;
  if (typeof channel?.is_selected === "boolean") return channel.is_selected;

  const numericFlag =
    channel?.enabled ??
    channel?.is_enabled ??
    channel?.selected ??
    channel?.is_selected;

  if (numericFlag === 1 || numericFlag === "1") return true;
  if (numericFlag === 0 || numericFlag === "0") return false;

  const status = String(channel?.status || channel?.state || "")
    .trim()
    .toUpperCase();

  return [
    "ENABLED",
    "ENABLE",
    "ACTIVE",
    "OPTED_IN",
    "SELECTED",
    "TRUE",
  ].includes(status);
}

function identifyChannelKind(channel) {
  const name = normalizeText(getChannelName(channel));
  const channelId = getChannelId(channel);
  const signature = getChannelSignature(channel);

  if (SPX_LOGISTICS_CHANNEL_IDS.has(channelId)) {
    return "spx";
  }
  if (isHeavyChannelName(name)) {
    return "heavy";
  }
  if (
    signature.includes("intelipost") ||
    signature.includes("logistica do vendedor") ||
    signature.includes("logistica vendedor") ||
    signature.includes("seller logistics")
  ) {
    return "intelipost";
  }
  if (
    signature.includes("shopee xpress") ||
    signature.includes("shopee express") ||
    signature.includes("spx express") ||
    signature.includes("\"spx\"") ||
    signature.includes(" spx ") ||
    signature.startsWith("spx ") ||
    signature.endsWith(" spx") ||
    name === "spx" ||
    name === "xpress"
  ) {
    return "spx";
  }
  if (
    signature.includes("retire perto de voce") ||
    signature.includes("retire perto") ||
    signature.includes("retirada pelo comprador") ||
    signature.includes("buyer self collection") ||
    signature.includes("self collection") ||
    signature.includes("pickup")
  ) {
    return "pickup";
  }

  return "other";
}

function getChannelLabel(channel, kind = identifyChannelKind(channel)) {
  const name = getChannelName(channel);

  if (kind === "spx") {
    if (!name || isGenericStandardDeliveryName(name)) {
      return "Shopee Xpress (SPX)";
    }
    return name;
  }
  if (kind === "heavy") return name || "Entrega de Item Grande/Pesado";
  if (kind === "intelipost") return name || "Logistica do vendedor";
  if (kind === "pickup") return name || "Retire Perto de Voce";
  if (name) return name;

  return "Canal logistico";
}

function normalizeChannel(channel, forcedKind) {
  const kind = forcedKind || identifyChannelKind(channel);
  const rawName = getChannelName(channel);
  const label = getChannelLabel(channel, kind);

  return {
    channelId: getChannelId(channel),
    name:
      rawName && !(kind === "spx" && isGenericStandardDeliveryName(rawName))
        ? rawName
        : label,
    label,
    enabled: getEnabled(channel),
    kind,
    raw: channel,
  };
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

const CUBIC_WEIGHT_DIVISOR = 6000;

function analyzeSpxPhysicalEligibility({ dimension, weight }) {
  const packageLength = toFiniteNumber(
    dimension?.package_length ?? dimension?.length,
  );
  const packageWidth = toFiniteNumber(
    dimension?.package_width ?? dimension?.width,
  );
  const packageHeight = toFiniteNumber(
    dimension?.package_height ?? dimension?.height,
  );
  const packageWeight = toFiniteNumber(weight);
  const sides = [packageLength, packageWidth, packageHeight];
  const hasFullDimension = sides.every((value) => value != null);
  const cubicWeight =
    hasFullDimension
      ? Number(
          (
            (packageLength * packageWidth * packageHeight) /
            CUBIC_WEIGHT_DIVISOR
          ).toFixed(3),
        )
      : null;
  const chargeableWeightCandidates = [packageWeight, cubicWeight].filter(
    (value) => value != null,
  );
  const chargeableWeight = chargeableWeightCandidates.length
    ? Number(Math.max(...chargeableWeightCandidates).toFixed(3))
    : null;

  const reasons = [];

  if (!hasFullDimension) {
    reasons.push("Dimensoes do pacote incompletas.");
  } else {
    const maxSide = Math.max(packageLength, packageWidth, packageHeight);
    const sideSum = packageLength + packageWidth + packageHeight;

    if (maxSide > 120) {
      reasons.push(
        `Maior lado ${maxSide} cm excede o limite de 120 cm.`,
      );
    }

    if (sideSum > 200) {
      reasons.push(`Soma C+L+A ${sideSum} cm excede o limite de 200 cm.`);
    }
  }

  if (packageWeight == null) {
    reasons.push("Peso do pacote nao informado.");
  }

  if (cubicWeight != null && cubicWeight > 30) {
    reasons.push(`Peso cubico ${cubicWeight} kg excede o limite de 30 kg.`);
  }

  if (packageWeight != null && packageWeight > 30) {
    reasons.push(`Peso real ${packageWeight} kg excede o limite de 30 kg.`);
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    metrics: {
      packageLength,
      packageWidth,
      packageHeight,
      sideSum: hasFullDimension
        ? packageLength + packageWidth + packageHeight
        : null,
      maxSide: hasFullDimension
        ? Math.max(packageLength, packageWidth, packageHeight)
        : null,
      weight: packageWeight,
      cubicWeight,
      chargeableWeight,
      cubicWeightDivisor: CUBIC_WEIGHT_DIVISOR,
    },
  };
}

function buildSpxSnapshot({ logistics, dimension, weight }) {
  const logisticsAnalysis = analyzeLogistics(logistics);
  const physicalAnalysis = analyzeSpxPhysicalEligibility({ dimension, weight });
  const spxEligible = Boolean(
    logisticsAnalysis.spxEligible && physicalAnalysis.eligible,
  );

  return {
    logistics: logisticsAnalysis.logistics,
    spxChannel: logisticsAnalysis.spxChannel,
    pickupChannel: logisticsAnalysis.pickupChannel,
    intelipostChannels: logisticsAnalysis.intelipostChannels,
    shippingChannels: logisticsAnalysis.shippingChannels,
    shippingKinds: logisticsAnalysis.shippingKinds,
    shippingMode: logisticsAnalysis.shippingMode,
    spxEnabled: logisticsAnalysis.spxEnabled,
    spxLogisticsEligible: logisticsAnalysis.spxEligible,
    spxPhysicalEligible: physicalAnalysis.eligible,
    spxEligibilityReasons: physicalAnalysis.reasons,
    spxEligibilityMetrics: physicalAnalysis.metrics,
    spxEligible,
    cache: {
      shippingModeCache: logisticsAnalysis.shippingMode,
      spxEnabledCache: logisticsAnalysis.spxEnabled,
      spxLogisticsEligibleCache: logisticsAnalysis.spxEligible,
      spxPhysicalEligibleCache: physicalAnalysis.eligible,
      spxEligibleCache: spxEligible,
      spxEligibilityReasonsCache: physicalAnalysis.reasons,
      spxSnapshotAt: new Date(),
    },
  };
}

function analyzeLogistics(raw) {
  const rawLogistics = extractLogistics(raw);
  const logistics = rawLogistics.map((channel) => normalizeChannel(channel));

  if (!logistics.some((channel) => channel.kind === "spx")) {
    const fallbackCandidates = logistics.filter(
      (channel) =>
        channel.kind === "other" && isGenericStandardDeliveryName(channel.name),
    );

    if (fallbackCandidates.length === 1) {
      const fallbackIndex = logistics.findIndex(
        (channel) =>
          channel.kind === "other" &&
          isGenericStandardDeliveryName(channel.name),
      );

      if (fallbackIndex >= 0) {
        logistics[fallbackIndex] = normalizeChannel(
          rawLogistics[fallbackIndex],
          "spx",
        );
      }
    }
  }

  const enabledChannels = logistics.filter((channel) => channel.enabled);
  const spxChannels = logistics.filter((channel) => channel.kind === "spx");
  const spxEnabled = spxChannels.some((channel) => channel.enabled);
  const spxChannel =
    spxChannels.find((channel) => channel.enabled) || spxChannels[0] || null;
  const pickupChannel =
    logistics.find((channel) => channel.kind === "pickup") || null;
  const heavyChannels = logistics.filter((channel) => channel.kind === "heavy");
  const heavyChannel =
    heavyChannels.find((channel) => channel.enabled) || heavyChannels[0] || null;
  const heavyEnabled = heavyChannels.some((channel) => channel.enabled);
  const intelipostChannels = logistics.filter(
    (channel) => channel.kind === "intelipost",
  );
  const sellerEnabled = intelipostChannels.some((channel) => channel.enabled);
  const shippingChannels = unique(
    enabledChannels.map((channel) => channel.label || channel.name),
  );
  const availableKinds = unique(logistics.map((channel) => channel.kind));
  const enabledKinds = unique(enabledChannels.map((channel) => channel.kind));
  const shippingKinds = enabledKinds;

  return {
    logistics,
    enabledChannels,
    spxChannels,
    spxChannel,
    pickupChannel,
    heavyChannels,
    heavyChannel,
    intelipostChannels,
    shippingChannels,
    shippingKinds,
    shippingMode: shippingChannels.join(" / ") || null,
    heavyEnabled,
    sellerEnabled,
    availableKinds,
    enabledKinds,
    spxEnabled,
    spxEligible: Boolean(spxChannels.length && !spxEnabled),
  };
}

module.exports = {
  analyzeLogistics,
  extractLogistics,
  getChannelId,
  getChannelName,
  getEnabled,
  identifyChannelKind,
  normalizeChannel,
  SPX_LOGISTICS_CHANNEL_IDS,
  analyzeSpxPhysicalEligibility,
  buildSpxSnapshot,
};
