"use strict";

// SKU Leader, Tracking e DavanttiLog foram retirados da oferta (09/11/2026): somem da seleção para todos.
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSellerPortalService, RETIRED_MODULES } = require("../apps/gateway/services/sellerPortalService");

const root = path.resolve(__dirname, "..");

test("visão geral do portal tira os módulos retirados (contratados ou disponíveis) e refaz as contagens", async () => {
  const modules = [
    { slug: "ml", installed: true }, { slug: "magalu", installed: true }, { slug: "tracking", installed: true },
    { slug: "shopee", installed: false }, { slug: "davanttilog", installed: false }, { slug: "skuleader", installed: false },
  ];
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({
    ok: true, modules, alerts: [{ module: "tracking", text: "x" }, { module: "ml", text: "y" }],
    summary: { installed_modules: 3, available_modules: 3, active_accounts: 2 },
  }) });
  const portal = createSellerPortalService({ baseUrl: "https://acessos", internalToken: "tok", fetchImpl });
  const { payload } = await portal.overview({ tenant_id: "t1", user_id: "u1" });
  assert.deepEqual(payload.modules.map((m) => m.slug), ["ml", "magalu", "shopee"]);
  assert.deepEqual(payload.alerts.map((a) => a.module), ["ml"]);
  assert.deepEqual(payload.summary, { installed_modules: 2, available_modules: 1, active_accounts: 2 });
  assert.deepEqual([...RETIRED_MODULES].sort(), ["davanttilog", "skuleader", "tracking"]);
});

test("login da suíte e tela da seleção não carregam mais os módulos retirados", () => {
  const auth = fs.readFileSync(path.join(root, "routes/suiteAuthRoutes.js"), "utf8");
  const matrix = auth.slice(auth.indexOf("const MODULE_MATRIX"), auth.indexOf("];", auth.indexOf("const MODULE_MATRIX")));
  assert.doesNotMatch(matrix, /tracking|davanttilog|skuleader/);
  // O Hub ainda pode devolver os slugs (e apelidos antigos): são descartados antes de entrar na sessão.
  assert.match(auth, /if \(RETIRED_SUITE_MODULES\.has\(normalized\)\) return null;/);
  for (const slug of ["tracking", "rastreio", "avantracking", "davanttilog", "logisync", "skuleader"]) {
    assert.match(auth.slice(auth.indexOf("const RETIRED_SUITE_MODULES"), auth.indexOf("]);", auth.indexOf("const RETIRED_SUITE_MODULES"))), new RegExp(`"${slug}"`));
  }
  const candidates = auth.slice(auth.indexOf("const HUB_AUTH_MODULE_CANDIDATES"), auth.indexOf("];", auth.indexOf("const HUB_AUTH_MODULE_CANDIDATES")));
  assert.doesNotMatch(candidates, /tracking|davanttilog|skuleader/);
  // Sem login legado direto nos apps retirados.
  assert.doesNotMatch(auth, /\/avantracking\/api|\/davanttilog\/api|\/skuleader\/api/);
  const page = fs.readFileSync(path.join(root, "apps/seller-ml/views/selecao-plataforma.html"), "utf8");
  assert.doesNotMatch(page, /\/go\/tracking|\/go\/davanttilog|\/go\/skuleader/);
});
