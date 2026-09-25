"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");

test("every legacy audit producer uses the shared sanitizer before persistence", () => {
  const sanitizer = require("../src/services/auditSanitizer");
  const auditService = fs.readFileSync(path.join(ROOT, "src", "services", "auditService.js"), "utf8");
  const writeRepository = fs.readFileSync(path.join(ROOT, "src", "repositories", "writeRepository.js"), "utf8");
  const accountRepository = fs.readFileSync(path.join(ROOT, "src", "repositories", "accountManagementRepository.js"), "utf8");

  assert.deepEqual(sanitizer.sanitizeAuditDetails({
    authorization: "Bearer secret",
    nested: { refresh_token: "refresh-secret", safe: "ok" },
  }), {
    authorization: "[REDACTED]",
    nested: { refresh_token: "[REDACTED]", safe: "ok" },
  });
  assert.match(auditService, /sanitizeAuditDetails/);
  assert.match(auditService, /appendAuditEvent/);
  assert.match(writeRepository, /appendAuditEvent/);
  assert.match(accountRepository, /appendAuditEvent/);
});
