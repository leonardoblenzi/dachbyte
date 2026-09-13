"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");

function createVoltChatApp() {
  const router = express.Router();
  const buildDir = path.join(__dirname, "sordchat-frontend", "build");
  const indexPath = path.join(buildDir, "index.html");

  if (!fs.existsSync(indexPath)) {
    router.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      return res.status(503).json({
        success: false,
        error: "Build do Volt Chat nao encontrado. Execute npm run build no business antes de iniciar.",
        path: req.originalUrl,
      });
    });
    return router;
  }

  router.use(express.static(buildDir, {
    index: false,
    immutable: true,
    maxAge: "1d",
  }));

  router.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    return res.sendFile(indexPath);
  });

  return router;
}

module.exports = createVoltChatApp;
