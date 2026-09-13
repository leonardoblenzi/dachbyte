"use strict";

const fetch = require("node-fetch");

const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";

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
  return {
    email:
      normalize(process.env.BREVO_COMMERCIAL_TO_EMAIL) ||
      "contato@davanttisuite.com.br",
    name: normalize(process.env.BREVO_COMMERCIAL_TO_NAME) || "Comercial DACHBYTE",
  };
}

function channelsLabel(channels) {
  return Array.isArray(channels) && channels.length
    ? channels.map((item) => normalize(item)).filter(Boolean).join(", ")
    : "Nao informado";
}

function buildCommercialLeadHtml({
  name,
  email,
  cellphone,
  company,
  channels,
  message,
  pagePath,
  userAgent,
  ipAddress,
}) {
  const safeName = escapeHtml(name || "-");
  const safeEmail = escapeHtml(email || "-");
  const safeCellphone = escapeHtml(cellphone || "-");
  const safeCompany = escapeHtml(company || "Nao informado");
  const safeChannels = escapeHtml(channelsLabel(channels));
  const safeMessage = escapeHtml(message || "Lead sem mensagem adicional.").replaceAll(
    "\n",
    "<br />",
  );
  const safePath = escapeHtml(pagePath || "/landing");
  const safeUserAgent = escapeHtml(userAgent || "-");
  const safeIp = escapeHtml(ipAddress || "-");

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#f4f7fb;padding:32px;color:#0f172a;">
      <div style="max-width:760px;margin:0 auto;background:#ffffff;border-radius:28px;overflow:hidden;border:1px solid #dbe5f0;box-shadow:0 24px 60px rgba(15,23,42,.10);">
        <div style="padding:32px;background:linear-gradient(135deg,#1d4ed8 0%,#2563eb 38%,#7c3aed 100%);color:#ffffff;">
          <div style="display:inline-flex;align-items:center;padding:8px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.10);font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;">Lead comercial</div>
          <h1 style="margin:18px 0 10px;font-size:32px;line-height:1.05;">Novo contato recebido pela landing</h1>
          <p style="margin:0;max-width:56ch;font-size:15px;line-height:1.7;color:rgba(255,255,255,.86);">Interesse comercial capturado pela jornada publica DACHBYTE Seller.</p>
        </div>

        <div style="padding:28px 32px 32px;">
          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-bottom:22px;">
            <div style="padding:16px 18px;border:1px solid #dbe5f0;border-radius:18px;background:#f8fbff;">
              <div style="font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#64748b;">Lead</div>
              <div style="margin-top:8px;font-size:18px;font-weight:800;color:#0f172a;">${safeName}</div>
              <div style="margin-top:4px;font-size:14px;color:#475569;">${safeEmail}</div>
            </div>
            <div style="padding:16px 18px;border:1px solid #dbe5f0;border-radius:18px;background:#f8fbff;">
              <div style="font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#64748b;">Canais operados</div>
              <div style="margin-top:8px;font-size:18px;font-weight:800;color:#0f172a;">${safeChannels}</div>
              <div style="margin-top:4px;font-size:14px;color:#475569;">Empresa: ${safeCompany}</div>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-bottom:22px;">
            <div style="padding:16px 18px;border:1px solid #dbe5f0;border-radius:18px;background:#f8fbff;">
              <div style="font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#64748b;">Celular</div>
              <div style="margin-top:8px;font-size:16px;font-weight:800;color:#0f172a;">${safeCellphone}</div>
            </div>
            <div style="padding:16px 18px;border:1px solid #dbe5f0;border-radius:18px;background:#f8fbff;">
              <div style="font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#64748b;">Origem</div>
              <div style="margin-top:8px;font-size:16px;font-weight:800;color:#0f172a;">${safePath}</div>
            </div>
          </div>

          <div style="padding:20px 22px;border-radius:22px;background:linear-gradient(180deg,#ffffff,#f8fbff);border:1px solid #dbe5f0;">
            <div style="font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#64748b;">Mensagem</div>
            <div style="margin-top:12px;font-size:15px;line-height:1.8;color:#1e293b;">${safeMessage}</div>
          </div>

          <div style="margin-top:22px;padding:16px 18px;border:1px dashed #cbd5e1;border-radius:18px;background:#f8fafc;">
            <div style="font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#64748b;">Contexto tecnico</div>
            <div style="margin-top:8px;font-size:13px;line-height:1.7;color:#64748b;">User-Agent: ${safeUserAgent}</div>
            <div style="margin-top:4px;font-size:13px;line-height:1.7;color:#64748b;">IP/Forwarded: ${safeIp}</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

async function sendCommercialLeadEmail({
  name,
  email,
  cellphone,
  company,
  channels,
  message,
  pagePath,
  userAgent,
  ipAddress,
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
      reason: "Caixa comercial nao configurada.",
    };
  }

  const payload = {
    sender: sender(),
    to: [{ email: to.email, name: to.name || undefined }],
    subject: `[DACHBYTE Seller] Lead comercial - ${channelsLabel(channels)}`,
    htmlContent: buildCommercialLeadHtml({
      name,
      email,
      cellphone,
      company,
      channels,
      message,
      pagePath,
      userAgent,
      ipAddress,
    }),
    tags: ["commercial-lead", "landing"],
    replyTo: {
      email: normalize(email),
      name: normalize(name) || undefined,
    },
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
    const messageText =
      data?.message ||
      data?.code ||
      `Brevo respondeu com HTTP ${response.status}.`;

    const error = new Error(messageText);
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
  sendCommercialLeadEmail,
};
