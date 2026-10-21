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
      encryptionKey: key,
    });
    res.cookie(COOKIE_NAME, browserNonce, {
      ...cookieOptions(),
      maxAge: 24 * 60 * 60 * 1000,
    });
    return res.redirect("/selecao-plataforma?trial=shopee_email_required");
  }

  return { start, callback };
}

module.exports = { createPublicTrialOAuthController, COOKIE_NAME };
