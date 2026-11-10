"use strict";

// API interna da conexão única do Mercado Livre (só entre containers da DACHBYTE).
// Autenticação: Bearer SELLER_CONNECTIONS_TOKEN. O Caddy não expõe /ml/internal/*.

const express = require("express");
const { authorizedRetirementCall } = require("../../../lib/hubSellerRetirementAuth");

const KNOWN_ERRORS = new Set([400, 403, 404, 409, 503]);

function createInternalConnectionsRouter({ secret, service }) {
  const router = express.Router();
  router.use(express.json({ limit: "32kb" }));
  router.use((req, res, next) => {
    if (!authorizedRetirementCall(req.headers.authorization, secret)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    return next();
  });

  const handle = (fn) => async (req, res) => {
    try {
      return res.json({ ok: true, ...(await fn(req)) });
    } catch (error) {
      const status = KNOWN_ERRORS.has(error?.status) ? error.status : 500;
      const code = /^[a-z][a-z0-9_]{2,100}$/i.test(String(error?.message || "")) ? error.message : "connections_failed";
      if (status === 500) console.error("[ML][internal-connections]", error?.message || error);
      return res.status(status).json({ ok: false, error: status === 500 ? "connections_failed" : code });
    }
  };

  router.get("/accounts", handle((req) => service.listAccounts({ tenant_id: req.query.tenant_id })));
  router.post("/authorize", handle((req) => service.authorize(req.body)));
  router.post("/token", handle((req) => service.token(req.body)));
  router.post("/activate", handle((req) => service.activate(req.body)));
  router.post("/register-ml", handle((req) => service.registerForMl(req.body)));
  router.post("/deactivate", handle((req) => service.deactivate(req.body)));
  return router;
}

module.exports = { createInternalConnectionsRouter };
