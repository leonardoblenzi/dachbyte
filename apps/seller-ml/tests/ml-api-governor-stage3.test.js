"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function requireWithRedisStub(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "../lib/redisClient") {
      return {
        getSharedRedis() {
          return {
            pttl: async () => -2,
            eval: async () => [1, 0],
          };
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const limiterPath = require.resolve("../services/mlApiRateLimiter");
    const governorPath = require.resolve(modulePath);
    delete require.cache[limiterPath];
    delete require.cache[governorPath];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

test("governador so intercepta api oficial do ML com Bearer", () => {
  const governor = requireWithRedisStub("../services/mlApiRequestGovernor");
  const { shouldGovernRequest, extractBearerToken } = governor._test;

  assert.equal(
    shouldGovernRequest("https://api.mercadolibre.com/items/MLB1", {
      headers: { Authorization: "Bearer secret-token" },
    }),
    true,
  );
  assert.equal(
    shouldGovernRequest("https://example.com/items/MLB1", {
      headers: { Authorization: "Bearer secret-token" },
    }),
    false,
  );
  assert.equal(
    shouldGovernRequest("https://api.mercadolibre.com/items/MLB1", {}),
    false,
  );
  assert.equal(
    extractBearerToken(null, { headers: { authorization: "Bearer abc" } }),
    "abc",
  );
});

test("Retry-After aceita segundos e nunca gera espera zero", () => {
  const governor = requireWithRedisStub("../services/mlApiRequestGovernor");
  const { parseRetryAfterMs } = governor._test;

  assert.equal(
    parseRetryAfterMs({ headers: { get: () => "2" } }),
    2000,
  );
  assert.equal(
    parseRetryAfterMs({ headers: { get: () => "0" } }),
    1000,
  );
});

test("identidade do limitador prioriza conta e nunca expoe token", () => {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "../lib/redisClient") {
      return { getSharedRedis() { throw new Error("nao usado"); } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const path = require.resolve("../services/mlApiRateLimiter");
    delete require.cache[path];
    const limiter = require("../services/mlApiRateLimiter");
    assert.equal(limiter.normalizeIdentity({ meliContaId: 42, accessToken: "secret" }), "account:42");
    const tokenIdentity = limiter.normalizeIdentity({ accessToken: "secret" });
    assert.match(tokenIdentity, /^token:[a-f0-9]{24}$/);
    assert.equal(tokenIdentity.includes("secret"), false);
  } finally {
    Module._load = originalLoad;
  }
});
