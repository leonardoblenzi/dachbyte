const DRAFT_STORAGE_PREFIX = "volt_core_optical_sale_draft";

function opticalSaleDraftKey({ companyId, operatorId } = {}) {
  return `${DRAFT_STORAGE_PREFIX}:${companyId || "company"}:${operatorId || "operator"}`;
}

function readOpticalSaleDraft(storage, scope) {
  try {
    return JSON.parse(storage?.getItem(opticalSaleDraftKey(scope)) || "null");
  } catch (_error) {
    return null;
  }
}

function writeOpticalSaleDraft(storage, scope, draft) {
  try {
    storage?.setItem(opticalSaleDraftKey(scope), JSON.stringify(draft));
  } catch (_error) {
    // Restricted browser modes may disable session storage.
  }
}

function clearOpticalSaleDraft(storage, scope) {
  try {
    storage?.removeItem(opticalSaleDraftKey(scope));
  } catch (_error) {
    // Keep the in-memory workflow usable when persistence is unavailable.
  }
}

export {
  clearOpticalSaleDraft,
  opticalSaleDraftKey,
  readOpticalSaleDraft,
  writeOpticalSaleDraft,
};
