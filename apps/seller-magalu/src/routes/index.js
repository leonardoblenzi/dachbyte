"use strict";

const express = require("express");
const path = require("node:path");
const apiRoutes = require("./api.routes");
const oauthController = require("../controllers/oauthController");

const router = express.Router();
const appView = path.resolve(__dirname, "../../views/app.html");

router.get("/auth/start", oauthController.start);
router.use("/api", apiRoutes);

for (const route of ["/", "/catalogo", "/estoque", "/precos", "/contas"]) {
  router.get(route, (_req, res) => res.sendFile(appView));
}

module.exports = router;
