"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const authPath = path.join(__dirname, "..", "src", "auth.js");
const db = require("../src/db");
const { config } = require("../src/config");

function sessionRow({ mustChangePassword = false } = {}) {
  return {
    session_id: "session-1",
    tenant_id: "tenant-1",
    user_id: "user-1",
    csrf_hash: "csrf-hash",
    support_reason: null,
    email: "user@example.com",
    full_name: "User",
    user_status: "active",
    must_change_password: mustChangePassword,
    platform_role: null,
    tenant_role: "analyst",
    membership_status: "active",
    tenant_name: "Workspace",
    tenant_slug: "workspace",
    tenant_status: "active",
  };
}

async function authenticateWith({ row, memberships, middleware = "authenticate" }) {
  const originalQuery = db.query;
  const responses = [{ rows: [row] }, { rows: memberships }];
  let responseIndex = 0;
  delete require.cache[require.resolve(authPath)];
  db.query = async () => responses[responseIndex++];

  try {
    const auth = require(authPath);
    const req = { cookies: { [config.sessionCookie]: "session-token" } };
    const error = await new Promise((resolve) => auth[middleware](req, {}, resolve));
    return { error, req };
  } finally {
    db.query = originalQuery;
    delete require.cache[require.resolve(authPath)];
  }
}

test("auth session blocks business resources while a password change is pending", async () => {
  const { error } = await authenticateWith({
    row: sessionRow({ mustChangePassword: true }),
    memberships: [{ tenant_id: "tenant-1", role: "analyst", name: "Workspace", slug: "workspace" }],
  });

  assert.equal(error?.code, "password_change_required");
  assert.equal(error?.statusCode, 403);
});

test("auth session keeps password-change authentication available while a password change is pending", async () => {
  const { error, req } = await authenticateWith({
    middleware: "authenticateForPasswordChange",
    row: sessionRow({ mustChangePassword: true }),
    memberships: [{ tenant_id: "tenant-1", role: "analyst", name: "Workspace", slug: "workspace" }],
  });

  assert.equal(error, undefined);
  assert.equal(req.vpAuth.passwordChangeRequired, true);
});

test("auth session invalidates a regular session after a second active membership is added", async () => {
  const { error } = await authenticateWith({
    row: sessionRow(),
    memberships: [
      { tenant_id: "tenant-1", role: "analyst", name: "Workspace", slug: "workspace" },
      { tenant_id: "tenant-2", role: "viewer", name: "Other", slug: "other" },
    ],
  });

  assert.equal(error?.code, "multiple_workspaces_not_allowed");
  assert.equal(error?.statusCode, 409);
});
