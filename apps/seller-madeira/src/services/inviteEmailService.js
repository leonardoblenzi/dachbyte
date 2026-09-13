"use strict";

const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";
const fetchFn =
  typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : (...args) =>
        import("node-fetch").then(({ default: fetch }) => fetch(...args));

function normalize(value) {
  return String(value || "").trim();
}

function senderEmail() {
  return normalize(process.env.BREVO_SENDER_MAIL || process.env.BREVO_SENDER_EMAIL);
}

function isConfigured() {
  return Boolean(normalize(process.env.BREVO_API_KEY) && senderEmail());
}

function sender() {
  return {
    email: senderEmail(),
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
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#eef8ff;padding:32px;color:#0f172a;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:24px;padding:32px;border:1px solid #dbeafe;">
        <p style="margin:0 0 16px;font-size:13px;color:#0f766e;font-weight:800;letter-spacing:.08em;text-transform:uppercase;">
          DAVANTTI • Convite MadeiraMadeira
        </p>
        <h1 style="margin:0 0 14px;font-size:32px;line-height:1.05;color:#0f172a;">
          Ative seu acesso ao workspace
        </h1>
        <p style="margin:0 0 18px;font-size:16px;line-height:1.65;color:#334155;">
          Ola, ${escapeHtml(nome || "cliente")}. Seu acesso ao ambiente MadeiraMadeira foi criado.
          Clique no botao abaixo para definir sua senha e concluir o registro.
        </p>
        <p style="margin:24px 0;">
          <a href="${escapeHtml(activationLink)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:800;padding:14px 20px;border-radius:14px;">
            Ativar acesso
          </a>
        </p>
        <p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#64748b;">
          Se preferir, copie este link no navegador:
        </p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;word-break:break-all;color:#0369a1;">
          ${escapeHtml(activationLink)}
        </p>
        <p style="margin:0;font-size:13px;color:#64748b;">
          Este convite expira em ${escapeHtml(expiresAt)}.
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

  const response = await fetchFn(BREVO_API_URL, {
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
      subject: "Ative seu acesso DAVANTTI MadeiraMadeira",
      htmlContent: buildInviteHtml({
        nome: toName,
        activationLink,
        expiresAt,
      }),
      tags: ["invite-activation", "madeiramadeira-auth"],
    }),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const err = new Error(
      data?.message || data?.code || `Brevo respondeu com HTTP ${response.status}.`,
    );
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return {
    sent: true,
    skipped: false,
    messageId: data?.messageId || null,
  };
}

async function sendPatchNotesEmail({ toEmail, toName, subject, htmlContent }) {
  if (!isConfigured()) {
    return {
      sent: false,
      skipped: true,
      reason: "Brevo nao configurado.",
    };
  }

  const response = await fetchFn(BREVO_API_URL, {
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
      subject: normalize(subject) || "Atualizacao DAVANTTI MadeiraMadeira",
      htmlContent: String(htmlContent || ""),
      tags: ["patch-notes", "release-notes", "madeiramadeira"],
    }),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const err = new Error(
      data?.message || data?.code || `Brevo respondeu com HTTP ${response.status}.`,
    );
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return {
    sent: true,
    skipped: false,
    messageId: data?.messageId || null,
  };
}

module.exports = {
  sendInviteEmail,
  sendPatchNotesEmail,
};
