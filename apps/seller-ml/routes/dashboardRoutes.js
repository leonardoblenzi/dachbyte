"use strict";

const express = require("express");
const router = express.Router();

const DashboardController = require("../controllers/DashboardController");

// ✅ principal
router.get("/summary", DashboardController.summary);

// ✅ alias pra não quebrar quem ainda chama /monthly-sales
router.get("/monthly-sales", DashboardController.summary);

module.exports = router;
