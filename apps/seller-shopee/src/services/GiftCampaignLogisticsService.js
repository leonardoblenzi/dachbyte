const OPTION_DEFINITIONS = [
  {
    id: "adjust_gifts",
    label: "Preservar logística dos principais",
    source: "mainItems",
    affected: "giftItems",
  },
  {
    id: "adjust_main_items",
    label: "Preservar logística dos brindes",
    source: "giftItems",
    affected: "mainItems",
  },
];

function uniqueKinds(kinds) {
  return Array.from(
    new Set((Array.isArray(kinds) ? kinds : []).filter((kind) => typeof kind === "string" && kind)),
  );
}

function toPublicKind(kind) {
  if (kind === "intelipost") return "seller";
  if (kind === "seller" || kind === "spx" || kind === "pickup") return kind;
  return null;
}

function kindsFromLogistics(logistics, enabledOnly = false) {
  return uniqueKinds(
    (Array.isArray(logistics) ? logistics : [])
      .filter((entry) => !enabledOnly || entry?.enabled)
      .map((entry) => toPublicKind(entry?.kind))
      .filter(Boolean),
  );
}

function normalizedAvailableKinds(item) {
  if (Array.isArray(item?.availableKinds)) return uniqueKinds(item.availableKinds);
  return kindsFromLogistics(item?.logistics);
}

function normalizedEnabledKinds(item) {
  if (Array.isArray(item?.enabledKinds)) return uniqueKinds(item.enabledKinds);

  return uniqueKinds([
    ...uniqueKinds(item?.shippingKinds).map(toPublicKind).filter(Boolean),
    ...kindsFromLogistics(item?.logistics, true),
  ]);
}

function toMatrixItem(item) {
  return {
    itemId: String(item?.itemId ?? ""),
    availableKinds: normalizedAvailableKinds(item),
    enabledKinds: normalizedEnabledKinds(item),
    spxPhysicalEligible: item?.spxPhysicalEligible !== false,
    spxEligibilityReasons: Array.isArray(item?.spxEligibilityReasons)
      ? item.spxEligibilityReasons.filter(Boolean)
      : [],
  };
}

function sharedEnabledKinds(items) {
  if (!items.length) return [];

  return items[0].enabledKinds.filter((kind) =>
    items.every((item) => item.enabledKinds.includes(kind)),
  );
}

function itemChange(item, targetKinds) {
  const missingKinds = targetKinds.filter((kind) => !item.availableKinds.includes(kind));
  const spxRestricted = targetKinds.includes("spx") && !item.spxPhysicalEligible;
  const reasons = [];

  if (missingKinds.length) {
    reasons.push(`Canal indisponível: ${missingKinds.join(", ")}.`);
  }
  if (spxRestricted) {
    reasons.push(
      item.spxEligibilityReasons.join(" ") || "Produto fora das regras físicas do SPX.",
    );
  }

  return {
    itemId: item.itemId,
    targetKinds,
    feasible: reasons.length === 0,
    reason: reasons.join(" ") || null,
  };
}

function buildAdjustmentOption(definition, groups) {
  const targetKinds = sharedEnabledKinds(groups[definition.source]);
  const changes = groups[definition.affected].map((item) => itemChange(item, targetKinds));
  const unavailableTarget = targetKinds.length === 0;

  if (unavailableTarget) {
    changes.push({
      itemId: null,
      targetKinds: [],
      feasible: false,
      reason: "Os itens preservados não possuem um canal de logística ativo em comum.",
    });
  }

  const failedChanges = changes.filter((change) => !change.feasible);

  return {
    id: definition.id,
    label: definition.label,
    feasible: failedChanges.length === 0,
    reason: failedChanges.map((change) => change.reason).join(" ") || null,
    affectedItemIds: groups[definition.affected].map((item) => item.itemId),
    targetKinds,
    changes,
  };
}

function buildGiftCampaignLogisticsOptions({ mainItems, giftItems } = {}) {
  const groups = {
    mainItems: (Array.isArray(mainItems) ? mainItems : []).map(toMatrixItem),
    giftItems: (Array.isArray(giftItems) ? giftItems : []).map(toMatrixItem),
  };
  const matrix = {
    mainItems: groups.mainItems,
    giftItems: groups.giftItems,
  };
  const allItems = [...groups.mainItems, ...groups.giftItems];
  const compatible = sharedEnabledKinds(allItems).length > 0;
  const options = OPTION_DEFINITIONS.map((definition) =>
    buildAdjustmentOption(definition, groups),
  );

  options.push({
    id: "edit_selection",
    label: "Editar seleção",
    feasible: true,
    reason: null,
    affectedItemIds: allItems.map((item) => item.itemId),
    targetKinds: [],
    changes: [],
  });

  return { compatible, matrix, options };
}

module.exports = { buildGiftCampaignLogisticsOptions };
