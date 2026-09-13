"use strict";

/**
 * Compatibility facade for the existing SAC/support implementation.
 *
 * No routes, persistence, credentials, cookies or widget behavior are changed
 * here. New platform-level code can depend on this stable entry point while
 * existing applications continue to import the modules under `lib/` directly.
 * Lazy loading also keeps importing this facade side-effect free.
 */
function getService() {
  return require("../../lib/sacSupportService");
}

function getEmailService() {
  return require("../../lib/sacSupportEmailService");
}

function getDatabase() {
  return require("../../lib/sacDatabase");
}

function createWidgetInjector(options) {
  return require("../../lib/supportWidgetInjector").createSupportWidgetInjector(options);
}

module.exports = Object.freeze({
  getService,
  getEmailService,
  getDatabase,
  createWidgetInjector,
});
