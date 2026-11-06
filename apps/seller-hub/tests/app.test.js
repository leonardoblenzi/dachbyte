"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createApp } = require("../src/app");
const { loadConfig } = require("../src/platform/config");

const SECRET = "segredo-de-teste";

function token(payload) {
  return jwt.sign({ tenant_id: "t1", user_id: "u1", email: "ana@empresa.com", name: "Ana", ...payload }, SECRET);
}

async function withServer(options, run) {
  const config = loadConfig({ SUITE_JWT_SECRET: SECRET, HUB_ALLOWED_TENANTS: "t1", HUB_PLATFORM_ADMIN_EMAILS: "root@dachbyte.tech", ...options.env });
  const calls = [];
  const catalog = {
    overview: async () => ({ items: 3, accounts: 1, listings: 5, linked: 4, unlinked: 1, with_suggestion: 1 }),
    listItems: async () => [{ id: 1, sku: "SKU-1", name: "Sofá", listings: [] }],
    listPending: async () => [],
    linkListing: async (...args) => { calls.push(args); return { id: args[1], itemId: args[2] }; },
  };
  const imports = {
    requestImport: async (input) => { calls.push(["import", input.accountId, input.trigger]); return { run: { id: 1, status: "queued" }, created: true }; },
    getRun: async () => ({ id: 1, status: "running" }),
  };
  const app = await createApp({ config, db: {}, catalog, imports });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base, calls); } finally { server.close(); }
}

const get = (url, cookie, accept = "application/json") => fetch(url, { headers: { accept, ...(cookie ? { cookie: `suite_auth_token=${cookie}` } : {}) }, redirect: "manual" });

test("sem sessão: página manda para o login e API responde 401", async () => {
  await withServer({}, async (base) => {
    const page = await get(`${base}/`, null, "text/html");
    assert.equal(page.status, 302);
    assert.equal(page.headers.get("location"), "/login");
    assert.equal((await get(`${base}/api/overview`)).status, 401);
  });
});

test("empresa fora da lista de liberação não entra (produto oculto)", async () => {
  await withServer({}, async (base) => {
    const res = await get(`${base}/api/overview`, token({ tenant_id: "outra" }));
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "hub_not_enabled");
    const page = await get(`${base}/catalogo`, token({ tenant_id: "outra" }), "text/html");
    assert.match(page.headers.get("location"), /selecao-plataforma/);
  });
});

test("administrador da plataforma entra mesmo sem a empresa liberada", async () => {
  await withServer({}, async (base) => {
    assert.equal((await get(`${base}/api/overview`, token({ tenant_id: "x", email: "root@dachbyte.tech" }))).status, 200);
  });
});

test("páginas usam o shell compartilhado com tema Violeta e ícone do Hub", async () => {
  await withServer({}, async (base) => {
    const html = await (await get(`${base}/pendencias`, token({}), "text/html")).text();
    assert.match(html, /data-seller-theme="violet"/);
    assert.match(html, /\/hub\/ui\/seller-shell\.css/);
    assert.match(html, /\/brand\/dachbyte\/hub\/mark\.svg/);
    assert.match(html, /data-view="pending"/);
    assert.match(html, /<html lang="pt-BR"/);
  });
});

test("API do catálogo responde e vínculo manual exige administrador", async () => {
  await withServer({}, async (base, calls) => {
    const overview = await (await get(`${base}/api/overview`, token({}))).json();
    assert.equal(overview.overview.unlinked, 1);
    const post = (cookie) => fetch(`${base}/api/listings/9/link`, { method: "POST", headers: { "content-type": "application/json", cookie: `suite_auth_token=${cookie}` }, body: JSON.stringify({ itemId: 4 }) });
    assert.equal((await post(token({ company_role: "operator" }))).status, 403);
    const ok = await post(token({ company_role: "admin" }));
    assert.equal(ok.status, 200);
    assert.deepEqual(calls[0], ["t1", 9, 4]);
  });
});

test("canais aparecem como aguardando app enquanto o OAuth não está pronto", async () => {
  await withServer({}, async (base) => {
    const { channels } = await (await get(`${base}/api/channels`, token({}))).json();
    assert.deepEqual(channels.map((c) => c.id), ["mercadolivre", "magalu", "shopee"]);
    assert.ok(channels.every((c) => c.available === false));
  });
});

test("conectar conta: operador volta com aviso, app sem configuração volta com erro", async () => {
  await withServer({}, async (base) => {
    const operator = await get(`${base}/auth/mercadolivre/start`, token({ company_role: "operator" }), "text/html");
    assert.equal(operator.status, 302);
    assert.equal(operator.headers.get("location"), "/hub/contas?erro=admin_required");
    const admin = await get(`${base}/auth/mercadolivre/start`, token({ company_role: "admin" }), "text/html");
    assert.equal(admin.headers.get("location"), "/hub/contas?erro=channel_not_configured");
    const callback = await get(`${base}/auth/magalu/callback?error=access_denied`, token({ company_role: "admin" }), "text/html");
    assert.equal(callback.headers.get("location"), "/hub/contas?erro=authorization_denied");
  });
});

test("importar agora: só administrador, responde 202 com a execução na fila", async () => {
  await withServer({}, async (base, calls) => {
    const post = (cookie) => fetch(`${base}/api/accounts/5/import`, { method: "POST", headers: { cookie: `suite_auth_token=${cookie}` } });
    assert.equal((await post(token({ company_role: "operator" }))).status, 403);
    const res = await post(token({ company_role: "admin" }));
    assert.equal(res.status, 202);
    assert.equal((await res.json()).run.status, "queued");
    assert.deepEqual(calls.at(-1), ["import", 5, "manual"]);
    assert.equal((await (await get(`${base}/api/imports/1`, token({}))).json()).run.status, "running");
  });
});

test("lista de canais traz tipo, forma de conexão e capacidades", async () => {
  await withServer({}, async (base) => {
    const { channels } = await (await get(`${base}/api/channels`, token({}))).json();
    assert.ok(channels.every((c) => c.kind === "marketplace" && c.auth === "oauth" && c.capabilities.listings === true));
  });
});
