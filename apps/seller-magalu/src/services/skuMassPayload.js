"use strict";

const crypto = require("node:crypto");
const WRITE_SCOPE = "open:portfolio-skus-seller:write";
const ACTIONS = new Set(["activate", "deactivate"]);

function text(value, max = 300) { return String(value == null ? "" : value).trim().slice(0, max); }
function normalizeAction(value) {
  const action = text(value, 30).toLowerCase();
  if (!ACTIONS.has(action)) {
    const error = new Error("Ação de SKU inválida. Use activate ou deactivate.");
    error.code = "MAGALU_SKU_MASS_INVALID_ACTION";
    error.status = 400;
    throw error;
  }
  return action;
}
function desiredActive(action) { return normalizeAction(action) === "activate"; }
function hasWriteScope(scopes) { return (Array.isArray(scopes) ? scopes : []).map(String).includes(WRITE_SCOPE); }
function previewState(row) {
  return {
    active: row?.active === true,
    status: text(row?.status, 80) || null,
  };
}
function remoteState(payload) {
  return {
    active: payload?.active === true,
    status: text(payload?.status, 80) || null,
  };
}
function samePreviewState(before, remote) {
  return Boolean(before) && Boolean(remote)
    && before.active === remote.active
    && String(before.status || "") === String(remote.status || "");
}
function requestPayload(action) { return { active: desiredActive(action) }; }
function requestHash({ accountId, sku, action, before }) {
  return crypto.createHash("sha256").update(JSON.stringify({ accountId:Number(accountId), sku:text(sku,64), action:normalizeAction(action), before:before||{} })).digest("hex");
}
module.exports = {
  WRITE_SCOPE, ACTIONS, normalizeAction, desiredActive, hasWriteScope, previewState, remoteState,
  samePreviewState, requestPayload, requestHash, _test:{ text },
};
