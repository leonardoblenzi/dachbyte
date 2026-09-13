"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { runWithRequestContext, getRequestContext, setRequestContext } = require("../../observability/requestContext");
const { assertConfigHasNoSecrets, backoffMs, normalizeCredentialRef } = require("./helpers");
const { registerJobHandler, getJobHandler, registerOutboxHandler, getOutboxHandlers } = require("./registry");
const { registerWebhookAdapter, getWebhookAdapter } = require("./webhookRegistry");
const { resolveCredentialRef } = require("./credentialRegistry");
const { redactString } = require("../../observability/logger");

function source(relative) { return fs.readFileSync(path.join(__dirname, "..", "..", "..", relative), "utf8"); }

test("phase D migration creates durable tenant-isolated integration primitives", () => {
  const migration = source("db/016_observability_integration_engine.sql");
  for (const table of ["integration_accounts", "integration_mappings", "integration_jobs", "integration_job_attempts", "integration_webhook_events", "integration_outbox_events"]) {
    assert.match(migration, new RegExp(`create table if not exists volt_core\\.${table}`));
    assert.match(migration, new RegExp(`'${table}'`));
  }
  assert.match(migration, /FORCE ROW LEVEL SECURITY/i);
  assert.match(migration, /company_id, provider, coalesce\(account_id, ''\), external_event_id/i);
});

test("phase D request context carries request, user and tenant correlation without globals", async () => {
  await Promise.all([
    runWithRequestContext({ requestId: "req-a" }, async () => {
      setRequestContext({ companyId: "company-a", userId: "user-a" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.deepEqual(getRequestContext(), { requestId: "req-a", companyId: "company-a", userId: "user-a" });
    }),
    runWithRequestContext({ requestId: "req-b" }, async () => {
      setRequestContext({ companyId: "company-b" });
      assert.equal(getRequestContext().companyId, "company-b");
    }),
  ]);
});

test("phase D never stores integration secrets in account config", () => {
  assert.doesNotThrow(() => assertConfigHasNoSecrets({ warehouseId: "abc", options: { mode: "sync" } }));
  assert.throws(() => assertConfigHasNoSecrets({ accessToken: "secret" }), (error) => error.code === "INTEGRATION_SECRET_STORAGE_FORBIDDEN");
  assert.throws(() => assertConfigHasNoSecrets({ nested: { api_key: "secret" } }), (error) => error.code === "INTEGRATION_SECRET_STORAGE_FORBIDDEN");
  assert.equal(normalizeCredentialRef("env:MERCADO_LIVRE_TOKEN"), "env:MERCADO_LIVRE_TOKEN");
  assert.throws(() => normalizeCredentialRef("raw:my-secret"), (error) => error.code === "INTEGRATION_CREDENTIAL_REF_INSECURE");
  assert.throws(() => normalizeCredentialRef("my-secret-without-resolver"), (error) => error.code === "INTEGRATION_CREDENTIAL_REF_INVALID");
});

test("phase D credential refs resolve secrets outside the database", async () => {
  const previous = process.env.PHASE_D_TEST_SECRET;
  process.env.PHASE_D_TEST_SECRET = "secret-value";
  try {
    assert.equal(await resolveCredentialRef("env:PHASE_D_TEST_SECRET"), "secret-value");
    await assert.rejects(() => resolveCredentialRef("env:PHASE_D_MISSING_SECRET"), (error) => error.code === "INTEGRATION_CREDENTIAL_MISSING");
  } finally {
    if (previous === undefined) delete process.env.PHASE_D_TEST_SECRET;
    else process.env.PHASE_D_TEST_SECRET = previous;
  }
});

test("phase D retry backoff is exponential and capped", () => {
  const first = backoffMs(1);
  const second = backoffMs(2);
  const third = backoffMs(3);
  assert.ok(first >= 1000);
  assert.equal(second, Math.min(Number(process.env.VOLT_CORE_JOB_RETRY_MAX_MS || 900000), first * 2));
  assert.equal(third, Math.min(Number(process.env.VOLT_CORE_JOB_RETRY_MAX_MS || 900000), first * 4));
});

test("phase D registries support jobs, outbox subscribers and verified webhook adapters", () => {
  const removeJob = registerJobHandler("phase_d.test", async () => true);
  assert.equal(typeof getJobHandler("phase_d.test"), "function");
  removeJob();
  assert.equal(getJobHandler("phase_d.test"), null);

  const removeOutboxA = registerOutboxHandler("sale.created", async () => "a");
  const removeOutboxB = registerOutboxHandler("*", async () => "all");
  assert.equal(getOutboxHandlers("sale.created").length, 2);
  removeOutboxA(); removeOutboxB();

  assert.throws(() => registerWebhookAdapter("provider-x", { verify() {} }), /verify, resolveAccount e normalize/);
  const removeWebhook = registerWebhookAdapter("provider-x", {
    verify: async () => true,
    resolveAccount: async () => ({ companyId: "company-a" }),
    normalize: async () => ({ externalEventId: "1", eventType: "created", payload: {} }),
  });
  assert.ok(getWebhookAdapter("provider-x"));
  removeWebhook();
  assert.equal(getWebhookAdapter("provider-x"), null);
});

test("phase D worker uses SKIP LOCKED, lease recovery, tenant context and dead-letter", () => {
  const jobStore = source("src/modules/integrations/jobStore.js");
  const jobEngine = source("src/modules/integrations/jobEngine.js");
  const outboxEngine = source("src/modules/integrations/outboxEngine.js");
  assert.match(jobStore, /for update skip locked/i);
  assert.match(jobStore, /claimJobById/);
  assert.match(jobStore, /WORKER_LEASE_EXPIRED/);
  assert.match(jobEngine, /withTenantContext\(job\.company_id/);
  assert.match(jobEngine, /dead_letter/);
  assert.match(outboxEngine, /withTenantContext\(event\.company_id/);
  assert.match(outboxEngine, /processOutboxById/);
});

test("phase D public webhook endpoint is fail-closed until a verified provider adapter is registered", async () => {
  const createApp = require("../../app");
  const app = createApp();
  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/core/webhooks/provider-unregistered`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "evt-1" }),
    });
    const payload = await response.json();
    assert.equal(response.status, 404);
    assert.equal(payload.error.code, "WEBHOOK_PROVIDER_NOT_REGISTERED");
    assert.ok(response.headers.get("x-request-id"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


test("phase D staging validator processes only probe ids and never drains the shared queue", () => {
  const validator = source("scripts/validate-phase-d.js");
  assert.match(validator, /processJobById/);
  assert.match(validator, /processOutboxById/);
  assert.match(validator, /processOutboxById\s*\(\s*workerId\s*,\s*`outbox-missing-\$\{suffix\}`\s*\)/);
  assert.match(validator, /assert\.equal\s*\(\s*missingOutbox\s*,\s*null\s*\)/);
  assert.match(validator, /empty_outbox_noop/);
  assert.doesNotMatch(validator, /runJobBatch/);
  assert.doesNotMatch(validator, /runOutboxBatch/);
});

test("phase D integration engine is a required platform capability with explicit permissions", () => {
  const modules = source("src/modules/core/registries/modules.js");
  const permissions = source("src/modules/core/registries/permissions.js");
  assert.match(modules, /key:\s*"integrations"[\s\S]*required:\s*true/);
  assert.match(permissions, /integrations:read/);
  assert.match(permissions, /integrations:write/);
});

test("phase D domain events are atomically mirrored to outbox", () => {
  const helpers = source("src/modules/core/runtime/services/persistenceHelpers.js");
  assert.match(helpers, /insertDomainEventWithClient/);
  assert.match(helpers, /insertOutboxEventWithClient/);
  assert.match(helpers, /domain-event:/);
});


test("phase D observability redacts credentials from structured log strings", () => {
  assert.equal(redactString("Authorization: Bearer abc.def.ghi"), "Authorization: Bearer [REDACTED]");
  assert.equal(redactString("postgresql://user:super-secret@host/db"), "postgresql://user:[REDACTED]@host/db");
  assert.equal(redactString("https://example.test/callback?access_token=sensitive&ok=1"), "https://example.test/callback?access_token=[REDACTED]&ok=1");
});

test("phase D webhook resolution is global-only before signature verification and tenant entry", () => {
  const registry = source("src/modules/integrations/webhookRegistry.js");
  const service = source("src/modules/integrations/integrationService.js");
  const resolvePosition = registry.indexOf("adapter.resolveAccount(request)");
  const verifyPosition = registry.indexOf("adapter.verify(request, account)");
  const tenantPosition = registry.indexOf("db.withTenantContext(companyId");
  assert.ok(resolvePosition >= 0 && verifyPosition > resolvePosition && tenantPosition > verifyPosition);
  assert.match(service, /resolveIntegrationAccountGlobally[\s\S]*withRlsBypass/);
});

test("phase D observability exposes structured request and slow query instrumentation", () => {
  const app = source("src/app.js");
  const dbSource = source("db/db.js");
  const errorHandler = source("src/middlewares/errorHandler.js");
  assert.match(app, /requestObservability/);
  assert.match(dbSource, /db\.query\.slow/);
  assert.match(dbSource, /VOLT_CORE_SLOW_QUERY_MS/);
  assert.match(errorHandler, /http\.error/);
});

test("phase D embedded Volt Core lifecycle starts the integration worker outside src/server.js", () => {
  const entrypoint = source("index.js");
  const server = source("src/server.js");
  const lifecycle = source("src/runtime/coreRuntimeLifecycle.js");
  const worker = source("src/modules/integrations/worker.js");

  assert.match(entrypoint, /await startCoreRuntime\(\{ source: "embedded"/);
  assert.match(entrypoint, /createVoltCoreApp\.stopRuntime = stopCoreRuntime/);
  assert.match(server, /await startCoreRuntime\(\{ source: "standalone"/);
  assert.match(server, /await stopCoreRuntime\(\{ closePool: true/);
  assert.match(lifecycle, /void worker\.start\(\)/);
  assert.match(lifecycle, /process\.once\("SIGTERM"/);
  assert.match(worker, /const firstRun = runOnce\(\)/);
  assert.match(worker, /return firstRun/);
});

test("phase D core health is public and exposes database plus worker lifecycle", async () => {
  const routes = source("src/routes/core.routes.js");
  const healthPosition = routes.indexOf('router.get("/health"');
  const authPosition = routes.indexOf("router.use(ensureAuth)");
  assert.ok(healthPosition >= 0 && authPosition > healthPosition, "Core health must be registered before authentication");

  const createApp = require("../../app");
  const app = createApp();
  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/core/health`);
    const payload = await response.json();
    assert.notEqual(response.status, 401);
    assert.equal(payload.name, "Volt Core API");
    assert.ok(Object.hasOwn(payload, "database"));
    assert.equal(typeof payload.worker, "object");
    assert.ok(Object.hasOwn(payload.worker, "started"));
    assert.ok(Object.hasOwn(payload.worker, "running"));
    assert.ok(Object.hasOwn(payload.worker, "lastRunAt"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
