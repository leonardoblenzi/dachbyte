"use strict";

function postOAuthSelectionDestination({ moduleSlug, externalAccountId }) {
  const module = String(moduleSlug || "").trim();
  const accountId = String(externalAccountId || "").trim();
  if (!module || !accountId) throw new Error("post_oauth_destination_invalid");
  return `/selecao-plataforma?resource_key=${encodeURIComponent(`${module}:${accountId}`)}`;
}

module.exports = { postOAuthSelectionDestination };
