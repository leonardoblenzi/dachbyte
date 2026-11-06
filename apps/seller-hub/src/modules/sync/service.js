// @ts-check
"use strict";

const { computeAvailability, planListings } = require("../stock/plan");
const { ruleFromRow } = require("../stock/rules");

/** @param {string} message @param {number} status @param {string} code */
function fail(message, status, code) { return Object.assign(new Error(message), { status, code }); }
/** @param {unknown} error */
const errorText = (error) => String(/** @type {any} */ (error)?.message || error || "Erro desconhecido.").slice(0, 500);

/** Releituras depois de enviar (o canal leva um tempo para refletir). */
const VERIFY_DELAYS_MS = [0, 800, 1500, 3000];
const BATCH_SIZE = 50;
const MAX_BATCHES_PER_RUN = 10;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 30_000;

/**
 * @typedef {{ ref: number, listingId: string, variationId: string, quantity: number }} StockWrite
 * @typedef {{ ref: number, ok: boolean, uncertain?: boolean, retryable?: boolean, error?: string }} StockWriteResult
 * @typedef {{ enqueuePush: (accountId: number, delayMs?: number) => Promise<void> }} PushQueue
 */

/**
 * Envio de estoque aos canais (E3). Só conta "active", só sem pausa geral, nunca anúncio Full.
 * Cada envio é conferido relendo o canal: verificado, divergente (não reenvia sozinho) ou falhou.
 * @param {{
 *   repository: ReturnType<typeof import("./repository").createSyncRepository>,
 *   stockRepository: ReturnType<typeof import("../stock/repository").createStockRepository>,
 *   connectors: ReturnType<typeof import("../../connectors/registry").createConnectors>,
 *   tokens: { getAccessToken: (accountId: number) => Promise<{ accessToken: string, externalAccountId: string }> },
 *   queue?: PushQueue | null,
 *   verifyDelaysMs?: number[],
 *   sleep?: (ms: number) => Promise<void>,
 * }} deps
 */
function createSyncService({ repository, stockRepository, connectors, tokens, queue = null, verifyDelaysMs = VERIFY_DELAYS_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  /** @param {number[]} accountIds @param {number} [delayMs] */
  async function enqueue(accountIds, delayMs) {
    if (!queue) return;
    for (const id of accountIds) await queue.enqueuePush(id, delayMs);
  }

  /**
   * Calcula o que enviar para os anúncios das contas ativas e abre os envios.
   * @param {string} tenantId @param {{ itemIds?: number[] | null, accountId?: number | null }} scope @param {string} reason
   */
  async function planPushes(tenantId, scope, reason) {
    const listings = await stockRepository.planListings(tenantId, { itemIds: scope.itemIds || null, accountId: scope.accountId || null });
    const active = listings.filter((/** @type {any} */ l) => l.accountMode === "active");
    if (!active.length) return { pushes: 0, accounts: [] };
    const itemIds = [...new Set(active.map((/** @type {any} */ l) => Number(l.itemId)))];
    const availability = computeAvailability(await stockRepository.availabilityInputs(tenantId, itemIds));
    const { rows } = planListings({
      availability,
      listings: active.map((/** @type {any} */ l) => ({ ...l, accountRule: ruleFromRow(l.accountRule), listingRule: ruleFromRow(l.listingRule) })),
    });
    const changes = rows
      .filter((r) => r.desired != null && r.desired !== (r.channelStock == null ? null : Number(r.channelStock)))
      .map((r) => ({ listingDbId: Number(r.id), accountId: Number(r.accountId), desired: /** @type {number} */ (r.desired), previous: r.channelStock ?? null, reason }));
    const accounts = await repository.upsertPushes(tenantId, changes);
    await enqueue(accounts);
    return { pushes: changes.length, accounts };
  }

  /**
   * Confere no canal os envios aceitos. Para quando todos batem ou acabam as releituras.
   * @param {any} connector @param {any} account @param {any[]} pushes
   */
  async function verify(connector, account, pushes) {
    /** @type {Map<number, number | null>} */
    const observed = new Map();
    let pending = pushes;
    for (const delay of verifyDelaysMs) {
      if (delay) await sleep(delay);
      const reads = await connector.readStock(account, pending.map((p) => ({ ref: Number(p.id), listingId: p.listingId, variationId: p.variationId || "" })));
      for (const r of reads) observed.set(Number(r.ref), r.stock == null ? null : Number(r.stock));
      pending = pending.filter((p) => observed.get(Number(p.id)) !== Number(p.desired));
      if (!pending.length) break;
    }
    return observed;
  }

  return {
    planPushes,

    /** Chamado depois de movimentos de estoque (venda, ajuste, planilha). @param {string} tenantId @param {number[]} itemIds @param {string} reason */
    async onItemsChanged(tenantId, itemIds, reason) {
      if (!itemIds.length) return { pushes: 0, accounts: [] };
      const kits = await repository.kitsContaining(tenantId, itemIds);
      return planPushes(tenantId, { itemIds: [...new Set([...itemIds, ...kits])] }, reason);
    },

    /**
     * Liga a escrita na conta. Exige a confirmação de que outro sistema não escreve estoque nela
     * (Tray, ANYMARKET, Bling...) e que o canal permita gravar estoque. Em seguida envia o que difere.
     * @param {{ identity: { tenantId: string, userId?: string | null }, accountId: number, confirm: boolean }} input
     */
    async activateAccount({ identity, accountId, confirm }) {
      if (confirm !== true) throw fail("Confirme que a sincronização de estoque desta conta está desligada em outros sistemas.", 400, "confirmation_required");
      const state = await repository.getAccountState(accountId);
      if (!state || state.tenantId !== identity.tenantId || state.status !== "connected") throw fail("Conta não encontrada ou desconectada.", 404, "account_not_found");
      if (!connectors.has(state.channel) || !connectors.definition(state.channel).capabilities.stockWrite) throw fail("Este canal ainda não permite gravar estoque.", 400, "stock_write_not_supported");
      await repository.activate(identity.tenantId, accountId, identity.userId || null);
      await repository.audit({ tenantId: identity.tenantId, userId: identity.userId, action: "stock_sync_activated", details: { account_id: accountId } });
      const result = await planPushes(identity.tenantId, { accountId }, "ativação da conta");
      return { activated: true, ...result };
    },

    /** Conta saiu do modo ativo: cancela o que estava na fila. @param {number} accountId @param {string} reason */
    skipPending: (accountId, reason) => repository.skipPending(accountId, reason),

    /** @param {string} tenantId */
    getSettings: (tenantId) => repository.getSettings(tenantId),

    /** Pausa geral: nada sai até retomar (os pendentes ficam guardados). @param {{ identity: { tenantId: string, userId?: string | null }, paused: boolean }} input */
    async setPaused({ identity, paused }) {
      await repository.setPaused(identity.tenantId, Boolean(paused), identity.userId || null);
      await repository.audit({ tenantId: identity.tenantId, userId: identity.userId, action: paused ? "stock_sync_paused" : "stock_sync_resumed" });
      if (!paused) await enqueue(await repository.accountsWithPending(identity.tenantId));
      return repository.getSettings(identity.tenantId);
    },

    /** @param {string} tenantId @param {{ state?: string, accountId?: number | null, limit?: number, offset?: number }} [options] */
    listPushes: (tenantId, options) => repository.listPushes(tenantId, options),

    /** @param {{ identity: { tenantId: string, userId?: string | null }, pushId: number }} input */
    async retryPush({ identity, pushId }) {
      const created = await repository.retry(identity.tenantId, pushId);
      if (!created) throw fail("Só dá para reenviar envio com falha ou divergente, sem outro envio aberto no anúncio.", 409, "retry_not_allowed");
      await enqueue([Number(created.accountId)]);
      return created;
    },

    /**
     * Worker: envia os pendentes de uma conta em lotes e confere cada um.
     * @param {number} accountId
     */
    async processAccount(accountId) {
      const state = await repository.getAccountState(accountId);
      if (!state) return { skipped: "conta não existe" };
      if (state.mode !== "active" || state.status !== "connected") {
        await repository.skipPending(accountId, "conta fora do modo ativo");
        return { skipped: "conta fora do modo ativo" };
      }
      if (state.paused) return { paused: true };
      if (!connectors.has(state.channel) || !connectors.definition(state.channel).capabilities.stockWrite) {
        await repository.skipPending(accountId, "canal sem escrita de estoque");
        return { skipped: "canal sem escrita de estoque" };
      }
      const connector = connectors.get(state.channel);
      const totals = { verified: 0, divergent: 0, failed: 0, retry: 0, skipped: 0 };
      let followups = false, retryLater = false;
      for (let batchNo = 0; batchNo < MAX_BATCHES_PER_RUN; batchNo += 1) {
        // Pausa geral conferida a cada lote: o botão para no meio do caminho.
        if (batchNo > 0 && (await repository.getAccountState(accountId))?.paused) return { paused: true, ...totals };
        const batch = await repository.claimPending(accountId, BATCH_SIZE);
        if (!batch.length) break;
        const sendable = [];
        for (const push of batch) {
          if (push.fulfillment) { await repository.finish(Number(push.id), { state: "skipped", error: "anúncio Full: estoque do canal" }); totals.skipped += 1; }
          else sendable.push(push);
        }
        if (!sendable.length) continue;
        let account;
        try {
          const { accessToken, externalAccountId } = await tokens.getAccessToken(accountId);
          account = { id: accountId, accessToken, externalAccountId };
        } catch (error) {
          for (const p of sendable) await repository.finish(Number(p.id), { state: "failed", error: errorText(error) });
          totals.failed += sendable.length;
          break;
        }
        /** @type {StockWriteResult[]} */
        let results;
        try {
          results = await connector.writeStock(account, sendable.map((p) => ({ ref: Number(p.id), listingId: p.listingId, variationId: p.variationId || "", quantity: Number(p.desired) })));
        } catch (error) {
          results = sendable.map((p) => ({ ref: Number(p.id), ok: false, retryable: true, error: errorText(error) }));
        }
        const byRef = new Map(results.map((r) => [Number(r.ref), r]));
        // Aceito ou incerto (pode ter sido gravado): confere relendo. Incerto nunca é reenviado sem conferir.
        const toVerify = sendable.filter((p) => byRef.get(Number(p.id))?.ok || byRef.get(Number(p.id))?.uncertain);
        let observed = new Map();
        try { if (toVerify.length) observed = await verify(connector, account, toVerify); } catch (_error) { /* releitura falhou: fica divergente */ }
        for (const push of sendable) {
          const r = byRef.get(Number(push.id));
          let done;
          if (r?.ok || r?.uncertain) {
            const seen = observed.get(Number(push.id));
            const ok = seen === Number(push.desired);
            done = await repository.finish(Number(push.id), { state: ok ? "verified" : "divergent", observed: seen ?? null, error: ok ? null : (r?.uncertain ? "resposta incerta do canal; valor lido diferente" : "valor lido no canal diferente do enviado") });
            if (ok) totals.verified += 1; else totals.divergent += 1;
          } else if (r?.retryable && Number(push.attempts) < MAX_ATTEMPTS) {
            await repository.requeue(Number(push.id), r?.error || "erro temporário");
            totals.retry += 1;
            retryLater = true;
          } else {
            done = await repository.finish(Number(push.id), { state: "failed", error: r?.error || "sem resposta do conector" });
            totals.failed += 1;
          }
          if (done?.followup) followups = true;
        }
        if (retryLater) break;
      }
      if (retryLater) await enqueue([accountId], RETRY_DELAY_MS);
      else if (followups || (await repository.accountsWithPending(state.tenantId)).includes(accountId)) await enqueue([accountId]);
      return totals;
    },
  };
}

module.exports = { createSyncService, VERIFY_DELAYS_MS, MAX_ATTEMPTS };
