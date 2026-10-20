"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTrialVerificationHtml } = require("../services/inviteEmailService");

test("verification email says the seven-day trial has not started and escapes links", () => {
  const html = buildTrialVerificationHtml({
    activationLink: 'https://seller.example/ativar-teste?token=x"<unsafe>',
    expiresAt: "21/10/2026 12:00"
  });
  assert.match(html, /O teste não começou ainda/);
  assert.match(html, /7 dias de teste/);
  assert.doesNotMatch(html, /x"<unsafe>/);
  assert.match(html, /&quot;&lt;unsafe&gt;/);
});
