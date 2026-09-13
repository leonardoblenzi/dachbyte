"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const createApp = require("../../app");
const runtime = require("./persistentCoreService");
const runtimeAccess = require("./runtimeAccess");

function token(payload) {
  return jwt.sign(payload, "volt-core-dev-secret", { expiresIn: "5m" });
}

async function withServer(run) {
  const app = createApp();
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("runtime HTTP blocks access to another company before touching the database", async () => {
  await withServer(async (baseUrl) => {
    const authToken = token({
      uid: "usr-1",
      role: "operator",
      companies: [{ id: "company-a", name: "Empresa A" }],
    });
    const response = await fetch(`${baseUrl}/api/core/runtime/companies/company-b/workspace`, {
      headers: { cookie: `auth_token=${authToken}` },
    });
    const payload = await response.json();
    assert.equal(response.status, 403);
    assert.equal(payload.error.code, "COMPANY_ACCESS_DENIED");
  });
});

test("runtime HTTP lets an assigned company reach the controller", async () => {
  await withServer(async (baseUrl) => {
    const authToken = token({
      uid: "usr-1",
      role: "operator",
      companies: [{ id: "company-a", name: "Empresa A" }],
    });
    const response = await fetch(`${baseUrl}/api/core/runtime/companies/company-a/workspace`, {
      headers: { cookie: `auth_token=${authToken}` },
    });
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.error.code, "VOLT_CORE_DATABASE_DISABLED");
  });
});

test("runtime HTTP is available under the public /api/core prefix", async () => {
  await withServer(async (baseUrl) => {
    const authToken = token({
      uid: "usr-1",
      role: "operator",
      companies: [{ id: "company-a", name: "Empresa A" }],
    });
    const response = await fetch(`${baseUrl}/api/core/runtime/companies/company-a/workspace`, {
      headers: { cookie: `auth_token=${authToken}` },
    });
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.error.code, "VOLT_CORE_DATABASE_DISABLED");
  });
});

test("public /core route serves the product landing instead of the API", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/core`);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/html/);
    assert.match(body, /DACHBYTE Core/i);
  });
});

test("runtime HTTP serves authenticated spreadsheet import templates", async () => {
  await withServer(async (baseUrl) => {
    const authToken = token({
      uid: "usr-1",
      role: "operator",
      companies: [{ id: "company-a", name: "Empresa A" }],
    });
    const response = await fetch(`${baseUrl}/api/core/import-templates/customers.xlsx`, {
      headers: { cookie: `auth_token=${authToken}` },
    });
    const body = Buffer.from(await response.arrayBuffer());

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /spreadsheetml\.sheet/);
    assert.match(response.headers.get("content-disposition") || "", /modelo-clientes-volt-core\.xlsx/);
    assert.equal(body.subarray(0, 2).toString("utf8"), "PK");
  });
});

test("runtime HTTP blocks writes when company user lacks the required permission", async () => {
  await withServer(async (baseUrl) => {
    const authToken = token({
      uid: "usr-1",
      role: "operator",
      companies: [{ id: "company-a", name: "Empresa A", role: "operator" }],
    });
    const response = await fetch(`${baseUrl}/api/core/runtime/companies/company-a/products`, {
      method: "POST",
      headers: {
        cookie: `auth_token=${authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Produto bloqueado", salePrice: 10 }),
    });
    const payload = await response.json();
    assert.equal(response.status, 403);
    assert.equal(payload.error.code, "PERMISSION_DENIED");
    assert.equal(payload.error.permission, "products:write");
  });
});

test("runtime HTTP lets company admins pass write permission checks", async () => {
  await withServer(async (baseUrl) => {
    const authToken = token({
      uid: "usr-1",
      role: "operator",
      companies: [{ id: "company-a", name: "Empresa A", role: "admin" }],
    });
    const response = await fetch(`${baseUrl}/api/core/runtime/companies/company-a/products`, {
      method: "POST",
      headers: {
        cookie: `auth_token=${authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Produto liberado", salePrice: 10 }),
    });
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.error.code, "VOLT_CORE_DATABASE_DISABLED");
  });
});

test("runtime HTTP exposes manual receivable creation behind write permission", async () => {
  await withServer(async (baseUrl) => {
    const blockedToken = token({
      uid: "finance-read",
      role: "operator",
      companies: [{ id: "company-a", name: "Empresa A", role: "operator", permissions: ["receivables:read"] }],
    });
    const blocked = await fetch(`${baseUrl}/api/core/runtime/companies/company-a/receivables`, {
      method: "POST",
      headers: { cookie: `auth_token=${blockedToken}`, "content-type": "application/json" },
      body: JSON.stringify({ customer: "Cliente", amount: 100, dueDate: "2026-07-10" }),
    });
    const blockedPayload = await blocked.json();
    assert.equal(blocked.status, 403);
    assert.equal(blockedPayload.error.permission, "receivables:write");

    const adminToken = token({
      uid: "admin-a",
      role: "operator",
      companies: [{ id: "company-a", name: "Empresa A", role: "admin" }],
    });
    const allowed = await fetch(`${baseUrl}/api/core/runtime/companies/company-a/receivables`, {
      method: "POST",
      headers: { cookie: `auth_token=${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ customer: "Cliente", amount: 100, dueDate: "2026-07-10" }),
    });
    const allowedPayload = await allowed.json();
    assert.equal(allowed.status, 503);
    assert.equal(allowedPayload.error.code, "VOLT_CORE_DATABASE_DISABLED");
  });
});

test("runtime HTTP protects auditable receivable due date correction with write permission", async () => {
  await withServer(async (baseUrl) => {
    const blockedToken = token({
      uid: "finance-read",
      role: "operator",
      companies: [{ id: "company-a", name: "Empresa A", role: "operator", permissions: ["receivables:read"] }],
    });
    const blocked = await fetch(`${baseUrl}/api/core/runtime/companies/company-a/receivables/rec-38/due-date`, {
      method: "PATCH",
      headers: { cookie: `auth_token=${blockedToken}`, "content-type": "application/json" },
      body: JSON.stringify({ dueDate: "2026-08-30", reason: "Correcao da venda 38" }),
    });
    const blockedPayload = await blocked.json();
    assert.equal(blocked.status, 403);
    assert.equal(blockedPayload.error.permission, "receivables:write");

    const adminToken = token({
      uid: "admin-a",
      role: "operator",
      companies: [{ id: "company-a", name: "Empresa A", role: "admin" }],
    });
    const allowed = await fetch(`${baseUrl}/api/core/runtime/companies/company-a/receivables/rec-38/due-date`, {
      method: "PATCH",
      headers: { cookie: `auth_token=${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ dueDate: "2026-08-30", reason: "Correcao da venda 38" }),
    });
    const allowedPayload = await allowed.json();
    assert.equal(allowed.status, 503);
    assert.equal(allowedPayload.error.code, "VOLT_CORE_DATABASE_DISABLED");
  });
});

test("company user management stays scoped to admins own company", async () => {
  await withServer(async (baseUrl) => {
    const authToken = token({
      uid: "admin-a",
      role: "operator",
      companies: [{ id: "company-a", name: "Empresa A", role: "admin" }],
    });
    const ownCompany = await fetch(`${baseUrl}/api/core/runtime/companies/company-a/users`, {
      method: "POST",
      headers: { cookie: `auth_token=${authToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Usuario A", email: "a@example.com", role: "operator" }),
    });
    const otherCompany = await fetch(`${baseUrl}/api/core/runtime/companies/company-b/users`, {
      method: "POST",
      headers: { cookie: `auth_token=${authToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Usuario B", email: "b@example.com", role: "operator" }),
    });

    assert.equal(ownCompany.status, 503);
    assert.equal(otherCompany.status, 403);
  });
});

test("master can manage users in any company context", async () => {
  await withServer(async (baseUrl) => {
    const authToken = token({ uid: "master-1", role: "admin_master", is_master: true, companies: [] });
    const response = await fetch(`${baseUrl}/api/core/runtime/companies/company-any/users`, {
      method: "POST",
      headers: { cookie: `auth_token=${authToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Usuario", email: "user@example.com", role: "operator" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 503);
    assert.equal(payload.error.code, "VOLT_CORE_DATABASE_DISABLED");
  });
});

test("only master can change an already configured company segment", async () => {
  await withServer(async (baseUrl) => {
    const companyAdminToken = token({
      uid: "admin-a",
      role: "operator",
      companies: [{ id: "company-a", name: "Empresa A", role: "admin" }],
    });
    const masterToken = token({ uid: "master-1", role: "admin_master", is_master: true, companies: [] });
    const adminResponse = await fetch(`${baseUrl}/api/core/runtime/companies/company-a/apply-segment`, {
      method: "POST",
      headers: { cookie: `auth_token=${companyAdminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ segmentKey: "optical" }),
    });
    const masterResponse = await fetch(`${baseUrl}/api/core/runtime/companies/company-a/apply-segment`, {
      method: "POST",
      headers: { cookie: `auth_token=${masterToken}`, "content-type": "application/json" },
      body: JSON.stringify({ segmentKey: "optical" }),
    });

    assert.equal(adminResponse.status, 403);
    assert.equal(masterResponse.status, 503);
  });
});

test("only master can change module and screen overrides", async () => {
  await withServer(async (baseUrl) => {
    const companyAdminToken = token({
      uid: "admin-a",
      role: "operator",
      companies: [{ id: "company-a", name: "Empresa A", role: "admin" }],
    });
    const masterToken = token({ uid: "master-1", role: "admin_master", is_master: true, companies: [] });
    const adminResponse = await fetch(`${baseUrl}/api/core/runtime/companies/company-a/configuration/overrides`, {
      method: "PATCH",
      headers: { cookie: `auth_token=${companyAdminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ enabledModules: ["optical_prescriptions"] }),
    });
    const masterResponse = await fetch(`${baseUrl}/api/core/runtime/companies/company-a/configuration/overrides`, {
      method: "PATCH",
      headers: { cookie: `auth_token=${masterToken}`, "content-type": "application/json" },
      body: JSON.stringify({ enabledModules: ["optical_prescriptions"] }),
    });

    assert.equal(adminResponse.status, 403);
    assert.equal(masterResponse.status, 503);
  });
});

test("assigned company admin can reach the one-time sector onboarding", async () => {
  await withServer(async (baseUrl) => {
    const authToken = token({
      uid: "admin-a",
      role: "operator",
      companies: [{ id: "company-a", name: "Empresa A", role: "admin" }],
    });
    const response = await fetch(`${baseUrl}/api/core/runtime/companies/company-a/onboarding/sector`, {
      method: "POST",
      headers: { cookie: `auth_token=${authToken}`, "content-type": "application/json" },
      body: JSON.stringify({ sectorKey: "general" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 503);
    assert.equal(payload.error.code, "VOLT_CORE_DATABASE_DISABLED");
  });
});

test("assigned company admin can reach company profile onboarding", async () => {
  await withServer(async (baseUrl) => {
    const authToken = token({
      uid: "admin-a",
      role: "operator",
      companies: [{ id: "company-a", name: "Empresa A", role: "admin" }],
    });
    const response = await fetch(`${baseUrl}/api/core/runtime/companies/company-a/onboarding/company-profile`, {
      method: "POST",
      headers: { cookie: `auth_token=${authToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Empresa A", document: "00.000.000/0001-00" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 503);
    assert.equal(payload.error.code, "VOLT_CORE_DATABASE_DISABLED");
  });
});

test("legacy operational API is no longer exposed", async () => {
  await withServer(async (baseUrl) => {
    const authToken = token({
      uid: "usr-1",
      role: "operator",
      companies: [{ id: "company-a", name: "Empresa A", role: "operator" }],
    });
    const response = await fetch(`${baseUrl}/api/core/companies/company-a/customers`, {
      headers: { cookie: `auth_token=${authToken}` },
    });
    const payload = await response.json();
    assert.equal(response.status, 404);
    assert.equal(payload.error.code, "CORE_ROUTE_NOT_FOUND");
  });
});

test("effective screens never cross the configured company segment", () => {
  const user = {
    uid: "usr-1",
    role: "operator",
    companies: [{
      id: "company-a",
      role: "manager",
      screens: ["dashboard", "sales", "service_orders", "optical_prescriptions"],
    }],
  };

  assert.deepEqual(
    runtimeAccess.getEffectiveScreens(user, "company-a", ["dashboard", "sales", "customers"]),
    ["dashboard", "sales"],
  );
  assert.equal(runtimeAccess.normalizeRole("Financeiro"), "finance");
});
test("persistent payment rules keep credit card immediate and reject non-positive values", () => {
  assert.equal(runtime.__test.normalizePaymentMethod("Cartao"), "credit_card");
  assert.equal(runtime.__test.isImmediatePayment("credit_card"), true);
  assert.equal(runtime.__test.isImmediatePayment("transferencia"), true);
  assert.throws(
    () => runtime.__test.assertPositive(-1, "invalido", "INVALID"),
    (error) => error.code === "INVALID" && error.statusCode === 400,
  );
  assert.equal(
    runtime.__test.defaultReceivableDueDate("2026-07-31T09:00:00.000Z"),
    "2026-08-30",
  );
});

test("optical laboratory creation requires optical write permission", async () => {
  await withServer(async (baseUrl) => {
    const authToken = token({
      uid: "seller-a",
      role: "operator",
      companies: [{ id: "company-a", role: "operator", permissions: ["optical_prescriptions:read"] }],
    });
    const response = await fetch(`${baseUrl}/api/core/runtime/companies/company-a/optical-laboratories`, {
      method: "POST",
      headers: { cookie: `auth_token=${authToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Lab teste" }),
    });
    const payload = await response.json();
    assert.equal(response.status, 403);
    assert.equal(payload.error.permission, "optical_prescriptions:write");
  });
});

test("optical production status is exposed behind service order write permission", async () => {
  await withServer(async (baseUrl) => {
    const authToken = token({
      uid: "manager-a",
      role: "operator",
      companies: [{ id: "company-a", role: "manager" }],
    });
    const response = await fetch(`${baseUrl}/api/core/runtime/companies/company-a/optical-orders/opt-1/status`, {
      method: "PATCH",
      headers: { cookie: `auth_token=${authToken}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "in_production" }),
    });
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.error.code, "VOLT_CORE_DATABASE_DISABLED");
  });
});

test("health and error responses expose request tracing without caching auth", async () => {
  await withServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}/health`);
    const healthPayload = await health.json();
    assert.equal(health.status, 200);
    assert.equal(healthPayload.database, "disabled");
    assert.ok(health.headers.get("x-request-id"));

    const login = await fetch(`${baseUrl}/api/core/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const loginPayload = await login.json();
    assert.equal(login.status, 400);
    assert.match(login.headers.get("cache-control") || "", /no-store/);
    assert.ok(login.headers.get("x-request-id"));
    assert.equal(loginPayload.error.requestId, login.headers.get("x-request-id"));
  });
});
