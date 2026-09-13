// shopee/index.js
const express = require("express");
const path = require("path");
const createApp = require("./src/app");

async function createShopeeApp() {
  const app = createApp();

  // ✅ ADICIONAR: Servir arquivos estáticos do public
  app.use(express.static(path.join(__dirname, "public")));

  return app;
}

module.exports = createShopeeApp;
