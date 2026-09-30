"use strict";

const READ_SCOPE = "open:promotion-promotions-seller:read";

function scopesOf(account) {
  return new Set((Array.isArray(account?.scopes) ? account.scopes : [])
    .map((scope) => String(scope || "").trim())
    .filter(Boolean));
}

function forAccount(account) {
  const readable = String(account?.status || "").toLowerCase() === "active"
    && scopesOf(account).has(READ_SCOPE);
  return {
    list: readable,
    detail: readable,
    promotionSkuRead: false,
    promotionSkuWrite: false,
    subscriptionWrite: false,
    apply: false,
  };
}

module.exports = { READ_SCOPE, forAccount, _test: { scopesOf } };
