"use strict";

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("trial_email_invalid");
  }
  return email;
}

async function resolveTrialEmail(rawEmail, { findLocalUser, lookupHubEmail }) {
  const email = normalizeEmail(rawEmail);
  if (typeof findLocalUser !== "function" || typeof lookupHubEmail !== "function") {
    throw new Error("trial_email_lookup_unavailable");
  }
  if (await findLocalUser(email)) return { email, action: "login_required" };
  const hub = await lookupHubEmail(email);
  if (hub?.exists === true) return { email, action: "login_required" };
  if (hub?.exists !== false) throw new Error("trial_email_hub_lookup_incomplete");
  return { email, action: "send_activation" };
}

async function lookupHubEmail(rawEmail, options = {}) {
  const email = normalizeEmail(rawEmail);
  const baseUrl = String(options.baseUrl ?? process.env.HUB_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(options.token ?? process.env.HUB_INTERNAL_TOKEN ?? "").trim();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!baseUrl || !token || typeof fetchImpl !== "function") {
    throw new Error("trial_email_hub_unavailable");
  }
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/v1/internal/portal/auth/email-exists`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (_error) {
    throw new Error("trial_email_hub_unavailable");
  }
  if (!response.ok) throw new Error("trial_email_hub_unavailable");
  const payload = await response.json().catch(() => null);
  if (payload?.ok !== true || typeof payload.exists !== "boolean") {
    throw new Error("trial_email_hub_lookup_incomplete");
  }
  return { exists: payload.exists };
}

module.exports = { normalizeEmail, resolveTrialEmail, lookupHubEmail };
