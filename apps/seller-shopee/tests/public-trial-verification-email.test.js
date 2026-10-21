"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { sendTrialVerificationEmail } = require("../src/services/publicTrialVerificationEmail");

test("Shopee verification email names the module and uses a fixed sender", async () => {
  let sent;
  const result = await sendTrialVerificationEmail({
    toEmail: "user@example.com", activationLink: "https://dachbyte.tech/shopee/auth/trial/verify?token=x",
  }, {
    apiKey: "key", senderEmail: "noreply@example.com",
    fetchImpl: async (_url, options) => { sent = JSON.parse(options.body); return { ok: true, json: async () => ({ messageId: "m1" }) }; },
  });
  assert.equal(result.sent, true);
  assert.match(sent.subject, /Shopee/);
  assert.equal(sent.sender.email, "noreply@example.com");
  assert.equal(sent.to[0].email, "user@example.com");
});

test("Shopee verification email fails closed without delivery configuration", async () => {
  const result = await sendTrialVerificationEmail({ toEmail: "user@example.com", activationLink: "https://example.test" }, {
    apiKey: "", senderEmail: "",
  });
  assert.equal(result.sent, false);
});
