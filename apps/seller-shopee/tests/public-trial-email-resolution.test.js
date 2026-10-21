"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveTrialEmail } = require("../src/services/publicTrialEmailResolution");

test("existing Shopee or Hub email requires login", async () => {
  const local = await resolveTrialEmail(" USER@example.com ", {
    findLocalUser: async () => ({ id: 1 }), lookupHubEmail: async () => { throw new Error("must not query"); },
  });
  assert.deepEqual(local, { email: "user@example.com", action: "login_required" });
  const hub = await resolveTrialEmail("user@example.com", {
    findLocalUser: async () => null, lookupHubEmail: async () => ({ exists: true }),
  });
  assert.equal(hub.action, "login_required");
});

test("unknown email can receive verification, but unavailable Hub fails closed", async () => {
  const fresh = await resolveTrialEmail("user@example.com", {
    findLocalUser: async () => null, lookupHubEmail: async () => ({ exists: false }),
  });
  assert.equal(fresh.action, "send_activation");
  await assert.rejects(resolveTrialEmail("user@example.com", {
    findLocalUser: async () => null, lookupHubEmail: async () => null,
  }), /trial_email_hub_lookup_incomplete/);
});
