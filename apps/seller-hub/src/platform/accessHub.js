// @ts-check
"use strict";

/**
 * Cliente do hub de acessos (repositório "hub pagamento"): diz se a empresa e o usuário podem usar o DACH Hub.
 * A senha é conferida pelo login da suíte (/api/auth/login); aqui só a liberação do produto:
 * POST /v1/access/check com o módulo do Hub (padrão "dach_hub"), em cache curto.
 * Qualquer resposta estranha conta como "não" (falha fechada).
 */

const CACHE_MS = 45_000;
const TIMEOUT_MS = 8_000;

/** @param {unknown} value */
const text = (value) => String(value ?? "").trim();

/**
 * @param {{ baseUrl: string, token: string, module: string, fetchImpl?: typeof fetch, now?: () => number, timeoutMs?: number }} options
 */
function createAccessHub({ baseUrl, token, module, fetchImpl = fetch, now = () => Date.now(), timeoutMs = TIMEOUT_MS }) {
  const configured = Boolean(baseUrl && token);
  /** @type {Map<string, { value: { allow: boolean, reason: string, accountLimit: number | null }, expiresAt: number }>} */
  const cache = new Map();

  /** @param {string} path @param {Record<string, any>} body */
  async function call(path, body) {
    if (!configured) return { ok: false, status: 503, payload: { reason: "hub_not_configured" } };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST", signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, payload: payload && typeof payload === "object" ? payload : {} };
    } catch (_error) {
      return { ok: false, status: 0, payload: { reason: "hub_unreachable" } };
    } finally { clearTimeout(timer); }
  }

  /** @param {{ status: number }} result */
  const transient = (result) => result.status === 0 || result.status === 408 || result.status === 429 || result.status >= 500;

  return {
    configured,

    /**
     * A empresa e o usuário podem usar o DACH Hub? Resposta em cache por 45 s (erros de rede não entram no cache).
     * @param {{ tenantId: string, userId: string }} identity @param {{ force?: boolean }} [options]
     * accountLimit: contas de marketplace que o plano permite (limits.channel_accounts); null = não informado.
     * @returns {Promise<{ allow: boolean, reason: string, accountLimit: number | null }>}
     */
    async checkAccess(identity, { force = false } = {}) {
      const key = `${identity.tenantId}:${identity.userId}`;
      const hit = cache.get(key);
      if (!force && hit && hit.expiresAt > now()) return hit.value;
      const res = await call("/v1/access/check", { tenant_id: identity.tenantId, user_id: identity.userId, module, action: `ACCESS ${module}` });
      if (transient(res)) return { allow: false, reason: text(res.payload.reason) || "hub_unavailable", accountLimit: null };
      const rawLimit = res.payload.limits && typeof res.payload.limits === "object" ? res.payload.limits.channel_accounts : undefined;
      const accountLimit = rawLimit == null || rawLimit === "" || !Number.isFinite(Number(rawLimit)) ? null : Math.max(0, Math.trunc(Number(rawLimit)));
      const value = { allow: res.ok && res.payload.allow === true, reason: text(res.payload.reason || res.payload.error) || (res.ok ? "denied" : `hub_http_${res.status}`), accountLimit };
      cache.set(key, { value, expiresAt: now() + CACHE_MS });
      return value;
    },

    /**
     * Registra a conta conectada como recurso do DACH Hub (mesmo endpoint dos módulos).
     * Erro vira exceção; quem chama decide não derrubar a conexão.
     * @param {{ tenantId: string, channel: string, externalAccountId: string, label?: string | null }} input
     */
    async syncResource({ tenantId, channel, externalAccountId, label }) {
      if (!configured) return { skipped: true };
      const res = await call("/v1/internal/resources/sync", { tenant_id: tenantId, module_slug: module, account_id: `${channel}:${externalAccountId}`, label: label || `${channel} ${externalAccountId}`, oauth_confirmed: true, metadata: { channel } });
      if (!res.ok) throw new Error(text(res.payload.error || res.payload.reason) || `hub_http_${res.status}`);
      return res.payload;
    },

    /** @param {{ tenantId: string, channel: string, externalAccountId: string }} input */
    async unlinkResource({ tenantId, channel, externalAccountId }) {
      if (!configured) return { skipped: true };
      const res = await call("/v1/internal/resources/unlink", { tenant_id: tenantId, module_slug: module, account_id: `${channel}:${externalAccountId}`, reason: "disconnected_in_hub" });
      if (!res.ok) throw new Error(text(res.payload.error || res.payload.reason) || `hub_http_${res.status}`);
      return res.payload;
    },

  };
}

module.exports = { createAccessHub };
