"use strict";

const { sendUmblerEmail } = require("./umblerMailer");
const { DACHBYTE_BRAND } = require("./dachbyteBrand");

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

function plainFromHtml(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function ticketUrl(ticket) {
  const base = normalize(
    process.env.PUBLIC_APP_ORIGIN ||
      process.env.APP_PUBLIC_URL ||
      process.env.DAVANTTI_SUITE_URL ||
      "https://davanttisuite.com.br",
  ).replace(/\/+$/, "");
  return `${base}/?sacTicket=${encodeURIComponent(ticket.protocol || "")}`;
}

function shell({ title, preheader, body }) {
  return `
    <div style="margin:0;padding:0;background:#f4f7fb;color:#102033;font-family:Arial,Helvetica,sans-serif;">
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader || title)}</div>
      <div style="max-width:720px;margin:0 auto;padding:28px 16px;">
        <div style="background:#ffffff;border:1px solid #dbe5ef;border-radius:18px;overflow:hidden;box-shadow:0 18px 45px rgba(15,23,42,.08);">
          <div style="background:#0f766e;padding:24px 28px;color:#ffffff;">
            <div style="font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;">${DACHBYTE_BRAND.support}</div>
            <h1 style="font-size:26px;line-height:1.2;margin:10px 0 0;">${escapeHtml(title)}</h1>
          </div>
          <div style="padding:26px 28px;font-size:15px;line-height:1.7;color:#243449;">
            ${body}
            <div style="margin-top:24px;padding:16px 18px;border-radius:14px;background:#ecfdf5;border:1px solid #a7f3d0;color:#14532d;">
              <strong>Prazo de resposta do usuario:</strong> apos uma resposta do suporte, voce tem 48 horas uteis para retornar.
              Sem resposta dentro desse prazo, o ticket pode ser fechado automaticamente.
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function ticketSummary(ticket) {
  return `
    <table style="width:100%;border-collapse:collapse;margin:18px 0;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
      <tr><td style="padding:10px 12px;background:#f8fafc;font-weight:700;width:160px;">Protocolo</td><td style="padding:10px 12px;">${escapeHtml(ticket.protocol)}</td></tr>
      <tr><td style="padding:10px 12px;background:#f8fafc;font-weight:700;">Titulo</td><td style="padding:10px 12px;">${escapeHtml(ticket.title)}</td></tr>
      <tr><td style="padding:10px 12px;background:#f8fafc;font-weight:700;">Categoria</td><td style="padding:10px 12px;">${escapeHtml(ticket.category)}${ticket.subcategory ? ` / ${escapeHtml(ticket.subcategory)}` : ""}</td></tr>
      <tr><td style="padding:10px 12px;background:#f8fafc;font-weight:700;">Empresa</td><td style="padding:10px 12px;">${escapeHtml(ticket.company_name)}</td></tr>
      <tr><td style="padding:10px 12px;background:#f8fafc;font-weight:700;">Status</td><td style="padding:10px 12px;">${escapeHtml(ticket.status)}</td></tr>
    </table>
  `;
}

async function sendTicketOpenedEmail(ticket) {
  if (!ticket?.email) {
    return { sent: false, skipped: true, reason: "Ticket sem e-mail." };
  }
  const html = shell({
    title: `Ticket aberto: ${ticket.protocol}`,
    preheader: `Recebemos seu ticket ${ticket.protocol}.`,
    body: `
      <p>Ola, ${escapeHtml(ticket.customer_name)}.</p>
      <p>Recebemos seu ticket e nossa equipe vai responder pelo ${DACHBYTE_BRAND.sac}.</p>
      ${ticketSummary(ticket)}
      <p>Guarde o protocolo <strong>${escapeHtml(ticket.protocol)}</strong>.</p>
      <p>Voce pode acompanhar pelo widget de suporte usando o protocolo e este e-mail.</p>
      <p><a href="${escapeHtml(ticketUrl(ticket))}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700;">Abrir suporte DACHBYTE</a></p>
    `,
  });
  return sendUmblerEmail({
    toEmail: ticket.email,
    toName: ticket.customer_name,
    subject: `[DACHBYTE SAC] Ticket aberto ${ticket.protocol}`,
    html,
    text: plainFromHtml(html),
  });
}

async function sendTicketReplyEmail(ticket, replyText, options = {}) {
  if (!ticket?.email) {
    return { sent: false, skipped: true, reason: "Ticket sem e-mail." };
  }
  const html = shell({
    title: options.resend ? `Reenvio de resposta: ${ticket.protocol}` : `Nova resposta: ${ticket.protocol}`,
    preheader: `Ha uma nova resposta no ticket ${ticket.protocol}.`,
    body: `
      <p>Ola, ${escapeHtml(ticket.customer_name)}.</p>
      <p>${options.resend ? "Estamos reenviando a ultima resposta do suporte." : `${DACHBYTE_BRAND.support} respondeu seu ticket.`}</p>
      ${ticketSummary(ticket)}
      <div style="margin:18px 0;padding:16px 18px;border-radius:14px;background:#f8fafc;border:1px solid #e2e8f0;white-space:pre-line;">${escapeHtml(replyText || "Resposta registrada no ticket.")}</div>
      <p>Para responder, abra o widget de suporte e consulte o ticket pelo protocolo e e-mail.</p>
      <p><a href="${escapeHtml(ticketUrl(ticket))}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700;">Responder ticket</a></p>
    `,
  });
  return sendUmblerEmail({
    toEmail: ticket.email,
    toName: ticket.customer_name,
    subject: `[DACHBYTE SAC] Resposta no ticket ${ticket.protocol}`,
    html,
    text: plainFromHtml(html),
  });
}

async function sendTicketStatusEmail(ticket, statusText) {
  if (!ticket?.email) {
    return { sent: false, skipped: true, reason: "Ticket sem e-mail." };
  }
  const html = shell({
    title: `Atualizacao do ticket ${ticket.protocol}`,
    preheader: statusText,
    body: `
      <p>Ola, ${escapeHtml(ticket.customer_name)}.</p>
      <p>${escapeHtml(statusText)}</p>
      ${ticketSummary(ticket)}
      <p>Guarde o protocolo <strong>${escapeHtml(ticket.protocol)}</strong>.</p>
    `,
  });
  return sendUmblerEmail({
    toEmail: ticket.email,
    toName: ticket.customer_name,
    subject: `[DACHBYTE SAC] Atualizacao ${ticket.protocol}`,
    html,
    text: plainFromHtml(html),
  });
}

module.exports = {
  sendTicketOpenedEmail,
  sendTicketReplyEmail,
  sendTicketStatusEmail,
};
