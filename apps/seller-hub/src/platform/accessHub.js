// @ts-check
"use strict";

/**
 * Cliente do hub de acessos (repositório "hub pagamento"), a autoridade de identidade do DACH Hub por enquanto.
 * - Senha: POST /v1/internal/portal/auth/verify (clientes) e, como reserva, /v1/internal/auth/verify (equipe da plataforma).
 * - Liberação: POST /v1/access/check com o módulo do Hub (padrão "dach_hub"), em cache curto.
 * Qualquer resposta estranha conta como "não" (falha fechada).
 */

const CACHE_MS = 45_000;
const TIMEOUT_MS = 8_000;
const INVALID = new Set(["invalid_credentials", "bad_password", "user_not_found"]);

/**
 * @typedef {{ tenantId: string, companyName: string | null, role: string | null }} TenantOption
 * @typedef {{ userId: string, email: string, name: string, tenantId: string, companyName: string | null, companyRole: string | null, tenants: TenantOption[] }} VerifiedUser
 */

/** @param {unknown} value */
const text = (value) => String(value ?? "").trim();

/** @param {Record<string, any>} payload */
function isPlatformPayload(payload) {
  const context = text(payload.context).toLowerCase();
  const reason = text(payload.reason).toLowerCase();
  return context === "platform" || reason === "platform_admin" || reason === "platform_module_master";
}

/** @param {Record<string, any>} payload @param {string} email @returns {VerifiedUser | null} */
function userFromPayload(payload, email) {
  const userId = text(payload.user_id);
  const tenantId = text(payload.tenant_id) || (isPlatformPayload(payload) && userId ? `platform-${userId}` : "");
  const mail = text(payload.email || email).toLowerCase();
  if (!userId || !tenantId || !mail) return null;
  const tenants = (Array.isArray(payload.available_tenants) ? payload.available_tenants : [])
    .map((/** @type {any} */ t) => ({ tenantId: text(t?.tenant_id), companyName: text(t?.company_name) || null, role: text(t?.role).toLowerCase() || null }))
    .filter((/** @type {TenantOption} */ t) => t.tenantId);
  return {
    userId, email: mail, name: text(payload.name || payload.full_name) || mail, tenantId,
    companyName: text(payload.company_name) || null,
    companyRole: text(payload.portal_role || payload.company_role).toLowerCase() || null,
    tenants: tenants.length ? tenants : [{ tenantId, companyName: text(payload.company_name) || null, role: text(payload.portal_role).toLowerCase() || null }],
  };
}

/**
 * @param {{ baseUrl: string, token: string, module: string, fetchImpl?: typeof fetch, now?: () => number, timeoutMs?: number }} options
 */
function createAccessHub({ baseUrl, token, module, fetchImpl = fetch, now = () => Date.now(), timeoutMs = TIMEOUT_MS }) {
  const configured = Boolean(baseUrl && token);
  /** @type {Map<string, { value: { allow: boolean, reason: string }, expiresAt: number }>} */
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
     * Confere e-mail e senha. Devolve o usuário ou o motivo da recusa
     * ("invalid_credentials", "no_company" ou "hub_unavailable").
     * @param {string} email @param {string} password
     * @returns {Promise<{ ok: true, user: VerifiedUser } | { ok: false, reason: string }>}
     */
    async verifyLogin(email, password) {
      if (!configured) return { ok: false, reason: "hub_unavailable" };
      const portal = await call("/v1/internal/portal/auth/verify", { email, password });
      if (portal.ok && portal.payload.allow === true) {
        const user = userFromPayload(portal.payload, email);
        return user ? { ok: true, user } : { ok: false, reason: "hub_unavailable" };
      }
      if (transient(portal)) return { ok: false, reason: "hub_unavailable" };
      const portalReason = text(portal.payload.reason).toLowerCase();
      if (portalReason === "invalid_credentials" || portalReason === "bad_password") return { ok: false, reason: "invalid_credentials" };
      // Sem empresa ativa no portal: pode ser alguém da equipe da plataforma.
      const internal = await call("/v1/internal/auth/verify", { email, password, module });
      if (internal.ok && internal.payload.allow === true) {
        const user = userFromPayload(internal.payload, email);
        if (user) return { ok: true, user };
      }
      if (transient(internal)) return { ok: false, reason: "hub_unavailable" };
      const reason = text(internal.payload.reason || portalReason).toLowerCase();
      return { ok: false, reason: INVALID.has(reason) ? "invalid_credentials" : "no_company" };
    },

    /**
     * A empresa e o usuário podem usar o DACH Hub? Resposta em cache por 45 s (erros de rede não entram no cache).
     * @param {{ tenantId: string, userId: string }} identity @param {{ force?: boolean }} [options]
     * @returns {Promise<{ allow: boolean, reason: string }>}
     */
    async checkAccess(identity, { force = false } = {}) {
      const key = `${identity.tenantId}:${identity.userId}`;
      const hit = cache.get(key);
      if (!force && hit && hit.expiresAt > now()) return hit.value;
      const res = await call("/v1/access/check", { tenant_id: identity.tenantId, user_id: identity.userId, module, action: `ACCESS ${module}` });
      if (transient(res)) return { allow: false, reason: text(res.payload.reason) || "hub_unavailable" };
      const value = { allow: res.ok && res.payload.allow === true, reason: text(res.payload.reason || res.payload.error) || (res.ok ? "denied" : `hub_http_${res.status}`) };
      cache.set(key, { value, expiresAt: now() + CACHE_MS });
      return value;
    },

    /** Esquece a decisão em cache (ao sair). @param {{ tenantId: string, userId: string }} identity */
    forget(identity) { cache.delete(`${identity.tenantId}:${identity.userId}`); },
  };
}

module.exports = { createAccessHub, _test: { userFromPayload } };
