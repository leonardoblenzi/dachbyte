"use strict";

const logger = require("../../observability/logger");
const db = require("../../../db/db");
const { runWithRequestContext } = require("../../observability/requestContext");
const metrics = require("../../observability/metrics");
const { backoffMs } = require("./helpers");
const { getOutboxHandlers } = require("./registry");
const { claimNextOutbox, claimOutboxById, finishOutbox, recoverStaleOutbox } = require("./outboxStore");

async function processClaimedOutbox(event, workerId) {
  if (!event) return null;
  const handlers = getOutboxHandlers(event.event_type);
  try {
    const outputs = [];
    for (const handler of handlers) outputs.push(await runWithRequestContext({
      requestId: event.request_id || event.correlation_id || event.id,
      companyId: event.company_id,
    }, () => db.withTenantContext(event.company_id, () => handler({ event, companyId: event.company_id, payload: event.payload || {} }))));
    const updatedResult = await finishOutbox(event, { status: "completed", result: { dispatched: handlers.length, outputs } });
    const updated = updatedResult?.rows?.[0] || updatedResult;
    metrics.recordIntegration("completedOutbox");
    const logCompleted = handlers.length ? logger.info : logger.debug;
    logCompleted("integration.outbox.completed", { requestId: event.request_id, correlationId: event.correlation_id, companyId: event.company_id, outboxId: event.id, eventType: event.event_type, subscribers: handlers.length });
    return updated;
  } catch (error) {
    const deadLetter = error?.retryable === false || Number(event.attempts) >= Number(event.max_attempts);
    const status = deadLetter ? "dead_letter" : "retrying";
    const availableAt = deadLetter ? null : new Date(Date.now() + backoffMs(event.attempts)).toISOString();
    const updatedResult = await finishOutbox(event, {
      status,
      errorCode: error?.code || "OUTBOX_DISPATCH_FAILED",
      errorMessage: String(error?.message || error).slice(0, 2000),
      availableAt,
    });
    if (deadLetter) metrics.recordIntegration("deadLetterOutbox");
    logger[deadLetter ? "error" : "warn"](deadLetter ? "integration.outbox.dead_letter" : "integration.outbox.retry", {
      requestId: event.request_id, correlationId: event.correlation_id, companyId: event.company_id, outboxId: event.id, eventType: event.event_type, attempt: event.attempts,
      errorCode: error?.code, errorMessage: error?.message, nextAttemptAt: availableAt,
    });
    return updatedResult?.rows?.[0] || updatedResult;
  }
}

async function processOneOutbox(workerId) {
  return processClaimedOutbox(await claimNextOutbox(workerId), workerId);
}

async function processOutboxById(workerId, eventId) {
  return processClaimedOutbox(await claimOutboxById(workerId, eventId), workerId);
}

async function runOutboxBatch(workerId, batchSize = 20) {
  const processed = [];
  for (let index = 0; index < Math.max(1, Number(batchSize || 20)); index += 1) {
    const event = await processOneOutbox(workerId);
    if (!event) break;
    processed.push(event);
  }
  return processed;
}

module.exports = { processOneOutbox, processOutboxById, recoverStaleOutbox, runOutboxBatch };
