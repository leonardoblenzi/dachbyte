// @ts-check
"use strict";

/** Filas da E3 (prefixo hub- para não misturar com os módulos DACH). */
const PUSH_QUEUE = "hub-stock-push";
const ORDERS_QUEUE = "hub-orders";
/** Espera antes de enviar: junta várias vendas do mesmo período num envio só por conta. */
const PUSH_DEBOUNCE_MS = 5_000;
const POLL_EVERY_MS = 10 * 60 * 1000;

/**
 * @typedef {{
 *   push: (accountId: number) => Promise<unknown>,
 *   webhook: (eventId: number) => Promise<unknown>,
 *   pollAll: () => Promise<unknown>,
 * }} SyncHandlers
 */

/** @param {string} redisUrl */
function redisConnection(redisUrl) {
  const { Redis } = require("ioredis");
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
  connection.on("error", (error) => console.error("[seller-hub:redis]", error?.message || error));
  return connection;
}

/**
 * Filas de envio de estoque e de pedidos.
 * - Com Redis: BullMQ, processadas pelo worker.
 * - Sem Redis (desenvolvimento): roda no próprio processo; sem leitura periódica.
 * @param {{ redisUrl: string, handlers: () => SyncHandlers }} options handlers é função para permitir ligação tardia
 */
function createSyncQueues({ redisUrl, handlers }) {
  if (!redisUrl) {
    /** @type {Map<number, ReturnType<typeof setTimeout>>} */
    const timers = new Map();
    const log = (/** @type {string} */ what) => (/** @type {any} */ error) => console.error(`[seller-hub:${what}]`, error?.message || error);
    return {
      mode: "inline",
      /** @param {number} accountId @param {number} [delayMs] */
      async enqueuePush(accountId, delayMs = PUSH_DEBOUNCE_MS) {
        if (timers.has(accountId)) return;
        timers.set(accountId, setTimeout(() => { timers.delete(accountId); handlers().push(accountId).catch(log("push")); }, delayMs));
      },
      /** @param {number} eventId */
      async enqueueWebhook(eventId) { setImmediate(() => { handlers().webhook(eventId).catch(log("webhook")); }); },
      async close() { for (const t of timers.values()) clearTimeout(t); timers.clear(); },
    };
  }
  const { Queue } = require("bullmq");
  const connection = redisConnection(redisUrl);
  const pushQueue = new Queue(PUSH_QUEUE, { connection, defaultJobOptions: { attempts: 1, removeOnComplete: 500, removeOnFail: 1000 } });
  const ordersQueue = new Queue(ORDERS_QUEUE, { connection, defaultJobOptions: { attempts: 5, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: 1000, removeOnFail: 2000 } });
  return {
    mode: "bullmq",
    /** Um job por conta por janela: chamadas repetidas na mesma janela viram um envio só. @param {number} accountId @param {number} [delayMs] */
    async enqueuePush(accountId, delayMs = PUSH_DEBOUNCE_MS) {
      const bucket = Math.floor(Date.now() / Math.max(1000, delayMs));
      await pushQueue.add("push", { accountId }, { jobId: `push-${accountId}-${bucket}`, delay: delayMs });
    },
    /** @param {number} eventId */
    async enqueueWebhook(eventId) { await ordersQueue.add("webhook", { eventId }, { jobId: `webhook-${eventId}` }); },
    async close() { await pushQueue.close(); await ordersQueue.close(); await connection.quit().catch(() => {}); },
  };
}

/**
 * Workers da E3 e a leitura periódica de pedidos (a cada 10 min).
 * @param {{ redisUrl: string, handlers: SyncHandlers, pollEveryMs?: number }} options
 */
async function startSyncWorkers({ redisUrl, handlers, pollEveryMs = POLL_EVERY_MS }) {
  const { Worker, Queue } = require("bullmq");
  const connection = redisConnection(redisUrl);
  const push = new Worker(PUSH_QUEUE, async (job) => handlers.push(Number(job.data.accountId)), { connection, concurrency: 4 });
  const orders = new Worker(ORDERS_QUEUE, async (job) => (job.name === "poll-all" ? handlers.pollAll() : handlers.webhook(Number(job.data.eventId))), { connection, concurrency: 3 });
  for (const [name, worker] of /** @type {Array<[string, any]>} */ ([["push", push], ["orders", orders]])) {
    worker.on("failed", (/** @type {any} */ job, /** @type {any} */ error) => console.error(`[seller-hub:worker:${name}] falhou`, job?.id, error?.message));
  }
  const scheduler = new Queue(ORDERS_QUEUE, { connection });
  await scheduler.add("poll-all", {}, { repeat: { every: pollEveryMs }, jobId: "poll-all", removeOnComplete: 50, removeOnFail: 50 });
  return {
    async close() { await push.close(); await orders.close(); await scheduler.close(); await connection.quit().catch(() => {}); },
  };
}

module.exports = { createSyncQueues, startSyncWorkers, PUSH_QUEUE, ORDERS_QUEUE, PUSH_DEBOUNCE_MS };
