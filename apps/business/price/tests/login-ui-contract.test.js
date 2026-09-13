"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const publicDirectory = path.join(__dirname, "..", "public");
const indexHtml = fs.readFileSync(path.join(publicDirectory, "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(publicDirectory, "app.js"), "utf8");

test("login ui contract presents credentials and a first-access password form", () => {
  for (const id of [
    "loginEmail",
    "loginPassword",
    "passwordChangeForm",
    "currentPassword",
    "newPassword",
    "confirmPassword",
  ]) assert.match(indexHtml, new RegExp(`id=["']${id}["']`));

  assert.match(indexHtml, /passwordChangeForm[^>]*hidden/);
  assert.match(indexHtml, /senha tempor[aá]ria/i);
});

test("login ui contract removes workspace and MFA controls", () => {
  for (const legacyId of ["loginWorkspace", "loginOtp", "workspacePicker"]) {
    assert.doesNotMatch(indexHtml, new RegExp(`id=["']${legacyId}["']`));
  }
  assert.doesNotMatch(indexHtml, /(?:c[oó]digo\s+(?:MFA|TOTP)|workspace\s*<)/i);
});

test("login ui contract sends credentials only and completes first access with CSRF", () => {
  assert.match(appJs, /api\("\/auth\/login",\{method:"POST",body:JSON\.stringify\(\{email,password\}\)\}\)/);
  assert.doesNotMatch(appJs, /auth\/login[\s\S]{0,220}(?:workspace|otp)/i);
  assert.match(appJs, /hydrateCsrf\(\)/);
  assert.match(appJs, /api\("\/auth\/change-password",\{method:"POST"/);
  assert.match(appJs, /passwordChangeRequired/);
});
