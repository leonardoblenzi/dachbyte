"use strict";

const express = require("express");
const { receiveV1Webhook } = require("../webhooks/webhookController");
const oauthController = require("../controllers/oauthController");

const router = express.Router();

// IMPORTANTE: o body raw é obrigatório para validar X-Signature-256.
router.post(
  "/webhooks/v1",
  express.raw({ type: ["application/json", "application/*+json"], limit: "1mb" }),
  receiveV1Webhook,
);

// Callback OAuth é público para o provedor, mas sessão DACH e acesso Magalu no Hub
// são revalidados imediatamente antes da troca do authorization code.
router.get("/auth/callback", oauthController.callback);

module.exports = router;
