"use strict";

function escapeHtml(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

async function sendTrialVerificationEmail(input, options = {}) {
  const apiKey = String(options.apiKey ?? process.env.BREVO_API_KEY ?? "").trim();
  const senderEmail = String(options.senderEmail ??
    process.env.BREVO_SENDER_MAIL ?? process.env.BREVO_SENDER_EMAIL ?? "").trim();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!apiKey || !senderEmail || typeof fetchImpl !== "function") {
    return { sent: false, reason: "trial_email_delivery_unavailable" };
  }
  const toEmail = String(input.toEmail || "").trim();
  const activationLink = String(input.activationLink || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail) ||
      !activationLink.startsWith("https://")) throw new Error("trial_email_payload_invalid");
  const response = await fetchImpl("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "api-key": apiKey },
    body: JSON.stringify({
      sender: { email: senderEmail, name: "DACHBYTE Seller" },
      to: [{ email: toEmail }],
      subject: "Confirme seu e-mail para testar o Seller Shopee",
      htmlContent: `<div style="font-family:Arial,sans-serif;color:#182238;max-width:540px;margin:auto;padding:24px"><h1>Confirme seu e-mail</h1><p>Você autorizou uma loja Shopee para iniciar o teste do DACHBYTE Seller. O teste de 7 dias começa somente depois da ativação.</p><p><a href="${escapeHtml(activationLink)}" style="background:#ee4d2d;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none">Confirmar e-mail</a></p><p>Se não foi você, ignore esta mensagem.</p></div>`,
      tags: ["seller-shopee-trial-verification"],
    }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error("trial_email_delivery_failed");
  return { sent: true, messageId: data?.messageId || null };
}

module.exports = { sendTrialVerificationEmail };
