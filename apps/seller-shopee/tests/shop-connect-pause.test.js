"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

// Carrega o AuthController com config e repositorios simulados.
function loadController() {
  Object.assign(process.env, {
    API_BASE_URL: "https://x.test/shopee",
    SHOPEE_API_BASE: "https://partner.shopeemobile.com",
    SHOPEE_PARTNER_ID: "12345",
    SHOPEE_PARTNER_KEY: "0123456789abcdef",
    SHOPEE_REDIRECT_URL: "https://x.test/shopee/auth/callback",
  });
  const issued = [];
  const controllerPath = require.resolve("../src/controllers/AuthController");
  delete require.cache[controllerPath];
  const originalLoad = Module._load;
  Module._load = function mockDependencies(request, parent, isMain) {
    if (request === "../repositories/oauthStateSqlRepository") {
      return new Proxy({ createOAuthState: async (row) => { issued.push(row); } }, {
        get: (target, key) => target[key] || (async () => null),
      });
    }
    if (/^\.\.\/(repositories|services|config\/postgres)/.test(request) && request !== "../config/shopee") {
      return new Proxy({}, { get: () => async () => null });
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return { controller: require("../src/controllers/AuthController"), issued };
  } finally {
    Module._load = originalLoad;
  }
}

function response() {
  return {
    statusCode: 200,
    body: null,
    cookies: [],
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    cookie(...args) { this.cookies.push(args); return this; },
  };
}

test("com a conexao pausada, os links de autorizacao respondem com aviso e sem OAuth", async () => {
  process.env.SHOPEE_SHOP_CONNECT_PAUSED = "true";
  delete process.env.SHOPEE_SHOP_CONNECT_PAUSED_MESSAGE;
  const { controller, issued } = loadController();
  for (const handler of [controller.getAuthUrl, controller.getAdsAuthUrl]) {
    const res = response();
    await handler({ query: {}, auth: { userId: 1, accountId: 1, role: "ADMIN" } }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, "shopee_connect_paused");
    assert.match(res.body.message, /homologação na Shopee/);
    assert.equal(res.body.auth_url, undefined);
  }
  assert.equal(issued.length, 0, "nenhum state de OAuth e criado com a conexao pausada");

  process.env.SHOPEE_SHOP_CONNECT_PAUSED_MESSAGE = "Aviso personalizado.";
  const custom = response();
  await controller.getAuthUrl({ query: {}, auth: { userId: 1, accountId: 1 } }, custom);
  assert.equal(custom.body.message, "Aviso personalizado.");
  delete process.env.SHOPEE_SHOP_CONNECT_PAUSED_MESSAGE;
});

test("sem a pausa, o link de autorizacao continua sendo gerado", async () => {
  process.env.SHOPEE_SHOP_CONNECT_PAUSED = "false";
  const { controller, issued } = loadController();
  const res = response();
  await controller.getAuthUrl({ query: {}, auth: { userId: 1, accountId: 1 } }, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.auth_url, /\/api\/v2\/shop\/auth_partner\?partner_id=12345/);
  assert.equal(issued.length, 1);
  delete process.env.SHOPEE_SHOP_CONNECT_PAUSED;
});

test("Entrar pelo portal abre a aba de conexao sem disparar o OAuth sozinho", () => {
  const gateway = fs.readFileSync(path.join(__dirname, "..", "..", "gateway", "server.js"), "utf8");
  const start = gateway.indexOf("async function bootstrapShopeeSession");
  const body = gateway.slice(start, gateway.indexOf("\n}\n", start));
  assert.ok(start > 0);
  assert.doesNotMatch(body, /startOauth=1/);
  assert.match(body, /"\/shopee\/\?tab=auth"/);
});

test("telas de conexao mostram a mensagem do servidor, nao o JSON cru", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.match(app, /function apiErrorMessage\(error\)/);
  assert.match(app, /preview\.textContent = apiErrorMessage\(e\)/);
  assert.match(app, /integracao de Ads: \$\{apiErrorMessage\(e\)\}/);
});

test("conta sem loja abre painel centralizado com o motivo e o botao Voltar", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.match(app, /async function showNoShopState\(\)/);
  assert.match(app, /apiGet\("\/auth\/connect-status"\)/);
  assert.match(app, /href="\/selecao-plataforma">Voltar aos módulos/);
  assert.match(app, /classList\.toggle\("modal-overlay--center", compact\)/);
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.match(css, /\.modal-overlay\.modal-overlay--center\{align-items:center\}/);
  const routes = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "auth.routes.js"), "utf8");
  assert.match(routes, /"\/auth\/connect-status"/);
});

test("status da conexao informa pausa e mensagem sem gerar link", async () => {
  process.env.SHOPEE_SHOP_CONNECT_PAUSED = "true";
  const { controller, issued } = loadController();
  const res = response();
  controller.connectStatus({}, res);
  assert.equal(res.body.paused, true);
  assert.match(res.body.message, /homologação/);
  assert.equal(issued.length, 0);
  delete process.env.SHOPEE_SHOP_CONNECT_PAUSED;
});

test("depois do OAuth da loja o usuario cai no Painel de Controle", () => {
  const controller = fs.readFileSync(path.join(__dirname, "..", "src", "controllers", "AuthController.js"), "utf8");
  assert.match(controller, /"\/shopee\/\?tab=control-panel"/);
  assert.doesNotMatch(controller, /: "\/shopee\/\?tab=auth"\)/);
  const index = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(index, /id="tab-control-panel"/);
});
