"use strict";

// Login próprio do DACH Hub: hub de acessos falso (sem rede) e servidor de verdade.
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createApp } = require("../src/app");
const { loadConfig } = require("../src/platform/config");
const { createAccessHub } = require("../src/platform/accessHub");
const { safeReturnPath } = require("../src/platform/auth");

const SUITE = "segredo-suite";
const SESSION = "segredo-hub";

/** Hub de acessos falso: rota → resposta. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: JSON.parse(init.body), auth: init.headers.authorization });
    const handler = routes[path];
    if (!handler) return { ok: false, status: 404, json: async () => ({}) };
    const r = typeof handler === "function" ? handler(JSON.parse(init.body)) : handler;
    if (r === "network") throw new Error("ECONNREFUSED");
    return { ok: (r.status || 200) < 400, status: r.status || 200, json: async () => r.body };
  };
  return { impl, calls };
}

test("hub de acessos: senha pelo portal, empresas do usuário, reserva para a equipe e falha fechada", async () => {
  const { impl, calls } = fakeFetch({
    "/v1/internal/portal/auth/verify": ({ email, password }) => {
      if (password !== "certa") return { body: { ok: true, allow: false, reason: "invalid_credentials" } };
      if (email === "equipe@dachbyte.tech") return { body: { ok: true, allow: false, reason: "portal_membership_inactive" } };
      return { body: { ok: true, allow: true, tenant_id: "t1", user_id: "u1", email, name: "Ana", company_name: "Loja A", portal_role: "owner",
        available_tenants: [{ tenant_id: "t1", company_name: "Loja A", role: "owner" }, { tenant_id: "t2", company_name: "Loja B", role: "operator" }] } };
    },
    "/v1/internal/auth/verify": { body: { ok: true, allow: true, context: "platform", user_id: "p9", email: "equipe@dachbyte.tech", name: "Equipe" } },
  });
  const hub = createAccessHub({ baseUrl: "https://acessos", token: "tok", module: "dach_hub", fetchImpl: impl });
  const ok = await hub.verifyLogin("ana@x.com", "certa");
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.user.tenants.map((t) => [t.tenantId, t.role]), [["t1", "owner"], ["t2", "operator"]]);
  assert.equal(calls[0].auth, "Bearer tok");
  assert.deepEqual(await hub.verifyLogin("ana@x.com", "errada"), { ok: false, reason: "invalid_credentials" });
  const team = await hub.verifyLogin("equipe@dachbyte.tech", "certa");
  assert.equal(team.user.tenantId, "platform-p9", "equipe da plataforma entra pela verificação interna");
  assert.equal(calls.at(-1).body.module, "dach_hub");

  const down = createAccessHub({ baseUrl: "https://acessos", token: "tok", module: "dach_hub", fetchImpl: fakeFetch({ "/v1/internal/portal/auth/verify": "network" }).impl });
  assert.deepEqual(await down.verifyLogin("a@x.com", "s"), { ok: false, reason: "hub_unavailable" });
  assert.deepEqual(await createAccessHub({ baseUrl: "", token: "", module: "dach_hub" }).verifyLogin("a@x.com", "s"), { ok: false, reason: "hub_unavailable" });
});

test("hub de acessos: liberação do módulo em cache curto; erro de rede não libera nem fica em cache", async () => {
  let now = 0, answer = { body: { allow: true, reason: "ok" } };
  const { impl, calls } = fakeFetch({ "/v1/access/check": () => answer });
  const hub = createAccessHub({ baseUrl: "https://acessos", token: "tok", module: "dach_hub", fetchImpl: impl, now: () => now });
  const who = { tenantId: "t1", userId: "u1" };
  assert.deepEqual(await hub.checkAccess(who), { allow: true, reason: "ok" });
  assert.deepEqual(calls[0].body, { tenant_id: "t1", user_id: "u1", module: "dach_hub", action: "ACCESS dach_hub" });
  answer = { body: { allow: false, reason: "product_not_installed" } };
  assert.equal((await hub.checkAccess(who)).allow, true, "dentro de 45 s vale o cache");
  now = 46_000;
  assert.deepEqual(await hub.checkAccess(who), { allow: false, reason: "product_not_installed" });
  answer = "network";
  now = 100_000;
  assert.equal((await hub.checkAccess(who)).allow, false, "sem resposta = não entra");
  answer = { body: { allow: true } };
  assert.equal((await hub.checkAccess(who)).allow, true, "erro de rede não ficou em cache");
});

test("volta depois do login: só caminhos do /hub", () => {
  assert.equal(safeReturnPath("/hub/pedidos?x=1"), "/hub/pedidos?x=1");
  for (const bad of ["https://mal.com", "//mal.com", "/hubx", "/outro", "/hub\\..\\", "", null]) assert.equal(safeReturnPath(bad), "/hub/");
});

/** Hub de acessos falso para o servidor. */
function stubAccessHub({ allowed = new Set(["t1", "t2"]) } = {}) {
  const users = {
    "ana@x.com": { userId: "u1", email: "ana@x.com", name: "Ana", tenantId: "t1", companyName: "Loja A", companyRole: "owner", tenants: [{ tenantId: "t1", companyName: "Loja A", role: "owner" }] },
    "bia@x.com": { userId: "u2", email: "bia@x.com", name: "Bia", tenantId: "t1", companyName: "Loja A", companyRole: "operator",
      tenants: [{ tenantId: "t1", companyName: "Loja A", role: "operator" }, { tenantId: "t2", companyName: "Loja B", role: "admin" }] },
    "caio@x.com": { userId: "u3", email: "caio@x.com", name: "Caio", tenantId: "t3", companyName: "Loja C", companyRole: "owner", tenants: [{ tenantId: "t3", companyName: "Loja C", role: "owner" }] },
  };
  return {
    configured: true,
    async verifyLogin(email, password) { return users[email] && password === "certa" ? { ok: true, user: users[email] } : { ok: false, reason: "invalid_credentials" }; },
    async checkAccess({ tenantId }) { return allowed.has(tenantId) ? { allow: true, reason: "ok" } : { allow: false, reason: "product_not_installed" }; },
    forget() {},
  };
}

async function withServer(run, { accessHub = stubAccessHub(), env = {} } = {}) {
  const config = loadConfig({ SUITE_JWT_SECRET: SUITE, HUB_SESSION_SECRET: SESSION, HUB_PLATFORM_ADMIN_EMAILS: "root@dachbyte.tech", ...env });
  const catalog = { overview: async () => ({ items: 1 }) };
  const app = await createApp({ config, db: {}, catalog, accessHub, imports: {}, orders: {}, sync: {}, syncQueues: {}, stock: {} });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { server.close(); }
}

/** Cookies da resposta → "a=1; b=2" (removidos ficam de fora). */
function cookiesFrom(res, jar = {}) {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const [name, ...value] = pair.split("=");
    if (/Expires=Thu, 01 Jan 1970/i.test(line)) delete jar[name]; else jar[name] = value.join("=");
  }
  return jar;
}
const header = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
const postJson = (url, body, jar = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", cookie: header(jar) }, body: JSON.stringify(body), redirect: "manual" });
const getHtml = (url, jar = {}) => fetch(url, { headers: { accept: "text/html", cookie: header(jar) }, redirect: "manual" });

test("entrar: sessão própria do Hub, cookie seguro no /hub e volta para a página pedida", async () => {
  await withServer(async (base) => {
    const first = await getHtml(`${base}/pedidos?prazo=late`);
    assert.equal(first.status, 302);
    assert.equal(first.headers.get("location"), `/hub/login?volta=${encodeURIComponent("/hub/pedidos?prazo=late")}`);
    const page = await (await getHtml(`${base}/login?volta=%2Fhub%2Fpedidos`)).text();
    assert.match(page, /Entrar · DACH Hub/);
    assert.match(page, /data-return="\/hub\/pedidos"/);
    assert.match(page, /\/esqueci-senha/);

    const res = await postJson(`${base}/api/session`, { email: "ana@x.com", password: "certa", volta: "/hub/pedidos" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, redirect: "/hub/pedidos" });
    const raw = res.headers.getSetCookie().find((c) => c.startsWith("dach_hub_session="));
    assert.match(raw, /HttpOnly/i);
    assert.match(raw, /Path=\/hub/);
    assert.match(raw, /SameSite=Lax/i);
    const jar = cookiesFrom(res);
    const claims = jwt.verify(jar.dach_hub_session, SESSION, { audience: "dach-hub" });
    assert.deepEqual([claims.tenant_id, claims.company_role, claims.company_name], ["t1", "owner", "Loja A"]);
    assert.equal((await fetch(`${base}/api/overview`, { headers: { cookie: header(jar) } })).status, 200);
    assert.equal((await getHtml(`${base}/login`, jar)).headers.get("location"), "/hub/", "já logado: página de login segue direto");
  });
});

test("entrar: senha errada, usuário sem liberação, limite de tentativas e volta para fora do Hub ignorada", async () => {
  await withServer(async (base) => {
    const wrong = await postJson(`${base}/api/session`, { email: "ana@x.com", password: "errada" });
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).message, "E-mail ou senha incorretos.");
    const denied = await postJson(`${base}/api/session`, { email: "caio@x.com", password: "certa" });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, "sem_acesso");
    assert.equal(denied.headers.getSetCookie().some((c) => c.startsWith("dach_hub_session=")), false);
    const outside = await postJson(`${base}/api/session`, { email: "ana@x.com", password: "certa", volta: "https://mal.com" });
    assert.equal((await outside.json()).redirect, "/hub/");
    for (let i = 0; i < 8; i += 1) await postJson(`${base}/api/session`, { email: "ana@x.com", password: "errada" });
    const blocked = await postJson(`${base}/api/session`, { email: "ana@x.com", password: "certa" });
    assert.equal(blocked.status, 429, "8 erros seguidos em 15 min bloqueiam o e-mail (login certo zera a contagem)");
  });
});

test("usuário em duas empresas escolhe com qual entrar (ticket curto, só empresas dele)", async () => {
  await withServer(async (base) => {
    const step1 = await (await postJson(`${base}/api/session`, { email: "bia@x.com", password: "certa" })).json();
    assert.deepEqual(step1.choose, [{ tenantId: "t1", companyName: "Loja A" }, { tenantId: "t2", companyName: "Loja B" }]);
    const other = await postJson(`${base}/api/session/tenant`, { ticket: step1.ticket, tenantId: "t3" });
    assert.equal(other.status, 400, "empresa fora da lista do usuário");
    const forged = await postJson(`${base}/api/session/tenant`, { ticket: jwt.sign({ tenants: [{ tenantId: "t3" }] }, "outro", { audience: "dach-hub-ticket" }), tenantId: "t3" });
    assert.equal(forged.status, 401);
    const res = await postJson(`${base}/api/session/tenant`, { ticket: step1.ticket, tenantId: "t2" });
    assert.equal(res.status, 200);
    const claims = jwt.verify(cookiesFrom(res).dach_hub_session, SESSION, { audience: "dach-hub" });
    assert.deepEqual([claims.tenant_id, claims.company_role], ["t2", "admin"], "papel da empresa escolhida");
  });
});

test("sessão da suíte entra direto; ao sair do Hub ela para de valer até o próximo login", async () => {
  await withServer(async (base) => {
    const suite = { suite_auth_token: jwt.sign({ tenant_id: "t1", user_id: "u1", email: "ana@x.com", name: "Ana", company_role: "admin" }, SUITE) };
    assert.equal((await fetch(`${base}/api/overview`, { headers: { cookie: header(suite) } })).status, 200);
    const out = await getHtml(`${base}/sair`, suite);
    assert.equal(out.headers.get("location"), "/hub/login?saiu=1");
    const jar = cookiesFrom(out, { ...suite });
    assert.equal(jar.dach_hub_signed_out, "1");
    assert.equal((await fetch(`${base}/api/overview`, { headers: { cookie: header(jar) } })).status, 401, "saiu: a sessão da suíte não entra sozinha");
    const page = await (await getHtml(`${base}/login`, jar)).text();
    assert.match(page, /Continuar como <strong>Ana<\/strong>/);
    const back = await postJson(`${base}/api/session/suite`, {}, jar);
    assert.equal(back.status, 200);
    cookiesFrom(back, jar);
    assert.equal(jar.dach_hub_signed_out, undefined, "entrar de novo limpa a marca de saída");
    assert.equal((await fetch(`${base}/api/overview`, { headers: { cookie: header(jar) } })).status, 200);
  });
});

test("empresa sem liberação no hub de acessos: API 403 e página volta ao login com o motivo; lista de reserva libera", async () => {
  await withServer(async (base) => {
    const suite = { suite_auth_token: jwt.sign({ tenant_id: "t3", user_id: "u3", email: "caio@x.com", name: "Caio" }, SUITE) };
    const api = await fetch(`${base}/api/overview`, { headers: { cookie: header(suite) } });
    assert.equal(api.status, 403);
    assert.equal((await api.json()).reason, "product_not_installed");
    assert.equal((await getHtml(`${base}/catalogo`, suite)).headers.get("location"), "/hub/login?erro=sem_acesso");
    const page = await (await getHtml(`${base}/login?erro=sem_acesso`, suite)).text();
    assert.match(page, /não está liberado/);
    assert.doesNotMatch(page, /Continuar como/, "sem botão que levaria de volta à recusa");
  });
  await withServer(async (base) => {
    const suite = { suite_auth_token: jwt.sign({ tenant_id: "t3", user_id: "u3", email: "caio@x.com", name: "Caio" }, SUITE) };
    assert.equal((await fetch(`${base}/api/overview`, { headers: { cookie: header(suite) } })).status, 200);
  }, { env: { HUB_ALLOWED_TENANTS: "t3" } });
});

test("sessão do Hub não vale como sessão da suíte (audiência própria) e cookie adulterado não entra", async () => {
  await withServer(async (base) => {
    const hubToken = jwt.sign({ tenant_id: "t1", user_id: "u1", email: "ana@x.com" }, SUITE, { audience: "dach-hub" });
    assert.equal((await fetch(`${base}/api/overview`, { headers: { cookie: `suite_auth_token=${hubToken}` } })).status, 401);
    const forged = jwt.sign({ tenant_id: "t1", user_id: "u1", email: "ana@x.com" }, "outro", { audience: "dach-hub" });
    assert.equal((await fetch(`${base}/api/overview`, { headers: { cookie: `dach_hub_session=${forged}` } })).status, 401);
  }, { env: { HUB_SESSION_SECRET: "" } });
});
