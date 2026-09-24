"use strict";

function hasActiveAccount(accounts) {
  return Array.isArray(accounts)
    && accounts.some((account) => String(account?.status || "").toLowerCase() === "active");
}

function accountPageForOAuthError(reason) {
  const params = new URLSearchParams({ oauth: "error" });
  if (reason) params.set("reason", String(reason));
  return `/magalu/contas?${params.toString()}`;
}

function resolveEntryRedirect({ accounts, returnPath = "/magalu/", oauth = {} } = {}) {
  if (hasActiveAccount(accounts)) return null;
  if (String(oauth.status || "").toLowerCase() === "error") {
    return accountPageForOAuthError(oauth.reason);
  }
  return `/magalu/auth/start?return=${encodeURIComponent(returnPath)}`;
}

module.exports = { hasActiveAccount, resolveEntryRedirect };
