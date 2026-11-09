"use strict";

// Conexão única: o app do Mercado Livre só tem um endereço de avisos, que é do
// módulo ML. Avisos de pedido e envio de contas ativas no DACH Hub são repassados
// ao Hub pela rede interna. A busca periódica do Hub cobre avisos perdidos.

const RELAY_TOPICS = new Set(["orders_v2", "orders", "shipments"]);
// Só o caminho do recurso, sem domínio nem parâmetros: o Hub monta a chamada.
const RESOURCE_PATH = /^\/(orders|shipments)\/\d{1,20}$/;

function createHubNotificationRelay({ db, url, token, appId = process.env.ML_APP_ID || process.env.APP_ID || process.env.CLIENT_ID, fetchImpl = globalThis.fetch, timeoutMs = 5000, log = console }) {
  const expectedAppId = Number(appId);
  const target = String(url || "").trim();
  const secret = String(token || "").trim();

  return async function relayToHub(body) {
    const topic = String(body?.topic || "").trim().toLowerCase();
    if (!RELAY_TOPICS.has(topic)) return { relayed: false, reason: "topic" };
    if (!target || !secret) return { relayed: false, reason: "not_configured" };
    const userId = Number(body?.user_id);
    if (!Number.isSafeInteger(userId) || userId <= 0) return { relayed: false, reason: "user" };
    // Tópicos fora da lista de promoções não passam pela checagem de app do módulo.
    if (!Number.isSafeInteger(expectedAppId) || Number(body?.application_id) !== expectedAppId) {
      return { relayed: false, reason: "application_id" };
    }
    const resource = String(body?.resource || "").trim();
    if (!RESOURCE_PATH.test(resource)) return { relayed: false, reason: "resource" };

    const { rows } = await db.query(
      `select 1
         from meli_contas mc
         join ml.meli_conta_produtos p on p.meli_conta_id = mc.id and p.produto = 'dach_hub'
        where mc.meli_user_id = $1
        limit 1`,
      [userId],
    );
    if (!rows.length) return { relayed: false, reason: "not_in_hub" };

    const payload = {
      topic,
      resource,
      user_id: userId,
      application_id: expectedAppId,
      sent: body?.sent ?? null,
      attempts: body?.attempts ?? null,
    };
    const response = await fetchImpl(target, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      log.warn?.("[ML][hub-relay] Hub recusou aviso", { status: response.status, topic });
      return { relayed: false, reason: `hub_${response.status}` };
    }
    return { relayed: true };
  };
}

module.exports = { createHubNotificationRelay, RELAY_TOPICS };
