"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (relativePath) => fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");

test("trial activation page and guest API are unavailable while rollout flag is off", () => {
  const app = read("app.js");
  const routes = read("routes/meliOAuthRoutes.js");
  assert.match(app, /p === "\/ativar-teste"[\s\S]*SELLER_TRIAL_ONBOARDING_ENABLED/);
  assert.match(app, /app\.get\("\/ativar-teste"[\s\S]*SELLER_TRIAL_ONBOARDING_ENABLED/);
  assert.match(routes, /"\/oauth\/trial\/activate"[\s\S]*if \(!trialOnboardingEnabled\(\)\)/);
});

test("activation page distinguishes email submission from verified-link activation", () => {
  const html = read("views/ativar-teste.html");
  const script = read("public/js/ml-trial-activation.js");
  assert.match(html, /id="trial-email-form"/);
  assert.match(html, /id="trial-activate-form"/);
  assert.match(html, /id="trial-existing-form"/);
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.match(script, /\/api\/meli\/oauth\/trial\/email/);
  assert.match(script, /\/api\/meli\/oauth\/trial\/activate/);
  assert.match(script, /trial_email_login_required/);
  assert.match(script, /\/api\/meli\/oauth\/trial\/link-options/);
  assert.match(script, /\/api\/meli\/oauth\/trial\/link-existing/);
  assert.doesNotMatch(script, /localStorage|sessionStorage/);
});

test("login return is a fixed trial destination, not a user-controlled redirect", () => {
  const login = read("views/login.html");
  assert.match(login, /next === "trial-existing-link"/);
  assert.match(login, /"\.\/ativar-teste\?link=1"/);
});

test("the activation page is excluded from the operational shell under the ML base path", () => {
  const source = read("public/js/ml-base.js");
  assert.match(source, /ativar-teste/);
  assert.match(source, /"\/ativar-teste"/);
});
