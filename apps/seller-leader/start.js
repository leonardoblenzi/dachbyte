"use strict";

const createApp = require("./index");
const { startExpressApp } = require("../../platform/runtime/startExpressApp");

startExpressApp({ createApp, name: "seller-leader", mountPath: "/skuleader" }).catch((error) => {
  console.error("[seller-leader] startup failed", error);
  process.exit(1);
});
