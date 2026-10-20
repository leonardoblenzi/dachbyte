"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveTrialEmail, lookupHubEmail } = require("../services/publicTrialEmailResolution");

test("existing local Seller email requires login without creating a company", async () => {
  let hubCalled = false;
  const result = await resolveTrialEmail(" Owner@Example.Test ", {
    findLocalUser: async (email) => {
      assert.equal(email, "owner@example.test");
      return { id: 42 };
    },
    lookupHubEmail: async () => { hubCalled = true; return { exists: false }; }
  });
  assert.deepEqual(result, { email: "owner@example.test", action: "login_required" });
  assert.equal(hubCalled, false);
});

test("existing global Hub email also requires login", async () => {
  const result = await resolveTrialEmail("owner@example.test", {
    findLocalUser: async () => null,
    lookupHubEmail: async () => ({ exists: true })
  });
  assert.equal(result.action, "login_required");
});

test("new company may be prepared only when local and Hub identity both confirm absence", async () => {
  const result = await resolveTrialEmail("new@example.test", {
    findLocalUser: async () => null,
    lookupHubEmail: async () => ({ exists: false })
  });
  assert.equal(result.action, "send_activation");
});

test("Hub unavailable fails closed instead of treating the email as new", async () => {
  await assert.rejects(resolveTrialEmail("new@example.test", {
    findLocalUser: async () => null,
    lookupHubEmail: async () => { throw new Error("hub_unavailable"); }
  }), /hub_unavailable/);
});

test("Hub lookup requires internal credentials and a definitive boolean response", async () => {
  await assert.rejects(lookupHubEmail("new@example.test", {
    baseUrl: "", token: "", fetchImpl: async () => { throw new Error("unexpected_fetch"); }
  }), /trial_email_hub_unavailable/);
  await assert.rejects(lookupHubEmail("new@example.test", {
    baseUrl: "https://hub.example", token: "internal",
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) })
  }), /trial_email_hub_lookup_incomplete/);
  const result = await lookupHubEmail("new@example.test", {
    baseUrl: "https://hub.example", token: "internal",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://hub.example/v1/internal/portal/auth/email-exists");
      assert.equal(options.headers.authorization, "Bearer internal");
      return { ok: true, json: async () => ({ ok: true, exists: false }) };
    }
  });
  assert.deepEqual(result, { exists: false });
});
