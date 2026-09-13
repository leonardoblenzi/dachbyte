"use strict";

process.env.SUITE_JWT_SECRET = "madeira-route-suite-auth-test-secret";

const http = require("node:http");
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const routes = require("../src/routes");

function request(app, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          headers,
        },
        (res) => {
          res.resume();
          res.on("end", () => {
            server.close((error) => {
              if (error) reject(error);
              else resolve(res);
            });
          });
        },
      );
      req.on("error", (error) => server.close(() => reject(error)));
      req.end();
    });
  });
}

function createApp() {
  const app = express();
  app.use(routes);
  return app;
}

function suiteCookie(allowedModules) {
  const token = jwt.sign(
    { email: "operacao@davantti.com.br", allowed_modules: allowedModules },
    process.env.SUITE_JWT_SECRET,
    { expiresIn: "1h" },
  );
  return `suite_auth_token=${token}`;
}

test("routes an authenticated Suite account with Madeira access directly to the panel", async () => {
  const response = await request(createApp(), "/", {
    accept: "text/html",
    cookie: suiteCookie(["madeiramadeira"]),
  });

  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, "painel");
});

test("does not expose the Madeira panel to a Suite account without the module", async () => {
  const response = await request(createApp(), "/painel", {
    accept: "text/html",
    cookie: suiteCookie(["ml"]),
  });

  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, "/selecao-plataforma?module=denied");
});
