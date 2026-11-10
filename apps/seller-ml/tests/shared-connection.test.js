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

test("callback: só o Hub ativa na hora; conta nova para o ML espera a contratação", () => {
  const source = read("routes/meliOAuthRoutes.js");
  assert.match(source, /set_config\('ml\.connection_product', \$1, true\)", \[row\.produto === "dach_hub" \? "dach_hub" : "none"\]/);
  assert.match(source, /if \(row\.produto === "dach_hub"\) \{\s*await activateProduct\(client, contaId, "dach_hub"/);
  assert.doesNotMatch(source, /activateProduct\([^)]*"ml"/, "o retorno da autorização nunca coloca a conta no ML");
  const hubBranch = source.indexOf('if (outcome?.produto === "dach_hub")');
  const billing = source.indexOf("confirmMlHubResourceAfterOAuth(outcome).catch");
  assert.ok(hubBranch > 0 && hubBranch < billing, "retorno ao Hub acontece antes do registro de cobrança do ML");
  assert.match(source, /if \(outcome\.mlActive && outcome\.usuarioId\)/, "cookie e conta padrão só para conta que já estava no ML");
  assert.match(read("db/080_meli_conta_produtos.sql"), /IF origem = 'none' THEN\s*RETURN NEW;/);
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

test("autorização pela seleção de plataforma: produto none volta só para /selecao-plataforma", async () => {
  const { svc } = service(account());
  const ok = await svc.authorize({ tenant_id: "t-1", product: "none", return_to: "/selecao-plataforma", public_origin: "https://dachbyte.tech" });
  assert.equal(ok.input.product, "none");
  await assert.rejects(svc.authorize({ tenant_id: "t-1", product: "none", return_to: "/hub/contas" }), { message: "invalid_return_to" });
  await assert.rejects(svc.authorize({ tenant_id: "t-1", product: "dach_hub", return_to: "/selecao-plataforma" }), { message: "invalid_return_to" });
  await assert.rejects(svc.authorize({ tenant_id: "t-1", product: "ml", return_to: "/selecao-plataforma" }), { message: "product_not_allowed" });
});

test("registrar conta da DACHBYTE para contratar no ML: hub de acessos e medição, sem entrar no módulo", async () => {
  const registered = [], measured = [];
  const db = fakeDb(account({ produtos: ["dach_hub"], empresa_id: 4 }));
  const svc = createInternalConnectionsService({
    db, tokens: {}, authorize: async () => ({}),
    registerHubResource: async (input) => { registered.push(input); },
    queueMeasurement: async (id) => { measured.push(id); },
  });
  assert.deepEqual(await svc.registerForMl({ tenant_id: "t-1", meli_user_id: 555 }), { resource_key: "ml:555" });
  assert.deepEqual(registered, [{ tenantId: "t-1", empresaId: 4, meliUserId: 555, label: "Loja Sul", accountId: 7 }]);
  assert.deepEqual(measured, [7]);
  assert.ok(!db.calls.some((c) => /insert into ml\.meli_conta_produtos/i.test(c.sql)), "não ativa o ML antes da contratação");
  const already = createInternalConnectionsService({ db: fakeDb(account()), tokens: {}, authorize: async () => ({}) });
  await assert.rejects(already.registerForMl({ tenant_id: "t-1", meli_user_id: 555 }), { message: "account_already_in_ml", status: 409 });
  const expired = createInternalConnectionsService({ db: fakeDb(account({ produtos: ["dach_hub"], status: "erro" })), tokens: {}, authorize: async () => ({}) });
  await assert.rejects(expired.registerForMl({ tenant_id: "t-1", meli_user_id: 555 }), { message: "reconnect_required" });
});

test("aviso de contratação do hub de acessos: conta entra no ML liberada, com plano e faixa", async () => {
  const { createMlActivationService } = require("../services/internalActivationService");
  const statements = [];
  const client = { query: async (sql, values) => {
    statements.push({ sql, values });
    if (sql.includes("from meli_contas mc join empresas e")) return { rows: [{ id: 7, empresa_id: 4, status: "ativa" }] };
    return { rows: [], rowCount: 1 };
  } };
  const activate = createMlActivationService({ withClient: async (fn) => fn(client) });
  const result = await activate({ action: "activate", tenant_id: "t-1", external_account_id: "555", resource_key: "ml:555", plan_code: "ml_pro", range_code: "ate_500", operation_id: "postpaid_term:pt_1" });
  assert.deepEqual(result, { ok: true, state: "active", meli_conta_id: 7 });
  assert.ok(statements.some((s) => /insert into ml\.meli_conta_produtos/.test(s.sql) && s.values[0] === 7));
  const update = statements.find((s) => /billing_status = 'active'/.test(s.sql));
  assert.deepEqual(update.values, [7, "ml_pro", "ate_500"]);
  await assert.rejects(activate({ action: "activate", tenant_id: "t-1", external_account_id: "555", resource_key: "ml:999", operation_id: "x" }), { message: "activation_invalid_payload" });
  await assert.rejects(activate({ action: "activate", tenant_id: "t-1", external_account_id: "555", resource_key: "ml:555", operation_id: "x", plan_code: "x;drop" }), { message: "activation_invalid_payload" });
});

test("aviso de contratação: só com a chave do hub, também na raiz do container", () => {
  const app = read("app.js");
  assert.ok(app.indexOf('app.use("/internal/hub/activation"') > 0 && app.indexOf('app.use("/internal/hub/activation"') < app.indexOf("app.use(authGate)"));
  assert.match(app, /secret: process\.env\.SELLER_RETIREMENT_TOKEN,\s*activate:/);
  const host = fs.readFileSync(path.join(__dirname, "../../../platform/runtime/startExpressApp.js"), "utf8");
  assert.match(host, /req\.path === "\/internal\/hub\/activation"/);
});

test("contratação centralizada na seleção de plataforma: nada de assinar conta por dentro do ML", () => {
  assert.match(read("app.js"), /app\.get\("\/vincular-conta"[\s\S]{0,120}res\.redirect\(302, "\/selecao-plataforma\?conectar=ml"\)/);
  assert.match(read("views/conta-contas.html"), /href="\/selecao-plataforma\?conectar=ml">Adicionar conta</);
  assert.doesNotMatch(read("public/js/conta-contas.js"), /oauth\/start/);
  assert.match(read("public/js/conta-regularizar.js"), /\/selecao-plataforma\?resource_key=/);
  assert.doesNotMatch(read("routes/meliOAuthRoutes.js"), /contas-dachbyte/);
  const portal = read("views/selecao-plataforma.html");
  assert.match(portal, /id="ml-link-drawer"/);
  assert.match(portal, /api\("\/api\/portal\/ml\/dachbyte-accounts"\)/);
  assert.match(portal, /api\("\/api\/portal\/ml\/register"/);
  assert.match(portal, /api\("\/api\/portal\/ml\/connect"/);
  assert.match(portal, /get\("conectar"\)==="ml"/);
});
