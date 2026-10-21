"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("existing Shopee email sends user through login to explicit link confirmation", () => {
  const emailPage = fs.readFileSync(path.join(__dirname, "../../seller-shopee/public/trial-email.html"), "utf8");
  const loginPage = fs.readFileSync(path.join(__dirname, "../../seller-ml/views/login.html"), "utf8");
  const linkPage = fs.readFileSync(path.join(__dirname, "../views/seller/shopee-trial-link.html"), "utf8");
  assert.match(emailPage, /\/login\?next=trial-existing-shopee-link/);
  assert.match(loginPage, /next === "trial-existing-shopee-link"/);
  assert.match(loginPage, /"\/seller\/shopee\/continuar"/);
  assert.match(linkPage, /Concluir vínculo/);
  assert.match(linkPage, /\/api\/portal\/trial\/shopee\/claim/);
  assert.match(linkPage, /\/api\/portal\/overview/);
  assert.match(linkPage, /tenant\.name/);
});

test("gateway requires signed Suite session, OAuth browser proof and same-origin POST", () => {
  const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  assert.match(server, /app\.post\("\/api\/portal\/trial\/shopee\/claim"/);
  assert.match(server, /readSuitePayload\(req\)/);
  assert.match(server, /shopee_trial_oauth_nonce/);
  assert.match(server, /trialRequestOriginMatches/);
  assert.match(server, /trial-existing-shopee-link/);
});
