// src/config/queue.js
const { Queue, Worker, QueueScheduler } = require("bullmq");
const redisConfig = require("./redis");
const {
  getShopeeWebhookCategories,
  normalizeShopeeWebhookCategory,
} = require("../webhooks/shopeePushCategories");

const connection = redisConfig.connection || { host: "localhost", port: 6379 };

function getShopeeWebhookQueueName(category) {
  const normalizedCategory = normalizeShopeeWebhookCategory(category).replace(
    /[^a-z0-9_-]/gi,
    "_",
  );
  return `shopeeWebhookPush__${normalizedCategory}`;
}

function createQueueScheduler(queueName) {
  return typeof QueueScheduler === "function"
    ? new QueueScheduler(queueName, { connection })
    : null;
}

const productSyncQueue = new Queue("productSync", { connection });
const orderSyncQueue = new Queue("orderSync", { connection });
const adsHourlySnapshotQueue = new Queue("adsHourlySnapshot", { connection });
const adsAttributionQueue = new Queue("adsAttribution", { connection });
const adsIntelligenceAutomationQueue = new Queue("adsIntelligenceAutomation", {
  connection,
});
const salesSummaryEmailQueue = new Queue("salesSummaryEmail", { connection });
const asyncProcessActionQueue = new Queue("asyncProcessAction", { connection });
const pricingApplyQueue = new Queue("pricingV6Apply", { connection });
const giftCampaignPublishQueue = new Queue("giftCampaignPublish", { connection });
const shopeeWebhookMaintenanceQueue = new Queue("shopeeWebhookMaintenance", {
  connection,
});
const shopeeWebhookCategories = getShopeeWebhookCategories();
const shopeeWebhookQueues = Object.fromEntries(
  shopeeWebhookCategories.map((category) => [
    category,
    new Queue(getShopeeWebhookQueueName(category), { connection }),
  ]),
);

const productSyncScheduler = createQueueScheduler("productSync");
const orderSyncScheduler = createQueueScheduler("orderSync");
const adsHourlySnapshotScheduler = createQueueScheduler("adsHourlySnapshot");
const adsAttributionScheduler = createQueueScheduler("adsAttribution");
const adsIntelligenceAutomationScheduler = createQueueScheduler(
  "adsIntelligenceAutomation",
);
const salesSummaryEmailScheduler = createQueueScheduler("salesSummaryEmail");
const asyncProcessActionScheduler = createQueueScheduler("asyncProcessAction");
const pricingApplyScheduler = createQueueScheduler("pricingV6Apply");
const shopeeWebhookMaintenanceScheduler = createQueueScheduler(
  "shopeeWebhookMaintenance",
);
const shopeeWebhookSchedulers = Object.fromEntries(
  shopeeWebhookCategories.map((category) => [
    category,
    createQueueScheduler(getShopeeWebhookQueueName(category)),
  ]),
);

const queues = {
  productSyncQueue,
  orderSyncQueue,
  adsHourlySnapshotQueue,
  adsAttributionQueue,
  adsIntelligenceAutomationQueue,
  salesSummaryEmailQueue,
  asyncProcessActionQueue,
  pricingApplyQueue,
  giftCampaignPublishQueue,
  shopeeWebhookMaintenanceQueue,
  ...shopeeWebhookQueues,
};

let productSyncWorker;
let orderSyncWorker;
let adsHourlySnapshotWorker;
let adsAttributionWorker;
let adsIntelligenceAutomationWorker;
let salesSummaryEmailWorker;
let asyncProcessActionWorker;
let pricingApplyWorker;
let giftCampaignPublishWorker;
let shopeeWebhookMaintenanceWorker;
const shopeeWebhookWorkers = {};

const SALES_REPORT_TZ =
  process.env.SALES_SUMMARY_TZ || "America/Sao_Paulo";
const ORDER_SYNC_TZ =
  process.env.ORDER_SYNC_TZ || process.env.SALES_SUMMARY_TZ || "America/Sao_Paulo";
const ORDER_SYNC_CRON_PATTERN =
  process.env.ORDER_SYNC_CRON_PATTERN || "0 6,18 * * 1-5";
const ORDER_SYNC_JOB_ID = "orderSync:auto:all-shops:weekdays:12h:06-18";
const ORDER_SYNC_RANGE_DAYS = Math.min(
  Math.max(Number(process.env.ORDER_SYNC_AUTO_RANGE_DAYS || 3) || 3, 1),
  30,
);
const ADS_INTELLIGENCE_AUTOMATION_TZ =
  process.env.ADS_INTELLIGENCE_AUTOMATION_TZ ||
  process.env.SALES_SUMMARY_TZ ||
  "America/Sao_Paulo";
const ADS_INTELLIGENCE_AUTOMATION_CRON_PATTERN =
  process.env.ADS_INTELLIGENCE_AUTOMATION_CRON_PATTERN || "5 * * * *";
const ADS_INTELLIGENCE_AUTOMATION_JOB_ID =
  "adsIntelligenceAutomation:hourly:05m";
const SHOPEE_WEBHOOK_WAITING_DRAIN_TZ =
  process.env.SHOPEE_WEBHOOK_WAITING_DRAIN_TZ ||
  process.env.SALES_SUMMARY_TZ ||
  "America/Sao_Paulo";
const SHOPEE_WEBHOOK_WAITING_DRAIN_CRON_PATTERN =
  process.env.SHOPEE_WEBHOOK_WAITING_DRAIN_CRON_PATTERN || "0 4 * * *";
const SHOPEE_WEBHOOK_WAITING_DRAIN_JOB_ID =
  "shopeeWebhookMaintenance_daily_waiting_drain";
const SHOPEE_WEBHOOK_WAITING_DRAIN_BATCH_SIZE = Math.min(
  1000,
  Math.max(1, Number(process.env.SHOPEE_WEBHOOK_WAITING_DRAIN_BATCH_SIZE || 200) || 200),
);
const SHOPEE_WEBHOOK_WAITING_DRAIN_MAX_PER_RUN = Math.min(
  20000,
  Math.max(
    1,
    Number(process.env.SHOPEE_WEBHOOK_WAITING_DRAIN_MAX_PER_RUN || 5000) || 5000,
  ),
);

const SALES_REPORT_JOBS = [
  {
    name: "daily_24h",
    data: { reportType: "daily_24h" },
    repeat: { pattern: "0 10 * * *", tz: SALES_REPORT_TZ },
    jobId: "salesSummaryEmail:daily_24h:10h",
  },
  {
    name: "weekend",
    data: { reportType: "weekend" },
    repeat: { pattern: "0 8 * * 1", tz: SALES_REPORT_TZ },
    jobId: "salesSummaryEmail:weekend:monday:08h",
  },
  {
    name: "weekly_7d",
    data: { reportType: "weekly_7d" },
    repeat: { pattern: "0 15 * * 5", tz: SALES_REPORT_TZ },
    jobId: "salesSummaryEmail:weekly_7d:friday:15h",
  },
  {
    name: "monthly",
    data: { reportType: "monthly" },
    repeat: { pattern: "0 8 1 * *", tz: SALES_REPORT_TZ },
    jobId: "salesSummaryEmail:monthly:day1:08h",
  },
];

function hasRepeatableJob(existingJobs, target) {
  return existingJobs.some(
    (job) =>
      job.name === target.name &&
      job.pattern === target.repeat.pattern &&
      job.tz === target.repeat.tz,
  );
}

function getShopeeWebhookQueue(category) {
  const normalizedCategory = normalizeShopeeWebhookCategory(category);
  return {
    category: normalizedCategory,
    queue:
      shopeeWebhookQueues[normalizedCategory] ||
      shopeeWebhookQueues.unknown,
  };
}

async function enqueueShopeeWebhookPush({
  category,
  payload,
  code = null,
}) {
  const resolved = getShopeeWebhookQueue(category);
  const queue = resolved.queue;
  const job = await queue.add(
    "process",
    {
      category: resolved.category,
      code: Number(code) || null,
      payload: payload && typeof payload === "object" ? payload : {},
      receivedAt: new Date().toISOString(),
    },
    {
      attempts: 5,
      backoff: {
        type: "exponential",
        delay: 5000,
      },
      removeOnComplete: 500,
      removeOnFail: 1000,
    },
  );

  return {
    queueCategory: resolved.category,
    queueName: queue.name,
    jobId: job?.id || null,
  };
}

async function getShopeeWebhookQueuesStatus() {
  const categories = getShopeeWebhookCategories();
  const now = Date.now();

  return Promise.all(
    categories.map(async (category) => {
      const queue = shopeeWebhookQueues[category];
      const [
        waiting,
        active,
        delayed,
        completed,
        failed,
        paused,
        oldestWaiting,
        oldestDelayed,
      ] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getDelayedCount(),
        queue.getCompletedCount(),
        queue.getFailedCount(),
        queue.isPaused(),
        queue.getWaiting(0, 0),
        queue.getDelayed(0, 0),
      ]);

      const oldestWaitingJob = Array.isArray(oldestWaiting)
        ? oldestWaiting[0]
        : null;
      const oldestDelayedJob = Array.isArray(oldestDelayed)
        ? oldestDelayed[0]
        : null;
      const oldestTimestamp =
        oldestWaitingJob?.timestamp || oldestDelayedJob?.timestamp || null;

      return {
        category,
        queueName: queue.name,
        paused: Boolean(paused),
        counts: {
          waiting: Number(waiting || 0),
          active: Number(active || 0),
          delayed: Number(delayed || 0),
          failed: Number(failed || 0),
          completed: Number(completed || 0),
        },
        oldestQueuedAt: oldestTimestamp ? new Date(oldestTimestamp) : null,
        oldestQueuedAgeSec: oldestTimestamp
          ? Math.max(0, Math.floor((now - Number(oldestTimestamp)) / 1000))
          : null,
      };
    }),
  );
}

async function processWaitingShopeeWebhookQueue(category, { limit = 100 } = {}) {
  const resolved = getShopeeWebhookQueue(category);
  const queue = resolved.queue;
  const processShopeePushPayload =
    require("../services/ShopeePushProcessingService").processShopeePushPayload;
  const controlLimit = Math.min(
    1000,
    Math.max(1, Number.isFinite(Number(limit)) ? Number(limit) : 100),
  );
  const waitingJobs = await queue.getWaiting(0, controlLimit - 1);
  let processed = 0;
  let failed = 0;

  for (const job of waitingJobs) {
    try {
      const payload =
        job?.data && typeof job.data === "object"
          ? job.data.payload || {}
          : {};
      await processShopeePushPayload(payload);
      await job.remove();
      processed += 1;
    } catch (error) {
      failed += 1;
      console.error("[shopeeWebhookQueue] waiting processing failed", {
        category: resolved.category,
        queueName: queue.name,
        jobId: job?.id,
        error: String(error?.message || error),
      });
    }
  }

  return {
    category: resolved.category,
    queueName: queue.name,
    scanned: waitingJobs.length,
    processed,
    failed,
  };
}

async function drainShopeeWebhookWaitingQueues({
  batchSize = SHOPEE_WEBHOOK_WAITING_DRAIN_BATCH_SIZE,
  maxPerRun = SHOPEE_WEBHOOK_WAITING_DRAIN_MAX_PER_RUN,
} = {}) {
  const categories = getShopeeWebhookCategories();
  const safeBatchSize = Math.min(
    1000,
    Math.max(1, Number(batchSize || SHOPEE_WEBHOOK_WAITING_DRAIN_BATCH_SIZE)),
  );
  const safeMaxPerRun = Math.min(
    20000,
    Math.max(1, Number(maxPerRun || SHOPEE_WEBHOOK_WAITING_DRAIN_MAX_PER_RUN)),
  );
  const startedAt = new Date();
  const results = [];
  let totalProcessed = 0;
  let totalFailed = 0;

  for (const category of categories) {
    let categoryProcessed = 0;
    let categoryFailed = 0;
    let loops = 0;

    while (totalProcessed + totalFailed < safeMaxPerRun) {
      // eslint-disable-next-line no-await-in-loop
      const result = await processWaitingShopeeWebhookQueue(category, {
        limit: safeBatchSize,
      });
      loops += 1;
      categoryProcessed += Number(result.processed || 0);
      categoryFailed += Number(result.failed || 0);
      totalProcessed += Number(result.processed || 0);
      totalFailed += Number(result.failed || 0);

      if (Number(result.scanned || 0) < safeBatchSize) break;
      if (!Number(result.processed || 0) && !Number(result.failed || 0)) break;
    }

    results.push({
      category,
      processed: categoryProcessed,
      failed: categoryFailed,
      loops,
    });
  }

  const status = await getShopeeWebhookQueuesStatus();
  const waitingAfter = status.reduce(
    (sum, row) => sum + Number(row?.counts?.waiting || 0),
    0,
  );

  return {
    ok: totalFailed === 0,
    startedAt,
    finishedAt: new Date(),
    totalProcessed,
    totalFailed,
    waitingAfter,
    results,
    limitReached: totalProcessed + totalFailed >= safeMaxPerRun,
  };
}

async function controlShopeeWebhookQueue(
  category,
  { action, limit } = {},
) {
  const resolved = getShopeeWebhookQueue(category);
  const queue = resolved.queue;
  const normalizedAction = String(action || "")
    .trim()
    .toLowerCase();
  const controlLimit = Math.min(
    1000,
    Math.max(1, Number.isFinite(Number(limit)) ? Number(limit) : 100),
  );

  let affected = 0;
  switch (normalizedAction) {
    case "pause":
      await queue.pause();
      break;
    case "resume":
      await queue.resume();
      break;
    case "clear_waiting":
      await queue.drain(false);
      break;
    case "clear_waiting_and_delayed":
      await queue.drain(true);
      break;
    case "retry_failed": {
      const failedJobs = await queue.getFailed(0, controlLimit - 1);
      for (const job of failedJobs) {
        try {
          await job.retry();
          affected += 1;
        } catch (_error) {
          // job pode estar em transicao; seguimos o restante
        }
      }
      break;
    }
    case "process_waiting": {
      const result = await processWaitingShopeeWebhookQueue(resolved.category, {
        limit: controlLimit,
      });
      affected = Number(result.processed || 0);
      break;
    }
    case "clean_failed":
      affected = (
        await queue.clean(0, controlLimit, "failed")
      ).length;
      break;
    case "clean_completed":
      affected = (
        await queue.clean(0, controlLimit, "completed")
      ).length;
      break;
    default: {
      const error = new Error("acao_de_fila_invalida");
      error.statusCode = 400;
      throw error;
    }
  }

  const [status] = await Promise.all([
    getShopeeWebhookQueuesStatus().then((rows) =>
      rows.find((row) => row.category === resolved.category) || null,
    ),
  ]);

  return {
    category: resolved.category,
    action: normalizedAction,
    affected,
    status,
  };
}

async function cleanupLegacySalesSummaryJobs(existingJobs) {
  const validJobIds = new Set(SALES_REPORT_JOBS.map((job) => job.jobId));

  for (const job of existingJobs) {
    const isLegacyHourly =
      job.name === "run" ||
      job.every != null ||
      (job.id && !validJobIds.has(job.id));

    if (isLegacyHourly && job.key) {
      await salesSummaryEmailQueue.removeRepeatableByKey(job.key);
    }
  }
}

async function cleanupLegacyOrderSyncJobs(existingJobs) {
  for (const job of existingJobs) {
    const isExpectedJob =
      job.name === "sync_all_shops" &&
      job.pattern === ORDER_SYNC_CRON_PATTERN &&
      job.tz === ORDER_SYNC_TZ &&
      job.id === ORDER_SYNC_JOB_ID;

    if (!isExpectedJob && job.key) {
      await orderSyncQueue.removeRepeatableByKey(job.key);
    }
  }
}

async function cleanupLegacyAdsIntelligenceAutomationJobs(existingJobs) {
  for (const job of existingJobs) {
    const isExpectedJob =
      job.name === "run" &&
      job.pattern === ADS_INTELLIGENCE_AUTOMATION_CRON_PATTERN &&
      job.tz === ADS_INTELLIGENCE_AUTOMATION_TZ &&
      job.id === ADS_INTELLIGENCE_AUTOMATION_JOB_ID;

    if (!isExpectedJob && job.key) {
      await adsIntelligenceAutomationQueue.removeRepeatableByKey(job.key);
    }
  }
}

async function ensureRepeatables() {
  const every15m = 15 * 60 * 1000;

  const [
    adsExisting,
    salesExisting,
    orderExisting,
    adsIntelExisting,
    shopeeWebhookMaintenanceExisting,
  ] = await Promise.all([
    adsHourlySnapshotQueue.getRepeatableJobs(),
    salesSummaryEmailQueue.getRepeatableJobs(),
    orderSyncQueue.getRepeatableJobs(),
    adsIntelligenceAutomationQueue.getRepeatableJobs(),
    shopeeWebhookMaintenanceQueue.getRepeatableJobs(),
  ]);

  const adsAlready = adsExisting.some(
    (j) => j.name === "run" && j.every === every15m,
  );
  if (!adsAlready) {
    await adsHourlySnapshotQueue.add(
      "run",
      {},
      {
        repeat: { every: every15m },
        jobId: "adsHourlySnapshot:repeat:15m",
      },
    );
  }

  await cleanupLegacySalesSummaryJobs(salesExisting);

  const refreshedSalesExisting = await salesSummaryEmailQueue.getRepeatableJobs();
  for (const job of SALES_REPORT_JOBS) {
    if (hasRepeatableJob(refreshedSalesExisting, job)) continue;

    await salesSummaryEmailQueue.add(job.name, job.data, {
      repeat: job.repeat,
      jobId: job.jobId,
    });
  }

  await cleanupLegacyOrderSyncJobs(orderExisting);

  const refreshedOrderExisting = await orderSyncQueue.getRepeatableJobs();
  const orderSyncAlready = refreshedOrderExisting.some(
    (job) =>
      job.name === "sync_all_shops" &&
      job.pattern === ORDER_SYNC_CRON_PATTERN &&
      job.tz === ORDER_SYNC_TZ &&
      job.id === ORDER_SYNC_JOB_ID,
  );

  if (!orderSyncAlready) {
    await orderSyncQueue.add(
      "sync_all_shops",
      {
        syncAllShops: true,
        rangeDays: ORDER_SYNC_RANGE_DAYS,
      },
      {
        repeat: { pattern: ORDER_SYNC_CRON_PATTERN, tz: ORDER_SYNC_TZ },
        jobId: ORDER_SYNC_JOB_ID,
      },
    );
  }

  await cleanupLegacyAdsIntelligenceAutomationJobs(adsIntelExisting);

  const shopeeWebhookWaitingDrainAlready = shopeeWebhookMaintenanceExisting.some(
    (job) =>
      job.name === "drain_waiting" &&
      job.pattern === SHOPEE_WEBHOOK_WAITING_DRAIN_CRON_PATTERN &&
      job.tz === SHOPEE_WEBHOOK_WAITING_DRAIN_TZ,
  );

  if (!shopeeWebhookWaitingDrainAlready) {
    await shopeeWebhookMaintenanceQueue.add(
      "drain_waiting",
      {},
      {
        repeat: {
          pattern: SHOPEE_WEBHOOK_WAITING_DRAIN_CRON_PATTERN,
          tz: SHOPEE_WEBHOOK_WAITING_DRAIN_TZ,
        },
        jobId: SHOPEE_WEBHOOK_WAITING_DRAIN_JOB_ID,
        removeOnComplete: 30,
        removeOnFail: 100,
      },
    );
  }

  return {
    adsHourlySnapshotEveryMs: every15m,
    orderSyncPattern: ORDER_SYNC_CRON_PATTERN,
    orderSyncTimezone: ORDER_SYNC_TZ,
    orderSyncRangeDays: ORDER_SYNC_RANGE_DAYS,
    adsIntelligenceAutomationPattern: null,
    adsIntelligenceAutomationTimezone: null,
    shopeeWebhookWaitingDrainPattern: SHOPEE_WEBHOOK_WAITING_DRAIN_CRON_PATTERN,
    shopeeWebhookWaitingDrainTimezone: SHOPEE_WEBHOOK_WAITING_DRAIN_TZ,
    salesReports: SALES_REPORT_JOBS.map((job) => ({
      name: job.name,
      pattern: job.repeat.pattern,
      tz: job.repeat.tz,
      jobId: job.jobId,
    })),
  };
}

async function initWorkers() {
  const repeatables = await ensureRepeatables();
  const shopeeWebhookPushProcessor = require("../jobs/shopeeWebhookPush.job");

  await Promise.all([
    productSyncQueue.resume(),
    orderSyncQueue.resume(),
    adsHourlySnapshotQueue.resume(),
    adsAttributionQueue.resume(),
    adsIntelligenceAutomationQueue.resume(),
    salesSummaryEmailQueue.resume(),
    asyncProcessActionQueue.resume(),
    pricingApplyQueue.resume(),
    giftCampaignPublishQueue.resume(),
    shopeeWebhookMaintenanceQueue.resume(),
    ...shopeeWebhookCategories.map((category) =>
      shopeeWebhookQueues[category]?.resume(),
    ),
  ]);

  productSyncWorker = new Worker(
    "productSync",
    require("../jobs/productSync.job"),
    {
      connection,
      concurrency: Number(process.env.PRODUCT_SYNC_CONCURRENCY || 2),
    },
  );

  orderSyncWorker = new Worker("orderSync", require("../jobs/orderSync.job"), {
    connection,
    concurrency: Number(process.env.ORDER_SYNC_CONCURRENCY || 2),
  });

  adsHourlySnapshotWorker = new Worker(
    "adsHourlySnapshot",
    require("../jobs/adsHourlySnapshot.job"),
    {
      connection,
      concurrency: Number(process.env.ADS_HOURLY_SNAPSHOT_CONCURRENCY || 1),
    },
  );

  adsAttributionWorker = new Worker(
    "adsAttribution",
    require("../jobs/adsAttribution.job"),
    {
      connection,
      concurrency: Number(process.env.ADS_ATTRIBUTION_CONCURRENCY || 1),
    },
  );

  adsIntelligenceAutomationWorker = new Worker(
    "adsIntelligenceAutomation",
    require("../jobs/adsIntelligenceAutomation.job"),
    {
      connection,
      concurrency: Number(
        process.env.ADS_INTELLIGENCE_AUTOMATION_CONCURRENCY || 1,
      ),
    },
  );

  salesSummaryEmailWorker = new Worker(
    "salesSummaryEmail",
    require("../jobs/salesSummaryEmail.job"),
    {
      connection,
      concurrency: Number(process.env.SALES_SUMMARY_EMAIL_CONCURRENCY || 1),
    },
  );
  asyncProcessActionWorker = new Worker(
    "asyncProcessAction",
    require("../jobs/asyncProcessAction.job"),
    {
      connection,
      concurrency: Number(process.env.ASYNC_PROCESS_ACTION_CONCURRENCY || 2),
    },
  );
  pricingApplyWorker = new Worker(
    "pricingV6Apply",
    require("../jobs/pricingV6Apply.job"),
    {
      connection,
      concurrency: Number(process.env.PRICING_V6_APPLY_CONCURRENCY || 1),
    },
  );
  giftCampaignPublishWorker = new Worker(
    "giftCampaignPublish",
    require("../jobs/giftCampaignPublish.job"),
    { connection, concurrency: Number(process.env.GIFT_CAMPAIGN_PUBLISH_CONCURRENCY || 1) },
  );
  shopeeWebhookMaintenanceWorker = new Worker(
    "shopeeWebhookMaintenance",
    async (job) => {
      if (job?.name !== "drain_waiting") {
        return { ok: true, ignored: true, reason: "unsupported_maintenance_job" };
      }
      return drainShopeeWebhookWaitingQueues();
    },
    {
      connection,
      concurrency: 1,
    },
  );

  for (const category of shopeeWebhookCategories) {
    const queueName = getShopeeWebhookQueueName(category);
    const worker = new Worker(queueName, shopeeWebhookPushProcessor, {
      connection,
      concurrency: Number(process.env.SHOPEE_WEBHOOK_PUSH_CONCURRENCY || 1),
    });

    worker.on("failed", (job, err) => {
      console.error("[shopeeWebhookPushWorker] failed", {
        category,
        queueName,
        jobId: job?.id,
        err,
      });
    });

    shopeeWebhookWorkers[category] = worker;
  }

  productSyncWorker.on("failed", (job, err) => {
    console.error("[productSyncWorker] failed", { jobId: job?.id, err });
  });

  orderSyncWorker.on("failed", (job, err) => {
    console.error("[orderSyncWorker] failed", { jobId: job?.id, err });
  });
  orderSyncWorker.on("completed", (job, result) => {
    console.log("[orderSyncWorker] completed", {
      jobId: job?.id,
      name: job?.name,
      totalShops: result?.totalShops ?? null,
      ok: result?.ok ?? null,
      failed: result?.failed ?? null,
      shopId: result?.shop_id ?? null,
      summary: result?.summary ?? null,
    });
  });

  adsHourlySnapshotWorker.on("failed", (job, err) => {
    console.error("[adsHourlySnapshotWorker] failed", { jobId: job?.id, err });
  });

  adsAttributionWorker.on("failed", (job, err) => {
    console.error("[adsAttributionWorker] failed", { jobId: job?.id, err });
  });

  adsIntelligenceAutomationWorker.on("failed", (job, err) => {
    console.error("[adsIntelligenceAutomationWorker] failed", {
      jobId: job?.id,
      err,
    });
  });

  adsIntelligenceAutomationWorker.on("completed", (job, result) => {
    console.log("[adsIntelligenceAutomationWorker] completed", {
      jobId: job?.id,
      name: job?.name,
      processedShops: result?.processedShops ?? null,
      okShops: result?.okShops ?? null,
      failedShops: result?.failedShops ?? null,
    });
  });

  salesSummaryEmailWorker.on("failed", (job, err) => {
    console.error("[salesSummaryEmailWorker] failed", {
      jobId: job?.id,
      err,
    });
  });

  salesSummaryEmailWorker.on("completed", (job, result) => {
    console.log("[salesSummaryEmailWorker] completed", {
      jobId: job?.id,
      name: job?.name,
      reportType: job?.data?.reportType || job?.name || null,
      totals: result?.totals || null,
    });
  });

  asyncProcessActionWorker.on("failed", (job, err) => {
    console.error("[asyncProcessActionWorker] failed", {
      jobId: job?.id,
      name: job?.name,
      err,
    });
  });

  asyncProcessActionWorker.on("completed", (job, result) => {
    console.log("[asyncProcessActionWorker] completed", {
      jobId: job?.id,
      name: job?.name,
      action: job?.data?.action || null,
      ok: result?.ok ?? null,
    });
  });
  pricingApplyWorker.on("failed", (job, err) => {
    console.error("[pricingV6ApplyWorker] failed", { jobId: job?.id, err });
  });

  giftCampaignPublishWorker.on("failed", (job, err) => {
    console.error("[giftCampaignPublishWorker] failed", { jobId: job?.id, err });
  });
  shopeeWebhookMaintenanceWorker.on("failed", (job, err) => {
    console.error("[shopeeWebhookMaintenanceWorker] failed", {
      jobId: job?.id,
      name: job?.name,
      err,
    });
  });

  shopeeWebhookMaintenanceWorker.on("completed", (job, result) => {
    console.log("[shopeeWebhookMaintenanceWorker] completed", {
      jobId: job?.id,
      name: job?.name,
      totalProcessed: result?.totalProcessed ?? null,
      totalFailed: result?.totalFailed ?? null,
      waitingAfter: result?.waitingAfter ?? null,
      limitReached: result?.limitReached ?? null,
    });
  });

  if (process.env.SHOPEE_WEBHOOK_DRAIN_ON_STARTUP !== "0") {
    setTimeout(() => {
      drainShopeeWebhookWaitingQueues()
        .then((result) => {
          console.log("[shopeeWebhookMaintenance] startup drain completed", {
            totalProcessed: result?.totalProcessed ?? null,
            totalFailed: result?.totalFailed ?? null,
            waitingAfter: result?.waitingAfter ?? null,
            limitReached: result?.limitReached ?? null,
          });
        })
        .catch((error) => {
          console.error("[shopeeWebhookMaintenance] startup drain failed", {
            error: String(error?.message || error),
          });
        });
    }, 10000);
  }

  return {
    repeatables,
    workers: [
      "productSync",
      "orderSync",
      "adsHourlySnapshot",
      "adsAttribution",
      "adsIntelligenceAutomation",
      "salesSummaryEmail",
      "asyncProcessAction",
      "pricingV6Apply",
      "giftCampaignPublish",
      "shopeeWebhookMaintenance",
      ...shopeeWebhookCategories.map(
        (category) => getShopeeWebhookQueueName(category),
      ),
    ],
  };
}

async function closeWorkers() {
  if (productSyncWorker) await productSyncWorker.close();
  if (orderSyncWorker) await orderSyncWorker.close();
  if (adsHourlySnapshotWorker) await adsHourlySnapshotWorker.close();
  if (adsAttributionWorker) await adsAttributionWorker.close();
  if (adsIntelligenceAutomationWorker) await adsIntelligenceAutomationWorker.close();
  if (salesSummaryEmailWorker) await salesSummaryEmailWorker.close();
  if (asyncProcessActionWorker) await asyncProcessActionWorker.close();
  if (pricingApplyWorker) await pricingApplyWorker.close();
  if (giftCampaignPublishWorker) await giftCampaignPublishWorker.close();
  if (shopeeWebhookMaintenanceWorker) {
    await shopeeWebhookMaintenanceWorker.close();
  }
  for (const category of shopeeWebhookCategories) {
    const worker = shopeeWebhookWorkers[category];
    if (worker) await worker.close();
  }

  if (productSyncScheduler) await productSyncScheduler.close();
  if (orderSyncScheduler) await orderSyncScheduler.close();
  if (adsHourlySnapshotScheduler) await adsHourlySnapshotScheduler.close();
  if (adsAttributionScheduler) await adsAttributionScheduler.close();
  if (adsIntelligenceAutomationScheduler) await adsIntelligenceAutomationScheduler.close();
  if (salesSummaryEmailScheduler) await salesSummaryEmailScheduler.close();
  if (asyncProcessActionScheduler) await asyncProcessActionScheduler.close();
  if (pricingApplyScheduler) await pricingApplyScheduler.close();
  if (shopeeWebhookMaintenanceScheduler) {
    await shopeeWebhookMaintenanceScheduler.close();
  }
  for (const category of shopeeWebhookCategories) {
    const scheduler = shopeeWebhookSchedulers[category];
    if (scheduler) await scheduler.close();
  }
}

module.exports = {
  queues,
  orderSyncQueue,
  adsAttributionQueue,
  adsHourlySnapshotQueue,
  adsIntelligenceAutomationQueue,
  salesSummaryEmailQueue,
  asyncProcessActionQueue,
  pricingApplyQueue,
  giftCampaignPublishQueue,
  shopeeWebhookMaintenanceQueue,
  enqueueShopeeWebhookPush,
  getShopeeWebhookQueuesStatus,
  controlShopeeWebhookQueue,
  drainShopeeWebhookWaitingQueues,
  initWorkers,
  closeWorkers,
};
