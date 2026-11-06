// @ts-check
"use strict";

/** Teto de segurança: ~200 mil anúncios em páginas de 100. */
const MAX_PAGES = 2000;

/** @param {string} message @param {number} status @param {string} code */
function fail(message, status, code) { return Object.assign(new Error(message), { status, code }); }

/** @param {unknown} error */
const errorText = (error) => String(/** @type {any} */ (error)?.message || error || "Erro desconhecido.").slice(0, 500);

/**
 * @typedef {{ runId: number, tenantId: string, accountId: number }} ImportJob
 * @typedef {{ enqueue: (job: ImportJob) => Promise<void>, close?: () => Promise<void>, mode: string }} ImportQueue
 */

/**
 * Importação de anúncios: pede (API), enfileira e executa (worker) página a página,
 * gravando o progresso. Igual para todo canal com a capacidade `listings`.
 * @param {{
 *   repository: ReturnType<typeof import("./repository").createImportsRepository>,
 *   catalog: { applyListings: (input: { tenantId: string, accountId: number, listings: any[] }) => Promise<{ listingsSeen: number, linkedAuto: number, unlinked: number }> },
 *   connectors: ReturnType<typeof import("../../connectors/registry").createConnectors>,
 *   tokens: { getAccessToken: (accountId: number) => Promise<{ accessToken: string, externalAccountId: string }> },
 *   queue?: ImportQueue | null,
 *   maxPages?: number,
 * }} deps
 */
function createImportsService({ repository, catalog, connectors, tokens, queue = null, maxPages = MAX_PAGES }) {
  return {
    /** Fila em uso; definida depois quando a fila depende do próprio serviço (modo no processo). @param {ImportQueue} value */
    setQueue(value) { queue = value; },

    /**
     * Pede uma importação da conta. Não duplica: se já houver uma ativa, devolve a mesma.
     * @param {{ identity: { tenantId: string, userId?: string }, accountId: number, trigger?: "manual" | "connect" | "schedule" }} input
     */
    async requestImport({ identity, accountId, trigger = "manual" }) {
      const account = await repository.findConnectedAccount(identity.tenantId, accountId);
      if (!account) throw fail("Conta não encontrada ou desconectada.", 404, "account_not_found");
      if (!connectors.has(account.channel) || !connectors.definition(account.channel).capabilities.listings) {
        throw fail("Este canal ainda não permite importar anúncios.", 400, "listings_not_supported");
      }
      if (!queue) throw fail("Processamento em segundo plano indisponível.", 503, "queue_unavailable");
      const { run, created } = await repository.createRun({ accountId, trigger, userId: identity.userId || null });
      if (created) {
        try {
          await queue.enqueue({ runId: Number(run.id), tenantId: identity.tenantId, accountId });
        } catch (error) {
          await repository.finish(Number(run.id), { status: "failed", pages: 0, listingsSeen: 0, linkedAuto: 0, unlinked: 0, error: errorText(error) });
          throw fail("Não foi possível colocar a importação na fila. Tente de novo.", 503, "queue_unavailable");
        }
      }
      return { run, created };
    },

    /** @param {string} tenantId @param {number} runId */
    async getRun(tenantId, runId) {
      const run = await repository.getRun(tenantId, runId);
      if (!run) throw fail("Importação não encontrada.", 404, "run_not_found");
      return run;
    },

    /**
     * Executa uma importação (chamado pelo worker). Token renovado a cada página
     * (importações longas passam da validade do token), progresso salvo a cada página.
     * @param {ImportJob} job
     */
    async runImport({ runId, tenantId, accountId }) {
      const account = await repository.markRunning(runId, tenantId);
      if (!account || Number(account.id) !== Number(accountId)) return { skipped: true };
      const connector = connectors.get(account.channel);
      const totals = { pages: 0, listingsSeen: 0, linkedAuto: 0, unlinked: 0 };
      /** @type {string | null} */
      let cursor = null;
      try {
        do {
          const { accessToken, externalAccountId } = await tokens.getAccessToken(accountId);
          const page = await connector.listListings({ id: accountId, externalAccountId, accessToken }, { cursor });
          const counts = await catalog.applyListings({ tenantId, accountId, listings: page.listings || [] });
          totals.pages += 1;
          totals.listingsSeen += counts.listingsSeen;
          totals.linkedAuto += counts.linkedAuto;
          totals.unlinked += counts.unlinked;
          await repository.progress(runId, totals);
          if (page.nextCursor && page.nextCursor === cursor) throw new Error("O canal repetiu a mesma página; importação interrompida.");
          cursor = page.nextCursor || null;
          if (cursor && totals.pages >= maxPages) throw new Error(`Limite de ${maxPages} páginas atingido.`);
        } while (cursor);
        await repository.finish(runId, { status: "succeeded", ...totals });
        return { skipped: false, status: "succeeded", ...totals };
      } catch (error) {
        await repository.finish(runId, { status: "failed", ...totals, error: errorText(error) });
        throw error;
      }
    },
  };
}

module.exports = { createImportsService, MAX_PAGES };
