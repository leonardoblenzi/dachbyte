"use strict";

// Conexão única do Mercado Livre: ativação por produto, API interna para o
// DACH Hub e repasse de avisos.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { activeInProductSql } = require("../services/connectionProducts");
const { createInternalConnectionsService } = require("../services/internalConnectionsService");
const { createInternalConnectionsRouter } = require("../routes/internalConnectionsRoutes");
const { createHubNotificationRelay } = require("../services/hubNotificationRelay");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

function account(overrides = {}) {
  return {
    id: 7, meli_user_id: "555", apelido: "Loja Sul", site_id: "MLB", status: "ativa",
    access_token: "plain-at", access_expires_at: "2026-11-10T12:00:00Z", refresh_token: "plain-rt", scope: "offline_access",
    produtos: ["dach_hub", "ml"], ...overrides,
  };
}

function fakeDb(row) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("group by mc.id, mt.meli_conta_id\n        limit 1")) return { rows: row ? [row] : [] };
      if (sql.includes("select access_expires_at from meli_tokens")) return { rows: [{ access_expires_at: "2026-11-10T18:00:00Z" }] };
      if (sql.includes("order by mc.id")) return { rows: row ? [{ ...row, has_tokens: true }] : [] };
      return { rows: [], rowCount: 1 };
    },
  };
}

function service(row, tokenImpl = {}, authorize = async (input) => ({ url: "https://auth/x", input })) {
  const db = fakeDb(row);
  const calls = { refreshIfNeeded: [], forced: [] };
  const tokens = {
    renovarTokenSeNecessario: tokenImpl.renovarTokenSeNecessario || (async (creds) => { calls.refreshIfNeeded.push(creds); return "AT-OK"; }),
    renovarToken: tokenImpl.renovarToken || (async (creds, opts) => { calls.forced.push({ creds, opts }); return { access_token: "AT-NEW" }; }),
  };
  return { db, calls, svc: createInternalConnectionsService({ db, tokens, authorize }) };
}

test("filtro SQL de produto só aceita alias e produto conhecidos", () => {
  assert.match(activeInProductSql("mc"), /mcp_mc\.meli_conta_id = mc\.id and mcp_mc\.produto = 'ml'/);
  assert.match(activeInProductSql("c", "dach_hub"), /produto = 'dach_hub'/);
  assert.throws(() => activeInProductSql("mc; drop", "ml"));
  assert.throws(() => activeInProductSql("mc", "shopee"));
});

test("lista as contas da empresa com produtos e situação da conexão", async () => {
  const { svc, db } = service(account({ status: "erro" }));
  const { accounts } = await svc.listAccounts({ tenant_id: "t-1" });
  assert.deepEqual(accounts, [{ meli_user_id: 555, label: "Loja Sul", site_id: "MLB", connection: "reconnect_required", products: ["dach_hub", "ml"] }]);
  assert.equal(db.calls[0].params[0], "t-1");
  await assert.rejects(svc.listAccounts({}), { message: "tenant_required", status: 400 });
});

test("autorização: só produtos externos e retorno dentro do Hub", async () => {
  const { svc } = service(account());
  const ok = await svc.authorize({ tenant_id: "t-1", product: "dach_hub", return_to: "/hub/contas", public_origin: "https://dachbyte.tech", user_global_id: "u-9", company_name: "ACME" });
  assert.deepEqual(ok.input, { tenantId: "t-1", product: "dach_hub", returnTo: "/hub/contas", companyName: "ACME", userGlobalId: "u-9", publicOrigin: "https://dachbyte.tech" });
  await assert.rejects(svc.authorize({ tenant_id: "t-1", product: "ml", return_to: "/hub/contas" }), { message: "product_not_allowed" });
  await assert.rejects(svc.authorize({ tenant_id: "t-1", product: "dach_hub", return_to: "https://evil.example/hub" }), { message: "invalid_return_to" });
  await assert.rejects(svc.authorize({ tenant_id: "t-1", product: "dach_hub", return_to: "//evil.example" }), { message: "invalid_return_to" });
});

test("chave: renova sob demanda pelo módulo e devolve a validade gravada", async () => {
  const { svc, calls } = service(account());
  const result = await svc.token({ tenant_id: "t-1", product: "dach_hub", meli_user_id: 555 });
  assert.deepEqual(result, { meli_user_id: 555, access_token: "AT-OK", expires_at: "2026-11-10T18:00:00.000Z" });
  assert.equal(calls.refreshIfNeeded[0].meli_conta_id, 7, "renovação usa a trava por conta do módulo");
  assert.equal(calls.forced.length, 0);
});

test("chave recusada pelo ML: força renovação só se ainda for a chave guardada", async () => {
  const { svc, calls } = service(account());
  const forced = await svc.token({ tenant_id: "t-1", product: "dach_hub", meli_user_id: 555, rejected_access_token: "plain-at" });
  assert.equal(forced.access_token, "AT-NEW");
  assert.equal(calls.forced[0].opts.rejectedAccessToken, "plain-at");
  const reused = await svc.token({ tenant_id: "t-1", product: "dach_hub", meli_user_id: 555, rejected_access_token: "old-token" });
  assert.equal(reused.access_token, "AT-OK", "outro processo já renovou: devolve a atual");
});

test("chave: conta fora do produto, sem conexão ou com autorização perdida", async () => {
  await assert.rejects(service(account({ produtos: ["ml"] })).svc.token({ tenant_id: "t", product: "dach_hub", meli_user_id: 555 }), { message: "account_not_active_in_product", status: 403 });
  await assert.rejects(service(null).svc.token({ tenant_id: "t", product: "dach_hub", meli_user_id: 555 }), { message: "account_not_found", status: 404 });
  await assert.rejects(service(account({ status: "erro" })).svc.token({ tenant_id: "t", product: "dach_hub", meli_user_id: 555 }), { message: "reconnect_required", status: 409 });
  const lost = service(account(), { renovarTokenSeNecessario: async () => { throw Object.assign(new Error("x"), { reconnectRequired: true }); } });
  await assert.rejects(lost.svc.token({ tenant_id: "t", product: "dach_hub", meli_user_id: 555 }), { message: "reconnect_required", status: 409 });
  const down = service(account(), { renovarTokenSeNecessario: async () => { throw new Error("ECONNRESET"); } });
  await assert.rejects(down.svc.token({ tenant_id: "t", product: "dach_hub", meli_user_id: 555 }), { message: "token_unavailable", status: 503 });
});

test("ativar e desativar no Hub não mexem nas chaves nem no módulo ML", async () => {
  const { svc, db } = service(account({ produtos: ["ml"] }));
  const { account: active } = await svc.activate({ tenant_id: "t", product: "dach_hub", meli_user_id: 555, actor: "hub_user:u-1" });
  assert.deepEqual(active.products, ["dach_hub", "ml"]);
  await svc.deactivate({ tenant_id: "t", product: "dach_hub", meli_user_id: 555 });
  const writes = db.calls.filter((c) => /insert|delete|update/i.test(c.sql));
  assert.equal(writes.length, 2);
  assert.ok(writes.every((c) => c.sql.includes("ml.meli_conta_produtos")));
  assert.ok(writes.every((c) => !c.params.includes("ml")), "nunca ativa/desativa o próprio módulo ML");
  await assert.rejects(svc.activate({ tenant_id: "t", product: "ml", meli_user_id: 555 }), { message: "product_not_allowed" });
});

async function callRouter(router, { method = "GET", url, auth, body }) {
  const app = express();
  app.use("/internal/connections", router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

test("API interna exige o token entre serviços e traduz erros conhecidos", async () => {
  const svc = {
    listAccounts: async ({ tenant_id }) => ({ accounts: [{ tenant_id }] }),
    token: async () => { throw Object.assign(new Error("reconnect_required"), { status: 409 }); },
    authorize: async () => { throw new Error("boom with spaces"); },
  };
  const router = createInternalConnectionsRouter({ secret: "s3cret", service: svc });
  assert.equal((await callRouter(router, { url: "/internal/connections/accounts?tenant_id=t" })).status, 401);
  assert.equal((await callRouter(router, { url: "/internal/connections/accounts?tenant_id=t", auth: "Bearer nope" })).status, 401);
  const ok = await callRouter(router, { url: "/internal/connections/accounts?tenant_id=t", auth: "Bearer s3cret" });
  assert.deepEqual(ok, { status: 200, body: { ok: true, accounts: [{ tenant_id: "t" }] } });
  const conflict = await callRouter(router, { method: "POST", url: "/internal/connections/token", auth: "Bearer s3cret", body: {} });
  assert.deepEqual(conflict, { status: 409, body: { ok: false, error: "reconnect_required" } });
  const crash = await callRouter(router, { method: "POST", url: "/internal/connections/authorize", auth: "Bearer s3cret", body: {} });
  assert.deepEqual(crash, { status: 500, body: { ok: false, error: "connections_failed" } });
  const unset = createInternalConnectionsRouter({ secret: "", service: svc });
  assert.equal((await callRouter(unset, { url: "/internal/connections/accounts?tenant_id=t", auth: "Bearer " })).status, 401, "sem token configurado, nada passa");
});

test("repasse de avisos: só pedidos/envios do app da DACHBYTE e de contas no Hub", async () => {
  const sent = [];
  let inHub = true;
  const relay = createHubNotificationRelay({
    db: { query: async () => ({ rows: inHub ? [{ ok: 1 }] : [] }) },
    url: "http://seller-hub-web:3000/hub/internal/notifications/mercadolivre",
    token: "s3cret",
    appId: "123",
    fetchImpl: async (url, init) => { sent.push({ url, init }); return { ok: true }; },
  });
  assert.deepEqual(await relay({ topic: "orders_v2", user_id: 9, application_id: 123, resource: "/orders/2000001", sent: "x" }), { relayed: true });
  assert.equal(sent[0].init.headers.authorization, "Bearer s3cret");
  assert.deepEqual(JSON.parse(sent[0].init.body), { topic: "orders_v2", resource: "/orders/2000001", user_id: 9, application_id: 123, sent: "x", attempts: null });
  assert.equal((await relay({ topic: "shipments", user_id: 9, application_id: 999, resource: "/shipments/1" })).reason, "application_id");
  assert.equal((await relay({ topic: "orders_v2", user_id: 9, application_id: 123, resource: "https://evil/orders/1" })).reason, "resource");
  assert.equal((await relay({ topic: "public_offers", user_id: 9, application_id: 123, resource: "/x" })).reason, "topic");
  inHub = false;
  assert.equal((await relay({ topic: "orders_v2", user_id: 9, application_id: 123, resource: "/orders/1" })).reason, "not_in_hub");
  assert.equal(sent.length, 1);
});

test("migração 080: contas atuais ficam no ML e contas novas nascem no produto de origem", () => {
  const sql = read("db/080_meli_conta_produtos.sql");
  assert.match(sql, /SELECT id, 'ml', 'migration_080'\s+FROM ml\.meli_contas/);
  assert.match(sql, /current_setting\('ml\.connection_product', true\)/);
  assert.match(sql, /AFTER INSERT ON ml\.meli_contas/);
  assert.match(sql, /ALTER COLUMN usuario_id DROP NOT NULL/);
});

test("callback: autorização do Hub não gera cobrança, cookie nem conta padrão no ML", () => {
  const source = read("routes/meliOAuthRoutes.js");
  assert.match(source, /set_config\('ml\.connection_product', \$1, true\)/);
  assert.match(source, /await activateProduct\(\s*client,\s*contaId,\s*row\.produto/);
  const hubBranch = source.indexOf('if (outcome?.produto && outcome.produto !== "ml")');
  const billing = source.indexOf("confirmMlHubResourceAfterOAuth(outcome).catch");
  assert.ok(hubBranch > 0 && hubBranch < billing, "retorno ao Hub acontece antes da cobrança do ML");
  assert.match(source, /\^\\\/hub\\\/\[A-Za-z0-9\/_-\]\*\$/);
});

test("módulo ML só enxerga contas ativas nele (telas, rotinas e cobrança)", () => {
  for (const file of [
    "middleware/ensureAccount.js", "routes/accountRoutes.js", "routes/extensionRoutes.js", "routes/meliOAuthRoutes.js",
    "services/defaultMeliAccount.js", "services/reputacaoSnapshotScheduler.js", "services/mercadolivreSkuPriceHistoryScheduler.js",
    "routes/mercadolivreRankingRoutes.js",
  ]) {
    assert.match(read(file), /activeInProductSql\("(mc|c)"\)/, file);
  }
  assert.match(read("services/mlTrialOrderMeasurementJob.js"), /p\.produto = 'ml'/);
  assert.match(read("services/promoOfferRefsService.js"), /p\.produto = 'ml'/);
});

test("desvincular no ML preserva a conexão quando o Hub usa a conta", () => {
  const source = read("routes/accountRoutes.js");
  assert.match(source, /produto <> 'ml'/);
  assert.match(source, /const deletedTokens = keepConnection\s*\?/);
  assert.match(source, /await deactivateProduct\(client, accountId, "ml"\)/);
});

test("renovação com autorização perdida marca a conta para reconectar", () => {
  const source = read("services/tokenService.js");
  assert.match(source, /isInvalidGrant\(response\.status, errorData\)/);
  assert.match(source, /set status = 'erro'/);
});

test("API interna fica antes da autenticação do navegador e fora do acesso público", () => {
  const app = read("app.js");
  assert.ok(app.indexOf('app.use("/internal/connections"') > 0);
  assert.ok(app.indexOf('app.use("/internal/connections"') < app.indexOf("app.use(authGate)"));
  const caddy = fs.readFileSync(path.join(__dirname, "../../../infra/Caddyfile"), "utf8");
  const block = caddy.indexOf("@internal-only path /ml/internal/* /hub/internal/*");
  assert.ok(block > 0 && block < caddy.indexOf("@seller-ml-web path"), "bloqueio vem antes do proxy do ML");
});

test("etapa 3: ativar no ML conta já conectada na DACHBYTE passa pela cobrança antes de entrar", () => {
  const source = read("routes/meliOAuthRoutes.js");
  const route = source.slice(source.indexOf('"/contas-dachbyte/:id/ativar"'));
  assert.ok(route.indexOf("companyAccessGuards.requireWriterUser()") > 0, "somente leitura não ativa");
  const confirm = route.indexOf("await confirmMlHubResourceAfterOAuth(outcome)");
  const activate = route.indexOf('await activateProduct(db, account.id, "ml"');
  assert.ok(confirm > 0 && activate > confirm, "recurso confirmado no hub de acessos antes de ativar");
  assert.ok(route.indexOf("queueClosedMonthMeasurement(db, account.id)") > activate, "medição da faixa como conta nova");
  assert.match(route, /account\.connection !== "ok"/);
  const list = source.slice(source.indexOf("async function findDachbyteAccounts"));
  assert.match(list, /and not \$\{activeInProductSql\("mc"\)\}/);
  assert.match(list, /mc\.empresa_id = \$1/);
  assert.match(read("db/081_meli_account_activated_audit.sql"), /'meli_account_activated'/);
});

test("etapa 3: telas de contas do ML mostram as contas já conectadas na DACHBYTE", () => {
  const select = read("public/js/select-conta.js");
  assert.match(select, /fetchJson\("\/api\/meli\/contas-dachbyte"\)/);
  assert.match(select, /\/api\/meli\/contas-dachbyte\/\$\{encodeURIComponent/);
  assert.match(read("views/select-conta.html"), /id="dachbyte-panel" hidden/);
  const link = read("views/vincular-conta.html");
  assert.match(link, /id="dachbyte-accounts" hidden/);
  assert.match(link, /Ativar neste módulo/);
});

test("etapa 3: Contas vinculadas (menu Conta) também mostra e ativa contas da DACHBYTE", () => {
  const js = read("public/js/conta-contas.js");
  assert.match(js, /api\("\/api\/meli\/contas-dachbyte"\)/);
  assert.match(js, /\/api\/meli\/contas-dachbyte\/\$\{encodeURIComponent/);
  assert.match(js, /await Promise\.all\(\[loadAccounts\(\), loadDachbyteAccounts\(\)\]\)/, "depois de ativar, a conta aparece na lista");
  assert.match(read("views/conta-contas.html"), /id="dachbyte-panel" hidden/);
});
