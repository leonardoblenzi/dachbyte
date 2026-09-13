const {
  analyzeLogistics,
  identifyChannelKind,
} = require("../utils/productLogistics");

const TARGET_KINDS = ["seller", "spx", "heavy"];
const MANAGED_KINDS = new Set(["seller", "spx", "heavy"]);
const INTERNAL_KIND_BY_TARGET_KIND = { seller: "intelipost", spx: "spx", heavy: "heavy" };

function normalizeTargetKinds(values) {
  const requested = Array.isArray(values) ? values : [values];
  const kinds = new Set(
    requested.filter((value) => TARGET_KINDS.includes(value)),
  );

  return TARGET_KINDS.filter((kind) => kinds.has(kind));
}

function availableTargetKinds(analysis) {
  const availableKinds = Array.isArray(analysis?.availableKinds)
    ? analysis.availableKinds
    : Array.isArray(analysis?.logistics)
      ? analysis.logistics.map((channel) => channel.kind)
      : [];

  return new Set(
    availableKinds.map((kind) => (kind === "intelipost" ? "seller" : kind)),
  );
}

function validateTargetKinds({ targetKinds, analysis }) {
  const normalizedTargetKinds = normalizeTargetKinds(targetKinds);
  const managedTargetKinds = normalizedTargetKinds.filter((kind) =>
    MANAGED_KINDS.has(kind),
  );
  const errors = [];
  const requestedKinds = Array.from(
    new Set((Array.isArray(targetKinds) ? targetKinds : [targetKinds])
      .filter((kind) => kind === "pickup")),
  );

  if (requestedKinds.length) {
    errors.push({
      code: "unsupported_target_kind",
      message: "Retire perto de voce nao pode ser selecionado como estado alvo.",
      kinds: requestedKinds,
    });
  }

  if (
    managedTargetKinds.includes("spx") &&
    managedTargetKinds.includes("heavy")
  ) {
    errors.push({
      code: "spx_heavy_conflict",
      message: "SPX nao pode ser combinado com entrega pesada.",
      kinds: ["spx", "heavy"],
    });
  }

  if (!managedTargetKinds.includes("seller")) {
    errors.push({
      code: "seller_required",
      message: "Logistica do vendedor e obrigatoria.",
      kinds: ["seller"],
    });
  }

  const availableKinds = availableTargetKinds(analysis);
  const missingKinds = managedTargetKinds.filter(
    (kind) => !availableKinds.has(kind),
  );

  if (missingKinds.length) {
    errors.push({
      code: "channel_unavailable",
      message: "Os canais logisticos solicitados nao estao disponiveis.",
      kinds: missingKinds,
    });
  }

  return {
    ok: errors.length === 0,
    targetKinds: normalizedTargetKinds,
    errors,
    missingKinds,
  };
}

function setChannelEnabled(channel, enabled) {
  const nextChannel = { ...channel };
  const activationKeys = ["enabled", "is_enabled", "selected", "is_selected"];
  let hasActivationFlag = false;

  for (const key of activationKeys) {
    if (Object.hasOwn(channel, key)) {
      nextChannel[key] = enabled;
      hasActivationFlag = true;
    }
  }

  return hasActivationFlag ? nextChannel : { ...channel, enabled };
}

function buildTargetLogistics({ logistics, targetKinds }) {
  const analysis = analyzeLogistics(logistics);
  const validation = validateTargetKinds({ targetKinds, analysis });

  if (!validation.ok) {
    return {
      ...validation,
      logistics,
      changed: false,
    };
  }

  const desiredManagedKinds = new Set(
    validation.targetKinds.filter((kind) => MANAGED_KINDS.has(kind)),
  );
  let changed = false;
  const nextLogistics = logistics.map((channel) => {
    const kind = identifyChannelKind(channel);
    const targetKind = Object.entries(INTERNAL_KIND_BY_TARGET_KIND).find(
      ([, internalKind]) => internalKind === kind,
    )?.[0];

    if (!targetKind) return channel;

    const shouldEnable = desiredManagedKinds.has(targetKind);
    const current = analysis.logistics.find((item) => item.raw === channel);
    const hasContradictoryActivationFlag = [
      "enabled",
      "is_enabled",
      "selected",
      "is_selected",
    ].some(
      (key) => Object.hasOwn(channel, key) && channel[key] !== shouldEnable,
    );
    if (current?.enabled === shouldEnable && !hasContradictoryActivationFlag) {
      return channel;
    }

    changed = true;
    return setChannelEnabled(channel, shouldEnable);
  });

  return {
    ...validation,
    logistics: changed ? nextLogistics : logistics,
    changed,
  };
}

module.exports = {
  normalizeTargetKinds,
  validateTargetKinds,
  buildTargetLogistics,
};
