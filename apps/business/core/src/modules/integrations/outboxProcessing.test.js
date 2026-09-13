"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../../../db/db");
const logger = require("../../observability/logger");
const metrics = require("../../observability/metrics");
const { claimNextOutbox, claimOutboxById } = require("./outboxStore");
const { runOutboxBatch } = require("./outboxEngine");
const { registerOutboxHandler } = require("./registry");

async function withOutboxRuntime(query, run) {
  const original = {
    query: db.query,
    withRlsBypass: db.withRlsBypass,
    withTenantContext: db.withTenantContext,
    debug: logger.debug,
    info: logger.info,
    warn: logger.warn,
    error: logger.error,
    recordIntegration: metrics.recordIntegration,
  };
  const observed = { logs: [], metrics: [], tenants: [] };
  db.query = (text, params) => query(String(text), params || []);
  db.withRlsBypass = (callback) => callback();
  db.withTenantContext = (companyId, callback) => {
    observed.tenants.push(companyId);
    return callback();
  };
  logger.info = (event, fields) => observed.logs.push({ level: "info", event, fields });
  logger.debug = (event, fields) => observed.logs.push({ level: "debug", event, fields });
  logger.warn = (event, fields) => observed.logs.push({ level: "warn", event, fields });
  logger.error = (event, fields) => observed.logs.push({ level: "error", event, fields });
  metrics.recordIntegration = (name) => observed.metrics.push(name);
  try {
    return await run(observed);
  } finally {
    db.query = original.query;
    db.withRlsBypass = original.withRlsBypass;
    db.withTenantContext = original.withTenantContext;
    logger.debug = original.debug;
    logger.info = original.info;
    logger.warn = original.warn;
    logger.error = original.error;
    metrics.recordIntegration = original.recordIntegration;
  }
}

function outboxEvent(overrides = {}) {
  return {
    id: "outbox-test-1",
    company_id: "company-test-1",
    event_type: "test.outbox.completed",
    payload: { probe: true },
    request_id: "request-test-1",
    correlation_id: "correlation-test-1",
    attempts: 1,
    max_attempts: 3,
    ...overrides,
  };
}

test("empty outbox claim returns null instead of PostgreSQL QueryResult", async () => {
  let queryCount = 0;
  await withOutboxRuntime(async () => {
    queryCount += 1;
    return { rows: [], rowCount: 0 };
  }, async () => {
    assert.equal(await claimNextOutbox("worker-empty-store"), null);
    assert.equal(await claimOutboxById("worker-empty-store", "outbox-missing"), null);
    assert.equal(queryCount, 2);
  });
});

test("empty outbox batch stops after one claim without log or metric", async () => {
  let queryCount = 0;
  await withOutboxRuntime(async () => {
    queryCount += 1;
    return { rows: [], rowCount: 0 };
  }, async (observed) => {
    const processed = await runOutboxBatch("worker-empty-batch", 20);
    assert.deepEqual(processed, []);
    assert.equal(queryCount, 1);
    assert.deepEqual(observed.logs, []);
    assert.deepEqual(observed.metrics, []);
    assert.deepEqual(observed.tenants, []);
  });
});

test("one real outbox event is dispatched and completed exactly once", async () => {
  const event = outboxEvent();
  let claims = 0;
  let finishes = 0;
  const removeHandler = registerOutboxHandler(event.event_type, async ({ payload }) => ({ consumed: payload.probe }));
  try {
    await withOutboxRuntime(async (text, params) => {
      if (/with candidate/i.test(text)) {
        claims += 1;
        return claims === 1 ? { rows: [event], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/set status=\$3/i.test(text)) {
        finishes += 1;
        assert.equal(params[2], "completed");
        assert.deepEqual(JSON.parse(params[3]), { dispatched: 1, outputs: [{ consumed: true }] });
        return { rows: [{ ...event, status: "completed" }], rowCount: 1 };
      }
      throw new Error(`SQL inesperado no teste: ${text}`);
    }, async (observed) => {
      const processed = await runOutboxBatch("worker-real-event", 20);
      assert.equal(processed.length, 1);
      assert.equal(claims, 2);
      assert.equal(finishes, 1);
      assert.deepEqual(observed.tenants, [event.company_id]);
      assert.deepEqual(observed.metrics, ["completedOutbox"]);
      const completed = observed.logs.filter((entry) => entry.event === "integration.outbox.completed");
      assert.equal(completed.length, 1);
      assert.equal(observed.logs.length, 1);
      assert.equal(completed[0].level, "info");
      assert.equal(completed[0].fields.companyId, event.company_id);
      assert.equal(completed[0].fields.outboxId, event.id);
      assert.equal(completed[0].fields.eventType, event.event_type);
    });
  } finally {
    removeHandler();
  }
});

test("real outbox event without subscribers completes at debug with full identifiers", async () => {
  const event = outboxEvent({ event_type: "test.outbox.without-subscribers" });
  let claims = 0;
  await withOutboxRuntime(async (text, params) => {
    if (/with candidate/i.test(text)) {
      claims += 1;
      return claims === 1 ? { rows: [event], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/set status=\$3/i.test(text)) {
      assert.equal(params[2], "completed");
      assert.deepEqual(JSON.parse(params[3]), { dispatched: 0, outputs: [] });
      return { rows: [{ ...event, status: "completed" }], rowCount: 1 };
    }
    throw new Error(`SQL inesperado no teste: ${text}`);
  }, async (observed) => {
    const processed = await runOutboxBatch("worker-no-subscriber", 20);
    assert.equal(processed.length, 1);
    assert.deepEqual(observed.metrics, ["completedOutbox"]);
    assert.equal(observed.logs.length, 1);
    const completed = observed.logs[0];
    assert.equal(completed.level, "debug");
    assert.equal(completed.event, "integration.outbox.completed");
    assert.equal(completed.fields.subscribers, 0);
    assert.equal(completed.fields.requestId, event.request_id);
    assert.equal(completed.fields.correlationId, event.correlation_id);
    assert.equal(completed.fields.companyId, event.company_id);
    assert.equal(completed.fields.outboxId, event.id);
    assert.equal(completed.fields.eventType, event.event_type);
  });
});

test("transient outbox failure is scheduled once for retry", async () => {
  const event = outboxEvent({ event_type: "test.outbox.retry" });
  let claims = 0;
  let retries = 0;
  const removeHandler = registerOutboxHandler(event.event_type, async () => {
    const error = new Error("temporary provider failure");
    error.code = "TEST_PROVIDER_TEMPORARY";
    error.retryable = true;
    throw error;
  });
  const retryStartedAt = Date.now();
  try {
    await withOutboxRuntime(async (text, params) => {
      if (/with candidate/i.test(text)) {
        claims += 1;
        return claims === 1 ? { rows: [event], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/set status=\$3/i.test(text)) {
        retries += 1;
        assert.equal(params[2], "retrying");
        assert.equal(params[4], "TEST_PROVIDER_TEMPORARY");
        assert.ok(new Date(params[6]).getTime() > retryStartedAt);
        return { rows: [{ ...event, status: "retrying", available_at: params[6] }], rowCount: 1 };
      }
      throw new Error(`SQL inesperado no teste: ${text}`);
    }, async (observed) => {
      const processed = await runOutboxBatch("worker-retry", 20);
      assert.equal(processed.length, 1);
      assert.equal(claims, 2);
      assert.equal(retries, 1);
      assert.equal(observed.logs.filter((entry) => entry.event === "integration.outbox.retry").length, 1);
      assert.equal(observed.logs.filter((entry) => entry.event === "integration.outbox.completed").length, 0);
      assert.equal(observed.logs.length, 1);
      assert.equal(observed.metrics.includes("completedOutbox"), false);
    });
  } finally {
    removeHandler();
  }
});

test("outbox failure at attempt limit is moved to dead letter once", async () => {
  const event = outboxEvent({ event_type: "test.outbox.dead", attempts: 3, max_attempts: 3 });
  let claims = 0;
  let deadLetters = 0;
  const removeHandler = registerOutboxHandler(event.event_type, async () => {
    const error = new Error("permanent failure");
    error.code = "TEST_PROVIDER_PERMANENT";
    throw error;
  });
  try {
    await withOutboxRuntime(async (text, params) => {
      if (/with candidate/i.test(text)) {
        claims += 1;
        return claims === 1 ? { rows: [event], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/set status=\$3/i.test(text)) {
        deadLetters += 1;
        assert.equal(params[2], "dead_letter");
        assert.equal(params[6], null);
        return { rows: [{ ...event, status: "dead_letter" }], rowCount: 1 };
      }
      throw new Error(`SQL inesperado no teste: ${text}`);
    }, async (observed) => {
      const processed = await runOutboxBatch("worker-dead-letter", 20);
      assert.equal(processed.length, 1);
      assert.equal(claims, 2);
      assert.equal(deadLetters, 1);
      assert.equal(observed.logs.filter((entry) => entry.event === "integration.outbox.dead_letter").length, 1);
      assert.equal(observed.logs.length, 1);
      assert.deepEqual(observed.metrics, ["deadLetterOutbox"]);
    });
  } finally {
    removeHandler();
  }
});
