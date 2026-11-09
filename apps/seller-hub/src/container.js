// @ts-check
"use strict";

const { loadConfig } = require("./platform/config");
const { createDb } = require("./platform/db");
const { createCipher } = require("./platform/crypto");
const { createConnectors } = require("./connectors/registry");
const { createCatalogRepository } = require("./modules/catalog/repository");
const { createCatalogService } = require("./modules/catalog/service");
const { createAccountsRepository } = require("./modules/accounts/repository");
const { createAccountsService, TokenManager } = require("./modules/accounts/service");
const { createImportsRepository } = require("./modules/imports/repository");
const { createImportsService } = require("./modules/imports/service");
const { createImportQueue } = require("./jobs/importQueue");
const { createStockRepository } = require("./modules/stock/repository");
const { createStockService } = require("./modules/stock/service");
const { createOrdersRepository } = require("./modules/orders/repository");
const { createOrdersService } = require("./modules/orders/service");
const { createSyncRepository } = require("./modules/sync/repository");
const { createSyncService } = require("./modules/sync/service");
const { createSyncQueues } = require("./jobs/syncQueues");
const { createReconcileRepository } = require("./modules/reconcile/repository");
const { createReconcileService } = require("./modules/reconcile/service");
const { createBillingService } = require("./modules/billing/service");
const { createAutomationsRepository } = require("./modules/automations/repository");
const { createAutomationsService } = require("./modules/automations/service");
const { createExpeditionRepository } = require("./modules/expedition/repository");
const { createExpeditionService } = require("./modules/expedition/service");
const { createLabelsRepository } = require("./modules/labels/repository");
const { createLabelsService } = require("./modules/labels/service");
const { createAnalyticsRepository } = require("./modules/analytics/repository");
const { createAnalyticsService } = require("./modules/analytics/service");
const { createAccessHub } = require("./platform/accessHub");

/** Cifra criada só quando usada: sem chave, conectar conta falha com 503 sem derrubar o app. @param {string} key */
function lazyCipher(key) {
  /** @type {ReturnType<typeof createCipher> | null} */
  let cipher = null;
  const get = () => (cipher = cipher || createCipher(key));
  return { encrypt: (/** @type {string} */ v) => get().encrypt(v), decrypt: (/** @type {string} */ v) => get().decrypt(v) };
}

/**
 * Raiz de composição: monta as peças do Hub uma vez, para o site (app.js) e para o worker.
 * Qualquer peça pode ser trocada (testes, prévia local).
 * @param {{ config?: ReturnType<typeof loadConfig>, db?: any, catalog?: any, connectors?: any, accounts?: any, imports?: any, queue?: any, stock?: any, orders?: any, sync?: any, syncQueues?: any, tokens?: any, reconcile?: any, billing?: any, automations?: any, expedition?: any, labels?: any, analytics?: any, accessHub?: any }} [overrides]
 */
function createContainer(overrides = {}) {
  const config = overrides.config || loadConfig();
  const db = overrides.db || createDb(config);
  const cipher = lazyCipher(config.tokenEncryptionKey);
  const connectors = overrides.connectors || createConnectors(config.channels);
  const catalog = overrides.catalog || createCatalogService({ repository: createCatalogRepository(db) });
  const accountsRepository = createAccountsRepository(db);
  const tokens = overrides.tokens || new TokenManager({ repository: accountsRepository, connectors, cipher });
  // Hub de acessos: liberação do produto, limite de contas do plano e registro das contas (substituível nos testes).
  const accessHub = overrides.accessHub || createAccessHub(config.accessHub);
  const resources = config.resourceSync === "off" || !accessHub?.syncResource ? null
    : { sync: (/** @type {any} */ input) => accessHub.syncResource(input), unlink: (/** @type {any} */ input) => accessHub.unlinkResource(input) };
  const accounts = overrides.accounts || createAccountsService({ repository: accountsRepository, connectors, cipher, publicBaseUrl: config.publicBaseUrl, tokens, defaultAccountLimit: config.defaultAccountLimit, resources });
  let imports = overrides.imports;
  if (!imports) {
    imports = createImportsService({ repository: createImportsRepository(db), catalog, connectors, tokens });
    imports.setQueue(overrides.queue || createImportQueue({ redisUrl: config.redisUrl, runInline: (job) => imports.runImport(job) }));
  }
  const stockRepository = createStockRepository(db);
  // Ligação tardia: as filas chamam o sync, o sync usa as filas.
  /** @type {any} */
  let sync = null;
  /** @type {any} */
  let orders = null;
  /** @type {any} */
  let reconcile = null;
  /** @type {any} */
  let billing = null;
  /** @type {any} */
  let automations = null;
  /** @type {any} */
  let labels = null;
  const syncQueues = overrides.syncQueues || createSyncQueues({
    redisUrl: config.redisUrl,
    handlers: () => ({
      push: (accountId) => sync.processAccount(accountId),
      webhook: (eventId) => orders.processWebhook(eventId),
      pollAll: async () => {
        for (const account of await ordersRepository.pollableAccounts()) {
          try { await orders.pollAccount(Number(account.id)); } catch (error) { console.error("[seller-hub:poll]", account.id, /** @type {any} */ (error)?.message); }
        }
      },
      reconcile: (job) => reconcile.runReconcile(job),
      reconcileAll: () => reconcile.scheduleAll(),
      // Rotina diária: fecha os meses passados e apaga arquivos de etiqueta com mais de 7 dias.
      closeMonths: async () => ({ ...(await billing.closePastMonths()), labelsRemoved: await labels.cleanup() }),
      automation: (job) => automations.onOrderEvent(job),
      automationsScan: () => automations.scanDue(),
    }),
  });
  const ordersRepository = createOrdersRepository(db);
  sync = overrides.sync || createSyncService({
    repository: createSyncRepository(db), stockRepository, connectors, tokens, queue: syncQueues,
    canWrite: (tenantId) => config.writeTenants.has(tenantId),
  });
  const onItemsChanged = (/** @type {string} */ tenantId, /** @type {number[]} */ itemIds, /** @type {string} */ reason) => sync.onItemsChanged(tenantId, itemIds, reason);
  automations = overrides.automations || createAutomationsService({ repository: createAutomationsRepository(db), queue: syncQueues });
  orders = overrides.orders || createOrdersService({
    repository: ordersRepository, stockRepository, connectors, tokens, onItemsChanged,
    onOrderChanged: (change) => automations.orderChanged(change),
    webhookSecrets: (channel, externalAccountId) => accounts.webhookSecrets(channel, externalAccountId),
  });
  const stock = overrides.stock || createStockService({ repository: stockRepository, onItemsChanged });
  reconcile = overrides.reconcile || createReconcileService({ repository: createReconcileRepository(db), connectors, tokens, orders, sync, queue: syncQueues });
  billing = overrides.billing || createBillingService({ repository: ordersRepository });
  const expedition = overrides.expedition || createExpeditionService({
    repository: createExpeditionRepository(db), onOrderPacked: (event) => automations.orderPacked(event),
  });
  labels = overrides.labels || createLabelsService({ repository: createLabelsRepository(db), connectors, tokens });
  const analytics = overrides.analytics || createAnalyticsService({ repository: createAnalyticsRepository(db) });
  return { config, db, connectors, catalog, accounts, tokens, imports, stock, orders, sync, syncQueues, reconcile, billing, automations, expedition, labels, analytics, accessHub };
}

module.exports = { createContainer, lazyCipher };
