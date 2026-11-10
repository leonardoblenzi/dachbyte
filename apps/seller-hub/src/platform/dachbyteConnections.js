// @ts-check
"use strict";

/**
 * Cliente da conexão única da DACHBYTE (rede interna). Para o Mercado Livre, o dono das
 * contas e das chaves é o módulo ML: o Hub lista, pede autorização, pede a chave válida e
 * ativa/desativa a conta no produto dach_hub. O Hub nunca renova chave desses canais.
 * @param {{ baseUrl: string, token: string, fetchImpl?: typeof fetch, timeoutMs?: number }} options
 */
function createDachbyteConnections({ baseUrl, token, fetchImpl = fetch, timeoutMs = 8000 }) {
  const root = String(baseUrl || "").trim().replace(/\/+$/, "");
  const secret = String(token || "").trim();
  const configured = Boolean(root && secret);
  const PRODUCT = "dach_hub";

  /** @param {"GET" | "POST"} method @param {string} path @param {Record<string, any>} [body] */
  async function call(method, path, body) {
    if (!configured) throw Object.assign(new Error("Conexão da DACHBYTE não configurada."), { status: 503, code: "connections_not_configured" });
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (_error) {
      throw Object.assign(new Error("Conexão da DACHBYTE indisponível no momento."), { status: 503, code: "connections_unavailable" });
    }
    /** @type {any} */
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      const code = String(payload?.error || `connections_${response.status}`);
      throw Object.assign(new Error(code), { status: response.status >= 500 ? 503 : response.status, code });
    }
    return payload;
  }

  return {
    configured,
    /** @param {string} tenantId */
    async listAccounts(tenantId) {
      const { accounts } = await call("GET", `/accounts?tenant_id=${encodeURIComponent(tenantId)}`);
      return Array.isArray(accounts) ? accounts : [];
    },
    /** @param {{ tenantId: string, userId: string | null, companyName?: string | null, returnTo: string, publicOrigin: string }} input */
    async authorize({ tenantId, userId, companyName, returnTo, publicOrigin }) {
      const { url } = await call("POST", "/authorize", {
        tenant_id: tenantId, user_global_id: userId, company_name: companyName || null, product: PRODUCT, return_to: returnTo, public_origin: publicOrigin,
      });
      return String(url);
    },
    /** @param {{ tenantId: string, externalAccountId: string, rejectedAccessToken?: string | null }} input */
    async token({ tenantId, externalAccountId, rejectedAccessToken = null }) {
      const out = await call("POST", "/token", {
        tenant_id: tenantId, product: PRODUCT, meli_user_id: Number(externalAccountId), ...(rejectedAccessToken ? { rejected_access_token: rejectedAccessToken } : {}),
      });
      return { accessToken: String(out.access_token), expiresAt: out.expires_at ? new Date(out.expires_at) : null };
    },
    /** @param {{ tenantId: string, externalAccountId: string, actor: string }} input */
    async activate({ tenantId, externalAccountId, actor }) {
      return (await call("POST", "/activate", { tenant_id: tenantId, product: PRODUCT, meli_user_id: Number(externalAccountId), actor })).account;
    },
    /** @param {{ tenantId: string, externalAccountId: string }} input */
    async deactivate({ tenantId, externalAccountId }) {
      await call("POST", "/deactivate", { tenant_id: tenantId, product: PRODUCT, meli_user_id: Number(externalAccountId) });
    },
  };
}

module.exports = { createDachbyteConnections };
