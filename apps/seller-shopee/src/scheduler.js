const {
  adsHourlySnapshotQueue,
  adsIntelligenceAutomationQueue,
  orderSyncQueue,
  salesSummaryEmailQueue,
} = require("./config/queue");

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

async function registerRepeatableJobs() {
  const every15m = 15 * 60 * 1000;

  const [adsExisting, salesExisting, orderExisting, adsIntelExisting] = await Promise.all([
    adsHourlySnapshotQueue.getRepeatableJobs(),
    salesSummaryEmailQueue.getRepeatableJobs(),
    orderSyncQueue.getRepeatableJobs(),
    adsIntelligenceAutomationQueue.getRepeatableJobs(),
  ]);

  const adsAlready = adsExisting.some(
    (job) => job.name === "run" && job.every === every15m,
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
}

module.exports = { registerRepeatableJobs };
