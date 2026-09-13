const express = require('express');
const TokenController = require('../controllers/TokenController');
const { createAuditAction } = require("../middleware/auditAction");
const { oauthRateLimiter } = require("../middleware/security");

const router = express.Router();

// Rotas de token
router.post(
  '/getAccessToken',
  oauthRateLimiter,
  createAuditAction({
    evento: "token_access_requested",
    metadata: (req) => ({
      has_refresh_token: !!req.body?.refresh_token,
      has_code: !!req.body?.code,
    }),
  }),
  TokenController.getAccessToken,
);
router.post(
  '/renovar-token-automatico',
  oauthRateLimiter,
  createAuditAction({
    evento: "token_renew_requested",
  }),
  TokenController.renovarToken,
);
router.get('/verificar-token', TokenController.verificarToken);
router.get('/test-token', TokenController.testarToken);

// Rota para autenticação inicial
router.post(
  '/dados',
  oauthRateLimiter,
  createAuditAction({
    evento: "token_initial_requested",
    metadata: (req) => ({
      has_code: !!req.body?.code,
      redirect_uri: req.body?.redirect_uri || null,
    }),
  }),
  TokenController.obterTokenInicial,
);

module.exports = router;
