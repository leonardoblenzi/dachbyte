"use strict";

const DEFAULT_TIMEOUT_MS = 5000;
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

function normalizeEnforcement() {
  const raw = String(process.env.HUB_AUTH_MODE || process.env.HUB_ENFORCEMENT || "hybrid")
    .trim()
    .toLowerCase();
  if (raw === "off" || raw === "disabled" || raw === "legacy") return "off";
  if (raw === "mirror" || raw === "sync") return "mirror";
  if (raw === "hybrid") return "hybrid";
  if (raw === "monitor" || raw === "warn") return "monitor";
  return "strict";
}

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeDocumentType(value) {
  const v = String(value || "")
    .trim()
    .toUpperCase();
  if (v === "CPF" || v === "CNPJ") return v;
  return null;
}

function normalizeDocumentNumber(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits || null;
}

function parseResponseBody(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function postJson(url, token, payload) {
  if (typeof fetch !== "function") {
    throw new Error("fetch_not_available");
  }

  const timeoutMs = Number(process.env.HUB_REQUEST_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS,
  );

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      data: parseResponseBody(text),
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildIdentity(input) {
  const user = input?.user || null;
  const account = input?.account || null;

  if (!user?.id || !user?.email) {
    return { ok: false, reason: "identity_user_missing" };
  }

  if (!account?.id) {
    if (input?.isSuperAdmin) {
      return { ok: true, bypass: true, reason: "super_admin_bypass_without_account" };
    }
    return { ok: false, reason: "identity_account_missing" };
  }

  const tenantGlobalId = String(account.tenantGlobalId || "").trim();
  const tenantId = tenantGlobalId || `shopee_account_${account.id}`;
  const companyName = String(account.name || "").trim();
  const userId = `shopee_user_${user.id}`;
  const fullName = String(user.name || "").trim() || normalizeEmail(user.email);
  const email = normalizeEmail(user.email);

  if (!tenantId || !companyName || !userId || !fullName || !email) {
    return { ok: false, reason: "identity_required_fields_missing" };
  }

  return {
    ok: true,
    payload: {
      tenant_id: tenantId,
      company_name: companyName,
      document_type: normalizeDocumentType(account.documentType),
      document_number: normalizeDocumentNumber(account.documentNumber),
      user_id: userId,
      full_name: fullName,
      email,
      role: String(user.role || "member").toLowerCase(),
      module: "shopee",
      modules: ["shopee"],
    },
  };
}

async function evaluateHubLoginAccess(input) {
  const enforcement = normalizeEnforcement();
  if (enforcement === "off") {
    return { allow: true, reason: "hub_enforcement_off" };
  }

  const hubBaseUrl = normalizeHubConfigValue(process.env.HUB_BASE_URL).replace(/\/+$/, "");
  const hubToken = normalizeHubConfigValue(process.env.HUB_INTERNAL_TOKEN);
  const strict = enforcement === "strict";
  const enforceHubDecision = enforcement === "strict" || enforcement === "hybrid";
  const mirrorOnly = enforcement === "mirror";

  if (!hubBaseUrl || !hubToken) {
    return { allow: true, reason: "hub_not_configured" };
  }

  const identity = buildIdentity(input);
  if (!identity.ok) {
    if (identity.bypass) {
      return { allow: true, reason: identity.reason || "hub_bypass" };
    }
    if (!strict) {
      return { allow: true, reason: identity.reason || "identity_not_ready_monitor" };
    }
    return {
      allow: false,
      reason: identity.reason || "identity_not_ready",
      message: "Identidade da conta nao esta configurada para validacao no Hub.",
    };
  }

  try {
    const syncResponse = await postJson(
      `${hubBaseUrl}/v1/internal/identity/sync`,
      hubToken,
      identity.payload,
    );

    if (!syncResponse.ok && (syncResponse.status === 401 || syncResponse.status === 403)) {
      return { allow: true, reason: "hub_auth_invalid_bypass" };
    }

    if (!syncResponse.ok && strict) {
      return {
        allow: false,
        reason: "hub_identity_sync_failed",
        message: "Nao foi possivel validar identidade da conta no Hub.",
      };
    }

    if (mirrorOnly) {
      return { allow: true, reason: syncResponse.ok ? "hub_identity_synced_mirror" : "hub_identity_sync_failed_mirror" };
    }

    const syncedIdentity = syncResponse.ok ? syncResponse.data || {} : {};
    const effectiveTenantId = String(
      syncedIdentity.tenant_id || identity.payload.tenant_id,
    ).trim();
    const effectiveUserId = String(
      syncedIdentity.user_id || identity.payload.user_id,
    ).trim();

    const checkResponse = await postJson(`${hubBaseUrl}/v1/access/check`, hubToken, {
      tenant_id: effectiveTenantId,
      user_id: effectiveUserId,
      module: "shopee",
      action: "login",
    });

    if (!checkResponse.ok) {
      if (checkResponse.status === 401 || checkResponse.status === 403) {
        return { allow: true, reason: "hub_auth_invalid_bypass" };
      }
      if (strict) {
        return {
          allow: false,
          reason: "hub_access_check_failed",
          message: "Nao foi possivel validar permissao de acesso no Hub.",
        };
      }
      return { allow: true, reason: "hub_access_check_failed_monitor" };
    }

    const data = checkResponse.data || {};
    if (!data.allow && !enforceHubDecision) {
      return { allow: true, reason: data.reason || "hub_denied_monitor", message: data.message || null };
    }
    return {
      allow: Boolean(data.allow),
      reason: data.reason || (data.allow ? "ok" : "hub_denied"),
      message: data.message || null,
      status: data.status || null,
      tenant_status: data.tenant_status || null,
    };
  } catch (error) {
    if (!strict) {
      return { allow: true, reason: "hub_unreachable_monitor" };
    }
    return {
      allow: false,
      reason: "hub_unreachable",
      message: "Hub indisponivel no momento para validar o acesso.",
      detail: error instanceof Error ? error.message : String(error || "unknown_error"),
    };
  }
}

module.exports = {
  evaluateHubLoginAccess,
};

