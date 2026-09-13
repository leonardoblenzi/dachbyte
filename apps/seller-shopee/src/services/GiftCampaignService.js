"use strict";

const crypto = require("crypto");
const repoDefault = require("../repositories/giftCampaignSqlRepository");
const { buildGiftCampaignPreview } = require("./GiftCampaignPricingService");
const { buildGiftCampaignLogisticsOptions } = require("./GiftCampaignLogisticsService");
const Logistics = require("./ShopeeLogisticsService");
const Writes = require("./ShopeeProductWriteService");
const remoteDefault = require("./ShopeeAddOnDealService");
const PricingV6 = require("./PricingV6Service");
const { analyzeLogistics, analyzeSpxPhysicalEligibility, identifyChannelKind } = require("../utils/productLogistics");

const DEFAULT_MAX_DURATION_DAYS = 30;
const POLICIES = new Set(["skip", "skip_conflicts", "replace_upcoming", "replace_existing", "raise_base_remove_promotions"]);
const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const rows = (value) => Array.isArray(value) ? value : [];
const unique = (values) => Array.from(new Set(rows(values).map((value) => String(value || "").trim()).filter(Boolean)));
function nameOf(value) { const name = String(value || "").trim().replace(/\s+/g, " "); if (name.length < 3 || name.length > 120) throw bad("Informe um nome de campanha entre 3 e 120 caracteres"); return name; }
function policyOf(value) { const policy = String(value || "skip").trim().toLowerCase(); if (!POLICIES.has(policy)) throw bad("Politica de conflito de preco invalida"); return policy === "skip_conflicts" ? "skip" : policy; }
function maxDays() { const days = Number(process.env.SHOPEE_ADD_ON_DEAL_MAX_DURATION_DAYS || process.env.GIFT_CAMPAIGN_MAX_DURATION_DAYS || DEFAULT_MAX_DURATION_DAYS); return Number.isInteger(days) && days >= 1 && days <= 180 ? days : DEFAULT_MAX_DURATION_DAYS; }
async function get({ shop, campaignId, repository = repoDefault }) { if (!shop?.id) throw bad("Loja invalida"); const campaign = await repository.getGiftCampaign({ shopId: shop.id, campaignId }); if (!campaign) throw bad("Campanha de brinde nao encontrada", 404); return campaign; }
function previewFor(campaign) { return buildGiftCampaignPreview({ ...campaign, maximumDurationDays: maxDays() }); }
function optionsFor(campaign) { return buildGiftCampaignLogisticsOptions({ mainItems: campaign.mainItems || [], giftItems: campaign.giftItems || [] }); }
function approvedKeys(input, preview, mainItems) { const available = new Set(rows(preview?.lines).map((line) => String(line?.key || "")).filter(Boolean)); const selected = Array.isArray(input?.approvedPriceKeys) ? unique(input.approvedPriceKeys) : rows(mainItems).map((item) => String(item?.pricingKey || item?.key || "")).filter(Boolean); if (!selected.length || selected.some((key) => !available.has(key))) throw bad("Precos aprovados invalidos"); return selected; }

async function createDraft({ shop, userId, input = {}, repository = repoDefault }) {
  if (!shop?.id) throw bad("Loja invalida");
  return repository.createGiftCampaign({ id: crypto.randomUUID(), shopId: shop.id, name: nameOf(input.name), status: "draft", minSpendCents: input.minSpendCents, targetMarginRate: input.targetMarginRate, startAt: input.startAt, endAt: input.endAt, useMaxDuration: Boolean(input.useMaxDuration), conflictPolicy: policyOf(input.conflictPolicy), mainItems: input.mainItems || [], giftItems: input.giftItems || [], preview: {}, logisticsPlan: {}, idempotencyKey: `gift-campaign:${crypto.randomUUID()}`, createdByUserId: userId, updatedByUserId: userId });
}
async function updateDraft({ shop, userId, campaignId, input = {}, repository = repoDefault }) {
  const campaign = await get({ shop, campaignId, repository });
  if (!["draft", "previewed"].includes(campaign.status)) throw bad("Somente rascunhos podem ser alterados", 409);
  const next = { ...campaign, ...input, name: input.name == null ? campaign.name : nameOf(input.name), conflictPolicy: input.conflictPolicy == null ? campaign.conflictPolicy : policyOf(input.conflictPolicy), shopId: shop.id, campaignId, updatedByUserId: userId };
  await repository.replaceCampaignItems(next);
  return repository.updateGiftCampaign(next);
}
async function preview({ shop, userId, campaignId, input = {}, repository = repoDefault }) {
  const campaign = await get({ shop, campaignId, repository });
  const result = previewFor({ ...campaign, ...input, mainItems: input.mainItems || campaign.mainItems, giftItems: input.giftItems || campaign.giftItems });
  await repository.updateGiftCampaign({ shopId: shop.id, campaignId, preview: result, startAt: result.period.startAt, endAt: result.period.endAt, updatedByUserId: userId });
  return result;
}
async function logisticsOptions({ shop, campaignId, input = {}, repository = repoDefault, logistics = Logistics }) { const campaign = await get({ shop, campaignId, repository }); const mainItems = input.mainItems || campaign.mainItems || []; const giftItems = input.giftItems || campaign.giftItems || []; const itemIds = unique([...mainItems, ...giftItems].map((item) => item?.itemId)); if (!itemIds.length) throw bad("Selecione os itens da campanha antes de validar a logistica", 422); const live = await logistics.getProductsBaseInfo({ shopId: externalShopId(campaign), itemIds }); const byId = new Map(rows(live).map((item) => [String(item?.item_id ?? item?.itemId ?? ""), item])); const enrich = (item) => { const raw = byId.get(String(item?.itemId)); if (!raw) throw bad(`Produto ${item?.itemId || ""} nao foi confirmado ao vivo na Shopee`, 409); return liveSummary(raw, item); }; return optionsFor({ mainItems: mainItems.map(enrich), giftItems: giftItems.map(enrich) }); }
async function confirm({ shop, userId, campaignId, input = {}, repository = repoDefault }) {
  const campaign = await get({ shop, campaignId, repository });
  if (!["draft", "previewed", "awaiting_confirmation"].includes(campaign.status)) throw bad("Campanha nao pode ser confirmada neste estado", 409);
  const result = previewFor({ ...campaign, ...input, mainItems: campaign.mainItems, giftItems: campaign.giftItems });
  const option = optionsFor(campaign).options.find((entry) => entry.id === input.logisticsResolution);
  if (!option || !option.feasible || option.id === "edit_selection") throw bad("Selecione uma opcao de logistica viavel");
  const name = input.name == null ? nameOf(campaign.name) : nameOf(input.name);
  const priceKeys = approvedKeys(input, result, campaign.mainItems);
  await repository.updateGiftCampaign({ shopId: shop.id, campaignId, name, preview: { ...result, approvedPriceKeys: priceKeys }, logisticsResolution: option.id, logisticsPlan: option, startAt: result.period.startAt, endAt: result.period.endAt, conflictPolicy: policyOf(input.conflictPolicy || campaign.conflictPolicy), updatedByUserId: userId });
  await repository.setGiftCampaignState({ shopId: shop.id, campaignId, status: "awaiting_confirmation", updatedByUserId: userId });
  await repository.appendGiftCampaignAction({ shopId: shop.id, campaignId, actorUserId: userId, action: "confirmed", payload: { name, logisticsOptionId: option.id, approvedPriceKeys: priceKeys } });
  return get({ shop, campaignId, repository });
}
function externalShopId(campaign) { return String(campaign?.shopeeShopId || campaign?.externalShopId || campaign?.shopId || ""); }
function publicKind(kind) { return kind === "intelipost" ? "seller" : String(kind || ""); }
function liveSummary(raw, fallback) {
  const rawLogistics = rows(raw?.logistic_info || raw?.logistics || fallback?.logistics);
  const analyzed = analyzeLogistics(rawLogistics);
  const physical = analyzeSpxPhysicalEligibility({ logistics: rawLogistics, dimension: raw?.dimension || fallback?.dimension, weight: raw?.weight ?? fallback?.weight });
  return { ...fallback, itemId: String(raw?.item_id ?? raw?.itemId ?? fallback?.itemId ?? ""), logistics: analyzed.logistics, shippingKinds: analyzed.shippingKinds.map(publicKind), spxPhysicalEligible: physical.eligible, spxEligibilityReasons: physical.reasons, _rawLogistics: rawLogistics };
}
async function revalidateLiveLogistics(campaign, dependencies) {
  const all = [...rows(campaign.mainItems), ...rows(campaign.giftItems)];
  const itemIds = unique(all.map((item) => item?.itemId));
  if (!itemIds.length || itemIds.length !== all.length) throw bad("Todos os itens da campanha precisam de um identificador Shopee valido", 409);
  const live = await dependencies.logistics.getProductsBaseInfo({ shopId: externalShopId(campaign), itemIds });
  const byId = new Map(rows(live).map((item) => [String(item?.item_id ?? item?.itemId ?? ""), item]));
  const resolve = (item) => { const raw = byId.get(String(item.itemId)); if (!raw) throw bad(`Produto ${item.itemId} nao foi confirmado ao vivo na Shopee`, 409); return liveSummary(raw, item); };
  const mainItems = rows(campaign.mainItems).map(resolve);
  const giftItems = rows(campaign.giftItems).map(resolve);
  const option = optionsFor({ mainItems, giftItems }).options.find((entry) => entry.id === campaign.logisticsResolution);
  if (!option || !option.feasible || option.id === "edit_selection") throw bad("A logistica mudou na Shopee; revise a campanha antes de publicar", 409);
  return { mainItems, giftItems, option };
}
function logisticsPayloadForTarget(item, targetKinds) {
  const wanted = new Set(rows(targetKinds).map(publicKind));
  const original = rows(item?._rawLogistics);
  if (!original.length || !wanted.size) throw bad("Logistica ao vivo indisponivel para o item", 409);
  return original.map((channel) => {
    const enabled = wanted.has(publicKind(identifyChannelKind(channel)));
    const next = { ...channel, enabled };
    if (Object.hasOwn(next, "is_enabled")) next.is_enabled = enabled;
    if (Object.hasOwn(next, "selected")) next.selected = enabled;
    if (Object.hasOwn(next, "is_selected")) next.is_selected = enabled;
    return next;
  });
}
function changedEnabled(before, after) { return rows(before).some((channel, index) => { const next = after[index] || {}; const was = Boolean(channel?.enabled ?? channel?.is_enabled ?? channel?.selected ?? channel?.is_selected); const now = Boolean(next?.enabled ?? next?.is_enabled ?? next?.selected ?? next?.is_selected); return was !== now; }); }
function plannedLogisticsUpdates(live) {
  const byId = new Map([...live.mainItems, ...live.giftItems].map((item) => [String(item.itemId), item]));
  return rows(live.option?.changes).filter((change) => change?.itemId && change?.feasible).map((change) => { const item = byId.get(String(change.itemId)); if (!item) throw bad("Item de logistica nao encontrado na revalidacao", 409); const logistics = logisticsPayloadForTarget(item, change.targetKinds); return { itemId: String(change.itemId), targetKinds: unique(change.targetKinds), logistics, needed: changedEnabled(item._rawLogistics, logistics) }; });
}
async function validateLivePrices(campaign, dependencies) {
  const allowed = new Set(unique(campaign.preview?.approvedPriceKeys));
  const lines = rows(campaign.preview?.lines).filter((line) => allowed.has(String(line?.key || "")));
  if (!lines.length) throw bad("Nenhum preco aprovado foi confirmado para a campanha", 409);
  const mains = new Map(rows(campaign.mainItems).map((item) => [String(item?.pricingKey || item?.key || ""), item]));
  const items = lines.map((line) => { const item = mains.get(String(line.key)); if (!item?.itemId || !Number.isSafeInteger(Number(line.suggestedPriceCents)) || Number(line.suggestedPriceCents) <= 0) throw bad("Preco aprovado invalido na previa", 409); return { ...item, recommendedPriceCents: Number(line.suggestedPriceCents) }; });
  const policy = policyOf(campaign.conflictPolicy);
  if (typeof dependencies.priceValidation !== "function") return { items, policy };
  const result = await dependencies.priceValidation({ shop: { id: campaign.shopId, shopId: externalShopId(campaign) }, items, conflictPolicy: policy });
  const eligible = rows(result?.items || result?.eligibleItems || items);
  if (eligible.length !== items.length) throw bad("Precos aprovados nao passaram na validacao ao vivo; revise a campanha", 409);
  return { items: eligible, policy };
}
function doneSteps(campaign) { return new Set(rows(campaign.actions).filter((entry) => entry?.action === "external_effect_completed").map((entry) => String(entry?.payload?.stepKey || "")).filter(Boolean)); }
function sanitized(effect, payload = {}) { const safe = { effect, ...payload }; delete safe.logistics; delete safe.raw; delete safe.response; delete safe.token; return safe; }
async function event(repository, campaign, action, payload = {}) { return repository.appendGiftCampaignAction({ campaignId: campaign.id, shopId: campaign.shopId, action, payload: sanitized(action, payload) }); }
async function effect({ repository, campaign, completed, stepKey, kind, payload, execute }) {
  if (completed.has(stepKey)) return { skipped: true };
  await event(repository, campaign, "external_effect_started", { stepKey, kind, ...payload });
  try { const result = await execute(); await event(repository, campaign, "external_effect_completed", { stepKey, kind, ...payload }); completed.add(stepKey); return { result, skipped: false }; }
  catch (error) { await event(repository, campaign, "external_effect_failed", { stepKey, kind, ...payload, message: String(error?.message || error).slice(0, 500) }); throw error; }
}
function catalogInvalidator(dependencies = {}) {
  return dependencies.invalidateCatalog || PricingV6.invalidateCatalogForGiftCampaignState;
}
async function transitionCampaignState({ repository, campaign, status, updatedByUserId, invalidateCatalog = catalogInvalidator() }) {
  await repository.setGiftCampaignState({
    campaignId: campaign.id,
    shopId: campaign.shopId,
    status,
    ...(updatedByUserId == null ? {} : { updatedByUserId }),
  });
  try {
    await invalidateCatalog({ shopId: campaign.shopId, status });
  } catch (error) {
    error.giftCampaignStateApplied = status;
    throw error;
  }
}
async function mark(repository, campaign, progress, status, action, payload = {}, invalidateCatalog) {
  await transitionCampaignState({ repository, campaign, status, invalidateCatalog });
  await event(repository, campaign, action, payload);
  if (typeof progress === "function") await progress({ status, action });
}
async function publishWithDependencies({ campaign, remote, repository, progress = async () => {}, dependencies = {} }) {
  const deps = {
    logistics: dependencies.logistics || Logistics,
    writes: dependencies.writes || Writes,
    priceValidation: dependencies.priceValidation || PricingV6.validateGiftCampaignBasePrices,
    invalidateCatalog: catalogInvalidator(dependencies),
  };
  let effected = Boolean(campaign.remoteAddOnDealId);
  const completed = doneSteps(campaign);
  try {
    await mark(repository, campaign, progress, "validating", "publish_validating", {}, deps.invalidateCatalog);
    const liveLogistics = await revalidateLiveLogistics(campaign, deps);
    const prices = await validateLivePrices(campaign, deps);
    const logistics = plannedLogisticsUpdates(liveLogistics);
    await mark(repository, campaign, progress, "applying_logistics", "logistics_started", { count: logistics.filter((item) => item.needed).length }, deps.invalidateCatalog);
    for (const update of logistics) {
      if (!update.needed) continue;
      const result = await effect({ repository, campaign, completed, stepKey: `logistics:${update.itemId}`, kind: "update_logistics", payload: { itemId: update.itemId, targetKinds: update.targetKinds }, execute: () => deps.logistics.updateProductLogistics({ shopId: externalShopId(campaign), itemId: update.itemId, logistics: update.logistics }) });
      effected ||= !result.skipped;
    }
    await mark(repository, campaign, progress, "applying_prices", "prices_started", { count: prices.items.length, policy: prices.policy }, deps.invalidateCatalog);
    for (const item of prices.items) {
      const result = await effect({ repository, campaign, completed, stepKey: `price:${item.itemId}:${item.modelId == null ? 0 : item.modelId}`, kind: "update_price", payload: { itemId: String(item.itemId), modelId: item.modelId == null ? null : String(item.modelId), priceCents: item.recommendedPriceCents, policy: prices.policy }, execute: () => deps.writes.updatePrice({ shopId: externalShopId(campaign), body: { item_id: Number(item.itemId), price_list: [{ model_id: item.modelId == null ? 0 : Number(item.modelId), original_price: Number(item.recommendedPriceCents) / 100 }] } }) });
      effected ||= !result.skipped;
    }
    let addOnDealId = campaign.remoteAddOnDealId;
    if (!addOnDealId) {
      await mark(repository, campaign, progress, "creating_campaign", "campaign_started", {}, deps.invalidateCatalog);
      const stepKey = "campaign:create";
      if (completed.has(stepKey)) throw bad("Checkpoint remoto inconsistente; revise a campanha antes de repetir", 409);
      await event(repository, campaign, "external_effect_started", { stepKey, kind: "create_add_on_deal", name: nameOf(campaign.name), minSpendCents: campaign.minSpendCents });
      try {
        const created = await remote.createGiftWithMinimumSpend({ shopId: externalShopId(campaign), name: nameOf(campaign.name), startAt: campaign.startAt, endAt: campaign.endAt, minSpendCents: campaign.minSpendCents });
        addOnDealId = created?.addOnDealId;
        if (!addOnDealId) throw new Error("Shopee nao retornou o identificador da campanha de brinde");
        // Persist the remote id before the completed checkpoint. A crash can then resume safely.
        await repository.setGiftCampaignState({ campaignId: campaign.id, shopId: campaign.shopId, status: "creating_campaign", remoteAddOnDealId: addOnDealId });
        await event(repository, campaign, "remote_campaign_checkpoint", { addOnDealId: String(addOnDealId) });
        await event(repository, campaign, "external_effect_completed", { stepKey, kind: "create_add_on_deal", addOnDealId: String(addOnDealId) });
        completed.add(stepKey);
        effected = true;
      } catch (error) {
        await event(repository, campaign, "external_effect_failed", { stepKey, kind: "create_add_on_deal", message: String(error?.message || error).slice(0, 500) });
        throw error;
      }
    }    const mainItems = rows(campaign.mainItems).map((item) => ({ item_id: Number(item.itemId), model_id: item.modelId == null ? undefined : Number(item.modelId) }));
    const giftItems = rows(campaign.giftItems).map((item) => ({ item_id: Number(item.itemId), model_id: item.modelId == null ? undefined : Number(item.modelId) }));
    const main = await effect({ repository, campaign, completed, stepKey: "campaign:add_main_items", kind: "add_main_items", payload: { addOnDealId: String(addOnDealId), itemCount: mainItems.length }, execute: () => remote.addMainItems({ shopId: externalShopId(campaign), addOnDealId, itemList: mainItems }) });
    effected ||= !main.skipped;
    const gifts = await effect({ repository, campaign, completed, stepKey: "campaign:add_gift_items", kind: "add_gift_items", payload: { addOnDealId: String(addOnDealId), itemCount: giftItems.length }, execute: () => remote.addGiftItems({ shopId: externalShopId(campaign), addOnDealId, itemList: giftItems }) });
    effected ||= !gifts.skipped;
    await mark(repository, campaign, progress, "published", "publish_completed", { remoteAddOnDealId: String(addOnDealId) }, deps.invalidateCatalog);
    return { ok: true, remoteAddOnDealId: addOnDealId };
  } catch (error) {
    if (error?.giftCampaignStateApplied === "published") throw error;
    await transitionCampaignState({ repository, campaign, status: effected ? "partial_failed" : "failed", invalidateCatalog: deps.invalidateCatalog });
    await event(repository, campaign, "publish_failed", { message: String(error?.message || error).slice(0, 500) });
    throw error;
  }
}
async function runPublishJob({ campaignId, progress, repository = repoDefault, remote = remoteDefault }) { const campaign = await repository.getGiftCampaignByIdUnsafe?.({ campaignId }); if (!campaign) throw bad("Campanha de brinde nao encontrada", 404); if (!["queued", "partial_failed"].includes(campaign.status)) return { ok: true, ignored: true, status: campaign.status }; return publishWithDependencies({ campaign, progress, repository, remote }); }
async function queuePublish({ shop, userId, campaignId, enqueue, repository = repoDefault }) { const campaign = await get({ shop, campaignId, repository }); if (campaign.status !== "awaiting_confirmation") throw bad("Confirme o rascunho antes de publicar", 409); if (!campaign.logisticsResolution || campaign.logisticsResolution === "edit_selection") throw bad("Edite a selecao antes de publicar", 409); await repository.setGiftCampaignState({ campaignId, shopId: shop.id, status: "queued", updatedByUserId: userId }); await repository.appendGiftCampaignAction({ campaignId, shopId: shop.id, actorUserId: userId, action: "publish_queued" }); await enqueue(campaignId, { retry: false }); return get({ shop, campaignId, repository }); }
async function retry({ shop, userId, campaignId, enqueue, repository = repoDefault }) { const campaign = await get({ shop, campaignId, repository }); if (!["failed", "partial_failed"].includes(campaign.status)) throw bad("Campanha nao pode ser repetida", 409); await repository.setGiftCampaignState({ campaignId, shopId: shop.id, status: "queued", updatedByUserId: userId }); await repository.appendGiftCampaignAction({ campaignId, shopId: shop.id, actorUserId: userId, action: "publish_retry_queued" }); await enqueue(campaignId, { retry: true }); return get({ shop, campaignId, repository }); }
async function cancel({ shop, userId, campaignId, repository = repoDefault, invalidateCatalog = catalogInvalidator() }) {
  const campaign = await get({ shop, campaignId, repository });
  if (campaign.status === "published") throw bad("Campanha publicada deve ser encerrada na Shopee", 409);
  await transitionCampaignState({ repository, campaign, status: "cancelled", updatedByUserId: userId, invalidateCatalog });
  return get({ shop, campaignId, repository });
}
async function createDraftWithDependencies({ repository, input }) { return repository.createGiftCampaign({ id: crypto.randomUUID(), shopId: input.shopId, name: nameOf(input.name), status: "draft", minSpendCents: input.minSpendCents, createdByUserId: input.userId, updatedByUserId: input.userId }); }
module.exports = { getCampaign: get, createDraft, updateDraft, preview, logisticsOptions, confirm, runPublishJob, queuePublish, retry, cancel, _test: { createDraftWithDependencies, publishWithDependencies, transitionCampaignState, revalidateLiveLogistics, plannedLogisticsUpdates, logisticsPayloadForTarget, validateLivePrices, previewFor, maxDays, nameOf } };