const http = require("node:http");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

const { createHostedExpressApp } = require("../platform/runtime/startExpressApp");

async function withServer(app, run) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("hosted product keeps routes below its prefix and exposes prefix health", async () => {
  const app = await createHostedExpressApp({
    name: "example",
    mountPath: "/example",
    createApp: async () => {
      const product = express();
      product.get("/oauth/callback", (_req, res) => res.status(204).end());
      return product;
    },
  });

  await withServer(app, async (origin) => {
    const health = await fetch(`${origin}/example/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, app: "example" });

    const callback = await fetch(`${origin}/example/oauth/callback`);
    assert.equal(callback.status, 204);
  });
});

test("every standalone starter declares its stable public prefix", () => {
  const prefixes = {
    "apps/seller-ml/start.js": "/ml",
    "apps/seller-shopee/start.js": "/shopee",
    "apps/seller-madeira/start.js": "/madeiramadeira",
    "apps/seller-tracking/start.js": "/avantracking",
    "apps/seller-log/start.js": "/davanttilog",
    "apps/seller-leader/start.js": "/skuleader",
    "apps/business/server.js": "/business",
  };

  for (const [relativePath, mountPath] of Object.entries(prefixes)) {
    const source = fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
    assert.match(source, new RegExp(`mountPath:\\s*["']${mountPath}["']`));
  }
});

test("Seller deployment commands launch prefix hosts and probe their mounted health paths", () => {
  const packages = {
    "apps/seller-ml/package.json": { start: "node start.js", dev: "nodemon start.js" },
    "apps/seller-shopee/package.json": { start: "node start.js", dev: "nodemon start.js" },
    "apps/seller-madeira/package.json": { start: "node start.js" },
    "apps/seller-tracking/package.json": { start: "node start.js", dev: "node --watch start.js" },
  };

  for (const [relativePath, expectedScripts] of Object.entries(packages)) {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8"));
    for (const [script, expectedCommand] of Object.entries(expectedScripts)) {
      assert.equal(packageJson.scripts[script], expectedCommand, `${relativePath} ${script}`);
    }
  }

  const mlRender = fs.readFileSync(path.join(__dirname, "..", "apps", "seller-ml", "render.yaml"), "utf8");
  assert.match(mlRender, /startCommand:\s*["']?node start\.js["']?/);
  assert.match(mlRender, /healthCheckPath:\s*["']?\/ml\/health["']?/);

  const rootRender = fs.readFileSync(path.join(__dirname, "..", "render.yaml"), "utf8");
  const businessService = rootRender.slice(rootRender.indexOf("name: volt-corp"));
  assert.match(businessService, /healthCheckPath:\s*\/business\/health/);
  assert.match(businessService, /key:\s*DACHBYTE_CHAT_API_URL\s*\n\s*sync:\s*false/);
  assert.equal(businessService.includes("VOLT_CHAT_UPSTREAM_URL"), false);
});
