"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Magalu callback is owned by seller-magalu and OAuth start stays behind suite auth", () => {
  const app = read("apps/seller-magalu/src/app.js");
  const publicRoutes = read("apps/seller-magalu/src/routes/public.routes.js");
  const protectedRoutes = read("apps/seller-magalu/src/routes/index.js");
  assert.match(app, /app\.use\(publicRoutes\)[\s\S]+app\.use\(suiteAuth\)[\s\S]+app\.use\(protectedRoutes\)/);
  assert.match(publicRoutes, /router\.get\("\/auth\/callback",\s*oauthController\.callback\)/);
  assert.match(protectedRoutes, /\/auth\/start/);
});

test("OAuth uses choose_tenants, official ID Magalu endpoints and canonical env names", () => {
  const protocol = read("apps/seller-magalu/src/services/magaluOAuthProtocol.js");
  const env = read("apps/seller-magalu/src/config/env.js");
  assert.match(protocol, /choose_tenants/);
  assert.match(protocol, /authorization_code/);
  assert.match(protocol, /refresh_token/);
  assert.match(env, /https:\/\/id\.magalu\.com\/login/);
  assert.match(env, /https:\/\/id\.magalu\.com\/oauth\/token/);
  assert.match(env, /process\.env\.MAGALU_OAUTH_CLIENT_ID/);
  assert.match(env, /process\.env\.MAGALU_OAUTH_CLIENT_SECRET/);
  assert.match(env, /process\.env\.MAGALU_OAUTH_REDIRECT_URI/);
  assert.doesNotMatch(env, /process\.env\.MAGALU_CLIENT_(?:ID|SECRET)/);
  assert.doesNotMatch(env, /process\.env\.MAGALU_REDIRECT_URI/);
});

test("OAuth state is stored hashed and tokens remain encrypted", () => {
  const controller = read("apps/seller-magalu/src/controllers/oauthController.js");
  const repository = read("apps/seller-magalu/src/repositories/oauthStateRepository.js");
  const tokenRepo = read("apps/seller-magalu/src/repositories/tokenRepository.js");
  assert.match(controller, /hashOAuthState/);
  assert.match(controller, /httpOnly:\s*true/);
  assert.match(repository, /state_hash/);
  assert.match(repository, /used_at is null/);
  assert.match(tokenRepo, /encryptSecret\(accessToken\)/);
  assert.match(tokenRepo, /encryptSecret\(refreshToken\)/);
});

test("Magalu tenant ownership is globally unique and OAuth rejects cross-DACH relinking", () => {
  const migration = read("apps/seller-magalu/db/migrations/001_foundation.sql");
  const accounts = read("apps/seller-magalu/src/repositories/accountRepository.js");
  assert.match(migration, /constraint uq_magalu_accounts_magalu_tenant unique \(magalu_tenant_id\)/i);
  assert.match(migration, /one Magalu tenant can belong to only one DACH tenant at a time/i);
  assert.match(accounts, /String\(existing\.dach_tenant_id\) !== String\(dachTenantId\)/);
  assert.match(accounts, /MAGALU_TENANT_ALREADY_LINKED/);
});

test("token refresh processor is isolated in magalu queue", () => {
  const queue = read("apps/seller-magalu/src/queues/magaluQueue.js");
  const worker = read("apps/seller-magalu/src/jobs/tokenRefresh.worker.js");
  assert.match(queue, /magalu-token-refresh-/);
  assert.doesNotMatch(queue, /jobId:\s*`[^`]*:/);
  assert.match(worker, /queueNames\.tokenRefresh/);
  assert.match(worker, /refreshAccount/);
});

test("OAuth callback revalidates DACH identity and fresh Hub access before exchanging code", () => {
  const controller = read("apps/seller-magalu/src/controllers/oauthController.js");
  const revalidate = controller.indexOf("await revalidateCallbackAccess(req, stateRecord)");
  const exchange = controller.indexOf("await finishAuthorization({ stateRecord, code })");

  assert.ok(revalidate >= 0, "callback must revalidate the DACH session");
  assert.ok(exchange > revalidate, "Hub/session revalidation must happen before code exchange");
  assert.match(controller, /String\(session\.identity\.dachTenantId\)[\s\S]*stateRecord\.dach_tenant_id/);
  assert.match(controller, /String\(session\.identity\.dachUserId\)[\s\S]*stateRecord\.dach_user_id/);
  assert.match(controller, /checkHubAccess\(session\.identity, \{ force: true, action: "ACCESS magalu" \}\)/);
});

test("OAuth account ownership race maps PostgreSQL 23505 to the same functional 409 conflict", () => {
  const source = read("apps/seller-magalu/src/repositories/accountRepository.js");
  assert.match(source, /savepoint magalu_account_insert/i);
  assert.match(source, /String\(error\?\.code \|\| ""\) !== "23505"/);
  assert.match(source, /rollback to savepoint magalu_account_insert/i);
  assert.match(source, /if \(String\(raced\.dach_tenant_id\) !== String\(dachTenantId\)\) throw ownershipConflict\(\)/);
  assert.match(source, /error\.status = 409/);
});

test("Hub audit action is canonicalized as ACCESS magalu", () => {
  const source = read("apps/seller-magalu/src/services/hubAccessService.js");
  const middleware = read("apps/seller-magalu/src/middlewares/suiteAuth.js");
  assert.match(source, /DEFAULT_ACTION = "ACCESS magalu"/);
  assert.match(middleware, /checkHubAccess\(session\.identity, \{ action: "ACCESS magalu" \}\)/);
  assert.doesNotMatch(source, /ACCESS seller-magalu/);
  assert.doesNotMatch(middleware, /ACCESS seller-magalu/);
});
