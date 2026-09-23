"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

test("calculator API routes use the same margem permission middleware as the page", () => {
  const routes = [];
  const permission = (_req, _res, next) => next?.();
  const originalLoad = Module._load;
  Module._load = function mockCalculatorRouteDependencies(request, parent, isMain) {
    if (request === "express") return { Router: () => ({
      get: (...args) => routes.push({ method: "get", args }),
      post: (...args) => routes.push({ method: "post", args }),
    }) };
    if (request === "../services/companyAccessService") return {
      requireModuleAccess(key, options) {
        assert.equal(key, "ml.precificacao.margem");
        assert.deepEqual(options, { defaultAllowIfUnconfigured: true });
        return permission;
      },
    };
    if (request === "../controllers/FinanceiroMlController") return {};
    if (request === "../controllers/FinanceiroMlCalculatorController") return {
      lookup: () => {}, calculate: () => {},
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  const routePath = require.resolve("../routes/financeiroMlRoutes");
  delete require.cache[routePath];
  require("../routes/financeiroMlRoutes");
  Module._load = originalLoad;

  const lookup = routes.find((row) => row.method === "get" && row.args[0] === "/calculator/lookup");
  const calculate = routes.find((row) => row.method === "post" && row.args[0] === "/calculator/calculate");
  assert.equal(lookup.args[1], permission);
  assert.equal(calculate.args[1], permission);
});
