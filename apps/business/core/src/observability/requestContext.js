"use strict";

const { AsyncLocalStorage } = require("async_hooks");

const storage = new AsyncLocalStorage();

function runWithRequestContext(initial, fn) {
  return storage.run({ ...(initial || {}) }, fn);
}

function getRequestContext() {
  return storage.getStore() || {};
}

function setRequestContext(fields = {}) {
  const store = storage.getStore();
  if (!store) return;
  Object.assign(store, fields);
}

module.exports = { getRequestContext, runWithRequestContext, setRequestContext };
