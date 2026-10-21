"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

test("public Shopee OAuth exchanges a code without persisting an operational token", async () => {
  const authPath = require.resolve("../src/services/ShopeeAuthService");
  const httpPath = require.resolve("../src/services/ShopeeHttp");
  const tokenPath = require.resolve("../src/repositories/TokenRepository");
  const originalAuth = require.cache[authPath];
  const originalHttp = require.cache[httpPath];
  const originalToken = require.cache[tokenPath];
  let saves = 0;
  try {
    require.cache[httpPath] = { id: httpPath, filename: httpPath, loaded: true, exports: {
      requestShopee: async () => ({ access_token: "access", refresh_token: "refresh", expire_in: 3600 }),
    } };
    require.cache[tokenPath] = { id: tokenPath, filename: tokenPath, loaded: true, exports: {
      saveTokens: async () => { saves += 1; },
    } };
    delete require.cache[authPath];
    const { exchangeCodeForToken } = require(authPath);
    const provisional = await exchangeCodeForToken({ code: "one", shopId: "123", persist: false });
    assert.equal(provisional.access_token, "access");
    assert.equal(saves, 0);
    await exchangeCodeForToken({ code: "two", shopId: "123" });
    assert.equal(saves, 1, "the existing authenticated callback still persists by default");
  } finally {
    if (originalAuth) require.cache[authPath] = originalAuth; else delete require.cache[authPath];
    if (originalHttp) require.cache[httpPath] = originalHttp; else delete require.cache[httpPath];
    if (originalToken) require.cache[tokenPath] = originalToken; else delete require.cache[tokenPath];
  }
});
