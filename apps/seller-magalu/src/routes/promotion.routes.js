"use strict";

const express = require("express");
const promotionController = require("../controllers/promotionController");

const router = express.Router();

router.get("/", promotionController.list);
router.get("/:promotionId", promotionController.detail);

module.exports = router;
