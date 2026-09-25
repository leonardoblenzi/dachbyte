"use strict";

const express = require("express");
const accountController = require("../controllers/accountController");

const router = express.Router();

router.get("/context", accountController.context);
router.post("/accounts/:accountId/unlink", accountController.unlink);
router.post("/help", accountController.help);

module.exports = router;
