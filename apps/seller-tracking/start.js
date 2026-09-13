import createApp from "./index.cjs";
import runtime from "../../platform/runtime/startExpressApp.js";

const { startExpressApp } = runtime;

startExpressApp({ createApp, name: "seller-tracking", mountPath: "/avantracking" }).catch((error) => {
  console.error("[seller-tracking] startup failed", error);
  process.exit(1);
});
