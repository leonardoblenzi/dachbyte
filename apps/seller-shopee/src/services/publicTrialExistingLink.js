"use strict";

const { confirmHubTrialActivation } = require("./publicTrialNewIdentity");

async function linkExistingShopeeTrial(input, dependencies = {}) {
  const encryptionKey = String(dependencies.encryptionKey || process.env.SHOPEE_TRIAL_TOKEN_ENCRYPTION_KEY || "");
  if (!/^[a-f0-9]{64}$/i.test(encryptionKey)) throw new Error("trial_encryption_key_invalid");
  const pool = () => dependencies.pool || require("../config/postgres").getPool();
  const stageIdentity = dependencies.stageIdentity || ((value) =>
    require("./publicTrialExistingIdentity").stageExistingShopeeIdentity(pool(), value));
  const activateHub = dependencies.activateHub ||
    require("./publicTrialHubActivation").activateShopeeTrialInHub;
  const finalizeTrial = dependencies.finalizeTrial || ((value) =>
    require("./publicTrialFinalization").finalizeShopeeTrial(pool(), value));
  const staged = await stageIdentity(input);
  const activation = await activateHub({
    tenantId: staged.tenantId, companyName: staged.companyName,
    userId: staged.globalUserId, fullName: staged.fullName,
    email: staged.email, shopId: staged.shopId, newIdentity: false,
    role: input.identity?.role,
  });
  const confirmed = confirmHubTrialActivation({
    tenantId: staged.tenantId, shopId: staged.shopId, activation,
  });
  const finalized = await finalizeTrial({
    sessionId: staged.sessionId, tenantId: staged.tenantId,
    shopId: staged.shopId, activation,
    encryptionKey,
  });
  return { shopId: staged.shopId, trialActive: finalized.trialActive };
}

module.exports = { linkExistingShopeeTrial };
