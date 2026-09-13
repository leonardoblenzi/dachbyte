"use strict";

const jobHandlers = new Map();
const outboxHandlers = new Map();

function registerJobHandler(type, handler) {
  const key = String(type || "").trim();
  if (!key || typeof handler !== "function") throw new Error("Handler de job invalido.");
  jobHandlers.set(key, handler);
  return () => jobHandlers.delete(key);
}

function registerOutboxHandler(eventType, handler) {
  const key = String(eventType || "").trim();
  if (!key || typeof handler !== "function") throw new Error("Handler de outbox invalido.");
  const current = outboxHandlers.get(key) || [];
  current.push(handler);
  outboxHandlers.set(key, current);
  return () => {
    const next = (outboxHandlers.get(key) || []).filter((item) => item !== handler);
    if (next.length) outboxHandlers.set(key, next);
    else outboxHandlers.delete(key);
  };
}

function getJobHandler(type) { return jobHandlers.get(String(type || "").trim()) || null; }
function getOutboxHandlers(eventType) {
  return [
    ...(outboxHandlers.get(String(eventType || "").trim()) || []),
    ...(outboxHandlers.get("*") || []),
  ];
}

// Safe internal probes. They are not exposed by an enqueue HTTP endpoint and
// exist so staging can validate the durable queue before a marketplace connector exists.
registerJobHandler("system.noop", async ({ payload }) => ({ ok: true, echo: payload || {} }));
registerJobHandler("system.recovery_probe", async ({ job, payload }) => {
  if (Number(job.manual_retries || 0) < 1) {
    const error = new Error("Falha diagnostica esperada antes do retry manual.");
    error.code = "PHASE_D_EXPECTED_FAILURE";
    error.retryable = false;
    throw error;
  }
  return { recovered: true, echo: payload || {} };
});
registerOutboxHandler("system.phase_d_probe", async ({ payload }) => ({ consumed: true, echo: payload || {} }));

module.exports = { getJobHandler, getOutboxHandlers, registerJobHandler, registerOutboxHandler };
