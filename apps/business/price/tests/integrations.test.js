"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createLinkToken, isLinkUsable, publicLinkState, authorizationLinkRecord } = require("../src/integrations/authorizationLink");
const { selectConnectionId } = require("../src/integrations/tokenStore");
const { integrationsRouter } = require("../src/routes/integrations.routes");

test("link OAuth usa token opaco e expira em quinze minutos", () => {
  const link = createLinkToken(new Date("2026-08-17T12:00:00Z"));
  assert.match(link.token, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(link.token, link.tokenHash);
  assert.equal(link.expiresAt.toISOString(), "2026-08-17T12:15:00.000Z");
});

test("estado publico do link nao revela hash e identifica expiração", () => {
  const link = { expires_at: "2026-08-17T12:15:00Z", used_at: null, cancelled_at: null, token_hash: "secret-hash" };
  assert.equal(isLinkUsable(link, new Date("2026-08-17T12:14:59Z")), true);
  assert.deepEqual(publicLinkState(link, new Date("2026-08-17T12:15:00Z")), { status: "expired" });
});

test("link OAuth em autorização não pode iniciar um segundo fluxo", () => {
  const link = { expires_at: "2026-08-17T12:15:00Z", opened_at: "2026-08-17T12:01:00Z", used_at: null, cancelled_at: null };
  assert.equal(isLinkUsable(link, new Date("2026-08-17T12:02:00Z")), false);
  assert.deepEqual(publicLinkState(link, new Date("2026-08-17T12:02:00Z")), { status: "in_progress" });
});

test("registro de link OAuth guarda apenas o hash e campos seguros do tenant", () => {
  const record = authorizationLinkRecord({
    tokenHash: "stored-hash",
    tenantId: "tenant-1",
    channel: "meli",
    userId: "user-1",
    expiresAt: new Date("2026-08-17T12:15:00Z"),
    supportReason: "Conta da operacao",
  });
  assert.deepEqual(record, {
    token_hash: "stored-hash",
    tenant_id: "tenant-1",
    channel: "meli",
    created_by_user_id: "user-1",
    expires_at: new Date("2026-08-17T12:15:00Z"),
    support_reason: "Conta da operacao",
  });
  assert.equal("token" in record, false);
});

test("conta única é selecionada quando a requisição não informa um id", () => {
  assert.equal(selectConnectionId(null, [{ id: "meli-1" }]), "meli-1");
});

test("contas múltiplas exigem uma seleção explícita", () => {
  assert.throws(
    () => selectConnectionId(null, [{ id: "meli-1" }, { id: "meli-2" }]),
    (error) => error.code === "connection_selection_required" && error.statusCode === 409,
  );
});

test("rotas de integrações expõem CRUD por conta e autorização por link", () => {
  const routes = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "integrations.routes.js"), "utf8");
  assert.match(routes, /router\.get\("\/:channel\/accounts"/);
  assert.match(routes, /router\.patch\("\/:connectionId"/);
  assert.match(routes, /router\.post\("\/:connectionId\/disconnect"/);
  assert.match(routes, /router\.post\("\/:channel\/links"/);
  assert.match(routes, /router\.get\("\/link\/:token"/);
  assert.match(routes, /router\.post\("\/link\/:token\/continue"/);
  assert.match(routes, /tenant_required/);
});

test("página pública de OAuth usa a identidade visual do VoltPrice", () => {
  const routes = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "integrations.routes.js"), "utf8");
  assert.match(routes, /vp-public-shell/);
  assert.match(routes, /Conexão segura/);
  assert.match(routes, /vp-public-continue/);
});

test("router despacha disconnect legado nas rotas estáticas antes da conta por id", () => {
  const routes = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "integrations.routes.js"), "utf8");
  assert.match(routes, /router\.post\("\/:connectionId\/refresh"/);
  const matchingPostPaths = (pathname) => integrationsRouter.stack
    .filter((layer) => layer.route?.methods.post && layer.match(pathname))
    .map((layer) => layer.route.path);
  for (const channel of ["tray", "meli", "shopee"]) {
    assert.equal(matchingPostPaths(`/${channel}/disconnect`)[0], `/${channel}/disconnect`);
  }
  assert.equal(integrationsRouter.stack.some((layer) => layer.route?.path === "/:channel/disconnect"), false);
  assert.ok(integrationsRouter.stack.some((layer) => layer.route?.path === "/:connectionId/disconnect"));
});

test("router despacha refresh legado nas rotas estáticas antes da conta por id", () => {
  const matchingPostPaths = (pathname) => integrationsRouter.stack
    .filter((layer) => layer.route?.methods.post && layer.match(pathname))
    .map((layer) => layer.route.path);
  for (const channel of ["tray", "meli", "shopee"]) {
    assert.equal(matchingPostPaths(`/${channel}/refresh`)[0], `/${channel}/refresh`);
  }
  assert.equal(integrationsRouter.stack.some((layer) => layer.route?.path === "/:channel/refresh"), false);
  assert.ok(integrationsRouter.stack.some((layer) => layer.route?.path === "/:connectionId/refresh"));
});
