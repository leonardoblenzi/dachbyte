"use strict";

const { pricingApplyQueue } = require("../config/queue");
const PricingV6Service = require("../services/PricingV6Service");
const PricingV7CalibrationService = require("../services/PricingV7CalibrationService");
const { resolveShop } = require("../utils/resolveShop");

async function getShop(req) {
  return resolveShop(req, req.params.shopId || "active");
}

function asBoolean(value) {
  return [true, "true", "1", "yes"].includes(value);
}

async function enqueuePricingJob(jobId) {
  await pricingApplyQueue.resume();
  await pricingApplyQueue.add(
    "apply",
    { jobId },
    {
      jobId: `pricing-v6:${jobId}:${Date.now()}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 500,
      removeOnFail: 1000,
    },
  );
}

async function overview(req, res) {
  const shop = await getShop(req);
  res.json(await PricingV6Service.getOverview({ shopId: shop.id, forceRefresh: asBoolean(req.query?.refresh) }));
}

async function refreshCatalog(req, res) {
  const shop = await getShop(req);
  const result = await PricingV6Service.refreshCatalogPrices({ shop });
  const overview = await PricingV6Service.getOverview({
    shopId: shop.id,
    forceRefresh: true,
    userId: req.auth?.userId,
  });
  res.json({ ...result, snapshotId: overview.snapshotId });
}
async function tacos(req, res) {
  const shop = await getShop(req);
  res.json(await PricingV6Service.getAccountTacos({ shop }));
}
async function products(req, res) {
  const shop = await getShop(req);
  res.json(await PricingV6Service.listProducts({
    shopId: shop.id,
    filters: req.query,
    page: req.query.page,
    pageSize: req.query.pageSize,
    forceRefresh: asBoolean(req.query?.refresh),
  }));
}

async function settings(req, res) {
  const shop = await getShop(req);
  res.json(await PricingV6Service.publicSettings(await PricingV6Service.getSettings(shop.id)));
}

async function updateSettings(req, res) {
  const shop = await getShop(req);
  res.json(await PricingV6Service.saveSettings({ shopId: shop.id, userId: req.auth?.userId, input: req.body || {} }));
}

async function simulate(req, res) {
  const shop = await getShop(req);
  res.json(await PricingV6Service.simulate({
    shopId: shop.id,
    userId: req.auth?.userId,
    selection: req.body?.selection,
    filters: req.body?.filters,
    forceRefresh: asBoolean(req.body?.forceRefresh),
  }));
}

async function salePriceSimulation(req, res) {
  const shop = await getShop(req);
  res.json(await PricingV6Service.simulateSalePrice({
    shopId: shop.id,
    key: String(req.body?.key || ""),
    salePrice: req.body?.salePrice,
  }));
}

async function conflicts(req, res) {
  const shop = await getShop(req);
  res.json(await PricingV6Service.getConflicts({
    shop,
    selection: req.body?.selection,
    filters: req.body?.filters,
    syncRemote: asBoolean(req.query.syncRemote ?? req.body?.syncRemote),
  }));
}

async function createJob(req, res) {
  const shop = await getShop(req);
  const job = await PricingV6Service.createJob({
    shop,
    userId: req.auth?.userId,
    snapshotId: String(req.body?.snapshotId || ""),
    conflictPolicy: req.body?.conflictPolicy,
  });
  res.status(201).json(job);
}

async function listJobs(req, res) {
  const shop = await getShop(req);
  const job = await require("../repositories/pricingV6SqlRepository").listPricingJobs({ shopId: shop.id, limit: req.query.limit });
  res.json({ jobs: job });
}

async function getJob(req, res) {
  const shop = await getShop(req);
  const job = await require("../repositories/pricingV6SqlRepository").getPricingJob({ id: req.params.jobId, shopId: shop.id, includeItems: true });
  if (!job) return res.status(404).json({ error: "pricing_job_not_found" });
  return res.json(job);
}

async function confirmJob(req, res) {
  const shop = await getShop(req);
  const job = await PricingV6Service.confirmJob({ shop, jobId: req.params.jobId, enqueue: enqueuePricingJob });
  res.status(202).json(job);
}

async function cancelJob(req, res) {
  const shop = await getShop(req);
  res.json(await PricingV6Service.cancelJob({ shopId: shop.id, jobId: req.params.jobId }));
}

async function retryJob(req, res) {
  const shop = await getShop(req);
  res.status(202).json(await PricingV6Service.retryJob({ shop, jobId: req.params.jobId, enqueue: enqueuePricingJob }));
}

async function audit(req, res) {
  const shop = await getShop(req);
  res.json(await PricingV6Service.listAudit({ shopId: shop.id, page: req.query.page, pageSize: req.query.pageSize }));
}


async function calibrationSummary(req, res) {
  const shop = await getShop(req);
  res.json(await PricingV7CalibrationService.summary(shop.id));
}

async function calibrationOrders(req, res) {
  const shop = await getShop(req);
  res.json(await PricingV7CalibrationService.orders({ shopId: shop.id, page: req.query.page, pageSize: req.query.pageSize }));
}

async function rebuildCalibration(req, res) {
  const shop = await getShop(req);
  const settings = await PricingV6Service.getSettings(shop.id);
  res.json(await PricingV7CalibrationService.rebuild({ shopId: shop.id, taxRate: settings.taxRate, windowDays: req.body?.windowDays ?? settings.calibrationWindowDays }));
}
module.exports = {
  overview,
  tacos,
  refreshCatalog,
  products,
  settings,
  updateSettings,
  simulate,
  salePriceSimulation,
  conflicts,
  createJob,
  listJobs,
  getJob,
  confirmJob,
  cancelJob,
  retryJob,
  audit,
  calibrationSummary,
  calibrationOrders,
  rebuildCalibration,
};
