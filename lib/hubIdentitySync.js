"use strict";

const HUB_DISABLED_VALUES = new Set([
  "",
  "0",
  "false",
  "null",
  "undefined",
  "off",
  "none",
  "disabled",
  "(not set)",
]);

function normalizeHubConfigValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (HUB_DISABLED_VALUES.has(value.toLowerCase())) {
    return "";
  }
  return value;
}

function normalizeHubBaseUrl(raw) {
  return normalizeHubConfigValue(raw)
    .replace(/\/+$/, "");
}

function isHubSyncConfigured() {
  const hubBaseUrl = normalizeHubBaseUrl(process.env.HUB_BASE_URL);
  const hubToken = normalizeHubConfigValue(process.env.HUB_INTERNAL_TOKEN);
  return Boolean(
    hubBaseUrl && hubToken,
  );
}

async function syncHubIdentity(identity) {
  if (!isHubSyncConfigured()) {
    return { ok: false, skipped: true, reason: "hub_not_configured" };
  }

  const tenantId = String(identity?.tenant_id || "").trim();
  const companyName = String(identity?.company_name || "").trim();
  const userId = String(identity?.user_id || "").trim();
  const fullName = String(identity?.full_name || "").trim();
  const email = String(identity?.email || "")
    .trim()
    .toLowerCase();

  if (!tenantId || !companyName || !userId || !fullName || !email) {
    return { ok: false, skipped: true, reason: "identity_payload_incomplete" };
  }

  const hubBaseUrl = normalizeHubBaseUrl(process.env.HUB_BASE_URL);
  const hubToken = normalizeHubConfigValue(process.env.HUB_INTERNAL_TOKEN);

  const response = await fetch(`${hubBaseUrl}/v1/internal/identity/sync`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${hubToken}`,
    },
    body: JSON.stringify({
      tenant_id: tenantId,
      company_name: companyName,
      document_type: identity?.document_type || null,
      document_number: identity?.document_number || null,
      user_id: userId,
      full_name: fullName,
      email,
      role: identity?.role || "owner",
      module: String(identity?.module || "").trim() || null,
      modules: Array.isArray(identity?.modules)
        ? identity.modules.map((item) => String(item || "").trim()).filter(Boolean)
        : [],
      access_policy: String(identity?.access_policy || "").trim() || null,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      skipped: false,
      reason: payload?.error || "hub_identity_sync_failed",
      status: response.status,
    };
  }

  return {
    ok: true,
    skipped: false,
    payload,
  };
}

async function revokeHubModuleAccess(identity) {
  if (!isHubSyncConfigured()) {
    return { ok: false, skipped: true, reason: "hub_not_configured" };
  }

  const tenantId = String(identity?.tenant_id || "").trim();
  const userId = String(identity?.user_id || "").trim();
  const email = String(identity?.email || "").trim().toLowerCase();
  const moduleSlug = String(identity?.module || "").trim();
  if (!tenantId || (!userId && !email) || !moduleSlug) {
    return { ok: false, skipped: true, reason: "module_revoke_payload_incomplete" };
  }

  const hubBaseUrl = normalizeHubBaseUrl(process.env.HUB_BASE_URL);
  const hubToken = normalizeHubConfigValue(process.env.HUB_INTERNAL_TOKEN);
  const response = await fetch(`${hubBaseUrl}/v1/internal/identity/module-access/revoke`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${hubToken}`,
    },
    body: JSON.stringify({
      tenant_id: tenantId,
      user_id: userId || null,
      email: email || null,
      module: moduleSlug,
      note: String(identity?.note || "").trim() || null,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  return response.ok
    ? { ok: true, skipped: false, payload }
    : {
        ok: false,
        skipped: false,
        reason: payload?.error || "hub_module_access_revoke_failed",
        status: response.status,
      };
}

module.exports = {
  isHubSyncConfigured,
  normalizeHubBaseUrl,
  revokeHubModuleAccess,
  syncHubIdentity,
};
