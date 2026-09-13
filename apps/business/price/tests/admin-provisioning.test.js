"use strict";

const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const test = require("node:test");

const { createAdminRouter, createProvisionUserHandler, createTenantHandler, createTenantUsersHandler, createIntegrationLinkHandler } = require("../src/routes/admin.routes");

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function request(body, tenantId = "tenant-1") {
  return {
    params: { tenantId },
    body,
    vpAuth: { userId: "master-1", isPlatformAdmin: true },
    ip: "203.0.113.8",
    get: () => "admin-provisioning-test",
  };
}

function provisionDb({ tenants = [{ id: "tenant-1", name: "Tenant 1", status: "active" }], users = [], memberships = [], sessions = [] } = {}) {
  const state = { tenants: structuredClone(tenants), users: structuredClone(users), memberships: structuredClone(memberships), sessions: structuredClone(sessions), audits: [] };
  const withPlatformAdmin = async (_actorId, work) => {
    const before = structuredClone(state);
    try { return await work(client); } catch (error) { Object.assign(state, before); throw error; }
  };
  const client = { query: async (text, params = []) => {
    if (/SELECT id FROM volt_price\.tenants/.test(text)) return { rows: state.tenants.filter((tenant) => tenant.id === params[0]) };
    if (/INSERT INTO volt_price\.users/.test(text)) {
      const [email, fullName, passwordHash] = params;
      let user = state.users.find((candidate) => candidate.email === email);
      if (user) Object.assign(user, { full_name: fullName, password_hash: passwordHash, status: "active", must_change_password: true });
      else { user = { id: `user-${state.users.length + 1}`, email, full_name: fullName, password_hash: passwordHash, status: "active", must_change_password: true }; state.users.push(user); }
      return { rows: [user] };
    }
    if (/SELECT tenant_id FROM volt_price\.memberships/.test(text)) return { rows: state.memberships.filter((membership) => membership.user_id === params[0] && membership.status === "active" && membership.tenant_id !== params[1]) };
    if (/INSERT INTO volt_price\.memberships/.test(text)) {
      const [tenantId, userId, role] = params;
      let membership = state.memberships.find((candidate) => candidate.tenant_id === tenantId && candidate.user_id === userId);
      if (membership) Object.assign(membership, { role, status: "active" });
      else { membership = { tenant_id: tenantId, user_id: userId, role, status: "active" }; state.memberships.push(membership); }
      return { rows: [membership] };
    }
    if (/DELETE FROM volt_price\.sessions/.test(text)) { state.sessions = state.sessions.filter((session) => session.user_id !== params[0]); return { rows: [] }; }
    throw new Error(`Unexpected query: ${text}`);
  } };
  return { state, withPlatformAdmin, client };
}

function provisionHandler(db) {
  return createProvisionUserHandler({
    withPlatformAdmin: db.withPlatformAdmin,
    audit: async (_client, event) => db.state.audits.push(event),
    hashPassword: async (password) => `hash:${password}`,
  });
}

async function invoke(handler, req) {
  const res = response();
  let error;
  await handler(req, res, (nextError) => { error = nextError; });
  return { res, error };
}

test("admin provisioning creates an active single-tenant user with a temporary password", async () => {
  const db = provisionDb();
  const { res, error } = await invoke(provisionHandler(db), request({ email: " USER@Company.com ", fullName: "User", role: "admin", temporaryPassword: "Temporary password 123" }));

  assert.equal(error, undefined);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { user: { id: "user-1", email: "user@company.com", fullName: "User", role: "admin", status: "active" }, mustChangePassword: true });
  assert.deepEqual(db.state.memberships, [{ tenant_id: "tenant-1", user_id: "user-1", role: "admin", status: "active" }]);
  assert.equal(db.state.users[0].password_hash, "hash:Temporary password 123");
  assert.equal(db.state.users[0].must_change_password, true);
  assert.deepEqual(db.state.audits, [{ tenantId: "tenant-1", actorUserId: "master-1", actorType: "platform_admin", action: "platform.user.provisioned", resourceType: "user", resourceId: "user-1", metadata: { role: "admin" }, ip: "203.0.113.8", userAgent: "admin-provisioning-test" }]);
  assert.equal(JSON.stringify(res.body).includes("Temporary password 123"), false);
});

test("Admin Master cria um link OAuth para tenant ativo sem expor token em auditoria", async () => {
  const audits = [];
  const handler = createIntegrationLinkHandler({
    withPlatformAdmin: async (_userId, work) => work({ query: async (text) => {
      if (/SELECT id,name,status FROM volt_price\.tenants/.test(text)) return { rows: [{ id: "tenant-1", name: "Empresa", status: "active" }] };
      throw new Error(`Unexpected query: ${text}`);
    } }),
    createAuthorizationLink: async () => ({ token: "raw-token-only-for-response", link: { id: "link-1", expires_at: "2026-08-17T12:15:00Z" } }),
    audit: async (_client, event) => audits.push(event),
    baseUrl: () => "https://volt.example",
  });
  const { res, error } = await invoke(handler, {
    ...request({ channel: "meli", reason: "Conta principal" }),
    params: { tenantId: "tenant-1" },
  });
  assert.equal(error, undefined);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { authorizationUrl: "https://volt.example/volt-price/api/integrations/link/raw-token-only-for-response", expiresAt: "2026-08-17T12:15:00Z" });
  assert.deepEqual(audits, [{ tenantId: "tenant-1", actorUserId: "master-1", actorType: "platform_admin", action: "integration.link.create", resourceType: "integration_authorization_link", resourceId: "link-1", metadata: { channel: "meli", reason: "Conta principal" }, ip: "203.0.113.8", userAgent: "admin-provisioning-test" }]);
  assert.equal(JSON.stringify(audits).includes("raw-token-only-for-response"), false);
});

test("admin provisioning rejects an active user assigned to another tenant without changing it", async () => {
  const db = provisionDb({
    users: [{ id: "user-9", email: "user@company.com", full_name: "Original", password_hash: "old", status: "active", must_change_password: false }],
    memberships: [{ tenant_id: "tenant-2", user_id: "user-9", role: "viewer", status: "active" }],
  });
  const { error } = await invoke(provisionHandler(db), request({ email: "user@company.com", fullName: "Changed", role: "admin", temporaryPassword: "Temporary password 123" }));

  assert.equal(error?.code, "active_membership_other_tenant");
  assert.equal(error?.statusCode, 409);
  assert.deepEqual(db.state.users[0], { id: "user-9", email: "user@company.com", full_name: "Original", password_hash: "old", status: "active", must_change_password: false });
  assert.deepEqual(db.state.memberships, [{ tenant_id: "tenant-2", user_id: "user-9", role: "viewer", status: "active" }]);
});

test("admin provisioning within the same tenant resets the temporary password and sessions", async () => {
  const db = provisionDb({
    users: [{ id: "user-1", email: "user@company.com", full_name: "User", password_hash: "old", status: "disabled", must_change_password: false }],
    memberships: [{ tenant_id: "tenant-1", user_id: "user-1", role: "viewer", status: "disabled" }],
    sessions: [{ id: "session-1", user_id: "user-1" }, { id: "session-2", user_id: "another-user" }],
  });
  const { res, error } = await invoke(provisionHandler(db), request({ email: "user@company.com", fullName: "Updated User", role: "finance", temporaryPassword: "Replacement password 456" }));

  assert.equal(error, undefined);
  assert.equal(res.statusCode, 201);
  assert.equal(db.state.users[0].password_hash, "hash:Replacement password 456");
  assert.equal(db.state.users[0].must_change_password, true);
  assert.deepEqual(db.state.memberships, [{ tenant_id: "tenant-1", user_id: "user-1", role: "finance", status: "active" }]);
  assert.deepEqual(db.state.sessions, [{ id: "session-2", user_id: "another-user" }]);
});

test("admin provisioning endpoint denies a tenant admin", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", createAdminRouter({
    authenticate: (req, _res, next) => { req.vpAuth = { userId: "tenant-admin-1", isPlatformAdmin: false, passwordChangeRequired: false }; next(); },
    requirePasswordChangeComplete: (_req, _res, next) => next(),
    requireCsrf: (_req, _res, next) => next(),
  }));
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.code || "internal_error" }));
  const server = await new Promise((resolve) => { const listening = app.listen(0, () => resolve(listening)); });
  try {
    const result = await new Promise((resolve, reject) => {
      const call = http.request({ port: server.address().port, method: "POST", path: "/api/admin/tenants/tenant-1/users", headers: { "content-type": "application/json" } }, (res) => {
        let body = ""; res.on("data", (chunk) => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
      call.on("error", reject); call.end(JSON.stringify({ email: "user@company.com", fullName: "User", role: "admin", temporaryPassword: "Temporary password 123" }));
    });
    assert.deepEqual(result, { status: 403, body: { error: "platform_admin_required" } });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("admin provisioning creates tenant owners with a required password change", async () => {
  const queries = [];
  const handler = createTenantHandler({
    withPlatformAdmin: async (_actorId, work) => work({ query: async (text, params = []) => {
      queries.push({ text, params });
      if (/INSERT INTO volt_price\.tenants/.test(text)) return { rows: [{ id: "tenant-1", name: "Tenant", slug: "tenant" }] };
      if (/INSERT INTO volt_price\.users/.test(text)) return { rows: [{ id: "owner-1", email: "owner@company.com", full_name: "Owner" }] };
      if (/SELECT tenant_id FROM volt_price\.memberships/.test(text)) return { rows: [] };
      if (/INSERT INTO volt_price\.memberships/.test(text)) return { rows: [] };
      if (/DELETE FROM volt_price\.sessions/.test(text)) return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    } }),
    audit: async () => {},
    hashPassword: async () => "owner-password-hash",
  });
  const { error } = await invoke(handler, { body: { name: "Tenant", ownerEmail: "owner@company.com", ownerName: "Owner", ownerPassword: "Temporary password 123" }, vpAuth: { userId: "master-1" }, get: () => "test" });

  assert.equal(error, undefined);
  const ownerInsert = queries.find(({ text }) => /INSERT INTO volt_price\.users/.test(text));
  assert.match(ownerInsert.text, /must_change_password/);
  assert.equal(ownerInsert.params.at(-1), true);
});

test("safe user listing returns only Master console metadata for the selected tenant", async () => {
  const queries = [];
  const handler = createTenantUsersHandler({
    withPlatformAdmin: async (_actorId, work) => work({ query: async (text, params = []) => {
      queries.push({ text, params });
      if (/SELECT id,name,slug,status FROM volt_price\.tenants/.test(text)) {
        return { rows: [{ id: "tenant-1", name: "Empresa", slug: "empresa", status: "active" }] };
      }
      if (/FROM volt_price\.memberships m JOIN volt_price\.users u/.test(text)) {
        return { rows: [{
          id: "user-1", full_name: "Ana", email: "ana@empresa.com", role: "finance", status: "active",
          must_change_password: true, created_at: "2026-08-13T12:00:00.000Z", updated_at: "2026-08-13T12:00:00.000Z",
          password_hash: "must-never-leak", token_hash: "must-never-leak", csrf_hash: "must-never-leak",
        }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    } }),
  });

  const { res, error } = await invoke(handler, request({}, "tenant-1"));

  assert.equal(error, undefined);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    tenant: { id: "tenant-1", name: "Empresa", slug: "empresa", status: "active" },
    users: [{
      id: "user-1", fullName: "Ana", email: "ana@empresa.com", role: "finance", status: "active",
      mustChangePassword: true, createdAt: "2026-08-13T12:00:00.000Z", updatedAt: "2026-08-13T12:00:00.000Z",
    }],
  });
  assert.equal(JSON.stringify(res.body).match(/password_hash|token|csrf|session/i), null);
  assert.equal(queries.length, 2);
});

test("tenant admin cannot list users through the Master console route", async () => {
  const app = express();
  app.use("/api/admin", createAdminRouter({
    authenticate: (req, _res, next) => { req.vpAuth = { userId: "tenant-admin-1", isPlatformAdmin: false, passwordChangeRequired: false }; next(); },
    requirePasswordChangeComplete: (_req, _res, next) => next(),
  }));
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.code || "internal_error" }));
  const server = await new Promise((resolve) => { const listening = app.listen(0, () => resolve(listening)); });
  try {
    const result = await new Promise((resolve, reject) => {
      const call = http.request({ port: server.address().port, method: "GET", path: "/api/admin/tenants/tenant-1/users" }, (res) => {
        let body = ""; res.on("data", (chunk) => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
      call.on("error", reject); call.end();
    });
    assert.deepEqual(result, { status: 403, body: { error: "platform_admin_required" } });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
