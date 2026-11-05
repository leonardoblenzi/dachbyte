"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

// Carrega o servico com o repositorio simulado: rowsByUser[userId] = linhas.
function loadService(rowsByUser = {}) {
  const servicePath = require.resolve("../src/services/userAccessService");
  delete require.cache[servicePath];
  const originalLoad = Module._load;
  Module._load = function mockRepository(request, parent, isMain) {
    if (request === "../repositories/userAccessRepository") {
      return {
        listModuleRows: async (_tenant, userId) => rowsByUser[userId] || [],
        upsertSeenUser: async () => {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require("../src/services/userAccessService");
  } finally {
    Module._load = originalLoad;
  }
}

function req(userId, extra = {}) {
  return {
    method: "GET",
    path: "/",
    body: {},
    headers: {},
    magaluIdentity: { dachTenantId: "t-1", dachUserId: userId, email: `${userId}@x.com`, companyRole: extra.role || null },
    magaluHubAccess: { reason: extra.reason || "ok" },
    ...extra.req,
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

async function run(middleware, request) {
  const res = response();
  let passed = false;
  await middleware(request, res, () => { passed = true; });
  return { passed, res };
}

const readOnlyRows = [
  { module_key: "magalu.operacoes.precos", can_access: true, can_edit: false },
  { module_key: "magalu.operacoes.estoque", can_access: true, can_edit: true },
];

test("so admin da empresa ou Master passam direto; owner segue as caixas como operador", async () => {
  const service = loadService({ owner: readOnlyRows, op: readOnlyRows });
  assert.equal(service.isAdmin(req("a", { role: "admin" })), true);
  assert.equal(service.isAdmin(req("m", { reason: "platform_admin" })), true);
  assert.equal(service.isAdmin(req("owner", { role: "owner" })), false);
  assert.equal(service.isAdmin(req("op", { role: "operator" })), false);

  assert.equal(await service.hasModuleAccess(req("owner", { role: "owner" }), "magalu.operacoes.precos", { edit: true }), false);
  assert.equal(await service.hasModuleAccess(req("op", { role: "operator" }), "magalu.operacoes.precos", { edit: true }), false);
  assert.equal(await service.hasModuleAccess(req("a", { role: "admin" }), "magalu.operacoes.precos", { edit: true }), true);
});

test("sem configuracao = acesso completo; com configuracao valem Acessar e Editar", async () => {
  const service = loadService({ restricted: readOnlyRows });
  assert.equal(await service.hasModuleAccess(req("legacy"), "magalu.pedidos", { edit: true }), true);
  const restricted = req("restricted");
  assert.equal(await service.hasModuleAccess(restricted, "magalu.operacoes.precos"), true);
  assert.equal(await service.hasModuleAccess(restricted, "magalu.operacoes.precos", { edit: true }), false);
  assert.equal(await service.hasModuleAccess(restricted, "magalu.operacoes.estoque", { edit: true }), true);
  assert.equal(await service.hasModuleAccess(restricted, "magalu.pedidos"), false, "modulo nao listado = sem acesso");
});

test("trava de escrita nega sem Editar, libera leitura e consultas via POST", async () => {
  const service = loadService({ u: readOnlyRows });
  const guard = service.requireEditForWrites("magalu.operacoes.precos", { readOnlyPaths: ["/calculator/calculate"] });
  assert.equal((await run(guard, req("u", { req: { method: "GET", path: "/costs" } }))).passed, true);
  assert.equal((await run(guard, req("u", { req: { method: "POST", path: "/calculator/calculate" } }))).passed, true);
  const denied = await run(guard, req("u", { req: { method: "PUT", path: "/costs/SKU1" } }));
  assert.equal(denied.passed, false);
  assert.equal(denied.res.statusCode, 403);
  assert.equal(denied.res.body.error, "magalu_edit_denied");
});

test("previa de preco e estoque escolhe o modulo pelo recurso enviado", async () => {
  const service = loadService({ u: readOnlyRows });
  const guard = service.requireEditForWrites((request) => (request.body?.resource === "stock" ? "magalu.operacoes.estoque" : "magalu.operacoes.precos"));
  assert.equal((await run(guard, req("u", { req: { method: "POST", path: "/", body: { resource: "stock" } } }))).passed, true);
  assert.equal((await run(guard, req("u", { req: { method: "POST", path: "/", body: { resource: "price" } } }))).passed, false);
  await assert.rejects(() => service.assertModuleEdit(req("u"), "magalu.operacoes.precos"), (error) => error.status === 403);
});

test("paginas: Conta so para admin; operacao pela caixa Acessar; Ajuda aberta", async () => {
  const service = loadService({ u: readOnlyRows });
  assert.equal(await service.canOpenPage(req("u"), "/usuarios"), false);
  assert.equal(await service.canOpenPage(req("u"), "/contas"), false);
  assert.equal(await service.canOpenPage(req("u"), "/ajuda"), true);
  assert.equal(await service.canOpenPage(req("u"), "/precos"), true);
  assert.equal(await service.canOpenPage(req("u"), "/pedidos"), false);
  assert.equal(await service.canOpenPage(req("adm", { role: "admin" }), "/usuarios"), true);
  const viewer = await service.viewerPermissions(req("u"));
  assert.equal(viewer.is_admin, false);
  assert.equal(viewer.pages["/usuarios"], false);
  assert.deepEqual(viewer.modules["magalu.operacoes.precos"], { access: true, edit: false });
});

test("salvar acessos grava todo o catalogo, entao nenhum modulo nunca vira acesso completo", () => {
  const service = loadService();
  const rows = service.normalizeModulePayload([
    { module_key: "magalu.pedidos", can_access: true, can_edit: true },
    { module_key: "magalu.operacoes.precos", can_access: false, can_edit: true },
    { module_key: "nao.existe", can_access: true },
  ]);
  assert.equal(rows.length, service.MODULES.length);
  assert.deepEqual(rows.find((row) => row.module_key === "magalu.pedidos"), { module_key: "magalu.pedidos", can_access: true, can_edit: true });
  assert.deepEqual(rows.find((row) => row.module_key === "magalu.operacoes.precos"), { module_key: "magalu.operacoes.precos", can_access: false, can_edit: false });
  assert.ok(rows.every((row) => service.MODULE_KEYS.has(row.module_key)));
  assert.equal(service.normalizeModulePayload([]).every((row) => row.can_access === false), true);
});

test("rotas instalam as travas e a gestao de usuarios e so de admin", () => {
  const api = read("src", "routes", "api.routes.js");
  for (const snippet of [
    'router.use("/orders", userAccess.requireEditForWrites("magalu.pedidos"',
    'router.use("/sku-management", userAccess.requireEditForWrites("magalu.operacoes.catalogo"',
    'router.use("/financial", userAccess.requireEditForWrites("magalu.precificacao.margem"',
    'router.post("/writes/preview", requireWritePreviewEdit',
    'router.post("/promo-prices/previews",requireCampaignEdit',
  ]) assert.ok(api.includes(snippet), snippet);
  assert.match(read("src", "controllers", "writeController.js"), /assertModuleEdit\(\s*req,/);

  const account = read("src", "routes", "account.routes.js");
  assert.match(account, /\/users", userAccess\.requireAdmin/);
  assert.match(account, /\/users\/:userId\/access", userAccess\.requireAdmin/);
  assert.match(account, /\/unlink", userAccess\.requireAdmin/);

  const pages = read("src", "routes", "index.js");
  assert.match(pages, /userAccess\.canOpenPage\(req, route\)/);
  assert.match(pages, /"\/auth\/start", userAccess\.requireAccountLinker/);
});

test("papel da empresa chega do Hub pelo token da suite", () => {
  const { _test } = require("../src/middlewares/suiteAuth");
  assert.equal(_test.identityFromPayload({ tenant_id: "t", user_id: "u", email: "a@b.c", company_role: "Admin" }).companyRole, "admin");
  assert.equal(_test.identityFromPayload({ tenant_id: "t", user_id: "u", email: "a@b.c" }).companyRole, null);

  const gateway = fs.readFileSync(path.join(root, "..", "..", "routes", "suiteAuthRoutes.js"), "utf8");
  assert.match(gateway, /company_role: identity\.companyRole \|\| null/);
  assert.match(gateway, /companyRole: normalizeCompanyRole\(portal\.user\?\.role\)/);
  assert.match(gateway, /normalizeCompanyRole\(payload\.portal_role\)/);
});

test("secao Conta segue o formato do Seller: indicadores, busca, tabela e modal de acessos", () => {
  const html = read("views", "app.html");
  for (const id of ["mg-users-page", "mg-plan-page", "mg-help-page", "mg-user-access-modal", "mg-unlink-dialog"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /<section class="mg-access-dialog mg-ui-modal" id="mg-user-access-modal" hidden>/);
  assert.match(html, /<section class="mg-unlink-modal mg-ui-modal" id="mg-unlink-dialog" hidden>/);
  assert.match(html, /<th>Usuário<\/th><th>Papel na empresa<\/th><th>Módulos<\/th>/);
  assert.match(html, /id="mg-accounts-search"/);
  const js = read("public", "js", "magalu-account.js");
  for (const label of ["Acessar", "Editar", "Acesso completo", "Editar acessos"]) assert.ok(js.includes(label), label);
  assert.match(js, /accountApi\("\/users"\)/);
});
