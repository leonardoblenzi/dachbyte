"use strict";

const COOKIE_NAME = "shopee_trial_oauth_nonce";
const COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_MS,
  };
}

function createPublicTrialOAuthController(dependencies = {}) {
  const enabled = dependencies.enabled || (() => process.env.SELLER_TRIAL_ONBOARDING_ENABLED === "true");
  const encryptionKey = dependencies.encryptionKey || (() => process.env.SHOPEE_TRIAL_TOKEN_ENCRYPTION_KEY);
  const client = dependencies.client || {
    query: (...args) => require("../config/postgres").query(...args),
  };
  const session = require("../services/publicTrialOAuthSession");
  const createSession = dependencies.createSession || session.createProvisionalSession;
  const claimCallback = dependencies.claimCallback || session.claimProvisionalCallback;
  const saveCredentials = dependencies.saveCredentials || session.saveProvisionalCredentials;
  const buildAuthUrl = dependencies.buildAuthUrl || ((args) => require("./AuthController").buildAuthUrl(args));
  const findShop = dependencies.findShop || ((shopId) => require("../repositories/oauthSqlRepository").findShopByShopeeShopId(shopId));
  const exchangeToken = dependencies.exchangeToken || ((args) => require("../services/ShopeeAuthService").exchangeCodeForToken(args));
  const loadConfirmedSession = dependencies.loadConfirmedSession || session.loadConfirmedTrialSession;
  const prepareEmail = dependencies.prepareEmail || session.prepareTrialEmail;
  const inspectActivation = dependencies.inspectActivation || session.inspectTrialActivation;
  const emailResolution = require("../services/publicTrialEmailResolution");
  const resolveEmail = dependencies.resolveEmail || ((email) => emailResolution.resolveTrialEmail(email, {
    findLocalUser: (value) => require("../repositories/authSqlRepository").findUserByEmail(value),
    lookupHubEmail: emailResolution.lookupHubEmail,
  }));
  const sendVerificationEmail = dependencies.sendVerificationEmail ||
    require("../services/publicTrialVerificationEmail").sendTrialVerificationEmail;
  const publicOrigin = dependencies.publicOrigin || (() => process.env.SHOPEE_PUBLIC_BASE_URL);
  const lookupHubEmail = dependencies.lookupHubEmail || emailResolution.lookupHubEmail;
  const hashPassword = dependencies.hashPassword || ((value) => require("bcrypt").hash(value, 10));
  const trialPool = dependencies.pool || { connect: (...args) => require("../config/postgres").getPool().connect(...args) };
  const stageIdentity = dependencies.stageIdentity || ((input) =>
    require("../services/publicTrialNewIdentity").stageVerifiedShopeeIdentity(trialPool, input));
  const activateHub = dependencies.activateHub || require("../services/publicTrialHubActivation").activateShopeeTrialInHub;
  const finalizeTrial = dependencies.finalizeTrial || ((input) =>
    require("../services/publicTrialFinalization").finalizeShopeeTrial(trialPool, input));

  async function availability(_req, res) {
    return res.json({ available: enabled() });
  }

  async function start(_req, res) {
    if (!enabled()) return res.status(404).json({ ok: false, error: "not_found" });
    const key = String(encryptionKey() || "");
    if (!/^[a-f0-9]{64}$/i.test(key)) {
      return res.status(503).json({ ok: false, error: "trial_oauth_unavailable" });
    }
    const shopee = dependencies.shopeeConfig || require("../config/shopee");
    const created = await createSession(client);
    const authUrl = buildAuthUrl({
      apiBase: shopee.SHOPEE_API_BASE,
      partnerId: shopee.PARTNER_ID,
      partnerKey: shopee.PARTNER_KEY,
      redirectUrl: shopee.REDIRECT_URL,
      state: created.state,
    });
    res.cookie(COOKIE_NAME, created.browserNonce, cookieOptions());
    return res.json({ ok: true, auth_url: authUrl });
  }

  async function callback(req, res) {
    if (!enabled()) return res.status(404).json({ ok: false, error: "not_found" });
    const state = String(req.query?.state || "").trim();
    const browserNonce = String(req.cookies?.[COOKIE_NAME] || "").trim();
    const code = String(req.query?.code || "").trim();
    const shopId = String(req.query?.shop_id || "").trim();
    const numericShopId = Number(shopId);
    if (!state.startsWith("trial_") || !code || !Number.isSafeInteger(numericShopId) || numericShopId <= 0) {
      return res.status(400).json({ ok: false, error: "trial_oauth_callback_invalid" });
    }
    if (!browserNonce) return res.status(403).json({ ok: false, error: "trial_oauth_session_missing" });
    const key = String(encryptionKey() || "");
    if (!/^[a-f0-9]{64}$/i.test(key)) {
      return res.status(503).json({ ok: false, error: "trial_oauth_unavailable" });
    }
    const claimed = await claimCallback(client, { state, browserNonce });
    if (!claimed) return res.status(403).json({ ok: false, error: "trial_oauth_state_invalid" });
    if (await findShop(shopId)) {
      return res.status(409).json({ ok: false, error: "trial_shopee_shop_already_linked" });
    }
    const payload = await exchangeToken({ code, shopId, persist: false });
    await saveCredentials(client, {
      sessionId: claimed.id,
      shopId,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      accessExpiresIn: payload.expire_in,
      refreshExpiresIn: payload.refresh_expire_in,
      encryptionKey: key,
    });
    res.cookie(COOKIE_NAME, browserNonce, {
      ...cookieOptions(),
      maxAge: 24 * 60 * 60 * 1000,
    });
    return res.redirect("/shopee/trial-email.html");
  }

  async function email(req, res) {
    if (!enabled()) return res.status(404).json({ ok: false, error: "not_found" });
    const browserNonce = String(req.cookies?.[COOKIE_NAME] || "").trim();
    if (!browserNonce || !(await loadConfirmedSession(client, browserNonce))) {
      return res.status(403).json({ ok: false, error: "trial_oauth_session_missing" });
    }
    try {
      const resolved = await resolveEmail(req.body?.email);
      const origin = String(publicOrigin() || "").trim().replace(/\/+$/, "");
      if (resolved.action === "send_activation" && !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin)) {
        return res.status(503).json({ ok: false, error: "trial_public_origin_unavailable" });
      }
      const prepared = await prepareEmail(client, { browserNonce, ...resolved });
      if (resolved.action === "login_required") {
        return res.json({ ok: true, action: "login_required" });
      }
      const activationLink = `${origin}/shopee/auth/trial/verify?token=${encodeURIComponent(prepared.token)}`;
      const delivered = await sendVerificationEmail({ toEmail: resolved.email, activationLink });
      if (!delivered?.sent) {
        return res.status(503).json({ ok: false, error: "trial_email_delivery_unavailable" });
      }
      return res.json({ ok: true, action: "verification_sent" });
    } catch (error) {
      if (error.message === "trial_email_invalid") {
        return res.status(400).json({ ok: false, error: error.message });
      }
      return res.status(503).json({ ok: false, error: "trial_email_unavailable" });
    }
  }

  async function verify(req, res) {
    if (!enabled()) return res.status(404).json({ ok: false, error: "not_found" });
    const verified = await inspectActivation(client, String(req.query?.token || ""));
    if (!verified) return res.status(410).json({ ok: false, error: "trial_verification_invalid_or_expired" });
    return res.redirect(`/shopee/trial-activate.html?token=${encodeURIComponent(String(req.query.token))}`);
  }

  async function activate(req, res) {
    if (!enabled()) return res.status(404).json({ ok: false, error: "not_found" });
    const token = String(req.body?.token || "").trim();
    const fullName = String(req.body?.full_name || "").trim();
    const companyName = String(req.body?.company_name || "").trim();
    const password = String(req.body?.password || "");
    if (!token || !fullName || !companyName || password.length < 10 ||
        !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
      return res.status(400).json({ ok: false, error: "trial_activation_fields_invalid" });
    }
    const key = String(encryptionKey() || "");
    if (!/^[a-f0-9]{64}$/i.test(key)) {
      return res.status(503).json({ ok: false, error: "trial_oauth_unavailable" });
    }
    try {
      const candidate = await inspectActivation(client, token);
      if (!candidate) return res.status(410).json({ ok: false, error: "trial_activation_invalid_or_expired" });
      if (candidate.status !== "identity_staged") {
        const existing = await lookupHubEmail(candidate.email);
        if (existing?.exists !== false) {
          return res.status(409).json({ ok: false, error: "trial_email_login_required" });
        }
      }
      const staged = await stageIdentity({ token, fullName, companyName,
        passwordHash: await hashPassword(password) });
      const activation = await activateHub({
        tenantId: staged.tenantId, companyName: staged.companyName,
        userId: staged.globalUserId, fullName: staged.fullName,
        email: staged.email, shopId: staged.shopId, newIdentity: true,
      });
      const finalized = await finalizeTrial({
        sessionId: staged.sessionId, tenantId: staged.tenantId,
        shopId: staged.shopId, activation, encryptionKey: key,
      });
      return res.json({ ok: true, action: "activated", shop_id: String(staged.shopId),
        trial_active: finalized.trialActive });
    } catch (error) {
      const code = String(error?.message || "");
      if (["trial_email_login_required", "trial_shopee_shop_already_linked"].includes(code)) {
        return res.status(409).json({ ok: false, error: code });
      }
      if (code === "trial_activation_invalid_or_expired") {
        return res.status(410).json({ ok: false, error: code });
      }
      return res.status(503).json({ ok: false, error: "trial_activation_pending_retry" });
    }
  }

  return { availability, start, callback, email, verify, activate };
}

module.exports = { createPublicTrialOAuthController, COOKIE_NAME };
