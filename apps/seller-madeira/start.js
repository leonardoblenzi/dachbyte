"use strict";

const createApp = require("./index");
const { startExpressApp } = require("../../platform/runtime/startExpressApp");

startExpressApp({ createApp, name: "seller-madeira", mountPath: "/madeiramadeira" }).catch((error) => {
  console.error("[seller-madeira] startup failed", error);
  process.exit(1);
});
