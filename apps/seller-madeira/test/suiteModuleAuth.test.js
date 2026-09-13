"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

const {
  createSuiteModuleAuthMiddleware,
} = require("../src/middleware/suiteModuleAuth");

const TEST_SECRET = "madeira-suite-auth-test-secret";

function runMiddleware(middleware, request) {
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ type: "json", status: this.statusCode, body });
      },
      redirect(location) {
        resolve({ type: "redirect", status: this.statusCode, location });
      },
    };

    middleware(request, response, (error) => {
      if (error) reject(error);
      else resolve({ type: "next", request });
    });
  });
}

function signedSuiteCookie(payload) {
  return `suite_auth_token=${jwt.sign(payload, TEST_SECRET, { expiresIn: "1h" })}`;
}

test("allows the Madeira panel for a Suite session with the madeira module", async () => {
  const middleware = createSuiteModuleAuthMiddleware({ secret: TEST_SECRET });
  const result = await runMiddleware(middleware, {
    method: "GET",
    path: "/painel",
    originalUrl: "/madeiramadeira/painel",
    headers: {
      accept: "text/html",
      cookie: signedSuiteCookie({
        email: "operacao@davantti.com.br",
        allowed_modules: ["madeiramadeira"],
      }),
    },
  });

  assert.equal(result.type, "next");
  assert.equal(result.request.suiteSession.email, "operacao@davantti.com.br");
});

test("redirects an authenticated account without Madeira access to the platform selector", async () => {
  const middleware = createSuiteModuleAuthMiddleware({ secret: TEST_SECRET });
  const result = await runMiddleware(middleware, {
    method: "GET",
    path: "/painel",
    originalUrl: "/madeiramadeira/painel",
    headers: {
      accept: "text/html",
      cookie: signedSuiteCookie({
        email: "operacao@davantti.com.br",
        allowed_modules: ["ml"],
      }),
    },
  });

  assert.deepEqual(result, {
    type: "redirect",
    status: 200,
    location: "/selecao-plataforma?module=denied",
  });
});

test("returns JSON authentication failure instead of HTML for protected APIs without a Suite session", async () => {
  const middleware = createSuiteModuleAuthMiddleware({ secret: TEST_SECRET });
  const result = await runMiddleware(middleware, {
    method: "GET",
    path: "/api/dashboard/overview",
    originalUrl: "/madeiramadeira/api/dashboard/overview",
    headers: { accept: "application/json" },
  });

  assert.deepEqual(result, {
    type: "json",
    status: 401,
    body: {
      ok: false,
      error: "Sessao da Suite ausente ou invalida.",
      redirect: "/login",
    },
  });
});
