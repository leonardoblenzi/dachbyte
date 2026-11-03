"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const Store = require("../services/promoSmartCheckpointStore");

function fakeRedis() {
  const values = new Map();
  const ttls = new Map();
  return {
    values,
    ttls,
    async set(key, value, ...args) {
      values.set(key, String(value));
      const px = args.indexOf("PX");
      if (px >= 0) ttls.set(key, Number(args[px + 1]));
      return "OK";
    },
    async get(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async del(key) {
      const existed = values.delete(key);
      ttls.delete(key);
      return existed ? 1 : 0;
    },
    async sadd(key, member) {
      const current = new Set(JSON.parse(values.get(key) || "[]"));
      const before = current.size;
      current.add(String(member));
      values.set(key, JSON.stringify([...current]));
      return current.size > before ? 1 : 0;
    },
    async smembers(key) {
      return JSON.parse(values.get(key) || "[]");
    },
    async pexpire(key, ttl) {
      ttls.set(key, Number(ttl));
      return values.has(key) ? 1 : 0;
    },
  };
}

test("chave isola conta, analise e campanha", () => {
  assert.equal(
    Store.key("acct-1", "analysis-1", "campaign-1"),
    "promo:smart-scan:acct-1:analysis-1:campaign-1",
  );
  assert.notEqual(Store.key("acct-2", "analysis-1", "campaign-1"), Store.key("acct-1", "analysis-1", "campaign-1"));
});

test("save e load preservam checkpoint e aplicam expiracao", async () => {
  const redis = fakeRedis();
  const scope = { accountKey: "acct", analysisId: "a1", campaignId: "c1", ttlMs: 3600000 };
  const checkpoint = { strategy: "cursor", cursor: "next", pages: 3, coverage: "partial" };

  assert.equal(await Store.save(redis, scope, checkpoint), true);
  assert.deepEqual(await Store.load(redis, scope), checkpoint);
  assert.equal(redis.ttls.get(Store.key("acct", "a1", "c1")), 3600000);
});

test("manifesto lista campanhas sem usar KEYS do Redis", async () => {
  const redis = fakeRedis();
  const scope = { accountKey: "acct", analysisId: "a1", ttlMs: 3600000 };

  await Store.addToManifest(redis, scope, "c1");
  await Store.addToManifest(redis, scope, "c2");
  await Store.addToManifest(redis, scope, "c1");

  assert.deepEqual(await Store.listManifest(redis, scope), ["c1", "c2"]);
});

test("remove apaga somente checkpoint solicitado", async () => {
  const redis = fakeRedis();
  const first = { accountKey: "acct", analysisId: "a1", campaignId: "c1" };
  const second = { accountKey: "acct", analysisId: "a1", campaignId: "c2" };
  await Store.save(redis, first, { pages: 1 });
  await Store.save(redis, second, { pages: 2 });

  assert.equal(await Store.remove(redis, first), true);
  assert.equal(await Store.load(redis, first), null);
  assert.deepEqual(await Store.load(redis, second), { pages: 2 });
});

test("store sem Redis degrada sem expor dados", async () => {
  const scope = { accountKey: "acct", analysisId: "a1", campaignId: "c1" };
  assert.equal(await Store.save(null, scope, { cursor: "secret" }), false);
  assert.equal(await Store.load(null, scope), null);
  assert.deepEqual(await Store.listManifest(null, scope), []);
});
