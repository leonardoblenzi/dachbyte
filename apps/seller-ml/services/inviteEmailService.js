"use strict";

const fetch = require("node-fetch");

const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";

function normalize(value) {
  return String(value || "").trim();
}

function isConfigured() {
  return Boolean(
    normalize(process.env.BREVO_API_KEY) &&
      normalize(process.env.BREVO_SENDER_EMAIL),
  );
}

function sender() {
  return {
    email: normalize(process.env.BREVO_SENDER_EMAIL),
    name: normalize(process.env.BREVO_SENDER_NAME) || "DAVANTTI",
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function buildInviteHtml({ nome, activationLink, expiresAt }) {
  const safeName = escapeHtml(nome || "cliente");
  const safeLink = escapeHtml(activationLink);
  const safeExpires = escapeHtml(expiresAt);

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#f6f8fd;padding:32px;color:#0f172a;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:20px;padding:32px;border:1px solid #e2e8f0;">
        <p style="margin:0 0 16px;font-size:14px;color:#2563eb;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">DAVANTTI • Convite de acesso</p>
        <h1 style="margin:0 0 12px;font-size:32px;line-height:1.05;">Sua conta esta pronta para ativacao</h1>
        <p style="margin:0 0 18px;font-size:16px;line-height:1.6;">
          Ola, ${safeName}. Seu acesso ao workspace do Mercado Livre foi criado. Clique no botao abaixo para definir sua senha e seguir para a vinculacao da conta.
        </p>
        <p style="margin:24px 0;">
          <a href="${safeLink}" style="display:inline-block;background:#ffe600;color:#111827;text-decoration:none;font-weight:800;padding:14px 20px;border-radius:14px;">
            Ativar acesso
          </a>
        </p>
        <p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#475569;">
          Se o botao nao abrir, copie este link no navegador:
        </p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;word-break:break-all;color:#1d4ed8;">
          ${safeLink}
        </p>
        <p style="margin:0;font-size:13px;color:#64748b;">
          Este convite expira em ${safeExpires}.
        </p>
      </div>
    </div>
  `;
}

function buildPasswordResetHtml({ nome, resetLink, expiresAt }) {
  const safeName = escapeHtml(nome || "cliente");
  const safeLink = escapeHtml(resetLink);
  const safeExpires = escapeHtml(expiresAt);

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#f6f8fd;padding:32px;color:#0f172a;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:20px;padding:32px;border:1px solid #e2e8f0;">
        <p style="margin:0 0 16px;font-size:14px;color:#2563eb;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">DAVANTTI • Recuperacao de senha</p>
        <h1 style="margin:0 0 12px;font-size:32px;line-height:1.05;">Redefina sua senha</h1>
        <p style="margin:0 0 18px;font-size:16px;line-height:1.6;">
          Ola, ${safeName}. Recebemos uma solicitacao para redefinir a senha do seu acesso ao workspace Mercado Livre.
        </p>
        <p style="margin:24px 0;">
          <a href="${safeLink}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:800;padding:14px 20px;border-radius:14px;">
            Redefinir senha
          </a>
        </p>
        <p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#475569;">
          Se o botao nao abrir, copie este link no navegador:
        </p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;word-break:break-all;color:#1d4ed8;">
          ${safeLink}
        </p>
        <p style="margin:0;font-size:13px;color:#64748b;">
          Este link expira em ${safeExpires}. Se voce nao pediu essa troca, ignore este email.
        </p>
      </div>
    </div>
  `;
}

async function sendInviteEmail({ toEmail, toName, activationLink, expiresAt }) {
  if (!isConfigured()) {
    return {
      sent: false,
      skipped: true,
      reason: "Brevo nao configurado.",
    };
  }

  const payload = {
    sender: sender(),
    to: [
      {
        email: normalize(toEmail),
        name: normalize(toName) || undefined,
      },
    ],
    subject: "Ative seu acesso ao workspace DAVANTTI",
    htmlContent: buildInviteHtml({
      nome: toName,
      activationLink,
      expiresAt,
    }),
    tags: ["invite-activation", "ml-auth"],
  };

  const response = await fetch(BREVO_API_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "api-key": normalize(process.env.BREVO_API_KEY),
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      data?.message ||
      data?.code ||
      `Brevo respondeu com HTTP ${response.status}.`;

    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return {
    sent: true,
    skipped: false,
    messageId: data?.messageId || null,
  };
}

async function sendPasswordResetEmail({
  toEmail,
  toName,
  resetLink,
  expiresAt,
}) {
  if (!isConfigured()) {
    return {
      sent: false,
      skipped: true,
      reason: "Brevo nao configurado.",
    };
  }

  const response = await fetch(BREVO_API_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "api-key": normalize(process.env.BREVO_API_KEY),
    },
    body: JSON.stringify({
      sender: sender(),
      to: [
        {
          email: normalize(toEmail),
          name: normalize(toName) || undefined,
        },
      ],
      subject: "Redefina sua senha DAVANTTI",
      htmlContent: buildPasswordResetHtml({
        nome: toName,
        resetLink,
        expiresAt,
      }),
      tags: ["password-reset", "ml-auth"],
    }),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      data?.message ||
      data?.code ||
      `Brevo respondeu com HTTP ${response.status}.`;

    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return {
    sent: true,
    skipped: false,
    messageId: data?.messageId || null,
  };
}

module.exports = {
  isConfigured,
  sendInviteEmail,
  sendPasswordResetEmail,
};
