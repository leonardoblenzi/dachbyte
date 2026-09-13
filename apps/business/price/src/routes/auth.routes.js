"use strict";

const express = require("express");
const {
  authUser,
  authenticateForPasswordChange,
  changePassword,
  login,
  logout,
  requireCsrf,
} = require("../auth");
const { query } = require("../db");
const { randomToken, sha256 } = require("../crypto");

const router = express.Router();

router.post("/login", (req, res, next) => login(req, res).catch(next));
router.post("/logout", authenticateForPasswordChange, (req, res, next) => logout(req, res).catch(next));
router.get("/me", authenticateForPasswordChange, (req, res) => res.json({ user: authUser(req.vpAuth) }));
router.get("/csrf", authenticateForPasswordChange, async (req, res, next) => {
  try {
    const csrf = randomToken(24);
    await query("UPDATE volt_price.sessions SET csrf_hash=$2 WHERE id=$1", [req.vpAuth.sessionId, sha256(csrf)]);
    req.vpAuth.csrfHash = sha256(csrf);
    res.json({ csrfToken: csrf });
  } catch (error) { next(error); }
});
router.post("/change-password", authenticateForPasswordChange, requireCsrf, (req, res, next) => changePassword(req, res).catch(next));

module.exports = { authRouter: router };
