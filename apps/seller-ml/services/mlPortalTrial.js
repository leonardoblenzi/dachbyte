"use strict";

// Conta do ML adicionada pela seleção de plataforma (conta da DACHBYTE ou autorização
// nova): se a empresa ainda não usou o teste do ML e não é cliente dele, ganha os 7 dias
// grátis (regra do hub de acessos: um teste por empresa e por CNPJ). Senão, segue para
// contratação (recurso aguardando contratação).

const NOT_ELIGIBLE = new Set([
  "trial_module_already_entitled",
  "trial_product_already_installed",
  "trial_document_already_used",
  "trial_resource_already_entitled",
]);

function hubConfig(options = {}) {
  const baseUrl = String(options.baseUrl ?? process.env.HUB_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(options.token ?? process.env.HUB_INTERNAL_TOKEN ?? "").trim();
  if (!baseUrl || !token) throw new Error("trial_hub_unavailable");
  return { baseUrl, token, fetchImpl: options.fetchImpl || globalThis.fetch };
}

/**
 * Tenta o teste no hub de acessos. Retorna { trial: true, endsAt } quando o teste está
 * valendo, { trial: false } quando a empresa não pode (ou já usou e acabou).
 */
async function tryStartMlTrial({ tenantId, meliUserId }, options = {}) {
  const hub = hubConfig(options);
  let response;
  try {
    response = await hub.fetchImpl(`${hub.baseUrl}/v1/internal/portal/module-trials/activate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${hub.token}` },
      body: JSON.stringify({ tenant_id: String(tenantId), module_slug: "ml", resource_key: `ml:${Number(meliUserId)}` }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (_error) {
    throw new Error("trial_hub_unavailable");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = String(payload?.error || "");
    // Sem o produto ML instalado e sem teste possível: quem decide é a contratação.
    if (NOT_ELIGIBLE.has(code) || code === "trial_product_not_found") return { trial: false, reason: code };
    throw new Error("trial_hub_activation_failed");
  }
  const endsAt = payload?.trial?.endsAt ? new Date(payload.trial.endsAt) : null;
  if (!endsAt || !Number.isFinite(endsAt.getTime()) || endsAt.getTime() <= Date.now()) {
    return { trial: false, reason: "trial_already_used" };
  }
  return { trial: true, endsAt: endsAt.toISOString() };
}

/** Conta entra no ML em teste: opera até o fim do teste e depois pede contratação. */
async function activateLocalTrial(db, { accountId, endsAt, actor }) {
  await db.query(
    `insert into ml.meli_conta_produtos (meli_conta_id, produto, ativado_por)
     values ($1, 'ml', $2) on conflict (meli_conta_id, produto) do nothing`,
    [accountId, actor || "portal_trial"],
  );
  await db.query(
    `update meli_contas
        set billing_status = 'awaiting_subscription', billing_mode = 'trial',
            usage_policy = 'metered', billing_grace_expires_at = $2, atualizado_em = now()
      where id = $1`,
    [accountId, endsAt],
  );
}

module.exports = { tryStartMlTrial, activateLocalTrial };
