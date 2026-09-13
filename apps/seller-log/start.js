"use strict";

const createApp = require("./index.cjs");
const { startExpressApp } = require("../../platform/runtime/startExpressApp");

startExpressApp({ createApp, name: "seller-log", mountPath: "/davanttilog" }).catch((error) => {
  console.error("[seller-log] startup failed", error);
  process.exit(1);
});
