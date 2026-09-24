const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { getCanonicalRedirect } = require("../platform/gateway/canonicalRoutes");

test("DachByte canonical paths retain legacy mounts and query strings", () => {
  assert.equal(getCanonicalRedirect("/dach/seller/mercado-livre", "?account=1", "seller"), "/ml?account=1");
  assert.equal(getCanonicalRedirect("/dach/business/stock", "?tab=labels", "business"), "/voltstock?tab=labels");
  assert.equal(getCanonicalRedirect("/dach/business/price/orders", "", "business"), "/volt-price/orders");
});

test("gateway does not mount product applications in-process", () => {
  const gatewayFile = path.join(__dirname, "..", "apps", "gateway", "server.js");
  assert.equal(fs.existsSync(gatewayFile), true, gatewayFile);

  const source = fs.readFileSync(gatewayFile, "utf8");

  for (const forbidden of [
    'require("../seller-ml")',
    'require("../seller-shopee")',
    'require("../seller-magalu")',
    'require("../seller-madeira")',
    'require("../seller-tracking")',
    'require("../seller-log")',
    'require("../seller-leader")',
    'require("../business/app")',
    'app.use("/business"',
    'app.use("/ml"',
    'app.use("/shopee"',
    'app.use("/magalu"',
    'app.use("/madeira"',
    'app.use("/madeiramadeira"',
    'app.use("/tracking"',
    'app.use("/avantracking"',
    'app.use("/log"',
    'app.use("/davanttilog"',
    'app.use("/leader"',
    'app.use("/skuleader"',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }

  assert.match(source, /app\.get\(\[?"\/health/);
});

test("products expose their own runtime starters and Business uses an external Chat API", () => {
  const expectedStarters = [
    "apps/seller-ml/start.js",
    "apps/seller-shopee/start.js",
    "apps/seller-magalu/start.js",
    "apps/seller-madeira/start.js",
    "apps/seller-tracking/start.js",
    "apps/seller-log/start.js",
    "apps/seller-leader/start.js",
    "apps/business/start.js",
    "platform/runtime/startExpressApp.js",
  ];

  for (const relativePath of expectedStarters) {
    assert.equal(fs.existsSync(path.join(__dirname, "..", relativePath)), true, relativePath);
  }

  const businessStart = fs.readFileSync(path.join(__dirname, "..", "apps", "business", "start.js"), "utf8");
  const chatProxy = fs.readFileSync(path.join(__dirname, "..", "apps", "business", "lib", "voltChatProxy.js"), "utf8");
  assert.equal(businessStart.includes("startVoltChatApi"), false);
  assert.match(chatProxy, /DACHBYTE_CHAT_API_URL/);
});
