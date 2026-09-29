"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  evaluateAccessToken,
  isReplayableBody,
} = require("../services/tokenRefreshPolicy");

const NOW = Date.parse("2026-09-29T12:00:00.000Z");

test("token com validade acima da margem e reutilizado sem validacao externa", () => {
  const result = evaluateAccessToken(
    {
      access_token: "token-atual",
      access_expires_at: "2026-09-29T12:10:00.000Z",
    },
    NOW,
    90_000,
  );
  assert.equal(result.usable, true);
  assert.equal(result.should_refresh, false);
  assert.equal(result.reason, "access_token_fresh");
});

test("token legado sem access_expires_at e usado de forma otimista", () => {
  const result = evaluateAccessToken({ access_token: "token-legado" }, NOW, 90_000);
  assert.equal(result.usable, true);
  assert.equal(result.reason, "expiry_unknown_assume_usable");
});

test("token perto de expirar pede refresh preventivo", () => {
  const result = evaluateAccessToken(
    {
      access_token: "token-atual",
      access_expires_at: "2026-09-29T12:01:00.000Z",
    },
    NOW,
    90_000,
  );
  assert.equal(result.usable, false);
  assert.equal(result.should_refresh, true);
  assert.equal(result.reason, "access_token_near_expiry");
});

test("token expirado pede refresh", () => {
  const result = evaluateAccessToken(
    {
      access_token: "token-atual",
      access_expires_at: "2026-09-29T11:59:59.000Z",
    },
    NOW,
    90_000,
  );
  assert.equal(result.usable, false);
  assert.equal(result.reason, "access_token_expired");
});

test("retry automatico so aceita corpos replayable", () => {
  assert.equal(isReplayableBody(undefined), true);
  assert.equal(isReplayableBody("{}"), true);
  assert.equal(isReplayableBody(Buffer.from("abc")), true);
  assert.equal(isReplayableBody(new URLSearchParams({ a: "1" })), true);
  assert.equal(isReplayableBody({ pipe() {} }), false);
});
