"use strict";

const fetch = require("node-fetch");

const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";

const TOPIC_LABELS = {
  duvidas: "Duvidas",
  reclamacoes: "Reclamacoes",
  sugestoes: "Sugestoes",
  bugs: "Problemas / Bugs",
  financeiro: "Financeiro",
  outro: "Outro",
};

function normalize(value) {
  return String(value || "").trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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
    name: normalize(process.env.BREVO_SENDER_NAME) || "DACHBYTE Seller",
  };
}

function recipient() {
  const email = normalize(
    process.env.BREVO_SUPPORT_TO_EMAIL || process.env.BREVO_SENDER_EMAIL,
  );
  const name = normalize(
    process.env.BREVO_SUPPORT_TO_NAME || process.env.BREVO_SENDER_NAME,
  );

  return {
    email,
    name: name || "Suporte DACHBYTE",
  };
}

function topicLabel(topic) {
  const key = normalize(topic).toLowerCase();
  return TOPIC_LABELS[key] || TOPIC_LABELS.outro;
}

function responseLabel(replyPreference) {
  return normalize(replyPreference).toLowerCase() === "cellphone"
    ? "Celular"
    : "Email";
}

function buildHelpContactHtml({
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
  userAgent,
}) {
  const safeName = escapeHtml(userName || "Usuario");
  const safeEmail = escapeHtml(userEmail || "-");
  const safeTopic = escapeHtml(topicLabel(topic));
  const safeMessage = escapeHtml(message || "").replaceAll("\n", "<br />");
  const safeReply = escapeHtml(responseLabel(replyPreference));
  const safeCellphone = escapeHtml(cellphone || "-");
  const safeAccountLabel = escapeHtml(accountLabel || "Nenhuma conta selecionada");
  const safeAccountId = escapeHtml(accountId || "-");
  const safeMeliUserId = escapeHtml(meliUserId || "-");
  const safePath = escapeHtml(pagePath || "-");
  const safeUserAgent = escapeHtml(userAgent || "-");

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#f4f7fb;padding:32px;color:#0f172a;">
      <div style="max-width:760px;margin:0 auto;background:#ffffff;border-radius:28px;overflow:hidden;border:1px solid #dbe5f0;box-shadow:0 24px 60px rgba(15,23,42,.10);">
        <div style="padding:32px 32px 28px;background:linear-gradient(135deg,#1d4ed8 0%,#2563eb 38%,#7c3aed 100%);color:#ffffff;">
          <div style="display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.10);font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;">Ajuda e contato</div>
          <h1 style="margin:18px 0 10px;font-size:32px;line-height:1.05;">Nova mensagem enviada pelo app</h1>
          <p style="margin:0;max-width:56ch;font-size:15px;line-height:1.7;color:rgba(255,255,255,.86);">Mensagem enviada pela central de ajuda do workspace DACHBYTE Mercado Livre.</p>
        </div>

        <div style="padding:28px 32px 32px;">
          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-bottom:22px;">
            <div style="padding:16px 18px;border:1px solid #dbe5f0;border-radius:18px;background:#f8fbff;">
              <div style="font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#64748b;">Usuario</div>
              <div style="margin-top:8px;font-size:18px;font-weight:800;color:#0f172a;">${safeName}</div>
              <div style="margin-top:4px;font-size:14px;color:#475569;">${safeEmail}</div>
            </div>
            <div style="padding:16px 18px;border:1px solid #dbe5f0;border-radius:18px;background:#f8fbff;">
              <div style="font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#64748b;">Assunto</div>
              <div style="margin-top:8px;font-size:18px;font-weight:800;color:#0f172a;">${safeTopic}</div>
              <div style="margin-top:4px;font-size:14px;color:#475569;">Resposta preferida: ${safeReply}</div>
            </div>
          </div>

          <div style="padding:20px 22px;border-radius:22px;background:linear-gradient(180deg,#ffffff,#f8fbff);border:1px solid #dbe5f0;">
            <div style="font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#64748b;">Mensagem</div>
            <div style="margin-top:12px;font-size:15px;line-height:1.8;color:#1e293b;">${safeMessage}</div>
          </div>

          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:22px;">
            <div style="padding:16px 18px;border:1px solid #dbe5f0;border-radius:18px;background:#f8fbff;">
              <div style="font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#64748b;">Conta ativa</div>
              <div style="margin-top:8px;font-size:16px;font-weight:800;color:#0f172a;">${safeAccountLabel}</div>
              <div style="margin-top:6px;font-size:13px;color:#64748b;">Conta ID: ${safeAccountId} | Seller ML: ${safeMeliUserId}</div>
            </div>
            <div style="padding:16px 18px;border:1px solid #dbe5f0;border-radius:18px;background:#f8fbff;">
              <div style="font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#64748b;">Celular informado</div>
              <div style="margin-top:8px;font-size:16px;font-weight:800;color:#0f172a;">${safeCellphone}</div>
              <div style="margin-top:6px;font-size:13px;color:#64748b;">Tela: ${safePath}</div>
            </div>
          </div>

          <div style="margin-top:22px;padding:16px 18px;border:1px dashed #cbd5e1;border-radius:18px;background:#f8fafc;">
            <div style="font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#64748b;">Contexto tecnico</div>
            <div style="margin-top:8px;font-size:13px;line-height:1.7;color:#64748b;">User-Agent: ${safeUserAgent}</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

async function sendHelpContactEmail({
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
  userAgent,
}) {
  if (!isConfigured()) {
    return {
      sent: false,
      skipped: true,
      reason: "Brevo nao configurado.",
    };
  }

  const to = recipient();
  if (!to.email) {
    return {
      sent: false,
      skipped: true,
      reason: "Caixa de suporte nao configurada.",
    };
  }

  const subjectParts = ["[DACHBYTE Mercado Livre]", topicLabel(topic)];
  if (accountLabel) subjectParts.push(accountLabel);

  const payload = {
    sender: sender(),
    to: [{ email: to.email, name: to.name || undefined }],
    subject: subjectParts.join(" • "),
    htmlContent: buildHelpContactHtml({
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
      userAgent,
    }),
    tags: ["support-contact", "ml-app"],
  };

  if (userEmail) {
    payload.replyTo = {
      email: normalize(userEmail),
      name: normalize(userName) || undefined,
    };
  }

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

module.exports = {
  TOPIC_LABELS,
  isConfigured,
  sendHelpContactEmail,
};
