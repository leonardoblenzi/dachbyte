const crypto = require("crypto");
const shopee = require("../config/shopee");
const shopeeAds = require("../config/shopeeAds");
const {
  countShopsByAccountId,
  updateSessionActiveShopId,
} = require("../repositories/authSqlRepository");
const {
  findShopByShopeeShopId,
  upsertOAuthTokens,
  upsertShop,
} = require("../repositories/oauthSqlRepository");
const {
  consumeLatestIssuedOAuthStateForUser,
  consumeOAuthState,
  createOAuthState,
} = require("../repositories/oauthStateSqlRepository");
const { hmacSha256Hex } = require("../utils/crypto");
const ShopeeAuthService = require("../services/ShopeeAuthService");
const ShopeeAdsAuthService = require("../services/ShopeeAdsAuthService");
const {
  ensureShopResourceSynced,
} = require("../services/hubResourceBillingService");

const AUTH_FLOW_COOKIE = "shopee_auth_flow";

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function createOAuthStateToken() {
  return crypto.randomBytes(20).toString("hex");
}

function signAuthPartner(path, timestamp, partnerId, partnerKey) {
  const base = `${partnerId}${path}${timestamp}`;
  return hmacSha256Hex(String(partnerKey || ""), base);
}

function authFlowCookieOptions() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
  };
}

function setAuthFlowCookie(res, flow) {
  res.cookie(AUTH_FLOW_COOKIE, flow, authFlowCookieOptions());
}

function clearAuthFlowCookie(res) {
  res.clearCookie(AUTH_FLOW_COOKIE, authFlowCookieOptions());
}

function buildAuthUrl({ apiBase, partnerId, partnerKey, redirectUrl, state = null }) {
  if (!apiBase || !partnerId || !partnerKey || !redirectUrl) {
    const err = new Error("Configuracao Shopee ausente para gerar auth_url");
    err.statusCode = 500;
    throw err;
  }

  const timestamp = nowTs();
  const path = "/api/v2/shop/auth_partner";
  const sign = signAuthPartner(path, timestamp, partnerId, partnerKey);
  const redirect = encodeURIComponent(redirectUrl);

  return (
    `${apiBase}${path}` +
    `?partner_id=${partnerId}` +
    `&timestamp=${timestamp}` +
    `&sign=${sign}` +
    `&redirect=${redirect}` +
    (state ? `&state=${encodeURIComponent(String(state))}` : "")
  );
}

function getTokenExpirations(payload) {
  const expireInSec = Number(payload?.expire_in ?? payload?.expireIn ?? 0);
  const refreshExpireInSec = Number(
    payload?.refresh_expire_in ?? payload?.refreshExpireIn ?? 0
  );

  return {
    accessTokenExpiresAt:
      Number.isFinite(expireInSec) && expireInSec > 0
        ? new Date(Date.now() + expireInSec * 1000)
        : null,
    refreshTokenExpiresAt:
      Number.isFinite(refreshExpireInSec) && refreshExpireInSec > 0
        ? new Date(Date.now() + refreshExpireInSec * 1000)
        : null,
  };
}

async function ensureShopCanBeLinked({ accountId, shopeeShopId }) {
  const existingShop = await findShopByShopeeShopId(shopeeShopId);

  if (existingShop?.accountId && existingShop.accountId !== accountId) {
    return { existingShop, conflict: true, shopLimitReached: false, currentShopCount: null };
  }

  let currentShopCount = null;
  if (!existingShop) {
    currentShopCount = await countShopsByAccountId(accountId);
    if (currentShopCount >= 2) {
      return { existingShop, conflict: false, shopLimitReached: true, currentShopCount };
    }
  }

  return { existingShop, conflict: false, shopLimitReached: false, currentShopCount };
}

async function upsertAuthorizedShop({ accountId, shopeeShopId, existingShop }) {
  return upsertShop({
    accountId: existingShop?.accountId ?? accountId,
    shopId: shopeeShopId,
    region: null,
    status: "AUTHORIZED",
  });
}

async function getAuthUrl(req, res) {
  const mode = String(req.query?.mode || "").toLowerCase();

  if (mode === "add_shop") {
    if (
      !req.auth ||
      (req.auth.role !== "ADMIN" && req.auth.role !== "SUPER_ADMIN")
    ) {
      return res.status(403).json({
        error: "forbidden",
        message: "Apenas ADMIN pode adicionar loja.",
      });
    }

    const accountId = req.auth.accountId;
    const shopsCount = await countShopsByAccountId(accountId);

    if (shopsCount >= 2) {
      return res.status(400).json({
        error: "shop_limit_reached",
        message: "Limite de 2 lojas por conta atingido.",
      });
    }
  }

  setAuthFlowCookie(res, "shop");

  const state = createOAuthStateToken();
  try {
    await createOAuthState({
      state,
      flow: "shop",
      userId: req.auth?.userId || null,
      accountId: req.auth?.accountId || null,
      returnTo: "/shopee/?tab=auth",
      status: "ISSUED",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      metadata: {
        mode: mode || null,
      },
    });
  } catch (error) {
    console.error("oauth state issue error:", error?.message || error);
  }

  const url = buildAuthUrl({
    apiBase: shopee.SHOPEE_API_BASE,
    partnerId: shopee.PARTNER_ID,
    partnerKey: shopee.PARTNER_KEY,
    redirectUrl: shopee.REDIRECT_URL || "",
    state,
  });

  res.json({ auth_url: url, state });
}

async function getAdsAuthUrl(req, res) {
  setAuthFlowCookie(res, "ads");

  const state = createOAuthStateToken();
  try {
    await createOAuthState({
      state,
      flow: "ads",
      userId: req.auth?.userId || null,
      accountId: req.auth?.accountId || null,
      returnTo: "/shopee/?tab=ads",
      status: "ISSUED",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
  } catch (error) {
    console.error("oauth state issue error:", error?.message || error);
  }

  const url = buildAuthUrl({
    apiBase: shopeeAds.SHOPEE_ADS_API_BASE,
    partnerId: shopeeAds.PARTNER_ID,
    partnerKey: shopeeAds.PARTNER_KEY,
    redirectUrl: shopeeAds.REDIRECT_URL || shopee.REDIRECT_URL || "",
    state,
  });

  res.json({ auth_url: url, state });
}

async function callback(req, res) {
  const { code, shop_id: shopId, main_account_id: mainAccountId } = req.query;
  const stateParam = String(req.query?.state || "").trim() || null;
  const authFlow =
    String(req.cookies?.[AUTH_FLOW_COOKIE] || "").toLowerCase() === "ads"
      ? "ads"
      : "shop";

  const accountId = req.auth?.accountId;
  const sessionId = req.auth?.sid || null;

  const markOAuthState = async (status, options = {}) => {
    const metadata = {
      authFlow,
      reason: options.reason || null,
    };

    if (stateParam) {
      await consumeOAuthState(stateParam, {
        status,
        shopId: options.shopId || null,
        metadata,
      }).catch(() => {});
      return;
    }

    if (req.auth?.userId != null) {
      await consumeLatestIssuedOAuthStateForUser({
        userId: req.auth.userId,
        flow: authFlow,
        status,
        shopId: options.shopId || null,
        metadata,
      }).catch(() => {});
    }
  };

  if (!accountId) {
    const err = new Error(
      "Nao autenticado: nao foi possivel identificar a conta para vincular a loja."
    );
    err.statusCode = 401;
    throw err;
  }

  if (!code || !shopId) {
    const err = new Error("Callback invalido: faltando code ou shop_id");
    err.statusCode = 400;
    throw err;
  }

  const shopeeShopId = BigInt(String(shopId));
  const { existingShop, conflict, shopLimitReached, currentShopCount } =
    await ensureShopCanBeLinked({
      accountId,
      shopeeShopId,
    });

  if (conflict) {
    await markOAuthState("REJECTED", { reason: "shop_already_linked" });
    clearAuthFlowCookie(res);
    return res.status(409).json({
      error: "shop_already_linked",
      message: "Esta loja ja esta vinculada a outra conta.",
    });
  }

  if (shopLimitReached) {
    await markOAuthState("REJECTED", { reason: "shop_limit_reached" });
    clearAuthFlowCookie(res);
    return res.status(400).json({
      error: "shop_limit_reached",
      message: "Limite de 2 lojas por conta atingido.",
    });
  }

  const payload =
    authFlow === "ads"
      ? await ShopeeAdsAuthService.exchangeCodeForToken({
          code: String(code),
          shopId: String(shopId),
          mainAccountId: mainAccountId ? String(mainAccountId) : undefined,
          persist: false,
        })
      : await ShopeeAuthService.exchangeCodeForToken({
          code: String(code),
          shopId: String(shopId),
          mainAccountId: mainAccountId ? String(mainAccountId) : undefined,
        });

  const shop = await upsertAuthorizedShop({
    accountId,
    shopeeShopId,
    existingShop,
  });

  const accessToken = payload?.access_token ?? payload?.accessToken ?? null;
  const refreshToken = payload?.refresh_token ?? payload?.refreshToken ?? null;
  const { accessTokenExpiresAt, refreshTokenExpiresAt } =
    getTokenExpirations(payload);

  await upsertOAuthTokens({
    shopDbId: shop.id,
    authFlow,
    accessToken: accessToken ? String(accessToken) : null,
    accessTokenExpiresAt,
    refreshToken: refreshToken ? String(refreshToken) : null,
    refreshTokenExpiresAt,
  });

  if (sessionId) {
    await updateSessionActiveShopId(String(sessionId), shop.id);
  }

  const isAdditionalNewShop = !existingShop && Number(currentShopCount || 0) >= 1;
  const isFirstHubShop = !existingShop && Number(currentShopCount || 0) === 0 && Boolean(req.auth?.tenantGlobalId);
  const hubResourceSync = await ensureShopResourceSynced({
    auth: req.auth,
    shop,
    status: isAdditionalNewShop ? "awaiting_subscription" : isFirstHubShop ? "active" : "legacy_active",
    billingMode: isAdditionalNewShop || isFirstHubShop ? "paid" : "legacy",
    usagePolicy: isAdditionalNewShop || isFirstHubShop ? "metered" : "unlimited",
    rangeEnforcement: isAdditionalNewShop || isFirstHubShop,
    planCode: "shopee_pro",
    orderRangeCode: "up_to_30",
    account: {
      name: req.auth?.accountName || null,
      tenantGlobalId: req.auth?.tenantGlobalId || null,
    },
  }).catch((error) => {
    console.warn("[shopee.auth] Falha ao sincronizar billing resource no Hub:", error?.message || error);
    return null;
  });
  if (hubResourceSync?.bypass && hubResourceSync.reason !== "billing_off") {
    console.warn(
      "[shopee.auth] Hub nao confirmou a sincronizacao da loja:",
      hubResourceSync.reason || "unknown",
      `tenant=${String(req.auth?.tenantGlobalId || "")}`,
      `shop=${String(shop?.shopId || "")}`,
    );
  }

  await markOAuthState("AUTHORIZED", {
    shopId: String(shopId),
  });
  clearAuthFlowCookie(res);
  return res.redirect(authFlow === "ads" ? "/shopee/?tab=ads" : "/shopee/?tab=auth");
}

async function refresh(req, res) {
  const { shop_id: shopId } = req.body;

  if (!shopId) {
    const err = new Error("Informe shop_id no body");
    err.statusCode = 400;
    throw err;
  }

  const payload = await ShopeeAuthService.refreshAccessToken({
    shopId: String(shopId),
  });

  res.json({
    status: "ok",
    shop_id: String(shopId),
    received: {
      expire_in: payload.expire_in,
      refresh_expire_in: payload.refresh_expire_in,
    },
  });
}

module.exports = {
  getAuthUrl,
  getAdsAuthUrl,
  callback,
  refresh,
};
