"use strict";

const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const AuthController = require("../controllers/AuthController");
const { ensureAuth } = require("../middlewares/authMiddleware");

const router = express.Router();

router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

router.post("/login", asyncHandler(AuthController.login));
router.get("/me", ensureAuth, asyncHandler(AuthController.me));
router.post("/logout", asyncHandler(AuthController.logout));

module.exports = router;
