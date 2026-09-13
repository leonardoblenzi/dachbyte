"use strict";

const http = require("http");
const httpProxy = require("http-proxy");
const createBusinessApp = require("./app");
const { createHostedExpressApp } = require("../../platform/runtime/startExpressApp");

const port = Number(process.env.PORT || process.env.VOLT_CORP_PORT || 3100);
const chatApiTarget =
  process.env.DACHBYTE_CHAT_API_URL
  || process.env.VOLT_CHAT_UPSTREAM_URL
  || `http://127.0.0.1:${process.env.VOLT_CHAT_API_PORT || "8001"}`;
const chatWebSocketProxy = httpProxy.createProxyServer({
  target: chatApiTarget,
  changeOrigin: true,
  ws: true,
});
let server;

chatWebSocketProxy.on("error", (error, _request, socket) => {
  console.error("[volt-corp] Falha no WebSocket do VoltChat:", error.message);
  if (socket && !socket.destroyed) socket.destroy();
});

async function start() {
  const app = await createHostedExpressApp({
    createApp: createBusinessApp,
    name: "business",
    mountPath: "/business",
  });
  server = http.createServer(app);
  server.on("upgrade", (request, socket, head) => {
    if (!request.url?.startsWith("/business/chat-api/")) {
      socket.destroy();
      return;
    }
    request.url = request.url.replace(/^\/business\/chat-api/, "") || "/";
    chatWebSocketProxy.ws(request, socket, head);
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`Volt Corp running on port ${port}`);
  });
}

function shutdown(signal) {
  console.log(`[volt-corp] Recebido ${signal}, encerrando...`);
  if (!server) process.exit(0);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start().catch((error) => {
  console.error("[volt-corp] Falha ao iniciar servidor:", error);
  process.exit(1);
});
