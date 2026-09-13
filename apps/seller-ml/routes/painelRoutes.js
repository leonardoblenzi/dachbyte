"use strict";

const express = require("express");
const PainelController = require("../controllers/PainelController");

const router = express.Router();

router.get("/overview", PainelController.overview);
router.get("/finance-summary", PainelController.financeSummary);
router.get("/inactivity", PainelController.inactivity);

module.exports = router;
