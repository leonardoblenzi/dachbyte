"use strict";

const crypto = require("node:crypto");
const { Queue } = require("bullmq");
const { ensureRedisConnected } = require("../config/redis");
const queueNames = require("../config/queueNames");

const queues = new Map();

async function getQueue(name) {
  if (!Object.values(queueNames).includes(name)) {
    throw new Error(`Fila Magalu desconhecida: ${name}`);
  }
  if (queues.has(name)) return queues.get(name);
  const connection = await ensureRedisConnected();
  const queue = new Queue(name, { connection });
  queues.set(name, queue);
  return queue;
}

async function enqueueWebhookEvent(eventId) {
  const queue = await getQueue(queueNames.webhookProcess);
  return queue.add("process", { eventId: Number(eventId) }, {
    jobId: `magalu-webhook-${Number(eventId)}`,
    attempts: 5,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 500,
    removeOnFail: 1000,
  });
}

async function enqueueTokenRefresh(accountId) {
  const id = Number(accountId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("accountId inválido para refresh Magalu.");
  const queue = await getQueue(queueNames.tokenRefresh);
  return queue.add("refresh", { accountId: id }, {
    jobId: `magalu-token-refresh-${id}`,
    attempts: 4,
    backoff: { type: "exponential", delay: 10000 },
    removeOnComplete: true,
    removeOnFail: true,
  });
}

async function enqueueCatalogSync(accountId, { dachTenantId = null, reason = "manual" } = {}) {
  const id = Number(accountId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("accountId inválido para sync Magalu.");
  const queue = await getQueue(queueNames.catalogSync);
  return queue.add("full-sync", { accountId: id, dachTenantId: dachTenantId || null, reason }, {
    jobId: `magalu-catalog-full-${id}-${crypto.randomUUID()}`,
    attempts: 2,
    backoff: { type: "exponential", delay: 15000 },
    removeOnComplete: 200,
    removeOnFail: 500,
  });
}

async function enqueueHubResourceSync(accountId) {
  const id = Number(accountId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("accountId inválido para recurso Hub Magalu.");
  const queue = await getQueue(queueNames.hubResourceSync);
  const jobId = `magalu-hub-resource-${id}`;
  const existing = typeof queue.getJob === "function" ? await queue.getJob(jobId) : null;
  if (existing) return { id: existing.id, scheduled: false };
  const job = await queue.add("sync-resource", { accountId: id }, {
    jobId,
    attempts: 5,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: true,
    removeOnFail: true,
  });
  return { id: job.id, scheduled: true };
}

async function enqueueCatalogReconcile(accountId, sku, { topic = "manual", eventId = null } = {}) {
  const id = Number(accountId);
  const normalizedSku = String(sku || "").trim();
  if (!Number.isFinite(id) || id <= 0 || !normalizedSku) {
    throw new Error("Conta/SKU inválidos para reconciliação Magalu.");
  }
  const queue = await getQueue(queueNames.catalogSync);
  return queue.add("reconcile-sku", {
    accountId: id,
    sku: normalizedSku,
    topic,
    eventId: eventId ? Number(eventId) : null,
  }, {
    jobId: `magalu-catalog-sku-${id}-${Buffer.from(normalizedSku).toString("hex").slice(0, 48)}-${Date.now()}`,
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 500,
    removeOnFail: 1000,
  });
}

async function enqueueWriteOperation(operation, { reason = "apply" } = {}) {
  const id = Number(operation?.id);
  const resource = String(operation?.resource_type || "");
  if (!Number.isFinite(id) || id <= 0 || !["price", "stock"].includes(resource)) {
    throw new Error("Operação Magalu inválida para fila de escrita.");
  }
  const queueName = resource === "price" ? queueNames.priceUpdate : queueNames.stockUpdate;
  const queue = await getQueue(queueName);
  const jobName = reason === "reverify" ? "verify" : "apply";
  return queue.add(jobName, { operationId: id, reason }, {
    jobId: `magalu-${resource}-update-${id}-${crypto.randomUUID()}`,
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 500,
    removeOnFail: 1000,
  });
}

async function closeQueues() {
  await Promise.all([...queues.values()].map((queue) => queue.close().catch(() => {})));
  queues.clear();
}

module.exports = {
  getQueue,
  enqueueWebhookEvent,
  enqueueTokenRefresh,
  enqueueCatalogSync,
  enqueueHubResourceSync,
  enqueueCatalogReconcile,
  enqueueWriteOperation,
  closeQueues,
  queueNames,
};
