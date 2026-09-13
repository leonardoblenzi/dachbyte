"use strict";

const express = require("express");
const {
  sendHelpContactEmail,
  TOPIC_LABELS,
} = require("../services/helpContactEmailService");

const router = express.Router();

const ALLOWED_TOPICS = new Set(Object.keys(TOPIC_LABELS));
const ALLOWED_REPLY_PREFERENCES = new Set(["email", "cellphone"]);

function sanitizeText(value, max = 5000) {
  return String(value || "").trim().slice(0, max);
}

router.post("/help", async (req, res) => {
  try {
    const userEmail = sanitizeText(req.user?.email || "", 160).toLowerCase();
    const userName = sanitizeText(req.user?.nome || req.user?.name || "", 120);
    const topic = sanitizeText(req.body?.topic || "", 40).toLowerCase();
    const message = sanitizeText(req.body?.message || "", 5000);
    const replyPreference = sanitizeText(
      req.body?.reply_preference || "email",
      20,
    ).toLowerCase();
    const cellphone = sanitizeText(req.body?.cellphone || "", 40);
    const accountLabel = sanitizeText(req.body?.account_label || "", 180);
    const accountId = sanitizeText(req.body?.account_id || "", 40);
    const meliUserId = sanitizeText(req.body?.meli_user_id || "", 40);
    const pagePath = sanitizeText(req.body?.page_path || "", 180);

    if (!userEmail) {
      return res.status(401).json({
        ok: false,
        error: "Nao foi possivel identificar o email do usuario logado.",
      });
    }

    if (!ALLOWED_TOPICS.has(topic)) {
      return res.status(400).json({
        ok: false,
        error: "Selecione um assunto valido.",
      });
    }

    if (message.length < 10) {
      return res.status(400).json({
        ok: false,
        error: "Escreva uma mensagem com pelo menos 10 caracteres.",
      });
    }

    if (!ALLOWED_REPLY_PREFERENCES.has(replyPreference)) {
      return res.status(400).json({
        ok: false,
        error: "Selecione uma forma valida para a resposta.",
      });
    }

    if (replyPreference === "cellphone" && cellphone.length < 8) {
      return res.status(400).json({
        ok: false,
        error: "Informe um celular valido para receber a resposta.",
      });
    }

    const delivery = await sendHelpContactEmail({
      userName,
      userEmail,
      topic,
      message,
      replyPreference,
      cellphone,
      accountLabel,
      accountId,
      meliUserId,
      pagePath,
      userAgent: req.get("user-agent") || "",
    });

    if (!delivery.sent) {
      return res.status(503).json({
        ok: false,
        error:
          delivery.reason ||
          "Nao foi possivel enviar a mensagem agora. Tente novamente em instantes.",
      });
    }

    return res.json({
      ok: true,
      message:
        replyPreference === "cellphone"
          ? "Mensagem enviada. Vamos considerar o celular informado para o retorno."
          : "Mensagem enviada. Vamos responder no email do seu login.",
      delivery,
    });
  } catch (error) {
    console.error("POST /api/contact/help erro:", error);
    return res.status(500).json({
      ok: false,
      error: "Nao foi possivel enviar sua mensagem agora.",
    });
  }
});

module.exports = router;
