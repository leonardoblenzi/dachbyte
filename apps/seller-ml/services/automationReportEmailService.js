"use strict";

const fetch = require("node-fetch");
const { isConfigured } = require("./inviteEmailService");

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

function publicOrigin() {
  return normalize(
    process.env.ML_PUBLIC_ORIGIN ||
      process.env.PUBLIC_APP_ORIGIN ||
      process.env.APP_PUBLIC_URL,
  ).replace(/\/+$/, "");
}

function absolutizeUrl(pathOrUrl) {
  const raw = normalize(pathOrUrl);
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  const origin = publicOrigin();
  if (!origin) return raw;
  return `${origin}${raw.startsWith("/") ? raw : `/${raw}`}`;
}

function enrichmentLabel(value) {
  return {
    none: "Sem enriquecimento",
    category: "Categoria",
    visits: "Visitas",
    ads: "Ads",
    promos: "Promocoes",
    variations: "Variacoes",
  }[normalize(value)] || "Sem enriquecimento";
}

function baseStatusLabel(value) {
  return {
    active: "Ativos",
    paused: "Inativos/pausados",
    all: "Todos",
    mlb_list: "Lista de MLBs",
  }[normalize(value)] || "Ativos";
}

function periodLabel(value) {
  return {
    none: "Sem periodo comercial",
    last_7_days: "Ultimos 7 dias",
    last_30_days: "Ultimos 30 dias",
    current_month: "Mes atual",
    previous_month: "Mes anterior",
  }[normalize(value)] || "Sem periodo comercial";
}

function buildHtml({ automation, run, csvUrl }) {
  const safeName = escapeHtml(automation?.name || "Relatorio automatico");
  const safeCsvUrl = escapeHtml(absolutizeUrl(csvUrl));
  const rows = Number(run?.rows_count || 0);

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#f6f8fd;padding:32px;color:#0f172a;">
      <div style="max-width:720px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:20px;padding:28px;">
        <p style="margin:0 0 14px;font-size:13px;color:#2563eb;font-weight:800;letter-spacing:.08em;text-transform:uppercase;">DAVANTTI • Relatorio automatico</p>
        <h1 style="margin:0 0 12px;font-size:28px;line-height:1.15;">${safeName}</h1>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#475569;">
          Seu relatorio foi processado e esta pronto para download.
        </p>

        <div style="display:grid;gap:10px;margin:0 0 22px;">
          <div><strong>Base:</strong> ${escapeHtml(baseStatusLabel(automation?.base_status))}</div>
          <div><strong>Enriquecimento:</strong> ${escapeHtml(enrichmentLabel(automation?.enrichment))}</div>
          <div><strong>Periodo:</strong> ${escapeHtml(periodLabel(automation?.period_type))}</div>
          <div><strong>Total de linhas:</strong> ${rows.toLocaleString("pt-BR")}</div>
        </div>

        ${
          safeCsvUrl
            ? `<p style="margin:24px 0;">
                <a href="${safeCsvUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:800;padding:14px 20px;border-radius:12px;">
                  Baixar CSV
                </a>
              </p>
              <p style="margin:0;color:#64748b;font-size:13px;line-height:1.5;word-break:break-all;">
                Link: ${safeCsvUrl}
              </p>`
            : `<p style="margin:0;color:#b91c1c;">O CSV foi gerado, mas o link de download nao ficou disponivel.</p>`
        }
      </div>
    </div>
  `;
}

async function sendAutomationReportEmail({ automation, run, recipients, csvUrl }) {
  const safeRecipients = (Array.isArray(recipients) ? recipients : [])
    .map((recipient) => ({
      email: normalize(recipient?.email || recipient),
      name: normalize(recipient?.name || recipient?.nome),
    }))
    .filter((recipient) => recipient.email);

  if (!safeRecipients.length) {
    return { sent: false, skipped: true, reason: "Sem destinatarios." };
  }

  if (!isConfigured()) {
    return { sent: false, skipped: true, reason: "Brevo nao configurado." };
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
      to: safeRecipients.map((recipient) => ({
        email: recipient.email,
        name: recipient.name || undefined,
      })),
      subject: `[Davantti] ${normalize(automation?.name) || "Relatorio automatico"}`,
      htmlContent: buildHtml({ automation, run, csvUrl }),
      tags: ["ml-report-automation", "ml"],
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
    recipients: safeRecipients.map((recipient) => recipient.email),
  };
}

module.exports = {
  sendAutomationReportEmail,
};
