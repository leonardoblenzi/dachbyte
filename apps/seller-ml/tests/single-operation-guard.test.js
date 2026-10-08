"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

class FakeRedis {
  constructor() {
    this.values = new Map();
    this.expires = new Map();
    this.fail = false;
  }

  reset() {
    this.values.clear();
    this.expires.clear();
    this.fail = false;
  }

  async incr(key) {
    if (this.fail) throw new Error("redis_down");
    const next = Number(this.values.get(key) || 0) + 1;
    this.values.set(key, next);
    return next;
  }

  async expire(key, seconds) {
    if (this.fail) throw new Error("redis_down");
    this.expires.set(key, Number(seconds));
    return 1;
  }

  async ttl(key) {
    if (this.fail) throw new Error("redis_down");
    if (!this.values.has(key)) return -2;
    return this.expires.get(key) ?? -1;
  }

  async set(key, value, mode, seconds) {
    if (this.fail) throw new Error("redis_down");
    this.values.set(key, value);
    if (String(mode).toUpperCase() === "EX") {
      this.expires.set(key, Number(seconds));
    }
    return "OK";
  }
}

const fakeRedis = new FakeRedis();
const originalLoad = Module._load;
Module._load = function mockDependencies(request, parent, isMain) {
  if (request === "../lib/redisClient") {
    return {
      getSharedRedis: () => fakeRedis,
    };
  }
  if (request === "./authAuditService") {
    return {
      getRequestIp: () => "127.0.0.1",
      getRequestUserAgent: () => "test",
      recordAuthEvent: async () => null,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const Guard = require("../services/singleOperationGuardService");
Module._load = originalLoad;

function resFor(accountId = "77") {
  return {
    locals: {
      mlCreds: { meli_conta_id: accountId },
      accountKey: `account-${accountId}`,
    },
  };
}

test("politicas unitarias usam os limites aprovados", () => {
  assert.deepEqual(Guard.POLICIES["listing.delete"], {
    burstLimit: 15,
    sustainedLimit: 50,
    bulkOperation: "listing.bulk-delete",
  });
  assert.deepEqual(Guard.POLICIES["promotions.remove"], {
    burstLimit: 20,
    sustainedLimit: 100,
    bulkOperation: "promotions.remove",
  });
  assert.deepEqual(Guard.POLICIES["production-time.apply"], {
    burstLimit: 30,
    sustainedLimit: 150,
    bulkOperation: "production-time.apply",
  });
  assert.deepEqual(Guard.POLICIES["dimensions.apply"], {
    burstLimit: 30,
    sustainedLimit: 150,
    bulkOperation: "dimensions.apply",
  });
});

test("exclusao individual permite 15 por minuto e bloqueia a 16a", async () => {
  fakeRedis.reset();
  const res = resFor("delete-account");

  for (let i = 1; i <= 15; i += 1) {
    const decision = await Guard.checkAndRecordAttempt({
      res,
      operation: "listing.delete",
    });
    assert.equal(decision.allowed, true, `tentativa ${i}`);
  }

  const blocked = await Guard.checkAndRecordAttempt({
    res,
    operation: "listing.delete",
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "burst_limit_exceeded");
  assert.equal(blocked.policy.bulkOperation, "listing.bulk-delete");
  assert.equal(blocked.retryAfterSeconds, 600);

  const cooldown = await Guard.checkAndRecordAttempt({
    res,
    operation: "listing.delete",
  });
  assert.equal(cooldown.allowed, false);
  assert.equal(cooldown.reason, "cooldown_active");
});

test("limites sao isolados por conta e operacao", async () => {
  fakeRedis.reset();
  const accountA = resFor("A");
  const accountB = resFor("B");

  for (let i = 0; i < 20; i += 1) {
    const decision = await Guard.checkAndRecordAttempt({
      res: accountA,
      operation: "promotions.remove",
    });
    assert.equal(decision.allowed, true);
  }

  const blockedA = await Guard.checkAndRecordAttempt({
    res: accountA,
    operation: "promotions.remove",
  });
  assert.equal(blockedA.allowed, false);

  const allowedB = await Guard.checkAndRecordAttempt({
    res: accountB,
    operation: "promotions.remove",
  });
  assert.equal(allowedB.allowed, true);

  const otherOperation = await Guard.checkAndRecordAttempt({
    res: accountA,
    operation: "production-time.apply",
  });
  assert.equal(otherOperation.allowed, true);
});

test("successful_changes sao contados separadamente de attempts", async () => {
  fakeRedis.reset();
  const res = resFor("success-account");
  await Guard.checkAndRecordAttempt({
    res,
    operation: "dimensions.apply",
  });
  const success = await Guard.recordSuccessfulChange({
    res,
    operation: "dimensions.apply",
  });

  assert.deepEqual(success, { success1m: 1, success10m: 1 });

  const identity = Guard.accountIdentity(res);
  const keys = Guard._test.keys(identity, "dimensions.apply");
  assert.equal(fakeRedis.values.get(keys.attempts1m), 1);
  assert.equal(fakeRedis.values.get(keys.success1m), 1);
});

test("Redis indisponivel falha aberto para nao derrubar operacao individual", async () => {
  fakeRedis.reset();
  fakeRedis.fail = true;
  const decision = await Guard.checkAndRecordAttempt({
    res: resFor("redis-down"),
    operation: "listing.delete",
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.guarded, false);
  assert.equal(decision.reason, "redis_unavailable");
});

test("middleware unitario aceita exatamente um MLB valido", async () => {
  const middleware = Guard.requireSingleMlb((req) => req.body?.mlb);
  let nextCalled = false;
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };

  middleware(
    { body: { mlb: ["MLB123456"] } },
    response,
    () => {
      nextCalled = true;
    },
  );
  assert.equal(nextCalled, false);
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, "single_item_required");

  nextCalled = false;
  response.statusCode = 200;
  response.body = null;
  const req = { body: { mlb: "mlb123456" } };
  middleware(req, response, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(req.singleOperationMlb, "MLB123456");
});

test("rotas prioritarias usam guard sem adicionar cobranca de creditos", () => {
  const base = path.join(__dirname, "..");
  const deletion = fs.readFileSync(path.join(base, "routes/excluirAnuncioRoutes.js"), "utf8");
  const promo = fs.readFileSync(path.join(base, "routes/removerPromocaoRoutes.js"), "utf8");
  const production = fs.readFileSync(path.join(base, "routes/prazoProducaoRoutes.js"), "utf8");
  const dimensions = fs.readFileSync(path.join(base, "routes/validarDimensoesRoutes.js"), "utf8");

  assert.match(deletion, /guardSingleOperation\(['"]listing\.delete['"]\)/);
  assert.match(promo, /guardSingleOperation\(["']promotions\.remove["']\)/);
  assert.match(production, /guardSingleOperation\(["']production-time\.apply["']\)/);
  assert.match(dimensions, /guardSingleOperation\(["']dimensions\.apply["']\)/);
  assert.match(dimensions, /const mutates\s*=/);

  const service = fs.readFileSync(
    path.join(base, "services/singleOperationGuardService.js"),
    "utf8",
  );
  assert.doesNotMatch(service, /reserveCredits|settleCredits|quoteCredits/);
});
