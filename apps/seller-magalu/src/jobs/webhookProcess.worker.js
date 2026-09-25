"use strict";

const { Worker } = require("bullmq");
const { ensureRedisConnected } = require("../config/redis");
const queueNames = require("../config/queueNames");
const accountRepository = require("../repositories/accountRepository");
const webhookRepository = require("../repositories/webhookRepository");
const { reconcileSku } = require("../services/catalogSyncService");
const { recordBestEffort, errorDetails } = require("../services/auditService");
const { enqueueOrderReconcile, enqueueDeliveryReconcile } = require("../queues/magaluQueue");

const SUPPORTED_TOPICS = new Set(["portfolios_sku", "portfolios_price", "portfolios_stock", "orders_order", "orders_delivery"]);
let worker = null;

function resourceIdFromEvent(event) {
  const direct = String(event?.payload?.data?.params?.id || "").trim();
  if (direct) return direct;
  const resource = String(event?.payload?.data?.resource || "").trim();
  if (!resource) return "";
  const path = resource.split("?")[0].replace(/\/+$/, "");
  const value = path.slice(path.lastIndexOf("/") + 1);
  try { return decodeURIComponent(value); } catch (_error) { return value; }
}

function skuFromEvent(event) {
  const direct = String(event?.payload?.data?.params?.sku || "").trim();
  if (direct) return direct;
  const resource = String(event?.payload?.data?.resource || "").trim();
  if (!resource) return "";
  const path = resource.split("?")[0].replace(/\/+$/, "");
  const value = path.slice(path.lastIndexOf("/") + 1);
  try { return decodeURIComponent(value); } catch (_error) { return value; }
}

async function processWebhookEvent(eventId) {
  const event = await webhookRepository.claimEvent(eventId);
  if (!event) return { ignored: true, reason: "event_not_claimable" };

  let account = null;
  let sku = "";
  try {
    if (!SUPPORTED_TOPICS.has(event.topic)) {
      await webhookRepository.markEventIgnored(event.id, `unsupported_topic:${event.topic}`);
      await recordBestEffort({
        eventKey: "webhook_ignored",
        source: "worker",
        magaluTenantId: event.magalu_tenant_id,
        details: { event_id: event.id, topic: event.topic, reason: "unsupported_topic" },
      });
      return { ignored: true, reason: "unsupported_topic" };
    }

    account = await accountRepository.findAccountByTenantId(event.magalu_tenant_id);
    if (!account || account.status !== "active") {
      await webhookRepository.markEventIgnored(event.id, "account_not_connected");
      await recordBestEffort({
        eventKey: "webhook_ignored",
        source: "worker",
        accountId: account?.id || null,
        dachTenantId: account?.dach_tenant_id || null,
        magaluTenantId: event.magalu_tenant_id,
        details: { event_id: event.id, topic: event.topic, reason: "account_not_connected" },
      });
      return { ignored: true, reason: "account_not_connected" };
    }

    if (event.topic === "orders_order" || event.topic === "orders_delivery") {
      const remoteId = resourceIdFromEvent(event);
      if (!remoteId) {
        await webhookRepository.markEventIgnored(event.id, "order_resource_id_missing");
        return { ignored: true, reason: "order_resource_id_missing" };
      }
      await webhookRepository.attachEventAccount(event.id, account.id);
      const job = event.topic === "orders_order"
        ? await enqueueOrderReconcile(account.id, remoteId, { dachTenantId: account.dach_tenant_id, reason: "orders_order" })
        : await enqueueDeliveryReconcile(account.id, remoteId, { dachTenantId: account.dach_tenant_id, reason: "orders_delivery" });
      await webhookRepository.markEventProcessed(event.id);
      await recordBestEffort({ eventKey: "webhook_processed", source: "worker", accountId: account.id, dachTenantId: account.dach_tenant_id, magaluTenantId: account.magalu_tenant_id, details: { event_id: event.id, topic: event.topic, remote_id: remoteId, orders_job_id: job?.id || null, read_only: true } });
      return { ok: true, topic: event.topic, remoteId, jobId: job?.id || null };
    }

    sku = skuFromEvent(event);
    if (!sku) {
      await webhookRepository.markEventIgnored(event.id, "sku_missing");
      await recordBestEffort({
        eventKey: "webhook_ignored",
        source: "worker",
        accountId: account.id,
        dachTenantId: account.dach_tenant_id,
        magaluTenantId: account.magalu_tenant_id,
        details: { event_id: event.id, topic: event.topic, reason: "sku_missing" },
      });
      return { ignored: true, reason: "sku_missing" };
    }

    await webhookRepository.attachEventAccount(event.id, account.id);
    const result = await reconcileSku(account.id, sku, { topic: event.topic });
    await webhookRepository.markEventProcessed(event.id);

    await recordBestEffort({
      eventKey: "webhook_processed",
      source: "worker",
      accountId: account.id,
      dachTenantId: account.dach_tenant_id,
      magaluTenantId: account.magalu_tenant_id,
      sku,
      details: { event_id: event.id, topic: event.topic },
    });

    return { ok: true, sku, topic: event.topic, result };
  } catch (error) {
    await webhookRepository.markEventFailed(event.id, error?.message || String(error)).catch(() => {});
    await recordBestEffort({
      eventKey: "webhook_failed",
      source: "worker",
      outcome: "failed",
      severity: "error",
      accountId: account?.id || event.account_id || null,
      dachTenantId: account?.dach_tenant_id || null,
      magaluTenantId: account?.magalu_tenant_id || event.magalu_tenant_id || null,
      sku: sku || null,
      requestId: error?.requestId || null,
      details: { event_id: event.id, topic: event.topic, error: errorDetails(error) },
    });
    throw error;
  }
}

async function startWebhookProcessWorker() {
  if (worker) return worker;
  const connection = await ensureRedisConnected();
  worker = new Worker(
    queueNames.webhookProcess,
    async (job) => processWebhookEvent(job.data.eventId),
    { connection, concurrency: 3 },
  );
  worker.on("failed", (job, error) =>
    console.error("[seller-magalu:webhook-worker] job failed", {
      job: job?.id || null,
      message: error?.message || String(error),
    }),
  );
  return worker;
}

async function stopWebhookProcessWorker() {
  if (!worker) return;
  const current = worker;
  worker = null;
  await current.close();
}

module.exports = {
  startWebhookProcessWorker,
  stopWebhookProcessWorker,
  _test: { skuFromEvent, resourceIdFromEvent, SUPPORTED_TOPICS, processWebhookEvent },
};
