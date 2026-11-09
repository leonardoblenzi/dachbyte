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

// Formulario das landings: o cliente escolhe como quer ser respondido (e-mail ou WhatsApp).
const CONTACT_PREFERENCES = new Set(["email", "whatsapp"]);
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 6;
const recentByIp = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const hits = (recentByIp.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  recentByIp.set(ip, hits);
  if (recentByIp.size > 5000) recentByIp.clear();
  return hits.length > RATE_MAX;
}

function phoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
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
    const preferenceRaw = sanitizeText(req.body?.contact_preference || "", 20).toLowerCase();
    const contactPreference = CONTACT_PREFERENCES.has(preferenceRaw) ? preferenceRaw : "";
    const ordersVolume = sanitizeText(req.body?.orders_volume || "", 60);
    const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();

    // Campo escondido: robos preenchem, pessoas nao. Responde como sucesso e descarta.
    if (sanitizeText(req.body?.website || "", 200)) {
      return res.json({ ok: true, message: "Contato enviado com sucesso. Nossa equipe comercial vai retornar em breve." });
    }
    if (rateLimited(ip || "sem-ip")) {
      return res.status(429).json({ ok: false, error: "Muitos envios em sequencia. Aguarde alguns minutos e tente de novo." });
    }

    if (name.length < 3) {
      return res.status(400).json({
        ok: false,
        error: "Informe um nome valido.",
      });
    }

    // Sem preferencia (formularios antigos): e-mail e celular continuam obrigatorios.
    const needsEmail = contactPreference !== "whatsapp";
    const needsPhone = contactPreference !== "email";

    if ((needsEmail || email) && !isValidEmail(email)) {
      return res.status(400).json({
        ok: false,
        error: "Informe um email valido.",
      });
    }

    if ((needsPhone || cellphone) && phoneDigits(cellphone).length < 10) {
      return res.status(400).json({
        ok: false,
        error: contactPreference === "whatsapp" ? "Informe um WhatsApp valido, com DDD." : "Informe um celular valido.",
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
      contactPreference,
      ordersVolume,
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
