"use strict";

const { extensionRegistry } = require("./extensionRegistry");

function mountExtensionRoutes(router, dependencies = {}) {
  for (const { extensionKey, register } of extensionRegistry.routeRegistrars()) {
    register({ router, extensionKey, ...dependencies });
  }
  return router;
}

module.exports = { mountExtensionRoutes };
