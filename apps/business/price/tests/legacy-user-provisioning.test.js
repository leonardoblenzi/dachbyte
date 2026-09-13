"use strict";

const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const { createAppDataRouter } = require("../src/routes/appData.routes");

function post(server, requestPath, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ port: server.address().port, method: "POST", path: requestPath, headers: { "content-type": "application/json" } }, (response) => {
      let payload = "";
      response.on("data", (chunk) => { payload += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: payload }));
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

test("legacy tenant user endpoint cannot create users", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", createAppDataRouter({
    authenticate: (req, _res, next) => { req.vpAuth = { userId: "tenant-admin-1", tenantId: "tenant-1", role: "admin", passwordChangeRequired: false }; next(); },
    requirePasswordChangeComplete: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next(),
    withTenant: async () => { throw new Error("legacy user creation reached a tenant database transaction"); },
  }));
  const server = await new Promise((resolve) => { const listening = app.listen(0, () => resolve(listening)); });
  try {
    const result = await post(server, "/api/users", { email: "new@company.com", fullName: "New User", password: "Temporary password 123", role: "admin" });
    assert.equal(result.status, 404);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("tenant user interface does not offer account creation", () => {
  const usersJs = fs.readFileSync(path.join(__dirname, "..", "public", "users.js"), "utf8");

  assert.doesNotMatch(usersJs, /Adicionar usu[aá]rio/i);
  assert.doesNotMatch(usersJs, /createUser|userPassword|userFullName|userEmail/);
  assert.doesNotMatch(usersJs, /api\("\/users",\s*\{\s*method:\s*"POST"/);
});
