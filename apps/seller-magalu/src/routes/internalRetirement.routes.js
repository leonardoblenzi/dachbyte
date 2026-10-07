"use strict";

const express = require("express");
const { authorizedRetirementCall } = require("../../../../lib/hubSellerRetirementAuth");

function createMagaluRetirementHandler({ secret, retire }) {
  return async (req, res) => {
    if (!authorizedRetirementCall(req.headers.authorization, secret)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    try {
      return res.json(await retire(req.body));
    } catch (error) {
      const status = error?.status === 400 || error?.status === 404 || error?.status === 409 ? error.status :
        error?.code === "MAGALU_ACCOUNT_UNLINK_BLOCKED_BY_WRITE" ? 409 : 500;
      const code = /^[A-Za-z][A-Za-z0-9_]{2,100}$/.test(String(error?.code || error?.message || ""))
        ? String(error.code || error.message) : "retirement_failed";
      return res.status(status).json({ ok: false, error: code });
    }
  };
}

function createMagaluRetirementRouter(dependencies) {
  const router = express.Router();
  router.post("/", createMagaluRetirementHandler(dependencies));
  return router;
}

module.exports = { createMagaluRetirementRouter, createMagaluRetirementHandler };
