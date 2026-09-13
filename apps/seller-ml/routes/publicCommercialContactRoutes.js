"use strict";

const express = require("express");
const {
  sendCommercialLeadEmail,
} = require("../services/commercialLeadEmailService");

const router = express.Router();

function sanitizeText(value, max = 5000) {
  return String(value || "").trim().slice(0, max);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

router.post("/commercial", async (req, res) => {
  try {
    const name = sanitizeText(req.body?.name || "", 120);
    const email = sanitizeText(req.body?.email || "", 160).toLowerCase();
    const cellphone = sanitizeText(req.body?.cellphone || "", 40);
    const company = sanitizeText(req.body?.company || "", 140);
    const channels = Array.isArray(req.body?.channels)
      ? req.body.channels.map((item) => sanitizeText(item, 80)).filter(Boolean)
      : [];
    const message = sanitizeText(req.body?.message || "", 5000);
    const pagePath = sanitizeText(req.body?.page_path || "", 180);

    if (name.length < 3) {
      return res.status(400).json({
        ok: false,
        error: "Informe um nome valido.",
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        ok: false,
        error: "Informe um email valido.",
      });
    }

    if (cellphone.length < 8) {
      return res.status(400).json({
        ok: false,
        error: "Informe um celular valido.",
      });
    }

    if (!channels.length) {
      return res.status(400).json({
        ok: false,
        error: "Selecione pelo menos um canal valido.",
      });
    }

    const delivery = await sendCommercialLeadEmail({
      name,
      email,
      cellphone,
      company,
      channels,
      message,
      pagePath,
      userAgent: req.get("user-agent") || "",
      ipAddress:
        req.headers["x-forwarded-for"] ||
        req.socket?.remoteAddress ||
        "",
    });

    if (!delivery.sent) {
      return res.status(503).json({
        ok: false,
        error:
          delivery.reason ||
          "Nao foi possivel enviar seu contato agora. Tente novamente em instantes.",
      });
    }

    return res.json({
      ok: true,
      message:
        "Contato enviado com sucesso. Nossa equipe comercial vai retornar em breve.",
      delivery,
    });
  } catch (error) {
    console.error("POST /api/contact/commercial erro:", error);
    return res.status(500).json({
      ok: false,
      error: "Nao foi possivel enviar seu contato agora.",
    });
  }
});

module.exports = router;
