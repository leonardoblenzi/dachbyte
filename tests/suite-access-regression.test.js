"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("redirecionamento consulta o Hub para sessoes nao legadas", () => {
  const server = source("apps/gateway/server.js");
  assert.match(
    server,
    /isLegacySuitePayload\(payload\)\s*&&\s*!hasSessionModuleReference\(payload, moduleId\)/,
  );
  assert.match(server, /await checkSuiteModuleAccess\(payload, moduleId\)/);
});

test("consulta de sessao persiste os acessos atualizados no cookie", () => {
  const routes = source(path.join("routes", "suiteAuthRoutes.js"));
  assert.match(routes, /function refreshSuiteAuthCookie/);
  assert.match(routes, /res\.cookie\("suite_auth_token", token, authCookieOptions\(\)\)/);
  assert.match(routes, /refreshSuiteAuthCookie\(res, payload, effectiveRefresh\)/);
});

test("master recebe somente os modulos retornados pelo Hub", () => {
  const routes = source(path.join("routes", "suiteAuthRoutes.js"));
  assert.match(
    routes,
    /const effectiveAllowedModules = subscription\.active \? effectiveVisibleModules : \[\];/,
  );
  assert.match(
    routes,
    /const allowedModules = subscription\.active\s*\? isMaster\s*\? visibleModules/,
  );
  assert.doesNotMatch(
    routes,
    /const allowedModules = isMaster\s*\? MODULE_MATRIX\.map\(\(item\) => item\.id\)/,
  );
});

test("operador interno do Hub recebe identidade de suite sem tenant comercial", () => {
  const routes = source(path.join("routes", "suiteAuthRoutes.js"));
  assert.match(routes, /function isPlatformIdentityPayload/);
  assert.match(routes, /context === "platform"/);
  assert.match(routes, /`platform-\$\{userId\}`/);
  assert.match(routes, /if \(isPlatformIdentityPayload\(payload\)\) return true;/);
});

test("renovacao de sessao usa os modulos do Hub para masters internos", () => {
  const routes = source(path.join("routes", "suiteAuthRoutes.js"));
  assert.match(routes, /const HUB_AUTH_MODULE_CANDIDATES = \[/);
  assert.match(routes, /for \(const moduleName of HUB_AUTH_MODULE_CANDIDATES\)/);
  assert.match(routes, /const result = await resolveGlobalIdentityByEmail\(email\);/);
});

test("bootstrap da Shopee exige senha de administrador configurada no ambiente", () => {
  const seedAdmin = source(path.join("apps", "seller-shopee", "scripts", "seed-admin.js"));
  assert.match(seedAdmin, /SUPER_ADMIN_PASSWORD obrigatoria/);
  assert.doesNotMatch(seedAdmin, /SUPER_ADMIN_PASSWORD\s*\|\|\s*["'][^"']+/);
});

test("Rastreio usa o Hub para sessoes atuais e normaliza a identidade", () => {
  const tracking = source(
    path.join("apps", "seller-tracking", "server", "src", "controllers", "userController.ts"),
  );
  assert.match(
    tracking,
    /isLegacySuitePayload\(suitePayload\)\s*&&\s*!hasSuiteTrackingAccess\(suitePayload\)/,
  );
  assert.match(
    tracking,
    /"userGlobalId"\s*=\s*COALESCE\(NULLIF\(\$4, ''\), "userGlobalId"\)/,
  );
});

test("modulos revalidam liberacao em cinco minutos e bloqueio em trinta segundos", () => {
  const gateSources = [
    source(path.join("apps", "seller-ml", "app.js")),
    source(path.join("apps", "seller-shopee", "src", "middlewares", "sessionAuth.js")),
    source(path.join("apps", "seller-tracking", "server", "src", "middleware", "auth.ts")),
  ];

  for (const gateSource of gateSources) {
    assert.match(
      gateSource,
      /HUB_BILLING_ALLOW_TTL_MS\s*\|\|\s*5\s*\*\s*60\s*\*\s*1000/,
    );
    assert.match(
      gateSource,
      /HUB_BILLING_DENY_TTL_MS\s*\|\|\s*30\s*\*\s*1000/,
    );
  }
});
