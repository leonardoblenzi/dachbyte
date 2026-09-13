"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createHostedExpressApp } = require("../platform/runtime/startExpressApp");
test("product host preserves suite session, OAuth query and response cookies", async () => {
  const app = await createHostedExpressApp({
    name: "test", mountPath: "/ml",
    createApp: () => {
      const product = express();
      product.get("/callback", (req, res) => {
        res.cookie("product_session", "test", {path: "/ml", httpOnly: true, secure: true});
        res.json({cookie: req.headers.cookie, code: req.query.code, path: req.originalUrl});
      });
      return product;
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/ml/callback?code=a%2Bb", {
      headers: {cookie: "suite_auth_token=test"},
    });
    assert.deepEqual(await response.json(), {cookie: "suite_auth_token=test", code: "a+b", path: "/ml/callback?code=a%2Bb"});
    assert.match(response.headers.get("set-cookie"), /product_session=test; Path=\/ml; HttpOnly; Secure/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
