"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const express = require("express");

// Banco simulado: usuario 35 (nivel usuario) na empresa 16, com modulos
// configurados por teste. Usuario 1 e administrador.
function createDbMock(state) {
  return {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, " ");
      if (text.includes("from usuarios")) {
        const user = state.users[params[0]];
        return { rows: user ? [{ id: params[0], ...user }] : [] };
      }
      if (text.includes("count(*)::int as total")) {
        const rows = Object.values(state.modules[params[0]] || {});
        return {
          rows: [{ total: rows.length, can_edit: rows.some((row) => row.pode_editar === true) }],
        };
      }
      if (text.includes("from empresa_usuario_modulos") && text.includes("modulo_key = $3")) {
        const row = (state.modules[params[1]] || {})[params[2]];
        return { rows: row ? [row] : [] };
      }
      if (text.includes("from empresa_usuario_modulos")) {
        const configured = Object.keys(state.modules[params[1]] || {}).length > 0;
        return { rows: configured ? [{ "?column?": 1 }] : [] };
      }
      throw new Error(`consulta inesperada: ${text}`);
    },
  };
}

function loadAccessService(state) {
  const servicePath = require.resolve("../services/companyAccessService");
  delete require.cache[servicePath];
  const originalLoad = Module._load;
  Module._load = function mockDb(request, parent, isMain) {
    if (request === "../db/db") return createDbMock(state);
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require("../services/companyAccessService");
  } finally {
    Module._load = originalLoad;
  }
}

function readOnlyState() {
  return {
    users: { 35: { nivel: "usuario", status: "ativo" }, 1: { nivel: "administrador", status: "ativo" } },
    modules: {
      35: {
        "ml.operacao.validar_dimensoes": { pode_acessar: true, pode_editar: false },
        "ml.promocoes.criar": { pode_acessar: true, pode_editar: false },
      },
    },
  };
}

async function withApp(configure, run) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { uid: Number(req.get("x-user") || 35), nivel: "" };
    res.locals.empresaId = 16;
    next();
  });
  configure(app);
  app.use((req, res) => res.status(200).json({ ok: true, reached: req.path }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, url, body, user) => fetch(base + url, {
      method,
      headers: { "content-type": "application/json", accept: "application/json", "x-user": String(user || 35) },
      body: body ? JSON.stringify(body) : undefined,
    });
    await run(call);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("requireEditForWrites so verifica escrita e respeita consultas e chaves por caminho", async () => {
  const calls = [];
  const { requireEditForWrites } = loadAccessService(readOnlyState());
  const guard = requireEditForWrites("ml.promocoes.criar", {
    readOnlyPaths: ["/credits/quote", "/promotions/:promotionId/export-ml-excel"],
    moduleByPath: [["/jobs/remove", "ml.promocoes.remover"]],
    accessFactory: (key, options) => (req, res, next) => {
      calls.push({ key, options, path: req.path });
      return res.status(403).json({ denied: key });
    },
  });
  await withApp((app) => app.use("/api/promocoes", guard), async (call) => {
    assert.equal((await call("GET", "/api/promocoes/promotions")).status, 200);
    assert.equal((await call("POST", "/api/promocoes/credits/quote", {})).status, 200);
    assert.equal((await call("POST", "/api/promocoes/promotions/P-1/export-ml-excel", {})).status, 200);
    assert.equal((await call("POST", "/api/promocoes/apply", {})).status, 403);
    assert.equal((await call("DELETE", "/api/promocoes/promotions/P-1")).status, 403);
    assert.equal((await call("POST", "/api/promocoes/jobs/remove", {})).status, 403);
  });
  assert.deepEqual(calls.map((row) => row.key), [
    "ml.promocoes.criar",
    "ml.promocoes.criar",
    "ml.promocoes.remover",
  ]);
  assert.ok(calls.every((row) => row.options.edit === true && row.options.defaultAllowIfUnconfigured === true));
});

test("trava real nega escrita sem Editar e libera admin, quem pode editar e usuario sem configuracao", async () => {
  const state = readOnlyState();
  const { requireEditForWrites } = loadAccessService(state);
  const guard = requireEditForWrites("ml.promocoes.criar");
  await withApp((app) => app.use("/api/promocoes", guard), async (call) => {
    const denied = await call("POST", "/api/promocoes/apply", {});
    assert.equal(denied.status, 403);
    assert.match((await denied.json()).error, /permissao de edicao/);
    assert.equal((await call("POST", "/api/promocoes/apply", {}, 1)).status, 200, "admin passa");
    assert.equal((await call("GET", "/api/promocoes/promotions")).status, 200, "leitura passa");
  });

  state.modules[35]["ml.promocoes.criar"].pode_editar = true;
  await withApp((app) => app.use("/api/promocoes", guard), async (call) => {
    assert.equal((await call("POST", "/api/promocoes/apply", {})).status, 200, "com Editar passa");
  });

  state.modules[35] = {};
  await withApp((app) => app.use("/api/promocoes", guard), async (call) => {
    assert.equal((await call("POST", "/api/promocoes/apply", {})).status, 200, "sem configuracao segue liberado");
  });
});

test("validar dimensoes bloqueia correcao e libera apenas a analise", async () => {
  const state = readOnlyState();
  const access = loadAccessService(state);
  const routePath = require.resolve("../routes/validarDimensoesRoutes");
  delete require.cache[routePath];
  const originalLoad = Module._load;
  const passThrough = () => (_req, _res, next) => next();
  Module._load = function mockRouteDependencies(request, parent, isMain) {
    if (request === "../services/companyAccessService") return access;
    if (request === "../middleware/auditAction") return { createAuditAction: passThrough };
    if (request === "../services/singleOperationGuardService") {
      return { guardSingleOperation: passThrough, requireSingleMlb: passThrough };
    }
    if (request === "../controllers/ValidarDimensoesController") {
      return new Proxy({}, { get: () => (req, res) => res.json({ ok: true, controller: req.path }) });
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  let router;
  try {
    router = require("../routes/validarDimensoesRoutes");
  } finally {
    Module._load = originalLoad;
  }

  await withApp((app) => app.use("/api/validar-dimensoes", router), async (call) => {
    const base = "/api/validar-dimensoes";
    assert.equal((await call("POST", `${base}/analisar-item`, { mlb: "MLB1" })).status, 200);
    assert.equal((await call("POST", `${base}/jobs`, { mlbs: ["MLB1"], mode: "analyze" })).status, 200);
    assert.equal((await call("POST", `${base}/credits/quote`, {})).status, 200);
    assert.equal((await call("POST", `${base}/analisar-item`, { mlb: "MLB1", fill_dimensions: { height: 1 } })).status, 403);
    assert.equal((await call("POST", `${base}/analisar-item`, { mlb: "MLB1", autofill_from_item: true })).status, 403);
    assert.equal((await call("POST", `${base}/jobs`, { mlbs: ["MLB1"], mode: "auto" })).status, 403);
    assert.equal((await call("POST", `${base}/jobs`, { mlbs: ["MLB1"], force_overwrite: true })).status, 403);
  });
});

test("requireWriterUser barra somente leitura e libera quem edita algum modulo", async () => {
  const state = readOnlyState();
  const { requireWriterUser, isReadOnlyCompanyUser } = loadAccessService(state);
  assert.equal(await isReadOnlyCompanyUser(35, 16), true);
  await withApp((app) => app.post("/api/meli/oauth/start", requireWriterUser()), async (call) => {
    assert.equal((await call("POST", "/api/meli/oauth/start", {})).status, 403);
    assert.equal((await call("POST", "/api/meli/oauth/start", {}, 1)).status, 200, "admin passa");
  });
  state.modules[35]["ml.promocoes.criar"].pode_editar = true;
  assert.equal(await isReadOnlyCompanyUser(35, 16), false);
  state.modules[35] = {};
  assert.equal(await isReadOnlyCompanyUser(35, 16), false, "sem configuracao nao e somente leitura");
});

test("owner e operador seguem o mesmo fluxo; so administrador passa direto", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "routes", "mercadolivreRankingRoutes.js"), "utf8");
  const start = source.indexOf("async function canManageRankingConfig");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  assert.ok(start > 0, "canManageRankingConfig deve existir");
  assert.doesNotMatch(body, /owner|papel/, "papel na empresa nao pode liberar a configuracao");
  assert.match(body, /isAdminUserFresh\(req\)/);
  assert.match(body, /moduleKey: "ml\.anuncios\.ranking"/);
  assert.match(body, /edit: true/);

  // requireModuleAccess so tem atalho para o nivel de administrador do usuario.
  const access = fs.readFileSync(path.join(__dirname, "..", "services", "companyAccessService.js"), "utf8");
  const guard = access.slice(access.indexOf("function requireModuleAccess"), access.indexOf("const WRITE_METHODS"));
  assert.doesNotMatch(guard, /papel|owner/);
});

test("todo modulo com escrita via API instala a trava de edicao", () => {
  const read = (name) => fs.readFileSync(path.join(__dirname, "..", "routes", name), "utf8");
  const expected = {
    "promocoesRoutes.js": ['"/api/promocoes"', 'requireEditForWrites("ml.promocoes.criar"', '"ml.promocoes.remover"'],
    "removerPromocaoRoutes.js": ['requireEditForWrites("ml.promocoes.remover")'],
    "publicidadeRoutes.js": ['requireEditForWrites("ml.publicidade.product_ads")'],
    "estoqueAlertaRoutes.js": ['requireEditForWrites("ml.anuncios.estoque"'],
    "prazoProducaoRoutes.js": ['requireEditForWrites("ml.operacao.prazo")', '"/anuncios/prazo-dias-lote"'],
    "clonarAnuncioRoutes.js": ['requireEditForWrites("ml.anuncios.clonar"'],
    "validarDimensoesRoutes.js": ['requireEditForWrites("ml.operacao.validar_dimensoes"'],
    "fullRoutes.js": ['requireEditForWrites("ml.anuncios.full"'],
    "estrategicosRoutes.js": ['requireEditForWrites("ml.anuncios.estrategicos"'],
    "financeiroMlRoutes.js": ['requireEditForWrites("ml.precificacao.margem"'],
    "fiscalRoutes.js": ['requireEditForWrites("ml.pedidos.logistica"'],
    "mercadolivreRankingRoutes.js": ['requireEditForWrites("ml.anuncios.ranking")'],
    "meliOAuthRoutes.js": ["requireWriterUser()"],
  };
  for (const [file, snippets] of Object.entries(expected)) {
    const source = read(file);
    for (const snippet of snippets) assert.ok(source.includes(snippet), `${file} deve conter ${snippet}`);
  }
  // A trava precisa vir antes das rotas do arquivo (router.use no topo).
  for (const file of ["publicidadeRoutes.js", "estoqueAlertaRoutes.js", "clonarAnuncioRoutes.js", "fullRoutes.js", "estrategicosRoutes.js", "fiscalRoutes.js"]) {
    const source = read(file);
    const guardAt = source.indexOf("requireEditForWrites(");
    const firstWrite = source.search(/router\.(post|put|patch|delete)\(/);
    assert.ok(guardAt > 0 && guardAt < firstWrite, `${file}: trava antes da primeira rota de escrita`);
  }
});
