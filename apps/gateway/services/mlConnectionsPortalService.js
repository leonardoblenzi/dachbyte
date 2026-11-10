"use strict";

// Seleção de plataforma: conectar e contratar contas do Mercado Livre num lugar só.
// - Lista as contas que a empresa já conectou na DACHBYTE (ex.: pelo DACH Hub) e
//   ainda não estão no módulo ML.
// - Registra uma delas para contratação (hub de acessos: aguardando contratação).
// - Inicia a autorização de uma conta nova no Mercado Livre, que volta para cá.
// O módulo ML é o dono das contas (API interna); quem pode fazer isso é quem
// gerencia a cobrança da empresa, conforme o hub de acessos (overview do portal).

function createMlConnectionsPortalService({ connectionsUrl, connectionsToken, portal, fetchImpl = fetch, timeoutMs = 8000 }) {
  const root = String(connectionsUrl || "").trim().replace(/\/+$/, "");
  const secret = String(connectionsToken || "").trim();

  async function call(method, path, body) {
    if (!root || !secret) return { ok: false, status: 503, payload: { ok: false, error: "ml_connections_not_configured" } };
    try {
      const response = await fetchImpl(`${root}${path}`, {
        method,
        headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await response.json().catch(() => ({}));
      return { ok: response.ok && payload?.ok !== false, status: response.status, payload };
    } catch (_error) {
      return { ok: false, status: 503, payload: { ok: false, error: "ml_connections_unavailable" } };
    }
  }

  /** Quem gerencia a cobrança, com o módulo ML instalado na empresa. */
  async function authorizeManager(identity) {
    const tenantId = String(identity?.tenant_id || "").trim();
    const userId = String(identity?.user_id || "").trim();
    if (!tenantId || !userId) return { error: { ok: false, status: 401, payload: { ok: false, error: "suite_identity_incomplete" } } };
    const overview = await portal.overview(identity);
    if (!overview.ok) return { error: overview };
    const data = overview.payload || {};
    if (data.user?.can_manage_billing !== true) {
      return { error: { ok: false, status: 403, payload: { ok: false, error: "billing_manager_required" } } };
    }
    // ML não instalado: o teste de 7 dias pode valer (o módulo ML decide com o hub de acessos).
    return {
      tenantId, userId,
      companyName: String(data.tenant?.name || "").trim() || null,
      user: data.user || {},
    };
  }

  /** Quem adiciona a conta do ML passa a poder entrar no módulo (se teste ou contrato liberarem). */
  async function grantMlAccess(identity, who) {
    if (typeof portal.grantModuleAccess !== "function") return;
    const result = await portal.grantModuleAccess(identity, {
      module: "ml",
      tenantName: who.companyName,
      userName: who.user?.name,
      userEmail: who.user?.email,
      userRole: who.user?.role,
    });
    if (!result?.ok) console.warn("[portal] permissão do ML não registrada", result?.payload?.error || result?.status);
  }

  return {
    async dachbyteAccounts(identity) {
      const who = await authorizeManager(identity);
      if (who.error) return who.error;
      const result = await call("GET", `/accounts?tenant_id=${encodeURIComponent(who.tenantId)}`);
      if (!result.ok) return result;
      const accounts = (result.payload.accounts || [])
        .filter((a) => Array.isArray(a.products) && !a.products.includes("ml"))
        .map((a) => ({ meli_user_id: a.meli_user_id, label: a.label, connection: a.connection, products: a.products }));
      return { ok: true, status: 200, payload: { ok: true, accounts } };
    },

    async register(identity, input = {}) {
      const who = await authorizeManager(identity);
      if (who.error) return who.error;
      const meliUserId = Number(input.meli_user_id);
      if (!Number.isSafeInteger(meliUserId) || meliUserId <= 0) return { ok: false, status: 400, payload: { ok: false, error: "meli_user_id_required" } };
      await grantMlAccess(identity, who);
      return call("POST", "/register-ml", { tenant_id: who.tenantId, meli_user_id: meliUserId });
    },

    async connect(identity, { publicOrigin } = {}) {
      const who = await authorizeManager(identity);
      if (who.error) return who.error;
      await grantMlAccess(identity, who);
      return call("POST", "/authorize", {
        tenant_id: who.tenantId,
        user_global_id: who.userId,
        company_name: who.companyName,
        product: "none",
        return_to: "/selecao-plataforma",
        public_origin: publicOrigin,
      });
    },
  };
}

module.exports = { createMlConnectionsPortalService };
