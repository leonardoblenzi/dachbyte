"use strict";

// Conexão DACHBYTE contra Postgres de verdade (HUB_TEST_DATABASE_URL).
const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("../src/platform/db");
const { createAccountsRepository } = require("../src/modules/accounts/repository");
const { createAccountsService } = require("../src/modules/accounts/service");
const { createConnectors } = require("../src/connectors/registry");

const url = process.env.HUB_TEST_DATABASE_URL || "";
const opts = { skip: url ? false : "defina HUB_TEST_DATABASE_URL para rodar" };
const db = url ? createDb({ databaseUrl: url, schema: "hub" }) : null;
const T = "tenant-dachbyte";

test.after(async () => { if (db) await db.close(); });

test("conta da conexão DACHBYTE: espelho sem chaves, situação acompanha o módulo, desconectar respeita o módulo", opts, async () => {
  await db.query("truncate hub.items, hub.channel_accounts, hub.oauth_states, hub.authorization_links, hub.audit_events restart identity cascade");
  const repository = createAccountsRepository(db);
  const remote = [{ meli_user_id: 222, label: "Loja Hub", connection: "ok", products: ["dach_hub"] }, { meli_user_id: 111, label: "Loja ML", connection: "ok", products: ["ml"] }];
  const deactivated = [];
  const broker = {
    configured: true,
    listAccounts: async () => remote.map((a) => ({ ...a })),
    activate: async ({ externalAccountId }) => { const a = remote.find((x) => String(x.meli_user_id) === externalAccountId); a.products.push("dach_hub"); return a; },
    deactivate: async ({ externalAccountId }) => { deactivated.push(externalAccountId); },
  };
  const service = createAccountsService({ repository, connectors: createConnectors({}), cipher: { encrypt: (v) => v, decrypt: (v) => v }, publicBaseUrl: "https://x/hub", brokers: { mercadolivre: broker } });
  const admin = { tenantId: T, userId: "u1", accountLimit: 5 };

  // Conta que já tinha conexão própria (com chave guardada) passa a ser da DACHBYTE: a chave antiga sai.
  const old = await repository.upsertAccount({ tenantId: T, channel: "mercadolivre", externalAccountId: "222", label: "Antiga", userId: "u1" });
  await repository.saveTokens(Number(old.id), { accessTokenEnc: "x", refreshTokenEnc: "y", expiresAt: null, scopes: [] });

  const { added, available } = await service.syncDachbyte(admin);
  assert.equal(added.length, 0, "conta já existia: não é nova");
  assert.deepEqual(available.map((a) => a.externalAccountId), ["111"]);
  const source = await repository.connectionSource(Number(old.id));
  assert.deepEqual([source.connectionSource, source.status], ["dachbyte", "connected"]);
  assert.equal((await db.query("select count(*)::int as n from hub.channel_tokens")).rows[0].n, 0, "nenhuma chave do ML fica no Hub");

  const imported = await service.importAccount({ identity: admin, channel: "mercadolivre", externalAccountId: "111" });
  assert.equal(imported.created, true);
  const listed = await service.listAccounts(T);
  assert.deepEqual(listed.map((a) => [a.externalAccountId, a.connectionSource]).sort(), [["111", "dachbyte"], ["222", "dachbyte"]]);

  remote[0].connection = "reconnect_required";
  await service.syncDachbyte(admin);
  assert.equal((await repository.connectionSource(Number(old.id))).status, "reconnect_required");

  await service.disconnect({ identity: admin, accountId: Number(imported.id) });
  assert.deepEqual(deactivated, ["111"]);
  assert.equal((await repository.connectionSource(Number(imported.id))).status, "disconnected");
  // Desconectada não volta na próxima sincronização, mesmo se o módulo ainda listar no Hub.
  await service.syncDachbyte(admin);
  assert.equal((await repository.connectionSource(Number(imported.id))).status, "disconnected");

  // Conta de outra empresa no Hub nunca é tomada.
  await repository.upsertAccount({ tenantId: "outra", channel: "mercadolivre", externalAccountId: "999", label: "X", userId: "u9" });
  remote.push({ meli_user_id: 999, label: "Y", connection: "ok", products: ["dach_hub"] });
  const again = await service.syncDachbyte(admin);
  assert.equal(again.added.length, 0);
  assert.equal((await db.query("select tenant_id from hub.channel_accounts where external_account_id = '999'")).rows[0].tenant_id, "outra");
});
