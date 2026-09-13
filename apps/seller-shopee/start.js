"use strict";

const createApp = require("./index");
const { startExpressApp } = require("../../platform/runtime/startExpressApp");

startExpressApp({ createApp, name: "seller-shopee", mountPath: "/shopee" }).catch((error) => {
  console.error("[seller-shopee] startup failed", error);
  process.exit(1);
});
