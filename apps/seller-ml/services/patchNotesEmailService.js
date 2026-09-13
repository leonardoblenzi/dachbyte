"use strict";

const fetch = require("node-fetch");
const {
  isConfigured,
} = require("./inviteEmailService");
const {
  parseLines,
} = require("./patchNotesService");

const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";

function normalize(value) {
  return String(value || "").trim();
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

function renderListBlock(title, text, accent) {
  const items = parseLines(text);
  if (!items.length) return "";

  const list = items
    .map(
      (item) => `
        <li style="margin:0 0 10px; line-height:1.55; color:#334155;">
          ${escapeHtml(item)}
        </li>`,
    )
    .join("");

  return `
    <div style="margin:0 0 18px; padding:18px 20px; background:#ffffff; border:1px solid #e2e8f0; border-radius:18px;">
      <div style="display:inline-block; margin:0 0 12px; padding:6px 10px; border-radius:999px; background:${accent}; color:#0f172a; font-size:12px; font-weight:800; letter-spacing:.04em; text-transform:uppercase;">
        ${escapeHtml(title)}
      </div>
      <ul style="margin:0; padding-left:18px;">
        ${list}
      </ul>
    </div>
  `;
}

function buildPatchNotesHtml(note) {
  const title = escapeHtml(note?.title || "Novidades DAVANTTI");
  const summary = escapeHtml(note?.summary || "");
  const version = escapeHtml(note?.version || "0.0.0");
  const ctaLabel = escapeHtml(note?.cta_label || "Abrir plataforma");
  const ctaUrl = escapeHtml(note?.cta_url || "");

  return `
    <div style="font-family:Arial,Helvetica,sans-serif; background:#f6f8fd; padding:32px; color:#0f172a;">
      <div style="max-width:720px; margin:0 auto;">
        <div style="background:linear-gradient(135deg,#0f172a 0%,#1d4ed8 100%); color:#ffffff; border-radius:24px; padding:32px; margin-bottom:18px;">
          <p style="margin:0 0 14px; font-size:13px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; opacity:.82;">
            DAVANTTI • Patch Notes ${version}
          </p>
          <h1 style="margin:0 0 10px; font-size:34px; line-height:1.08;">
            ${title}
          </h1>
          ${
            summary
              ? `<p style="margin:0; font-size:16px; line-height:1.65; color:rgba(255,255,255,.92);">${summary}</p>`
              : ""
          }
        </div>

        ${renderListBlock("Novidades", note?.novidades_text, "#dbeafe")}
        ${renderListBlock("Melhorias", note?.melhorias_text, "#dcfce7")}
        ${renderListBlock("Correcoes", note?.correcoes_text, "#fef3c7")}

        ${
          ctaUrl
            ? `<div style="margin-top:22px; text-align:center;">
                <a href="${ctaUrl}" style="display:inline-block; background:#ffe600; color:#111827; text-decoration:none; font-weight:800; padding:14px 22px; border-radius:14px;">
                  ${ctaLabel}
                </a>
              </div>`
            : ""
        }

        <div style="margin-top:18px; padding:18px 20px; background:#ffffff; border:1px solid #e2e8f0; border-radius:18px; color:#64748b; font-size:13px; line-height:1.6;">
          Este email foi enviado manualmente pela administracao da DAVANTTI para comunicar novidades da plataforma.
        </div>
      </div>
    </div>
  `;
}

function buildPatchNotesSubject(note) {
  const version = normalize(note?.version);
  const title = normalize(note?.title);
  return version ? `DAVANTTI ${version} • ${title}` : `DAVANTTI • ${title}`;
}

async function sendPatchNotesEmail({ toEmail, toName, note }) {
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
      subject: buildPatchNotesSubject(note),
      htmlContent: buildPatchNotesHtml(note),
      tags: ["patch-notes", "ml-admin"],
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
  buildPatchNotesHtml,
  buildPatchNotesSubject,
  sendPatchNotesEmail,
};
