"use strict";

const { env } = require("../../config/env");
const { createHubIdentityProvider } = require("./HubIdentityProvider");

const developmentProvider = Object.freeze({
  async resolve() {
    if (env.nodeEnv === "production") {
      return {
        status: "unavailable",
        reason: "development_identity_is_disabled_in_production",
      };
    }

    return {
      status: "authenticated",
      identity: {
        tenantId: env.devTenantId,
        userId: env.devUserId,
        email: env.devUserEmail,
        name: env.devUserName,
      },
    };
  },
});

function createIdentityProvider() {
  if (env.authMode === "development") return developmentProvider;
  return createHubIdentityProvider();
}

module.exports = { createIdentityProvider };
