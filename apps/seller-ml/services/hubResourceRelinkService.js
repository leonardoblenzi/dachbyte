"use strict";

function createMlHubRelink({ baseUrl, token, fetchImpl = fetch }) {
  return async function confirmMlHubResourceAfterOAuth({ tenantId, accountId, label }) {
    if (!baseUrl || !token || !tenantId || !accountId) throw new Error("ml_hub_relink_not_configured");
    const endpoint = new URL("/v1/internal/resources/sync", baseUrl);
    const response = await fetchImpl(endpoint.toString(), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        tenant_id: String(tenantId), module_slug: "ml", account_id: String(accountId),
        label: String(label || accountId), oauth_confirmed: true,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("ml_hub_relink_failed");
    const result = await response.json().catch(() => null);
    if (result?.access?.allow !== true) throw new Error("ml_hub_relink_not_allowed");
    return result;
  };
}

module.exports = { createMlHubRelink };
