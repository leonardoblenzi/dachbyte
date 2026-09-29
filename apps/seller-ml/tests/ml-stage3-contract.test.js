"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relative) {
  return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
}

test("web instala governor antes de carregar app", () => {
  const source = read("index.js");
  const install = source.indexOf("installMlApiRequestGovernor();");
  const appRequire = source.indexOf('require("./app")');
  assert.ok(install >= 0);
  assert.ok(appRequire > install);
});

test("worker instala governor antes dos services e agenda retencao", () => {
  const source = read("worker.js");
  const install = source.indexOf("installMlApiRequestGovernor();");
  const promoRequire = source.indexOf('require("./services/promoJobsService")');
  assert.ok(install >= 0);
  assert.ok(promoRequire > install);
  assert.equal(source.includes("startBullRetentionScheduler();"), true);
  assert.equal(source.includes("stopBullRetentionScheduler"), true);
});

test("governador nao registra Bearer/token em log", () => {
  const source = read("services/mlApiRequestGovernor.js");
  const limiter = read("services/mlApiRateLimiter.js");
  assert.equal(source.includes("console.log(accessToken"), false);
  assert.equal(source.includes("console.warn(accessToken"), false);
  assert.equal(limiter.includes("console.log(accessToken"), false);
  assert.equal(limiter.includes("console.warn(accessToken"), false);
});

test("retencao nao limpa jobs waiting, active ou delayed", () => {
  const source = read("services/bullRetentionService.js");
  assert.equal(/cleanState\([^\n]+"waiting"/.test(source), false);
  assert.equal(/cleanState\([^\n]+"active"/.test(source), false);
  assert.equal(/cleanState\([^\n]+"delayed"/.test(source), false);
  assert.equal(source.includes('"completed"'), true);
  assert.equal(source.includes('"failed"'), true);
});
