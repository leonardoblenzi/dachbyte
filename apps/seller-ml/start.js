"use strict";

const createApp = require("./index");
const { startExpressApp } = require("../../platform/runtime/startExpressApp");

startExpressApp({ createApp, name: "seller-ml", mountPath: "/ml" }).catch((error) => {
  console.error("[seller-ml] startup failed", error);
  process.exit(1);
});
