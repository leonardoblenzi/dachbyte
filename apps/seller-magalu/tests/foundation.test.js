"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const signature = require("../src/webhooks/signature");
const queueNames = require("../src/config/queueNames");
process.env.MAGALU_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const tokenCipher = require("../src/services/tokenCipher");

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

test("seller-magalu does not import business code from ML or Shopee", () => {
  const directories = ["src", "db", "scripts"];
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:js|cjs)$/i.test(entry.name)) files.push(full);
    }
  };
  directories.forEach((dir) => walk(path.join(root, dir)));
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    assert.equal(source.includes("seller-ml"), false, file);
    assert.equal(source.includes("seller-shopee"), false, file);
  }
});

test("queue names are isolated by magalu prefix", () => {
  for (const name of Object.values(queueNames)) assert.match(name, /^magalu:/);
  assert.deepEqual(Object.values(queueNames).sort(), [
    "magalu:catalog:sync",
    "magalu:hub-resource:sync",
    "magalu:price:update",
    "magalu:stock:update",
    "magalu:token:refresh",
    "magalu:webhook:process",
  ]);
});

test("suite auth requires global DACH identity and explicit magalu entitlement", () => {
  const source = read("src/middlewares/suiteAuth.js");
  assert.match(source, /payload\.tenant_id/);
  assert.match(source, /payload\.user_id/);
  assert.match(source, /identity\.modules\.has\("magalu"\)/);
  assert.match(source, /checkHubAccess\(session\.identity, \{ action: "ACCESS magalu" \}\)/);
  assert.doesNotMatch(source, /seller-ml|seller-shopee/);
});


test("token vault encrypts and decrypts with dedicated Magalu key", () => {
  const encrypted = tokenCipher.encryptSecret("secret-stage1");
  assert.notEqual(encrypted, "secret-stage1");
  assert.match(encrypted, /^v1:/);
  assert.equal(tokenCipher.decryptSecret(encrypted), "secret-stage1");
});

test("webhook HMAC uses timestamp dot raw-body and timing-safe verification", () => {
  const secret = "whsec_stage1_test";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = Buffer.from('{"tenant_id":"tenant-x","topic":"portfolios_sku","data":{"status":"new"}}');
  const digest = crypto.createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody])).digest("hex");
  assert.equal(signature.verifySignature({
    rawBody,
    signatureHeader: `sha256=${digest}`,
    timestamp,
    secrets: [secret],
  }), true);
  assert.equal(signature.verifySignature({
    rawBody: Buffer.from(rawBody.toString().replace("new", "updated")),
    signatureHeader: `sha256=${digest}`,
    timestamp,
    secrets: [secret],
  }), false);
});

test("webhook accepts either signature during secret rotation", () => {
  const rawBody = Buffer.from('{"tenant_id":"tenant-x","topic":"portfolios_stock"}');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const oldSecret = "whsec_old";
  const newSecret = "whsec_new";
  const oldDigest = crypto.createHmac("sha256", oldSecret).update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody])).digest("hex");
  const newDigest = crypto.createHmac("sha256", newSecret).update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody])).digest("hex");
  assert.equal(signature.verifySignature({
    rawBody,
    signatureHeader: `sha256=${newDigest},sha256=${oldDigest}`,
    timestamp,
    secrets: [newSecret, oldSecret],
  }), true);
});

test("webhook rejects replay outside configured window", () => {
  const now = Date.now();
  const fresh = Math.floor(now / 1000) - 30;
  const old = Math.floor(now / 1000) - 900;
  assert.equal(signature.isTimestampFresh(fresh, 300, now), true);
  assert.equal(signature.isTimestampFresh(old, 300, now), false);
});

test("foundation migration creates isolated magalu schema and required tables", () => {
  const sql = read("db/migrations/001_foundation.sql");
  assert.match(sql, /create schema if not exists magalu/i);
  for (const table of ["accounts", "tokens", "oauth_states", "webhook_subscriptions", "webhook_events", "sync_runs"]) {
    assert.match(sql, new RegExp(`create table if not exists magalu\\.${table}`, "i"));
  }
  assert.doesNotMatch(sql, /\bml\./i);
  assert.doesNotMatch(sql, /\bshopee\./i);
});
