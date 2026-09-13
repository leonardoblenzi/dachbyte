"use strict";

const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const express = require("express");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const authPath = path.join(__dirname, "..", "src", "auth.js");
const db = require("../src/db");
const { config } = require("../src/config");
const { sha256 } = require("../src/crypto");

function invoke(middleware, req) {
  return new Promise((resolve) => middleware(req, {}, resolve));
}

function response() {
  return {
    cookieCalls: [],
    body: null,
    cookie(...args) { this.cookieCalls.push(args); return this; },
    json(body) { this.body = body; return this; },
  };
}

async function withPasswordChangeDatabase(run) {
  const originalWithClient = db.withClient;
  const originalQueries = [];
  const currentHash = await bcrypt.hash("Current password 123", 4);
  let updatedHash = null;

  db.withClient = async (handler) => handler({
    query: async (text, params = []) => {
      originalQueries.push({ text, params });
      if (/SELECT id,email,full_name,password_hash,must_change_password/.test(text)) {
        return { rows: [{ id: "user-1", email: "user@example.com", full_name: "User", password_hash: currentHash, must_change_password: true }] };
      }
      if (/UPDATE volt_price.users SET password_hash/.test(text)) {
        updatedHash = params[1];
        return { rows: [] };
      }
      if (/INSERT INTO volt_price.sessions/.test(text)) return { rows: [{ id: "fresh-session" }] };
      return { rows: [] };
    },
  });

  delete require.cache[require.resolve(authPath)];
  try {
    return await run({ auth: require(authPath), currentHash, queries: originalQueries, getUpdatedHash: () => updatedHash });
  } finally {
    db.withClient = originalWithClient;
    delete require.cache[require.resolve(authPath)];
  }
}

function httpRequest(server, { method, path: requestPath, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ port: server.address().port, method, path: requestPath, headers }, (response) => {
      let payload = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { payload += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: payload ? JSON.parse(payload) : null }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function withAuthApp(run) {
  const originals = { query: db.query, withClient: db.withClient, withTenant: db.withTenant };
  const passwordHash = await bcrypt.hash("Temporary password 123", 4);
  let passwordChanged = false;
  let csrfHash = sha256("csrf-token");
  const sessionRow = (platformRole = null) => ({
    session_id: "session-1", tenant_id: platformRole ? null : "tenant-1", user_id: platformRole ? "master-1" : "user-1", csrf_hash: csrfHash, support_reason: null,
    email: platformRole ? "master@example.com" : "user@example.com", full_name: platformRole ? "Master" : "User", user_status: "active", must_change_password: !passwordChanged,
    platform_role: platformRole, tenant_role: platformRole ? null : "owner", membership_status: "active", tenant_name: platformRole ? null : "Workspace", tenant_slug: platformRole ? null : "workspace", tenant_status: "active",
  });
  let activePlatformRole = null;
  db.query = async (text, params = []) => {
    if (/FROM volt_price.users u/.test(text)) {
      activePlatformRole = params[0] === "master@example.com" ? "platform_super_admin" : null;
      return { rows: [{ id: activePlatformRole ? "master-1" : "user-1", email: params[0], full_name: activePlatformRole ? "Master" : "User", password_hash: passwordHash, status: "active", must_change_password: !passwordChanged, platform_role: activePlatformRole }] };
    }
    if (/FROM volt_price.sessions s/.test(text)) return { rows: [sessionRow(activePlatformRole)] };
    if (/FROM volt_price.memberships m/.test(text)) return { rows: activePlatformRole ? [] : [{ tenant_id: "tenant-1", role: "owner", name: "Workspace", slug: "workspace" }] };
    if (/UPDATE volt_price.sessions SET csrf_hash/.test(text)) { csrfHash = params[1]; return { rows: [] }; }
    return { rows: [] };
  };
  const client = {
    query: async (text, params = []) => {
      if (/SELECT id,email,full_name,password_hash,must_change_password/.test(text)) return { rows: [{ id: "user-1", email: "user@example.com", full_name: "User", password_hash: passwordHash, must_change_password: !passwordChanged }] };
      if (/UPDATE volt_price.users SET password_hash/.test(text)) { passwordChanged = true; return { rows: [] }; }
      if (/INSERT INTO volt_price.sessions/.test(text)) return { rows: [{ id: "fresh-session" }] };
      if (/count\(\*\)::int count/.test(text)) return { rows: [{ count: 0 }] };
      if (/max\(last_sync_at\)/.test(text)) return { rows: [{ last_sync: null }] };
      return { rows: [] };
    },
  };
  db.withClient = async (handler) => handler(client);
  db.withTenant = async (_tenantId, _userId, handler) => handler(client);
  const routePaths = ["../src/auth", "../src/routes/auth.routes", "../src/routes/dashboard.routes", "../src/routes/admin.routes"];
  for (const routePath of routePaths) delete require.cache[require.resolve(routePath)];
  try {
    const { authRouter } = require("../src/routes/auth.routes");
    const { dashboardRouter } = require("../src/routes/dashboard.routes");
    const { adminRouter } = require("../src/routes/admin.routes");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.cookies = Object.fromEntries(String(req.headers.cookie || "").split(";").filter(Boolean).map((part) => part.trim().split("="))); next(); });
    app.use("/api/auth", authRouter);
    app.use("/api/dashboard", dashboardRouter);
    app.use("/api/admin", adminRouter);
    app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ success: false, error: error.code || "internal_error", message: error.message }));
    const server = await new Promise((resolve) => { const listening = app.listen(0, () => resolve(listening)); });
    try { await run(server); } finally { await new Promise((resolve) => server.close(resolve)); }
  } finally {
    db.query = originals.query; db.withClient = originals.withClient; db.withTenant = originals.withTenant;
    for (const routePath of routePaths) delete require.cache[require.resolve(routePath)];
  }
}

test("password change guard blocks pending tenant and Platform Master sessions", async () => {
  const auth = require(authPath);

  for (const vpAuth of [
    { isPlatformAdmin: false, passwordChangeRequired: true },
    { isPlatformAdmin: true, passwordChangeRequired: true },
  ]) {
    const error = await invoke(auth.requirePasswordChangeComplete, { vpAuth });
    assert.equal(error?.statusCode, 403);
    assert.equal(error?.code, "password_change_required");
  }
});

test("password change rejects absent or invalid CSRF tokens", async () => {
  const auth = require(authPath);
  const req = { method: "POST", vpAuth: { csrfHash: sha256("expected-token") }, headers: {} };

  const missing = await invoke(auth.requireCsrf, req);
  assert.equal(missing?.code, "csrf_invalid");

  req.headers["x-csrf-token"] = "wrong-token";
  const invalid = await invoke(auth.requireCsrf, req);
  assert.equal(invalid?.code, "csrf_invalid");
});

test("password change public user keeps tenant context only for a non-global session", () => {
  const { authUser } = require(authPath);
  const globalMaster = authUser({
    userId: "master-1", email: "master@example.com", fullName: "Master", role: "platform_super_admin",
    isPlatformAdmin: true, tenantId: null, tenantName: null, tenantSlug: null, supportReason: null,
    passwordChangeRequired: true,
  });
  const tenantUser = authUser({
    userId: "user-1", email: "user@example.com", fullName: "User", role: "owner",
    isPlatformAdmin: false, tenantId: "tenant-1", tenantName: "Workspace", tenantSlug: "workspace", supportReason: null,
    passwordChangeRequired: false,
  });

  assert.equal(globalMaster.isPlatformAdmin, true);
  assert.equal(globalMaster.tenantId, null);
  assert.equal(globalMaster.tenantName, null);
  assert.equal(globalMaster.passwordChangeRequired, true);
  assert.equal(tenantUser.tenantId, "tenant-1");
  assert.equal(tenantUser.tenantName, "Workspace");
  assert.equal(tenantUser.tenantSlug, "workspace");
});

test("password change applies the production bootstrap password minimum", () => {
  const { validatePasswordForChange } = require(authPath);

  assert.throws(
    () => validatePasswordForChange("123456789012345", { isProduction: true }),
    (error) => error.code === "weak_password" && error.statusCode === 400,
  );
  assert.doesNotThrow(() => validatePasswordForChange("1234567890123456", { isProduction: true }));
});

test("password change route restricts temporary sessions and establishes a fresh protected session", async () => {
  await withAuthApp(async (server) => {
    const login = await httpRequest(server, { method: "POST", path: "/api/auth/login", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "user@example.com", password: "Temporary password 123" }) });
    const cookie = login.headers["set-cookie"][0].split(";", 1)[0];
    assert.equal(login.status, 200);
    assert.equal(login.body.user.passwordChangeRequired, true);
    assert.equal((await httpRequest(server, { method: "GET", path: "/api/auth/me", headers: { cookie } })).status, 200);
    const csrf = await httpRequest(server, { method: "GET", path: "/api/auth/csrf", headers: { cookie } });
    const tenantDenied = await httpRequest(server, { method: "GET", path: "/api/dashboard", headers: { cookie } });
    assert.equal(tenantDenied.status, 403);
    assert.equal(tenantDenied.body.error, "password_change_required");

    const missingCsrf = await httpRequest(server, { method: "POST", path: "/api/auth/change-password", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ currentPassword: "Temporary password 123", newPassword: "Replacement password 456" }) });
    assert.equal(missingCsrf.status, 403);
    assert.equal(missingCsrf.body.error, "csrf_invalid");
    const invalidCsrf = await httpRequest(server, { method: "POST", path: "/api/auth/change-password", headers: { cookie, "x-csrf-token": "invalid-token", "content-type": "application/json" }, body: JSON.stringify({ currentPassword: "Temporary password 123", newPassword: "Replacement password 456" }) });
    assert.equal(invalidCsrf.status, 403);
    assert.equal(invalidCsrf.body.error, "csrf_invalid");
    const changed = await httpRequest(server, { method: "POST", path: "/api/auth/change-password", headers: { cookie, "x-csrf-token": csrf.body.csrfToken, "content-type": "application/json" }, body: JSON.stringify({ currentPassword: "Temporary password 123", newPassword: "Replacement password 456" }) });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.passwordChangeRequired, false);
    const freshCookie = changed.headers["set-cookie"][0].split(";", 1)[0];
    assert.equal((await httpRequest(server, { method: "GET", path: "/api/dashboard", headers: { cookie: freshCookie } })).status, 200);
  });
});

test("password change guard blocks a pending Platform Master route", async () => {
  await withAuthApp(async (server) => {
    const login = await httpRequest(server, { method: "POST", path: "/api/auth/login", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "master@example.com", password: "Temporary password 123" }) });
    const cookie = login.headers["set-cookie"][0].split(";", 1)[0];
    const denied = await httpRequest(server, { method: "GET", path: "/api/admin/tenants", headers: { cookie } });
    assert.equal(login.body.user.isPlatformAdmin, true);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, "password_change_required");
  });
});

test("password change rejects a replacement that violates the production password minimum", async () => {
  await withPasswordChangeDatabase(async ({ auth }) => {
    const req = {
      body: { currentPassword: "Current password 123", newPassword: "short" },
      vpAuth: { userId: "user-1", tenantId: "tenant-1", isPlatformAdmin: false },
      get: () => "test-agent",
    };

    await assert.rejects(
      () => auth.changePassword(req, response()),
      (error) => error.code === "weak_password" && error.statusCode === 400,
    );
  });
});

test("password change replaces credentials, revokes old sessions, and returns a fresh session", async () => {
  await withPasswordChangeDatabase(async ({ auth, currentHash, queries, getUpdatedHash }) => {
    const req = {
      body: { currentPassword: "Current password 123", newPassword: "Replacement password 456" },
      vpAuth: { userId: "user-1", tenantId: "tenant-1", isPlatformAdmin: false },
      ip: "203.0.113.8",
      get: () => "test-agent",
    };
    const res = response();

    await auth.changePassword(req, res);

    assert.equal(await bcrypt.compare("Current password 123", currentHash), true);
    assert.equal(await bcrypt.compare("Replacement password 456", getUpdatedHash()), true);
    assert.ok(queries.some(({ text, params }) => /DELETE FROM volt_price.sessions WHERE user_id=\$1/.test(text) && params[0] === "user-1"));
    assert.equal(res.cookieCalls.length, 1);
    assert.equal(res.cookieCalls[0][0], config.sessionCookie);
    assert.equal(res.body.success, true);
    assert.equal(res.body.passwordChangeRequired, false);
    assert.equal(res.body.user.passwordChangeRequired, false);
    assert.equal(typeof res.body.csrfToken, "string");
    assert.ok(res.body.csrfToken.length > 0);
  });
});

test("password change from a support session returns the new global Master context", async () => {
  await withPasswordChangeDatabase(async ({ auth }) => {
    const req = {
      body: { currentPassword: "Current password 123", newPassword: "Replacement password 456" },
      vpAuth: { userId: "user-1", tenantId: "tenant-1", tenantName: "Support tenant", tenantSlug: "support-tenant", supportReason: "support case", isPlatformAdmin: true, role: "platform_super_admin" },
      ip: "203.0.113.8",
      get: () => "test-agent",
    };
    const res = response();

    await auth.changePassword(req, res);

    assert.equal(res.body.user.isPlatformAdmin, true);
    assert.equal(res.body.user.tenantId, null);
    assert.equal(res.body.user.tenantName, null);
    assert.equal(res.body.user.tenantSlug, null);
    assert.equal(res.body.user.supportReason, null);
    assert.equal(res.body.user.tenant, null);
  });
});
