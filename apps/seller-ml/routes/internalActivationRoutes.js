"use strict";

// Aviso do hub de acessos: contratação confirmada de uma conta do ML.
// Mesma chave da retirada (Bearer SELLER_RETIREMENT_TOKEN), só na rede interna.

const express = require("express");
const { authorizedRetirementCall } = require("../../../lib/hubSellerRetirementAuth");

function createMlActivationRouter({ secret, activate }) {
  const router = express.Router();
  router.post("/", express.json({ limit: "16kb" }), async (req, res) => {
    if (!authorizedRetirementCall(req.headers.authorization, secret)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    try {
      return res.json(await activate(req.body));
    } catch (error) {
      const status = [400, 404, 409].includes(error?.status) ? error.status : 500;
      const code = /^[a-z][a-z0-9_]{2,100}$/i.test(String(error?.message || "")) ? error.message : "activation_failed";
      if (status === 500) console.error("[ML][hub-activation]", error?.message || error);
      return res.status(status).json({ ok: false, error: code });
    }
  });
  return router;
}

module.exports = { createMlActivationRouter };
