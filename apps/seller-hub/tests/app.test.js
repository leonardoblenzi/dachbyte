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
  const orders = {
    applyPendingForListing: async (...args) => { calls.push(["pending", ...args]); return { orders: 1, movements: 1 }; },
    receiveWebhook: async ({ channel }) => { if (channel === "magalu") throw Object.assign(new Error("assinatura"), { status: 401, code: "invalid_webhook" }); return { received: 1, ids: [7] }; },
    receiveRelayed: async ({ channel, body }) => { calls.push(["relayed", channel, body.topic]); return { received: 1, ids: [8] }; },
    listOrders: async () => [],
  };
  const sync = {
    onItemsChanged: async (...args) => { calls.push(["changed", ...args]); },
    activateAccount: async (input) => { calls.push(["activate", input.accountId, input.confirm]); return { activated: true, pushes: 3 }; },
    skipPending: async () => 0, getSettings: async () => ({ paused: false }), setPaused: async ({ paused }) => { calls.push(["paused", paused]); return { paused }; },
    setLowStockThreshold: async ({ threshold }) => { calls.push(["threshold", threshold]); return { lowStockThreshold: threshold }; },
    listPushes: async () => ({ pushes: [], summary: {} }), retryPush: async () => ({}),
  };
  const syncQueues = { enqueueWebhook: async (id) => { calls.push(["webhook", id]); }, enqueuePush: async () => {} };
  const stock = { setAccountMode: async ({ mode }) => ({ mode }) };
  const app = await createApp({ config, db: {}, catalog, imports, orders, sync, syncQueues, stock });
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
    assert.match(html, /\/brand\/dachbyte\/hub\/mark-transparent\.png/);
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
    assert.deepEqual(calls[1], ["pending", "t1", 9], "vendas pendentes do anúncio são aplicadas ao vincular");
    assert.deepEqual(calls[2], ["changed", "t1", [4], "anúncio vinculado"]);
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

test("webhook: público, corpo bruto, assinatura inválida = 401 e evento vai para a fila", async () => {
  await withServer({}, async (base, calls) => {
    const ok = await fetch(`${base}/webhooks/mercadolivre`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: "orders_v2" }) });
    assert.equal(ok.status, 200);
    assert.deepEqual(calls.at(-1), ["webhook", 7]);
    assert.equal((await fetch(`${base}/webhooks/magalu`, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(`${base}/webhooks/amazon`, { method: "POST", body: "{}" })).status, 404);
  });
});

test("ativar escrita exige administrador e repassa a confirmação", async () => {
  await withServer({}, async (base, calls) => {
    const put = (cookie, body) => fetch(`${base}/api/stock/accounts/3/mode`, { method: "PUT", headers: { "content-type": "application/json", cookie: `suite_auth_token=${cookie}` }, body: JSON.stringify(body) });
    assert.equal((await put(token({ company_role: "operator" }), { mode: "active", confirm: true })).status, 403);
    const res = await put(token({ company_role: "admin" }), { mode: "active", confirm: true });
    assert.equal((await res.json()).pushes, 3);
    assert.deepEqual(calls.at(-1), ["activate", 3, true]);
  });
});

test("configurações: salvar só o limite de estoque baixo não mexe na pausa geral", async () => {
  await withServer({}, async (base, calls) => {
    const put = (body) => fetch(`${base}/api/stock/settings`, { method: "PUT", headers: { "content-type": "application/json", cookie: `suite_auth_token=${token({ company_role: "admin" })}` }, body: JSON.stringify(body) });
    assert.equal((await (await put({ lowStockThreshold: 8 })).json()).settings.lowStockThreshold, 8);
    assert.ok(!calls.some((c) => c[0] === "paused"), "não chamou a pausa");
    await put({ paused: true });
    assert.deepEqual(calls.filter((c) => c[0] !== "threshold").at(-1), ["paused", true]);
  });
});

test("avisos repassados pelo módulo ML: só com o token entre serviços, sem sessão", async () => {
  await withServer({ env: { SELLER_CONNECTIONS_TOKEN: "s3cret" } }, async (base, calls) => {
    const post = (auth) => fetch(`${base}/internal/notifications/mercadolivre`, {
      method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({ topic: "orders_v2", resource: "/orders/1", user_id: 2 }),
    });
    assert.equal((await post()).status, 401);
    assert.equal((await post("Bearer errado")).status, 401);
    const ok = await post("Bearer s3cret");
    assert.equal(ok.status, 200);
    assert.deepEqual(calls.filter((c) => c[0] === "relayed" || c[0] === "webhook"), [["relayed", "mercadolivre", "orders_v2"], ["webhook", 8]]);
  });
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/internal/notifications/mercadolivre`, { method: "POST", headers: { authorization: "Bearer " }, body: "{}" });
    assert.equal(res.status, 401, "sem token configurado, nada entra");
  });
});
