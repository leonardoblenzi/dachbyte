"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relative) {
  return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
}

test("authMiddleware nao chama testarToken/users-me por request", () => {
  const source = read("middleware/authMiddleware.js");
  assert.equal(source.includes("TokenService.testarToken"), false);
  assert.equal(source.includes("users_me"), false);
});

test("TokenService usa policy de expiracao e lock distribuido", () => {
  const source = read("services/tokenService.js");
  assert.equal(source.includes("evaluateAccessToken"), true);
  assert.equal(source.includes("withPostgresRefreshLock"), true);
  assert.equal(source.includes("fetchAutenticado"), true);
  assert.equal(source.includes("substring(0"), false);
});

test("ml-auth legado preserva access_expires_at quando disponivel", () => {
  const source = read("services/ml-auth.js");
  assert.equal(source.includes("ACCESS_EXPIRES_AT"), true);
});

test("webhook autenticado usa retry central em 401", () => {
  const source = read("services/promoOfferRefsService.js");
  assert.equal(source.includes("TokenService.fetchAutenticado"), true);
  assert.equal(source.includes('require("node-fetch")'), false);
});
