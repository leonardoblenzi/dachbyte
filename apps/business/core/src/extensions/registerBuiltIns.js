"use strict";

const { extensionRegistry } = require("../platform/extensions/extensionRegistry");
const optical = require("./optical/manifest");
const fiscal = require("./fiscal/manifest");

let registered = false;

function registerBuiltInExtensions() {
  if (registered) return extensionRegistry;
  extensionRegistry.register(optical);
  extensionRegistry.register(fiscal);
  registered = true;
  return extensionRegistry;
}

module.exports = {
  registerBuiltInExtensions,
};
