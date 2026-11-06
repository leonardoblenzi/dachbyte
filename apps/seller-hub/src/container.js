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
 * @param {{ config?: ReturnType<typeof loadConfig>, db?: any, catalog?: any, connectors?: any, accounts?: any, imports?: any, queue?: any }} [overrides]
 */
function createContainer(overrides = {}) {
  const config = overrides.config || loadConfig();
  const db = overrides.db || createDb(config);
  const cipher = lazyCipher(config.tokenEncryptionKey);
  const connectors = overrides.connectors || createConnectors(config.channels);
  const catalog = overrides.catalog || createCatalogService({ repository: createCatalogRepository(db) });
  const accountsRepository = createAccountsRepository(db);
  const accounts = overrides.accounts || createAccountsService({ repository: accountsRepository, connectors, cipher, publicBaseUrl: config.publicBaseUrl });
  const tokens = new TokenManager({ repository: accountsRepository, connectors, cipher });
  let imports = overrides.imports;
  if (!imports) {
    imports = createImportsService({ repository: createImportsRepository(db), catalog, connectors, tokens });
    imports.setQueue(overrides.queue || createImportQueue({ redisUrl: config.redisUrl, runInline: (job) => imports.runImport(job) }));
  }
  return { config, db, connectors, catalog, accounts, tokens, imports };
}

module.exports = { createContainer, lazyCipher };
