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

test("teste grátis: formulário (e-mail, nome, empresa, CNPJ) antes da autorização no Mercado Livre", () => {
  const html = read("views/ativar-teste.html");
  const script = read("public/js/ml-trial-signup.js");
  for (const field of ["email", "full_name", "company_name", "document_number"]) {
    assert.match(html, new RegExp(`name="${field}"`), field);
  }
  assert.doesNotMatch(html, /type="password"/, "a senha é criada pelo e-mail do convite");
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.match(script, /\/api\/meli\/oauth\/trial\/start/);
  assert.match(script, /get\("enviado"\) === "1"/);
  for (const code of ["trial_email_login_required", "trial_document_already_used", "trial_company_already_customer", "cnpj_not_found"]) {
    assert.match(script, new RegExp(code), code);
  }
  assert.doesNotMatch(script, /localStorage|sessionStorage/);
});

test("teste grátis: o início confere e-mail e CNPJ antes de mandar ao Mercado Livre", () => {
  const routes = read("routes/meliOAuthRoutes.js");
  const start = routes.slice(routes.indexOf('"/oauth/trial/start"'), routes.indexOf('"/oauth/trial/email"'));
  assert.match(start, /normalizeCompanyCnpj\(req\.body\?\.document_number\)/);
  assert.match(start, /resolution\.action === "login_required"/);
  assert.match(start, /checkMlTrialEligibility\(\{ documentNumber: document\.number \}\)/);
  assert.ok(start.indexOf("checkMlTrialEligibility") < start.indexOf("createTrialOAuthSession"), "confere antes de abrir a autorização");
  assert.match(start, /form: \{ email: resolution\.email, fullName, companyName: eligibility\.legalName \|\| companyName, documentNumber: document\.number \}/);
});

test("teste grátis: retorno da autorização cria tudo, mede a faixa e manda o e-mail de senha", () => {
  const routes = read("routes/meliOAuthRoutes.js");
  const flow = routes.slice(routes.indexOf("async function completeTrialFromForm"));
  const order = ["stageMlTrialIdentityFromForm", "activateMlTrialInHub", "finalizeConfirmedMlTrial", "processClosedMonthMeasurement", "sendMlTrialPasswordInvite"]
    .map((name) => flow.indexOf(name));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), "ordem: identidade, hub, conta, faixa, e-mail");
  assert.match(flow, /\/ativar-teste\?enviado=1/);
  assert.match(read("services/hubTrialActivation.js"), /invite: true,\s*origin_module: "ml"/);
});

test("landing do Mercado Livre leva ao teste quando ele está ligado", () => {
  const landing = fs.readFileSync(path.join(__dirname, "../../gateway/views/seller/landing-mercado-livre.html"), "utf8");
  assert.match(landing, /data-ml-trial-start/);
  const script = fs.readFileSync(path.join(__dirname, "../../../public/brand/dachbyte/seller/landing.js"), "utf8");
  assert.match(script, /\/ml\/api\/meli\/oauth\/trial\/availability/);
  assert.match(script, /'\/ml\/teste-gratis'/);
  assert.match(read("app.js"), /app\.get\("\/teste-gratis"/);
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

test("teste grátis: CNPJ conferido na Receita (ativo) antes do Mercado Livre e razão social gravada", async () => {
  const routes = read("routes/meliOAuthRoutes.js");
  const start = routes.slice(routes.indexOf('"/oauth/trial/start"'), routes.indexOf('"/oauth/trial/email"'));
  assert.match(start, /\["cnpj_not_found", "cnpj_not_active", "invalid_cnpj"\]\.includes\(eligibility\.reason\) \? 400 : 409/);
  assert.match(start, /companyName: eligibility\.legalName \|\| companyName/);
  assert.match(read("public/js/ml-trial-signup.js"), /cnpj_not_active/);
  const { checkMlTrialEligibility } = require("../services/hubTrialActivation");
  const reply = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });
  const opts = (fetchImpl) => ({ baseUrl: "http://hub", token: "t", fetchImpl });
  assert.deepEqual(await checkMlTrialEligibility({ documentNumber: "11222333000181" }, opts(reply(200, { ok: true, eligible: true, legal_name: "EMPRESA LTDA" }))),
    { eligible: true, legalName: "EMPRESA LTDA" });
  assert.deepEqual(await checkMlTrialEligibility({ documentNumber: "11222333000181" }, opts(reply(200, { ok: true, eligible: false, reason: "cnpj_not_active" }))),
    { eligible: false, reason: "cnpj_not_active" });
  await assert.rejects(checkMlTrialEligibility({ documentNumber: "11222333000181" }, opts(reply(503, { ok: false, error: "cnpj_lookup_unavailable" }))), /cnpj_lookup_unavailable/);
});
