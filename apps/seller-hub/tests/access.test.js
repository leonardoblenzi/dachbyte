"use strict";

// Acesso ao DACH Hub: login único da DACHBYTE (sem login próprio) e liberação do produto pelo hub de acessos.
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createApp } = require("../src/app");
const { loadConfig } = require("../src/platform/config");
const { createAccessHub } = require("../src/platform/accessHub");

const SUITE = "segredo-suite";

test("hub de acessos: liberação do produto dach_hub em cache curto; erro de rede não libera nem fica em cache", async () => {
  let now = 0, answer = { status: 200, body: { allow: true, reason: "ok" } };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ path: new URL(url).pathname, body: JSON.parse(init.body), auth: init.headers.authorization });
    if (answer === "network") throw new Error("ECONNREFUSED");
    return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
  };
  const hub = createAccessHub({ baseUrl: "https://acessos", token: "tok", module: "dach_hub", fetchImpl, now: () => now });
  const who = { tenantId: "t1", userId: "u1" };
  assert.deepEqual(await hub.checkAccess(who), { allow: true, reason: "ok", accountLimit: null });
  assert.deepEqual(calls[0], { path: "/v1/access/check", body: { tenant_id: "t1", user_id: "u1", module: "dach_hub", action: "ACCESS dach_hub" }, auth: "Bearer tok" });
  answer = { status: 200, body: { allow: false, reason: "product_not_installed" } };
  assert.equal((await hub.checkAccess(who)).allow, true, "dentro de 45 s vale o cache");
  now = 46_000;
  assert.deepEqual(await hub.checkAccess(who), { allow: false, reason: "product_not_installed", accountLimit: null });
  answer = "network";
  now = 100_000;
  assert.equal((await hub.checkAccess(who)).allow, false, "sem resposta = não entra");
  answer = { status: 200, body: { allow: true } };
  assert.equal((await hub.checkAccess(who)).allow, true, "erro de rede não ficou em cache");
  assert.equal(createAccessHub({ baseUrl: "", token: "", module: "dach_hub" }).configured, false);
});

/** Hub de acessos falso: t1 contratou o Hub; t3 só tem módulos. */
const accessHub = {
  configured: true,
  async checkAccess({ tenantId }) { return tenantId === "t1" ? { allow: true, reason: "ok" } : { allow: false, reason: "product_not_installed" }; },
};

async function withServer(run, { env = {}, hub = accessHub } = {}) {
  const config = loadConfig({ SUITE_JWT_SECRET: SUITE, HUB_PLATFORM_ADMIN_EMAILS: "root@dachbyte.tech", ...env });
  const app = await createApp({ config, db: {}, catalog: { overview: async () => ({ items: 1 }) }, accessHub: hub, imports: {}, orders: {}, sync: {}, syncQueues: {}, stock: {} });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { server.close(); }
}

const suiteCookie = (payload) => `suite_auth_token=${jwt.sign({ user_id: "u1", email: "ana@x.com", name: "Ana", ...payload }, SUITE)}`;
const getHtml = (url, cookie = "") => fetch(url, { headers: { accept: "text/html", cookie }, redirect: "manual" });
const getApi = (url, cookie = "") => fetch(url, { headers: { cookie } });

test("sem login próprio: sem sessão vai para o /login da DACHBYTE; /hub/login não existe", async () => {
  await withServer(async (base) => {
    const page = await getHtml(`${base}/pedidos`);
    assert.equal(page.status, 302);
    assert.equal(page.headers.get("location"), "/login");
    assert.equal((await getApi(`${base}/api/overview`)).status, 401);
    assert.equal((await getHtml(`${base}/login`)).headers.get("location"), "/login", "não há página de login no Hub");
  });
});

test("quem contratou o Hub entra com a sessão da DACHBYTE", async () => {
  await withServer(async (base) => {
    assert.equal((await getApi(`${base}/api/overview`, suiteCookie({ tenant_id: "t1", company_role: "owner" }))).status, 200);
  });
});

test("quem não contratou o Hub: API 403 e a página volta para a seleção de plataforma", async () => {
  await withServer(async (base) => {
    const cookie = suiteCookie({ tenant_id: "t3" });
    const api = await getApi(`${base}/api/overview`, cookie);
    assert.equal(api.status, 403);
    assert.equal((await api.json()).reason, "product_not_installed");
    assert.equal((await getHtml(`${base}/catalogo`, cookie)).headers.get("location"), "/selecao-plataforma?module=dach_hub_unavailable");
  });
});

test("hub de acessos fora do ar não libera; lista de reserva e equipe da plataforma entram", async () => {
  const down = { configured: true, async checkAccess() { return { allow: false, reason: "hub_unreachable" }; } };
  await withServer(async (base) => {
    assert.equal((await getApi(`${base}/api/overview`, suiteCookie({ tenant_id: "t1" }))).status, 403);
    assert.equal((await getApi(`${base}/api/overview`, suiteCookie({ tenant_id: "x", email: "root@dachbyte.tech" }))).status, 200);
  }, { hub: down });
  await withServer(async (base) => {
    assert.equal((await getApi(`${base}/api/overview`, suiteCookie({ tenant_id: "t3" }))).status, 200);
  }, { env: { HUB_ALLOWED_TENANTS: "t3" } });
});

test("sair do Hub sai da DACHBYTE e volta para o /login", async () => {
  await withServer(async (base) => {
    const out = await getHtml(`${base}/sair`, suiteCookie({ tenant_id: "t1" }));
    assert.equal(out.headers.get("location"), "/login");
    const cleared = out.headers.getSetCookie().find((c) => c.startsWith("suite_auth_token="));
    assert.match(cleared, /Path=\//);
    assert.match(cleared, /Expires=Thu, 01 Jan 1970/);
  });
});

test("token com audiência (de outro produto) e cookie adulterado não entram", async () => {
  await withServer(async (base) => {
    const withAudience = jwt.sign({ tenant_id: "t1", user_id: "u1", email: "ana@x.com" }, SUITE, { audience: "outro-produto" });
    assert.equal((await getApi(`${base}/api/overview`, `suite_auth_token=${withAudience}`)).status, 401);
    const forged = jwt.sign({ tenant_id: "t1", user_id: "u1", email: "ana@x.com" }, "outro-segredo");
    assert.equal((await getApi(`${base}/api/overview`, `suite_auth_token=${forged}`)).status, 401);
  });
});
