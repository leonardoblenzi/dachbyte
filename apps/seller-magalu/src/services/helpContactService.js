"use strict";

const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";
const TOPICS = Object.freeze({
  duvidas: "Dúvidas",
  reclamacoes: "Reclamações",
  sugestoes: "Sugestões",
  bugs: "Problemas / Bugs",
  financeiro: "Financeiro",
  integracao: "Integração Magalu",
  outro: "Outro",
});

function text(value) { return String(value == null ? "" : value).trim(); }
function html(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function configured() { return Boolean(text(process.env.BREVO_API_KEY) && text(process.env.BREVO_SENDER_EMAIL)); }
function topicLabel(value) { return TOPICS[text(value).toLowerCase()] || TOPICS.outro; }

function buildHtml(context) {
  const message = html(context.message).replaceAll("\n", "<br>");
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;background:#f4f7fb;padding:32px;color:#172033">
    <div style="max-width:760px;margin:auto;background:#fff;border:1px solid #dbe5f1;border-radius:24px;overflow:hidden">
      <div style="padding:28px 32px;background:linear-gradient(135deg,#0b70c9,#22b8e6);color:#fff">
        <div style="font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase">DACHBYTE Seller · Magalu</div>
        <h1 style="margin:12px 0 0;font-size:28px">Ajuda e contato</h1>
      </div>
      <div style="padding:28px 32px">
        <p><strong>Usuário:</strong> ${html(context.userName || "-")} &lt;${html(context.userEmail || "-")}&gt;</p>
        <p><strong>Assunto:</strong> ${html(topicLabel(context.topic))}</p>
        <p><strong>Conta Magalu:</strong> ${html(context.accountLabel || "Nenhuma conta selecionada")}</p>
        <p><strong>Tenant Magalu:</strong> ${html(context.magaluTenantId || "-")}</p>
        <p><strong>Tela:</strong> ${html(context.pagePath || "-")}</p>
        <div style="margin:20px 0;padding:18px;border:1px solid #dbe5f1;border-radius:16px;background:#f8fbff;line-height:1.7">${message}</div>
        <div style="font-size:13px;color:#64748b;line-height:1.7">
          <div><strong>Último sync:</strong> ${html(context.syncStatus || "-")}</div>
          <div><strong>Último erro:</strong> ${html(context.syncError || "-")}</div>
          <div><strong>Request ID:</strong> ${html(context.requestId || "-")}</div>
          <div><strong>Resposta preferida:</strong> ${html(context.replyPreference || "email")}</div>
          <div><strong>Celular:</strong> ${html(context.cellphone || "-")}</div>
        </div>
      </div>
    </div>
  </div>`;
}

async function sendHelpContact(context) {
  if (!configured()) return { sent: false, skipped: true, reason: "Brevo não configurado para seller-magalu." };
  const senderEmail = text(process.env.BREVO_SENDER_EMAIL);
  const senderName = text(process.env.BREVO_SENDER_NAME) || "DACHBYTE Seller";
  const supportEmail = text(process.env.BREVO_SUPPORT_TO_EMAIL) || senderEmail;
  const supportName = text(process.env.BREVO_SUPPORT_TO_NAME) || "Suporte DACHBYTE";
  const payload = {
    sender: { email: senderEmail, name: senderName },
    to: [{ email: supportEmail, name: supportName }],
    subject: `[DACHBYTE Magalu] ${topicLabel(context.topic)}${context.accountLabel ? ` · ${context.accountLabel}` : ""}`,
    htmlContent: buildHtml(context),
    tags: ["support-contact", "magalu-app"],
  };
  if (context.userEmail) payload.replyTo = { email: text(context.userEmail), name: text(context.userName) || undefined };
  const response = await fetch(BREVO_API_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "api-key": text(process.env.BREVO_API_KEY) },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.message || data?.code || `Brevo HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return { sent: true, skipped: false, messageId: data?.messageId || null };
}

module.exports = { TOPICS, configured, sendHelpContact, _test: { buildHtml, topicLabel } };
