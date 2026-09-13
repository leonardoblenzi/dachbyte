const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const HealthController = require("../controllers/HealthController");

const router = express.Router();

router.get("/health", asyncHandler(HealthController.health));

module.exports = router;