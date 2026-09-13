// src/worker.js
require("./config/env");

const { Worker } = require("bullmq");
const { client: redis } = require("./config/redis");
const { registerRepeatableJobs } = require("./scheduler");

const orderSyncProcessor = require("./jobs/orderSync.job");
const adsHourlySnapshotProcessor = require("./jobs/adsHourlySnapshot.job");
const adsAttributionProcessor = require("./jobs/adsAttribution.job");
const adsIntelligenceAutomationProcessor = require("./jobs/adsIntelligenceAutomation.job");
const salesSummaryEmailProcessor = require("./jobs/salesSummaryEmail.job");
const asyncProcessActionProcessor = require("./jobs/asyncProcessAction.job");
const pricingV6ApplyProcessor = require("./jobs/pricingV6Apply.job");
const giftCampaignPublishProcessor = require("./jobs/giftCampaignPublish.job");

async function main() {
  await registerRepeatableJobs();

  const w0 = new Worker("orderSync", orderSyncProcessor, {
    connection: redis,
    concurrency: Number(process.env.ORDER_SYNC_CONCURRENCY || 2),
  });

  const w1 = new Worker("adsHourlySnapshot", adsHourlySnapshotProcessor, {
    connection: redis,
    concurrency: 1,
  });

  const w2 = new Worker("adsAttribution", adsAttributionProcessor, {
    connection: redis,
    concurrency: 1,
  });

  const w3 = new Worker("salesSummaryEmail", salesSummaryEmailProcessor, {
    connection: redis,
    concurrency: 1,
  });

  const w4 = new Worker(
    "adsIntelligenceAutomation",
    adsIntelligenceAutomationProcessor,
    {
      connection: redis,
      concurrency: Number(
        process.env.ADS_INTELLIGENCE_AUTOMATION_CONCURRENCY || 1,
      ),
    },
  );

  const w5 = new Worker("asyncProcessAction", asyncProcessActionProcessor, {
    connection: redis,
    concurrency: Number(process.env.ASYNC_PROCESS_ACTION_CONCURRENCY || 2),
  });
  const w6 = new Worker("pricingV6Apply", pricingV6ApplyProcessor, {
    connection: redis,
    concurrency: Number(process.env.PRICING_V6_APPLY_CONCURRENCY || 1),
  });

  const w7 = new Worker("giftCampaignPublish", giftCampaignPublishProcessor, {
    connection: redis,
    concurrency: Number(process.env.GIFT_CAMPAIGN_PUBLISH_CONCURRENCY || 1),
  });

  w0.on("completed", (job, result) => {
    console.log("[worker] orderSync completed", {
      jobId: job.id,
      result,
    });
  });
  w0.on("failed", (job, err) => {
    console.error("[worker] orderSync failed", {
      jobId: job?.id,
      err: String(err?.message || err),
    });
  });

  w1.on("completed", (job, result) => {
    console.log("[worker] adsHourlySnapshot completed", {
      jobId: job.id,
      result,
    });
  });
  w1.on("failed", (job, err) => {
    console.error("[worker] adsHourlySnapshot failed", {
      jobId: job?.id,
      err: String(err?.message || err),
    });
  });

  w2.on("completed", (job, result) => {
    console.log("[worker] adsAttribution completed", { jobId: job.id, result });
  });
  w2.on("failed", (job, err) => {
    console.error("[worker] adsAttribution failed", {
      jobId: job?.id,
      err: String(err?.message || err),
    });
  });

  w3.on("completed", (job, result) => {
    console.log("[worker] salesSummaryEmail completed", {
      jobId: job.id,
      result,
    });
  });
  w3.on("failed", (job, err) => {
    console.error("[worker] salesSummaryEmail failed", {
      jobId: job?.id,
      err: String(err?.message || err),
    });
  });

  w4.on("completed", (job, result) => {
    console.log("[worker] adsIntelligenceAutomation completed", {
      jobId: job.id,
      result,
    });
  });
  w4.on("failed", (job, err) => {
    console.error("[worker] adsIntelligenceAutomation failed", {
      jobId: job?.id,
      err: String(err?.message || err),
    });
  });

  w5.on("completed", (job, result) => {
    console.log("[worker] asyncProcessAction completed", {
      jobId: job.id,
      action: job?.data?.action || null,
      ok: result?.ok ?? null,
    });
  });
  w5.on("failed", (job, err) => {
    console.error("[worker] asyncProcessAction failed", {
      jobId: job?.id,
      action: job?.data?.action || null,
      err: String(err?.message || err),
    });
  });
  w6.on("failed", (job, err) => {
    console.error("[worker] pricingV6Apply failed", {
      jobId: job?.id,
      err: String(err?.message || err),
    });
  });
  w7.on("failed", (job, err) => {
    console.error("[worker] giftCampaignPublish failed", { jobId: job?.id, err: String(err?.message || err) });
  });

  console.log("[worker] up");
}

main().catch((e) => {
  console.error("[worker] fatal", e);
  process.exit(1);
});
