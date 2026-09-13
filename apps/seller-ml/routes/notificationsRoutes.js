"use strict";

const express = require("express");
const NotificationsController = require("../controllers/NotificationsController");

const router = express.Router();

router.get("/", NotificationsController.list);
router.post("/refresh", NotificationsController.refresh);
router.post("/read-all", NotificationsController.markAllRead);

module.exports = router;
