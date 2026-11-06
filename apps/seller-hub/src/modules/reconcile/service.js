// @ts-check
"use strict";

const BATCH = 50;
/** Teto de segurança por conferência (~100 mil anúncios). */
const MAX_BATCHES = 2000;

/** @param {string} message @param {number} status @param {string} code */
function fail(message, status, code) { return Object.assign(new Error(message), { status, code }); }
/** @param {unknown} error */
const errorText = (error) => String(/** @type {any} */ (error)?.message || error || "Erro desconhecido.").slice(0, 500);

/**
 * Reconciliação (E4): relê o estoque nos canais e descobre o que mudou fora do Hub.
 *
 * Esperado no canal = último valor visto − vendas recebidas depois + cancelamentos recebidos depois.
 * Diferente disso = alguém mexeu por fora (Tray, ANYMARKET, Bling, manual no painel do canal).
 * - Conta ativa com política "sobrescrever": o Hub reenvia o valor dele, a não ser que o anúncio
 *   esteja divergindo de forma recorrente (outro sistema escrevendo): aí só avisa, para não brigar.
 * - Conta ativa com política "avisar" ou conta em observação: só registra para decisão.
 * Antes de comparar, lê os pedidos recentes (uma venda ainda não recebida pareceria divergência).
 * @param {{
 *   repository: ReturnType<typeof import("./repository").createReconcileRepository>,
 *   connectors: ReturnType<typeof import("../../connectors/registry").createConnectors>,
 *   tokens: { getAccessToken: (accountId: number) => Promise<{ accessToken: string, externalAccountId: string }> },
 *   orders?: { pollAccount: (accountId: number) => Promise<unknown> } | null,
 *   sync: { planPushes: (tenantId: string, scope: { itemIds?: number[] | null, accountId?: number | null }, reason: string) => Promise<unknown> },
 *   queue?: { enqueueReconcile: (job: { runId: number, tenantId: string, accountId: number }) => Promise<void> } | null,
 * }} deps
 */
function createReconcileService({ repository, connectors, tokens, orders = null, sync, queue = null }) {
  /** @param {{ tenantId: string, userId?: string | null }} identity @param {number} accountId @param {"manual" | "schedule"} trigger */
  async function request(identity, accountId, trigger) {
    const account = await repository.findConnectedAccount(identity.tenantId, accountId);
    if (!account) throw fail("Conta não encontrada ou desconectada.", 404, "account_not_found");
    if (!queue) throw fail("Processamento em segundo plano indisponível.", 503, "queue_unavailable");
    const { run, created } = await repository.createRun({ accountId, trigger, userId: identity.userId || null });
    if (created) await queue.enqueueReconcile({ runId: Number(run.id), tenantId: identity.tenantId, accountId });
    return { run, created };
  }

  return {
    /** Conferir agora (botão). @param {{ identity: { tenantId: string, userId?: string | null }, accountId: number }} input */
    requestReconcile: ({ identity, accountId }) => request(identity, accountId, "manual"),

    /** Agendamento: confere todas as contas em observação ou ativas. */
    async scheduleAll() {
      let queued = 0;
      for (const a of await repository.reconcilableAccounts()) {
        try { if ((await request({ tenantId: a.tenantId }, Number(a.id), "schedule")).created) queued += 1; }
        catch (error) { console.error("[seller-hub:reconcile] agendar", a.id, errorText(error)); }
      }
      return { queued };
    },

    /** Worker: confere a conta em lotes. @param {{ runId: number, tenantId: string, accountId: number }} job */
    async runReconcile({ runId, tenantId, accountId }) {
      const account = await repository.markRunning(runId, tenantId);
      if (!account || Number(account.id) !== Number(accountId)) return { skipped: true };
      const totals = { checked: 0, divergences: 0, overwritten: 0 };
      try {
        if (orders) {
          try { await orders.pollAccount(accountId); } catch (error) { console.error("[seller-hub:reconcile] pedidos", accountId, errorText(error)); }
        }
        const connector = connectors.get(account.channel);
        const overwrite = account.mode === "active" && account.policy === "overwrite";
        let afterId = 0;
        for (let batchNo = 0; batchNo < MAX_BATCHES; batchNo += 1) {
          const batch = await repository.listingsToCheck(accountId, afterId, BATCH);
          if (!batch.length) break;
          afterId = Number(batch[batch.length - 1].id);
          const { accessToken, externalAccountId } = await tokens.getAccessToken(accountId);
          const reads = await connector.readStock({ id: accountId, accessToken, externalAccountId },
            batch.map((/** @type {any} */ l) => ({ ref: Number(l.id), listingId: l.listingId, variationId: l.variationId || "" })));
          const seen = new Map(reads.map((/** @type {any} */ r) => [Number(r.ref), r.stock == null ? null : Number(r.stock)]));
          /** @type {Array<{ id: number, stock: number }>} */
          const observations = [];
          /** @type {Array<{ listingId: number, expected: number, observed: number, itemId: number }>} */
          const diverged = [];
          for (const l of batch) {
            const observed = seen.get(Number(l.id));
            if (observed == null) continue;
            observations.push({ id: Number(l.id), stock: observed });
            if (!l.checkedAt || l.channelStock == null) continue;
            const expected = Math.max(0, Number(l.channelStock) - Number(l.sold) + Number(l.restored));
            if (observed !== expected) diverged.push({ listingId: Number(l.id), expected, observed, itemId: Number(l.itemId) });
          }
          await repository.recordObservations(observations);
          const inserted = await repository.insertDivergences({ tenantId, accountId, runId }, diverged);
          totals.checked += observations.length;
          totals.divergences += inserted.length;
          if (overwrite) {
            const fixable = inserted.filter((/** @type {any} */ d) => !d.recurring);
            if (fixable.length) {
              const items = new Map(diverged.map((d) => [d.listingId, d.itemId]));
              await sync.planPushes(tenantId, { accountId, itemIds: [...new Set(fixable.map((/** @type {any} */ d) => /** @type {number} */ (items.get(Number(d.listingId)))))] }, "correção: estoque mudado fora do Hub");
              await repository.markOverwritten(fixable.map((/** @type {any} */ d) => Number(d.id)));
              totals.overwritten += fixable.length;
            }
          }
          await repository.progress(runId, totals);
        }
        await repository.finish(runId, { status: "succeeded", ...totals });
        return { status: "succeeded", ...totals };
      } catch (error) {
        await repository.finish(runId, { status: "failed", ...totals, error: errorText(error) });
        throw error;
      }
    },

    /** @param {string} tenantId @param {{ status?: string, accountId?: number | null, limit?: number, offset?: number }} [options] */
    listDivergences: (tenantId, options) => repository.listDivergences(tenantId, options),

    /**
     * Decisão sobre uma divergência: reenviar o valor do Hub (só conta ativa) ou ignorar.
     * @param {{ identity: { tenantId: string, userId?: string | null }, id: number, action: "resend" | "ignore" }} input
     */
    async resolve({ identity, id, action }) {
      if (!["resend", "ignore"].includes(action)) throw fail("Ação inválida.", 400, "invalid_action");
      const resend = action === "resend";
      const done = await repository.resolve(identity.tenantId, id, resend ? "overwritten" : "ignored", identity.userId || null, resend);
      if (!done) throw fail(resend ? "Divergência já decidida ou conta fora do modo ativo (em observação, use Ignorar)." : "Divergência não encontrada ou já decidida.", 404, "divergence_not_found");
      if (resend) {
        await sync.planPushes(identity.tenantId, { accountId: Number(done.accountId), itemIds: [Number(done.itemId)] }, "reenvio após divergência");
      }
      await repository.audit({ tenantId: identity.tenantId, userId: identity.userId, action: `divergence_${action}`, details: { divergence_id: id } });
      return done;
    },

    /** @param {{ identity: { tenantId: string, userId?: string | null }, accountId: number }} input */
    async ignoreAll({ identity, accountId }) {
      const count = await repository.ignoreAll(identity.tenantId, accountId, identity.userId || null);
      await repository.audit({ tenantId: identity.tenantId, userId: identity.userId, action: "divergence_ignore_all", details: { account_id: accountId, count } });
      return { ignored: count };
    },

    /** @param {{ identity: { tenantId: string, userId?: string | null }, accountId: number, policy: string }} input */
    async setPolicy({ identity, accountId, policy }) {
      if (!["overwrite", "alert"].includes(policy)) throw fail("Política inválida.", 400, "invalid_policy");
      const saved = await repository.setPolicy(identity.tenantId, accountId, /** @type {"overwrite" | "alert"} */ (policy));
      if (!saved) throw fail("Conta não encontrada.", 404, "account_not_found");
      await repository.audit({ tenantId: identity.tenantId, userId: identity.userId, action: "divergence_policy_changed", details: { account_id: accountId, policy } });
      return saved;
    },

    /** @param {string} tenantId */
    health: (tenantId) => repository.health(tenantId),
  };
}

module.exports = { createReconcileService };
