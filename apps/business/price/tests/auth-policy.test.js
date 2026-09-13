"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { resolveLoginScope, assertPasswordChangeComplete } = require("../src/auth-policy");

test("auth policy gives a Platform Master global access despite legacy MFA fields", () => {
  const scope = resolveLoginScope({
    platformRole: "platform_super_admin",
    memberships: [{ tenant_id: "tenant-1", role: "owner", name: "Workspace", slug: "workspace" }],
    mfaRequired: true,
    totpSecretCipher: "legacy-secret",
    mfaConfirmed: false,
  });

  assert.deepEqual(scope, {
    isPlatformAdmin: true,
    role: "platform_super_admin",
    tenantId: null,
    tenant: null,
  });
});

test("auth policy resolves a regular user to their sole active membership", () => {
  const membership = { tenant_id: "tenant-1", role: "analyst", name: "Workspace", slug: "workspace" };

  assert.deepEqual(resolveLoginScope({ platformRole: null, memberships: [membership] }), {
    isPlatformAdmin: false,
    role: "analyst",
    tenantId: "tenant-1",
    tenant: membership,
  });
});

test("auth policy denies a regular user without an active workspace", () => {
  assert.throws(
    () => resolveLoginScope({ platformRole: null, memberships: [] }),
    (error) => error.code === "no_workspace",
  );
});

test("auth policy denies a regular user with multiple active workspaces", () => {
  assert.throws(
    () => resolveLoginScope({
      platformRole: null,
      memberships: [
        { tenant_id: "tenant-1", role: "owner" },
        { tenant_id: "tenant-2", role: "viewer" },
      ],
    }),
    (error) => error.code === "multiple_workspaces_not_allowed" && error.statusCode === 409,
  );
});

test("auth policy denies protected resources until a password change is complete", () => {
  assert.throws(
    () => assertPasswordChangeComplete({ mustChangePassword: true }),
    (error) => error.code === "password_change_required" && error.statusCode === 403,
  );
  assert.doesNotThrow(() => assertPasswordChangeComplete({ mustChangePassword: false }));
});
