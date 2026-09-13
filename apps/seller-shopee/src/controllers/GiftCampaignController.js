"use strict";

const service = require("../services/GiftCampaignService");
const { giftCampaignPublishQueue } = require("../config/queue");
const { resolveShop } = require("../utils/resolveShop");

const shop = (req) => resolveShop(req, req.params.shopId || "active");
async function enqueue(campaignId, { retry = false } = {}) {
  await giftCampaignPublishQueue.resume();
  const baseJobId = `gift-campaign:${campaignId}`;
  const existing = await giftCampaignPublishQueue.getJob(baseJobId);
  if (retry && existing && await existing.isFailed()) {
    await existing.retry();
    return { jobId: existing.id, retried: true };
  }
  const jobId = retry ? `${baseJobId}:${Date.now()}` : baseJobId;
  const job = await giftCampaignPublishQueue.add("publish", { campaignId }, { jobId, attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 500, removeOnFail: 1000 });
  return { jobId: job.id, retried: false };
}
async function getCampaign(req, res) { const currentShop = await shop(req); res.json(await service.getCampaign({ shop: currentShop, campaignId: req.params.campaignId })); }
async function createDraft(req, res) { const currentShop = await shop(req); res.status(201).json(await service.createDraft({ shop: currentShop, userId: req.auth.userId, input: req.body || {} })); }
async function updateDraft(req, res) { const currentShop = await shop(req); res.json(await service.updateDraft({ shop: currentShop, userId: req.auth.userId, campaignId: req.params.campaignId, input: req.body || {} })); }
async function preview(req, res) { const currentShop = await shop(req); res.json(await service.preview({ shop: currentShop, userId: req.auth.userId, campaignId: req.params.campaignId, input: req.body || {} })); }
async function logisticsOptions(req, res) { const currentShop = await shop(req); res.json(await service.logisticsOptions({ shop: currentShop, campaignId: req.params.campaignId, input: req.body || {} })); }
async function confirm(req, res) { const currentShop = await shop(req); res.json(await service.confirm({ shop: currentShop, userId: req.auth.userId, campaignId: req.params.campaignId, input: req.body || {} })); }
async function publish(req, res) { const currentShop = await shop(req); res.status(202).json(await service.queuePublish({ shop: currentShop, userId: req.auth.userId, campaignId: req.params.campaignId, enqueue })); }
async function retry(req, res) { const currentShop = await shop(req); res.status(202).json(await service.retry({ shop: currentShop, userId: req.auth.userId, campaignId: req.params.campaignId, enqueue })); }
async function cancel(req, res) { const currentShop = await shop(req); res.json(await service.cancel({ shop: currentShop, userId: req.auth.userId, campaignId: req.params.campaignId })); }
module.exports = { getCampaign, createDraft, updateDraft, preview, logisticsOptions, confirm, publish, retry, cancel, _test: { enqueue } };