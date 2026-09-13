(function exposeLogisticsCenterRules(globalScope) {
  const TARGET_KINDS = ["seller", "spx", "heavy"];
  const PICKUP_KIND = "pickup";

  function normalizeText(value) {
    const normalized = String(value || "").normalize("NFD");
    return normalized
      .split("")
      .filter((char) => char.charCodeAt(0) < 768 || char.charCodeAt(0) > 879)
      .join("")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    /*
    return String(value || "")
      .normalize("NFD")
      .replace(/[\\u0300-\\u036f]/g, "")
      .trim()
      .split("")
      .filter((char) => char.charCodeAt(0) < 768 || char.charCodeAt(0) > 879)
      .join("")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    */
  }

  function kindFromValue(value) {
    const normalized = normalizeText(value);

    if (!normalized) return null;
    if (
      normalized === "seller" ||
      normalized.includes("logistica do vendedor") ||
      normalized.includes("logistica vendedor")
    ) {
      return "seller";
    }
    if (
      normalized === "spx" ||
      normalized.includes("shopee xpress") ||
      normalized.includes("expresso aereo")
    ) {
      return "spx";
    }
    if (
      normalized === "heavy" ||
      (normalized.includes("grande") && normalized.includes("pesado")) ||
      normalized.includes("large and bulky") ||
      normalized.includes("bulky delivery")
    ) {
      return "heavy";
    }
    if (normalized === "pickup" || normalized.includes("retire perto")) {
      return PICKUP_KIND;
    }

    return null;
  }

  function normalizeKinds(raw) {
    const values = Array.isArray(raw) ? raw : [raw];
    const requestedKinds = new Set(
      values.map(kindFromValue).filter((kind) => TARGET_KINDS.includes(kind)),
    );

    return TARGET_KINDS.filter((kind) => requestedKinds.has(kind));
  }

  function validationError(code, message, kinds) {
    return { code, message, kinds };
  }

  function validateKinds(kinds) {
    const values = Array.isArray(kinds) ? kinds : [kinds];
    const targetKinds = normalizeKinds(values);
    const errors = [];
    const unsupportedKinds = values
      .map((value) => ({ value, kind: kindFromValue(value) }))
      .filter(({ kind }) => kind === PICKUP_KIND)
      .map(({ kind }) => kind);

    if (unsupportedKinds.length) {
      errors.push(validationError(
        "unsupported_target_kind",
        "Retire perto de voce nao pode ser selecionado como estado alvo.",
        Array.from(new Set(unsupportedKinds)),
      ));
    }

    if (targetKinds.includes("spx") && targetKinds.includes("heavy")) {
      errors.push(validationError(
        "spx_heavy_conflict",
        "SPX nao pode ser combinado com entrega pesada.",
        ["spx", "heavy"],
      ));
    }

    if (!targetKinds.includes("seller")) {
      errors.push(validationError(
        "seller_required",
        "Logistica do vendedor e obrigatoria.",
        ["seller"],
      ));
    }

    return { ok: errors.length === 0, targetKinds, errors };
  }

  function toggleTargetKind(currentKinds, requestedKind) {
    const nextKind = kindFromValue(requestedKind);
    const targetKinds = normalizeKinds(currentKinds);
    const removedKinds = [];

    if (!TARGET_KINDS.includes(nextKind)) {
      return {
        targetKinds,
        removedKinds,
        sellerPromptRequired: false,
      };
    }

    const selectedKinds = new Set(targetKinds);
    if (selectedKinds.has(nextKind)) {
      selectedKinds.delete(nextKind);
      removedKinds.push(nextKind);
    } else {
      if (nextKind === "spx" && selectedKinds.delete("heavy")) {
        removedKinds.push("heavy");
      }
      if (nextKind === "heavy" && selectedKinds.delete("spx")) {
        removedKinds.push("spx");
      }
      selectedKinds.add(nextKind);
    }

    const nextTargetKinds = TARGET_KINDS.filter((kind) => selectedKinds.has(kind));
    return {
      targetKinds: nextTargetKinds,
      removedKinds,
      sellerPromptRequired:
        (nextKind === "spx" || nextKind === "heavy") &&
        nextTargetKinds.includes(nextKind) &&
        !nextTargetKinds.includes("seller"),
    };
  }

  function parseMappingKinds(raw) {
    const values = String(raw || "")
      .split(/[,;|]/)
      .map((value) => value.trim())
      .filter(Boolean);
    const kinds = normalizeKinds(values);
    const validation = validateKinds(values);
    const unknownValues = values.filter((value) => !kindFromValue(value));
    const errors = [...validation.errors];

    if (unknownValues.length) {
      errors.unshift(validationError(
        "unsupported_target_kind",
        "Tipo de logistica nao reconhecido.",
        unknownValues,
      ));
    }

    return {
      ok: errors.length === 0,
      kinds,
      errors,
    };
  }

  const api = {
    normalizeKinds,
    toggleTargetKind,
    validateKinds,
    parseMappingKinds,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (globalScope) globalScope.LogisticsCenterRules = api;
})(typeof window !== "undefined" ? window : null);
