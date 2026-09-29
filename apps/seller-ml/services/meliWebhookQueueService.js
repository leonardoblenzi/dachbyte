"use strict";

const crypto = require("crypto");
const Queue = require("bull");
const { makeBullClient } = require("../lib/redisClient");
const PromoOfferRefsService = require("./promoOfferRefsService");
const { validateWebhookNotification } = require("./meliWebhookSecurity");

const QUEUE_NAME = "meli-webhook-notifications";
const WORKER_CONCURRENCY = Math.max(
  1,
  Math.min(8, Number(process.env.ML_WEBHOOK_WORKER_CONCURRENCY || 2) || 2),
);

let queueInstance = null;
let workerStarted = false;

function getQueue() {
  if (!queueInstance) {
    queueInstance = new Queue(QUEUE_NAME, {
      createClient: (type) => makeBullClient(type, QUEUE_NAME),
    });
  }
  return queueInstance;
}

function buildJobId(notification) {
  const explicit = String(notification?._id || "").trim();
  const source = explicit || JSON.stringify({
    topic: notification?.topic || null,
    resource: notification?.resource || null,
    user_id: notification?.user_id || null,
    application_id: notification?.application_id || null,
    sent: notification?.sent || null,
  });
  const digest = crypto.createHash("sha256").update(source).digest("hex");
  return `meli-webhook-${digest}`;
}

async function enqueueNotification(notification = {}) {
  const validation = validateWebhookNotification(notification);
  if (!validation.ok) {
    const error = new Error(`Webhook Mercado Livre invalido: ${validation.reason}`);
    error.statusCode = 400;
    error.code = "ML_WEBHOOK_INVALID";
    error.reason = validation.reason;
    throw error;
  }

  const normalized = validation.notification;
  const queue = getQueue();
  const jobId = buildJobId(normalized);
  const existing = await queue.getJob(jobId);
  if (existing) {
    return { job_id: String(existing.id), deduplicated: true };
  }

  try {
    const job = await queue.add(
      "notification",
      { notification: normalized },
      {
        jobId,
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
      },
    );
    return { job_id: String(job.id), deduplicated: false };
  } catch (error) {
    const raced = await queue.getJob(jobId).catch(() => null);
    if (raced) {
      return { job_id: String(raced.id), deduplicated: true };
    }
    throw error;
  }
}

function initWorker() {
  if (workerStarted) return;
  workerStarted = true;

  const queue = getQueue();
  queue.process("notification", WORKER_CONCURRENCY, async (job) => {
    const notification = job?.data?.notification || {};
    const result = await PromoOfferRefsService.consumeNotification(notification);
    if (!result?.ok && !result?.skipped) {
      const error = new Error(result?.error || "Falha ao processar webhook Mercado Livre.");
      error.code = "ML_WEBHOOK_PROCESSING_FAILED";
      throw error;
    }
    return result;
  });

  queue.on("failed", (job, error) => {
    console.error(
      "[MeliWebhookQueue] job falhou:",
      job?.id || null,
      error?.message || error,
    );
  });

  console.log(
    `[MeliWebhookQueue] worker iniciado (concurrency=${WORKER_CONCURRENCY})`,
  );
}

module.exports = {
  QUEUE_NAME,
  enqueueNotification,
  getQueue,
  initWorker,
};
