"use strict";

const express = require("express");
const { authorizedRetirementCall } = require("../../../../lib/hubSellerRetirementAuth");

function createShopeeRetirementRouter({ secret, retire }) {
  const router = express.Router();
  router.post("/", async (req, res) => {
    if (!authorizedRetirementCall(req.headers.authorization, secret)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    try {
      return res.json(await retire(req.body));
    } catch (error) {
      const status = [400, 404, 409].includes(error?.status) ? error.status : 500;
      const code = /^[a-z][a-z0-9_]{2,100}$/i.test(String(error?.message || "")) ? error.message : "retirement_failed";
      return res.status(status).json({ ok: false, error: code });
    }
  });
  return router;
}

module.exports = { createShopeeRetirementRouter };
