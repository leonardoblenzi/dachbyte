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
  return Boolean(
    normalize(process.env.BREVO_API_KEY) &&
      senderEmail(),
  );
}

function sender() {
  return {
    email: senderEmail(),
    name: normalize(process.env.BREVO_SENDER_NAME) || "DACHBYTE Seller",
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

function formatDateTime(value) {
  if (!value) return "-";

  try {
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: process.env.SALES_SUMMARY_TZ || "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function buildInviteHtml({ nome, activationLink, expiresAt }) {
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#fff5ef;padding:32px;color:#1f2937;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:20px;padding:32px;border:1px solid #fed7c3;">
        <p style="margin:0 0 16px;font-size:14px;color:#ee4d2d;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">DACHBYTE Seller &bull; Convite Shopee</p>
        <h1 style="margin:0 0 12px;font-size:32px;line-height:1.05;">Ative seu acesso ao workspace</h1>
        <p style="margin:0 0 18px;font-size:16px;line-height:1.6;">
          Ola, ${escapeHtml(nome || "cliente")}. Seu acesso ao ambiente Shopee foi criado. Defina sua senha e siga para a vinculacao OAuth da loja.
        </p>
        <p style="margin:24px 0;">
          <a href="${escapeHtml(activationLink)}" style="display:inline-block;background:#ee4d2d;color:#ffffff;text-decoration:none;font-weight:800;padding:14px 20px;border-radius:14px;">
            Ativar acesso
          </a>
        </p>
        <p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#6b7280;">
          Se precisar, copie este link no navegador:
        </p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;word-break:break-all;color:#c2410c;">
          ${escapeHtml(activationLink)}
        </p>
        <p style="margin:0;font-size:13px;color:#6b7280;">
          Este convite expira em ${escapeHtml(expiresAt)}.
        </p>
      </div>
    </div>
  `;
}

function buildPasswordResetHtml({ nome, resetLink, expiresAt }) {
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#fff5ef;padding:32px;color:#1f2937;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:20px;padding:32px;border:1px solid #fed7c3;">
        <p style="margin:0 0 16px;font-size:14px;color:#ee4d2d;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">DACHBYTE Seller &bull; Recuperacao de senha Shopee</p>
        <h1 style="margin:0 0 12px;font-size:32px;line-height:1.05;">Redefina sua senha</h1>
        <p style="margin:0 0 18px;font-size:16px;line-height:1.6;">
          Ola, ${escapeHtml(nome || "cliente")}. Recebemos uma solicitacao para redefinir sua senha no workspace Shopee.
        </p>
        <p style="margin:24px 0;">
          <a href="${escapeHtml(resetLink)}" style="display:inline-block;background:#ee4d2d;color:#ffffff;text-decoration:none;font-weight:800;padding:14px 20px;border-radius:14px;">
            Redefinir senha
          </a>
        </p>
        <p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#6b7280;">
          Se precisar, copie este link no navegador:
        </p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;word-break:break-all;color:#c2410c;">
          ${escapeHtml(resetLink)}
        </p>
        <p style="margin:0;font-size:13px;color:#6b7280;">
          Este link expira em ${escapeHtml(expiresAt)}. Se voce nao pediu essa troca, ignore este email.
        </p>
      </div>
    </div>
  `;
}

function buildSalesSummaryHtml({ nome, companyName, report }) {
  const meta = report?.meta || {};
  const monthlyCards = Array.isArray(report?.monthly?.cards)
    ? report.monthly.cards
    : [];
  const comparisonMetrics = Array.isArray(report?.monthly?.comparisonMetrics)
    ? report.monthly.comparisonMetrics
    : [];
  const growthTone = (label) => {
    const value = String(label || "");
    if (value === "Novo" || value.startsWith("+")) return "#16a34a";
    if (value.startsWith("-")) return "#dc2626";
    return "#475569";
  };

  const ordersPreview = (Array.isArray(report?.orders) ? report.orders : [])
    .slice(0, 10)
    .map((order) => {
      const createdAt = order?.orderDate
        ? new Date(order.orderDate).toLocaleString("pt-BR")
        : "-";
      const gmv = Number(order?.gmvCents || 0) / 100;

      return `
        <tr>
          <td style="padding:10px 8px;border-bottom:1px solid #f3f4f6;">${escapeHtml(order?.orderSn || "-")}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #f3f4f6;">${escapeHtml(order?.orderStatus || "-")}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #f3f4f6;">${escapeHtml(String(order?.shopShopeeId || "-"))}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #f3f4f6;text-align:right;">${escapeHtml(
            gmv.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }),
          )}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #f3f4f6;">${escapeHtml(createdAt)}</td>
        </tr>
      `;
    })
    .join("");

  const monthlyCardsHtml = monthlyCards.length
    ? `
      <div style="margin-top:28px;">
        <div style="font-size:18px;font-weight:800;color:#ea580c;margin-bottom:12px;">Indicadores do mes fechado</div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;">
          ${monthlyCards
            .map(
              (card) => `
                <div style="flex:1 1 220px;border:1px solid #fed7aa;border-radius:16px;padding:16px;background:#fffaf5;">
                  <div style="font-size:13px;color:#6b7280;">${escapeHtml(card?.label || "-")}</div>
                  <div style="margin-top:8px;font-size:24px;font-weight:800;color:#1f2937;">${escapeHtml(card?.value || "0")}</div>
                  <div style="margin-top:8px;font-size:13px;font-weight:700;color:${growthTone(card?.growthLabel)};">${escapeHtml(card?.growthLabel || "0%")} vs ${escapeHtml(report?.period?.previousLabel || "periodo anterior")}</div>
                </div>
              `,
            )
            .join("")}
        </div>
      </div>
    `
    : "";

  const monthlyComparisonHtml = comparisonMetrics.length
    ? `
      <div style="margin-top:28px;">
        <div style="font-size:18px;font-weight:800;color:#ea580c;margin-bottom:8px;">Grafico comparativo com o mes anterior</div>
        <div style="font-size:13px;color:#6b7280;margin-bottom:14px;">
          Cada indicador usa escala propria para comparar ${escapeHtml(
            report?.period?.currentLabel || "mes atual",
          )} com ${escapeHtml(report?.period?.previousLabel || "mes anterior")}.
        </div>
        <div style="border:1px solid #fed7c3;border-radius:18px;padding:18px;background:#fffaf7;">
          ${comparisonMetrics
            .map((metric) => {
              const currentPct = Math.max(
                0,
                Math.min(100, Number(metric?.currentPct || 0)),
              ).toFixed(1);
              const previousPct = Math.max(
                0,
                Math.min(100, Number(metric?.previousPct || 0)),
              ).toFixed(1);

              return `
                <div style="margin-bottom:16px;">
                  <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:6px;">
                    <div style="font-size:14px;font-weight:800;color:#334155;">${escapeHtml(metric?.label || "-")}</div>
                    <div style="font-size:13px;font-weight:700;color:${growthTone(metric?.growthLabel)};">${escapeHtml(metric?.growthLabel || "0%")}</div>
                  </div>
                  <div style="display:grid;grid-template-columns:88px 1fr auto;gap:10px;align-items:center;margin-bottom:6px;">
                    <div style="font-size:12px;color:#6b7280;">Mes atual</div>
                    <div style="height:10px;background:#ffe7dc;border-radius:999px;overflow:hidden;">
                      <div style="width:${currentPct}%;height:10px;border-radius:999px;background:linear-gradient(90deg,#ee4d2d,#fb923c);"></div>
                    </div>
                    <div style="font-size:12px;font-weight:700;color:#334155;">${escapeHtml(metric?.currentLabel || "0")}</div>
                  </div>
                  <div style="display:grid;grid-template-columns:88px 1fr auto;gap:10px;align-items:center;">
                    <div style="font-size:12px;color:#6b7280;">Mes anterior</div>
                    <div style="height:10px;background:#dbeafe;border-radius:999px;overflow:hidden;">
                      <div style="width:${previousPct}%;height:10px;border-radius:999px;background:linear-gradient(90deg,#60a5fa,#2563eb);"></div>
                    </div>
                    <div style="font-size:12px;font-weight:700;color:#334155;">${escapeHtml(metric?.previousLabel || "0")}</div>
                  </div>
                </div>
              `;
            })
            .join("")}
        </div>
      </div>
    `
    : "";

  const operationsHtml = meta.hideOperations
    ? ""
    : `
      <div style="margin-top:24px;">
        <div style="font-size:18px;font-weight:800;color:#ea580c;margin-bottom:10px;">Operacao de envio</div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;">
          <div style="flex:1 1 140px;border:1px solid #fdba74;border-radius:14px;padding:14px;text-align:center;">
            <div style="font-size:24px;font-weight:800;">${escapeHtml(String(report?.shipping?.overdue || 0))}</div>
            <div style="font-size:13px;color:#6b7280;">Envio atrasado</div>
          </div>
          <div style="flex:1 1 140px;border:1px solid #fdba74;border-radius:14px;padding:14px;text-align:center;">
            <div style="font-size:24px;font-weight:800;">${escapeHtml(String(report?.shipping?.today || 0))}</div>
            <div style="font-size:13px;color:#6b7280;">Enviar hoje</div>
          </div>
          <div style="flex:1 1 140px;border:1px solid #fdba74;border-radius:14px;padding:14px;text-align:center;">
            <div style="font-size:24px;font-weight:800;">${escapeHtml(String(report?.shipping?.week || 0))}</div>
            <div style="font-size:13px;color:#6b7280;">Enviar em 7 dias</div>
          </div>
          <div style="flex:1 1 140px;border:1px solid #fdba74;border-radius:14px;padding:14px;text-align:center;">
            <div style="font-size:24px;font-weight:800;">${escapeHtml(String(report?.shipping?.later || 0))}</div>
            <div style="font-size:13px;color:#6b7280;">Proximas datas</div>
          </div>
        </div>
      </div>

      <div style="margin-top:24px;">
        <div style="font-size:18px;font-weight:800;color:#ea580c;margin-bottom:10px;">Status atuais da operacao</div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;">
          <div style="flex:1 1 140px;border:1px solid #fed7aa;border-radius:14px;padding:14px;text-align:center;">
            <div style="font-size:24px;font-weight:800;">${escapeHtml(String(report?.status?.readyToShip || 0))}</div>
            <div style="font-size:13px;color:#6b7280;">Ready to Ship</div>
          </div>
          <div style="flex:1 1 140px;border:1px solid #fed7aa;border-radius:14px;padding:14px;text-align:center;">
            <div style="font-size:24px;font-weight:800;">${escapeHtml(String(report?.status?.processed || 0))}</div>
            <div style="font-size:13px;color:#6b7280;">Processed</div>
          </div>
          <div style="flex:1 1 140px;border:1px solid #fed7aa;border-radius:14px;padding:14px;text-align:center;">
            <div style="font-size:24px;font-weight:800;">${escapeHtml(String(report?.status?.shipped || 0))}</div>
            <div style="font-size:13px;color:#6b7280;">Shipped</div>
          </div>
          <div style="flex:1 1 140px;border:1px solid #fed7aa;border-radius:14px;padding:14px;text-align:center;">
            <div style="font-size:24px;font-weight:800;">${escapeHtml(String(report?.status?.toConfirmReceive || 0))}</div>
            <div style="font-size:13px;color:#6b7280;">To confirm receive</div>
          </div>
        </div>
      </div>
    `;

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#fff7f0;padding:32px;color:#1f2937;">
      <div style="max-width:760px;margin:0 auto;background:#ffffff;border-radius:24px;overflow:hidden;border:1px solid #fed7c3;">
        <div style="background:#ee4d2d;padding:24px 28px;color:#ffffff;">
          <div style="font-size:20px;font-weight:800;letter-spacing:.06em;margin-bottom:14px;">DACHBYTE Seller</div>
          <div style="font-size:28px;font-weight:800;line-height:1.1;">${escapeHtml(
            meta.title || "Confira seu resumo de vendas",
          )}</div>
          <div style="margin-top:8px;font-size:14px;opacity:.92;">
            Empresa: ${escapeHtml(companyName || "DACHBYTE Seller")} &bull; Periodo: ${escapeHtml(report?.period?.currentLabel || "-")}
          </div>
        </div>

        <div style="padding:28px;">
          <p style="margin:0 0 18px;font-size:15px;line-height:1.6;">
            Ola, ${escapeHtml(nome || "time")}. ${escapeHtml(
              meta.intro ||
                "Segue o resumo da sua operacao Shopee. O CSV completo com os pedidos do periodo esta em anexo.",
            )}
          </p>

          <div style="text-align:center;margin:10px 0 18px;">
            <span style="display:inline-block;background:#ee4d2d;color:#ffffff;font-weight:800;padding:10px 18px;border-radius:999px;">
              ${escapeHtml(meta.badgeLabel || "Resumo de vendas")}
            </span>
          </div>

          <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:18px;">
            <div style="flex:1 1 220px;border:1px solid #ee4d2d;border-radius:16px;padding:18px;text-align:center;">
              <div style="font-size:30px;font-weight:800;color:#374151;">${escapeHtml(String(report?.summary?.ordersCount || 0))}</div>
              <div style="font-size:14px;color:#6b7280;">${escapeHtml(
                meta.ordersLabel || "Pedidos no periodo",
              )}</div>
            </div>
            <div style="flex:1 1 220px;border:1px solid #ee4d2d;border-radius:16px;padding:18px;text-align:center;">
              <div style="font-size:30px;font-weight:800;color:#374151;">${escapeHtml(
                (Number(report?.summary?.gmvCents || 0) / 100).toLocaleString(
                  "pt-BR",
                  { style: "currency", currency: "BRL" },
                ),
              )}</div>
              <div style="font-size:14px;color:#6b7280;">${escapeHtml(
                meta.salesLabel || "GMV pago no periodo",
              )}</div>
            </div>
            <div style="flex:1 1 220px;border:1px solid #ee4d2d;border-radius:16px;padding:18px;text-align:center;">
              <div style="font-size:26px;font-weight:800;color:#374151;">${escapeHtml(
                report?.summary?.ordersGrowthLabel || "0%",
              )}</div>
              <div style="font-size:14px;color:#6b7280;">${escapeHtml(
                meta.ordersCompareLabel || "Pedidos vs periodo anterior",
              )}</div>
            </div>
            <div style="flex:1 1 220px;border:1px solid #ee4d2d;border-radius:16px;padding:18px;text-align:center;">
              <div style="font-size:26px;font-weight:800;color:#374151;">${escapeHtml(
                report?.summary?.salesGrowthLabel || "0%",
              )}</div>
              <div style="font-size:14px;color:#6b7280;">${escapeHtml(
                meta.salesCompareLabel || "GMV vs periodo anterior",
              )}</div>
            </div>
          </div>

          ${monthlyCardsHtml}
          ${monthlyComparisonHtml}
          ${operationsHtml}

          <div style="margin-top:28px;">
            <div style="font-size:18px;font-weight:800;color:#ea580c;margin-bottom:10px;">${escapeHtml(
              meta.tableTitle || "Pedidos do periodo",
            )}</div>
            <div style="font-size:13px;color:#6b7280;margin-bottom:10px;">
              Exibindo ate 10 pedidos no email. O CSV anexo leva a lista completa do periodo.
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:13px;">
              <thead>
                <tr style="background:#fff7ed;text-align:left;">
                  <th style="padding:10px 8px;border-bottom:1px solid #fdba74;">Pedido</th>
                  <th style="padding:10px 8px;border-bottom:1px solid #fdba74;">Status</th>
                  <th style="padding:10px 8px;border-bottom:1px solid #fdba74;">Shop</th>
                  <th style="padding:10px 8px;border-bottom:1px solid #fdba74;text-align:right;">GMV</th>
                  <th style="padding:10px 8px;border-bottom:1px solid #fdba74;">Criado em</th>
                </tr>
              </thead>
              <tbody>
                ${
                  ordersPreview ||
                  `<tr><td colspan="5" style="padding:14px 8px;color:#6b7280;">${escapeHtml(meta.emptyTableText || "Nenhum pedido encontrado no periodo.")}</td></tr>`
                }
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;
}

function buildSalesSummaryHtmlV2({ nome, companyName, report }) {
  const meta = report?.meta || {};
  const dashboard = report?.dashboard || null;
  const monthlyCards = Array.isArray(report?.monthly?.cards)
    ? report.monthly.cards
    : [];
  const comparisonMetrics = Array.isArray(report?.monthly?.comparisonMetrics)
    ? report.monthly.comparisonMetrics
    : [];

  const growthTone = (label) => {
    const value = String(label || "");
    if (value === "Novo" || value.startsWith("+")) return "#16a34a";
    if (value.startsWith("-")) return "#dc2626";
    return "#475569";
  };

  const formatMoney = (cents) =>
    (Number(cents || 0) / 100).toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    });

  const formatRoundedPercent = (value) =>
    value == null || value === "" || !Number.isFinite(Number(value))
      ? "--%"
      : `${Math.round(Number(value))}%`;

  const buildStarsHtml = (rating) => {
    const safe = Number(rating);
    if (!Number.isFinite(safe)) {
      return `<span style="font-size:18px;color:#cbd5e1;letter-spacing:1px;">&#9734;&#9734;&#9734;&#9734;&#9734;</span>`;
    }

    const full = Math.max(0, Math.min(5, Math.round(safe)));
    const filled = "&#9733;".repeat(full);
    const empty = "&#9734;".repeat(Math.max(0, 5 - full));

    return `<span style="font-size:18px;color:#f59e0b;letter-spacing:1px;">${filled}</span><span style="font-size:18px;color:#cbd5e1;letter-spacing:1px;">${empty}</span>`;
  };

  const buildRevenueChartSvg = (series) => {
    const rows = Array.isArray(series) ? series : [];
    if (!rows.length) {
      return `<div style="height:280px;border:1px dashed #d8c7ff;border-radius:22px;background:#faf7ff;color:#64748b;font-size:13px;display:flex;align-items:center;justify-content:center;">Sem dados de faturamento para exibir.</div>`;
    }

    const width = 620;
    const height = 280;
    const left = 54;
    const right = 18;
    const top = 18;
    const bottom = 36;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const values = rows.map((row) => Number(row?.revenueCents || 0) / 100);
    const max = Math.max(...values, 1);
    const stepX = rows.length > 1 ? plotWidth / (rows.length - 1) : plotWidth;

    const pointAt = (value, index) => {
      const x = left + stepX * index;
      const y = top + plotHeight - (Number(value || 0) / max) * plotHeight;
      return [x, y];
    };

    const points = values.map((value, index) => pointAt(value, index));
    const linePath = points
      .map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`)
      .join(" ");
    const areaPath = `${linePath} L ${(left + plotWidth).toFixed(2)} ${(top + plotHeight).toFixed(2)} L ${left} ${(top + plotHeight).toFixed(2)} Z`;
    const gridLines = Array.from({ length: 5 }, (_, index) => {
      const ratio = index / 4;
      const y = top + plotHeight * ratio;
      const labelValue = ((max * (1 - ratio)) || 0).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
        maximumFractionDigits: 0,
      });

      return `
        <line x1="${left}" y1="${y.toFixed(2)}" x2="${(left + plotWidth).toFixed(2)}" y2="${y.toFixed(2)}" stroke="#e7ddff" stroke-width="1" />
        <text x="10" y="${(y + 4).toFixed(2)}" font-size="11" fill="#7c7fa1">${escapeHtml(labelValue)}</text>
      `;
    }).join("");

    const xLabels = rows
      .map((row, index) => {
        if (index !== 0 && index !== rows.length - 1 && index % 4 !== 0) return "";
        const x = left + stepX * index;
        return `<text x="${x.toFixed(2)}" y="${height - 10}" text-anchor="middle" font-size="11" fill="#7c7fa1">${escapeHtml(row?.label || "")}</text>`;
      })
      .join("");

    return `
      <div style="height:280px;border:1px solid #eadfff;border-radius:24px;background:linear-gradient(180deg,#ffffff 0%,#fcfaff 100%);padding:12px;">
        <svg width="100%" height="100%" viewBox="0 0 ${width} ${height}" role="img" aria-label="Evolucao do faturamento pago">
          <defs>
            <linearGradient id="dashAreaFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#a855f7" stop-opacity="0.28" />
              <stop offset="100%" stop-color="#a855f7" stop-opacity="0.04" />
            </linearGradient>
          </defs>
          ${gridLines}
          <path d="${areaPath}" fill="url(#dashAreaFill)"></path>
          <path d="${linePath}" fill="none" stroke="#9b5cff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>
          ${xLabels}
        </svg>
      </div>
    `;
  };

  const ordersPreview = (Array.isArray(report?.orders) ? report.orders : [])
    .slice(0, 10)
    .map((order) => {
      const createdAt = order?.orderDate
        ? new Date(order.orderDate).toLocaleString("pt-BR")
        : "-";
      const gmv = Number(order?.gmvCents || 0) / 100;

      return `
        <tr>
          <td style="padding:10px 8px;border-bottom:1px solid #f3f4f6;">${escapeHtml(order?.orderSn || "-")}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #f3f4f6;">${escapeHtml(order?.orderStatus || "-")}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #f3f4f6;">${escapeHtml(String(order?.shopShopeeId || "-"))}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #f3f4f6;text-align:right;">${escapeHtml(
            gmv.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }),
          )}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #f3f4f6;">${escapeHtml(createdAt)}</td>
        </tr>
      `;
    })
    .join("");

  const monthlyCardsHtml = monthlyCards.length
    ? `
      <div style="margin-top:28px;">
        <div style="font-size:18px;font-weight:800;color:#6d28d9;margin-bottom:12px;">Indicadores do mes fechado</div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;">
          ${monthlyCards
            .map(
              (card) => `
                <div style="flex:1 1 220px;border:1px solid #ddd6fe;border-radius:18px;padding:16px;background:#fcfbff;">
                  <div style="font-size:13px;color:#6b7280;">${escapeHtml(card?.label || "-")}</div>
                  <div style="margin-top:8px;font-size:24px;font-weight:800;color:#23293f;">${escapeHtml(card?.value || "0")}</div>
                  <div style="margin-top:8px;font-size:13px;font-weight:700;color:${growthTone(card?.growthLabel)};">${escapeHtml(card?.growthLabel || "0%")} vs ${escapeHtml(report?.period?.previousLabel || "periodo anterior")}</div>
                </div>
              `,
            )
            .join("")}
        </div>
      </div>
    `
    : "";

  const monthlyComparisonHtml = comparisonMetrics.length
    ? `
      <div style="margin-top:28px;">
        <div style="font-size:18px;font-weight:800;color:#6d28d9;margin-bottom:8px;">Grafico comparativo com o mes anterior</div>
        <div style="font-size:13px;color:#6b7280;margin-bottom:14px;">
          Cada indicador usa escala propria para comparar ${escapeHtml(
            report?.period?.currentLabel || "mes atual",
          )} com ${escapeHtml(report?.period?.previousLabel || "mes anterior")}.
        </div>
        <div style="border:1px solid #e9ddff;border-radius:18px;padding:18px;background:#fcfbff;">
          ${comparisonMetrics
            .map((metric) => {
              const currentPct = Math.max(
                0,
                Math.min(100, Number(metric?.currentPct || 0)),
              ).toFixed(1);
              const previousPct = Math.max(
                0,
                Math.min(100, Number(metric?.previousPct || 0)),
              ).toFixed(1);

              return `
                <div style="margin-bottom:16px;">
                  <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:6px;">
                    <div style="font-size:14px;font-weight:800;color:#334155;">${escapeHtml(metric?.label || "-")}</div>
                    <div style="font-size:13px;font-weight:700;color:${growthTone(metric?.growthLabel)};">${escapeHtml(metric?.growthLabel || "0%")}</div>
                  </div>
                  <div style="display:grid;grid-template-columns:88px 1fr auto;gap:10px;align-items:center;margin-bottom:6px;">
                    <div style="font-size:12px;color:#6b7280;">Mes atual</div>
                    <div style="height:10px;background:#efe7ff;border-radius:999px;overflow:hidden;">
                      <div style="width:${currentPct}%;height:10px;border-radius:999px;background:linear-gradient(90deg,#8b5cf6,#c084fc);"></div>
                    </div>
                    <div style="font-size:12px;font-weight:700;color:#334155;">${escapeHtml(metric?.currentLabel || "0")}</div>
                  </div>
                  <div style="display:grid;grid-template-columns:88px 1fr auto;gap:10px;align-items:center;">
                    <div style="font-size:12px;color:#6b7280;">Mes anterior</div>
                    <div style="height:10px;background:#dbeafe;border-radius:999px;overflow:hidden;">
                      <div style="width:${previousPct}%;height:10px;border-radius:999px;background:linear-gradient(90deg,#60a5fa,#2563eb);"></div>
                    </div>
                    <div style="font-size:12px;font-weight:700;color:#334155;">${escapeHtml(metric?.previousLabel || "0")}</div>
                  </div>
                </div>
              `;
            })
            .join("")}
        </div>
      </div>
    `
    : "";

  const dashboardHtml = dashboard
    ? `
      <div style="margin-top:28px;">
        <div style="font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#7c7fa1;">Pulso comercial</div>
        <div style="margin-top:14px;display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;">
          <div style="flex:1 1 450px;min-width:320px;border:1px solid #eadfff;border-radius:28px;padding:22px;background:linear-gradient(180deg,#ffffff 0%,#faf7ff 100%);">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px;">
              <div style="font-size:34px;font-weight:800;line-height:1.04;color:#23293f;">Evolucao do faturamento pago nos ultimos 30 dias</div>
              <div style="font-size:12px;font-weight:700;color:#4c5471;white-space:nowrap;">Atualizado ${escapeHtml(dashboard?.updatedAtLabel || "--:--")}</div>
            </div>
            ${buildRevenueChartSvg(dashboard?.revenueSeries)}
          </div>

          <div style="flex:0 0 336px;min-width:336px;border:1px solid #eadfff;border-radius:28px;padding:20px;background:linear-gradient(180deg,#ffffff 0%,#fcfbff 100%);">
            <div style="font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#7c7fa1;">Resumo rapido</div>
            <div style="margin-top:10px;font-size:22px;font-weight:800;color:#23293f;">KPIs da operacao</div>
            <div style="margin-top:16px;font-size:0;">
              ${(Array.isArray(dashboard?.operationKpis) ? dashboard.operationKpis : [])
                .map(
                  (kpi, index) => `
                    <div style="display:inline-block;vertical-align:top;width:calc(50% - 6px);min-height:116px;margin:${index % 2 === 0 ? "0 12px 12px 0" : "0 0 12px 0"};border:1px solid #e6e0f5;border-radius:18px;padding:14px;box-sizing:border-box;background:#ffffff;">
                      <div style="font-size:12px;line-height:1.35;color:#7c7fa1;word-break:break-word;">${escapeHtml(kpi?.label || "-")}</div>
                      <div style="margin-top:8px;font-size:18px;font-weight:800;line-height:1.25;color:#23293f;word-break:break-word;">${escapeHtml(kpi?.value || "--")}</div>
                      <div style="margin-top:6px;font-size:12px;line-height:1.35;color:#7c7fa1;word-break:break-word;">${escapeHtml(kpi?.meta || "")}</div>
                    </div>
                  `,
                )
                .join("")}
            </div>

            <div style="margin-top:4px;">
              <div style="border:1px solid #e6e0f5;border-radius:20px;padding:14px;box-sizing:border-box;background:#ffffff;">
                <div style="font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#7c7fa1;">Qualidade do SAC</div>
                <div style="margin-top:8px;font-size:24px;font-weight:800;color:#23293f;">${escapeHtml(formatRoundedPercent(dashboard?.qualitySac?.scorePct))}</div>
                <div style="margin-top:6px;font-size:12px;color:#7c7fa1;">${escapeHtml(String(dashboard?.qualitySac?.metricsMonitored || 0))} metrica(s) monitoradas &bull; ${escapeHtml(String(dashboard?.qualitySac?.outOfTargetCount || 0))} fora da meta</div>
                <div style="margin-top:14px;border:1px solid #efeaf9;border-radius:16px;padding:12px;background:#fbfaff;">
                  <div style="font-size:12px;color:#7c7fa1;">Taxa de resposta</div>
                  <div style="margin-top:6px;font-size:18px;font-weight:800;color:#23293f;">${escapeHtml(formatRoundedPercent(dashboard?.qualitySac?.responseRatePct))}</div>
                  <div style="margin-top:4px;font-size:11px;color:#7c7fa1;">Meta >= ${escapeHtml(String(Math.round(Number(dashboard?.qualitySac?.responseRateTargetPct || 0))))}%</div>
                </div>
                <div style="margin-top:10px;border:1px solid #efeaf9;border-radius:16px;padding:12px;background:#fbfaff;">
                  <div style="font-size:12px;color:#7c7fa1;">Shop Rating</div>
                  <div style="margin-top:6px;">${buildStarsHtml(dashboard?.qualitySac?.shopRating)}</div>
                  <div style="margin-top:6px;font-size:18px;font-weight:800;color:#23293f;">${escapeHtml(
                    dashboard?.qualitySac?.shopRating == null
                      ? "--"
                      : Number(dashboard.qualitySac.shopRating)
                          .toFixed(2)
                          .replace(".", ","),
                  )}</div>
                  <div style="margin-top:4px;font-size:11px;color:#7c7fa1;">Meta >= ${escapeHtml(
                    Number(dashboard?.qualitySac?.shopRatingTarget || 0)
                      .toFixed(2)
                      .replace(".", ","),
                  )}</div>
                </div>
              </div>

              <div style="margin-top:12px;border:1px solid #e6e0f5;border-radius:20px;padding:14px;box-sizing:border-box;background:#ffffff;">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
                  <div style="font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#7c7fa1;">Saude da conta</div>
                  <div style="padding:4px 10px;border-radius:999px;background:${Number(dashboard?.accountHealth?.outOfTargetCount || 0) > 1 ? "#fff1f2" : "#eefbf3"};color:${Number(dashboard?.accountHealth?.outOfTargetCount || 0) > 1 ? "#be123c" : "#166534"};font-size:11px;font-weight:800;">${Number(dashboard?.accountHealth?.outOfTargetCount || 0) > 1 ? "Atencao" : "Boa"}</div>
                </div>
                <div style="margin-top:10px;font-size:30px;font-weight:800;color:#23293f;">${escapeHtml(String(dashboard?.accountHealth?.score || 0))}/${escapeHtml(String(dashboard?.accountHealth?.total || 0))}</div>
                <div style="margin-top:6px;font-size:12px;color:#7c7fa1;">${escapeHtml(String(dashboard?.accountHealth?.outOfTargetCount || 0))} metrica(s) fora da meta</div>
                <div style="margin-top:14px;">
                  ${(Array.isArray(dashboard?.accountHealth?.metrics)
                    ? dashboard.accountHealth.metrics
                    : []
                  )
                    .map(
                      (metric, index) => `
                        <div style="border:1px solid ${metric?.ok ? "#d8f2e1" : "#f9d4dc"};border-radius:16px;padding:10px;box-sizing:border-box;background:${metric?.ok ? "#f4fcf7" : "#fff8fa"};${index > 0 ? "margin-top:10px;" : ""}">
                          <div style="font-size:11px;line-height:1.35;color:#7c7fa1;word-break:break-word;">${escapeHtml(metric?.label || "-")}</div>
                          <div style="margin-top:6px;font-size:18px;font-weight:800;line-height:1.25;color:#23293f;word-break:break-word;">${escapeHtml(metric?.valueLabel || "--")}</div>
                          <div style="margin-top:4px;font-size:11px;line-height:1.35;color:#7c7fa1;word-break:break-word;">${escapeHtml(metric?.targetLabel || "")}</div>
                        </div>
                      `,
                    )
                    .join("")}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div style="margin-top:14px;display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;">
          <div style="flex:1 1 450px;min-width:320px;border:1px solid #eadfff;border-radius:28px;padding:20px;background:linear-gradient(180deg,#ffffff 0%,#fcfbff 100%);">
            <div style="font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#7c7fa1;">Produtos em destaque</div>
            <div style="margin-top:10px;font-size:24px;font-weight:800;color:#23293f;">Mais vendidos nos ultimos 30 dias</div>
            <div style="margin-top:16px;">
              ${(Array.isArray(dashboard?.topProducts) ? dashboard.topProducts : [])
                .map(
                  (product, index) => `
                    <div style="display:flex;gap:14px;align-items:center;border:1px solid #e8e2f6;border-radius:18px;padding:14px;background:#ffffff;${index > 0 ? "margin-top:10px;" : ""}">
                      <div style="width:48px;height:48px;border-radius:16px;background:linear-gradient(135deg,#ece5ff,#d8c6ff);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#4c2f7d;flex:0 0 auto;">#${index + 1}</div>
                      <div style="min-width:0;">
                        <div style="font-size:15px;font-weight:800;color:#23293f;line-height:1.35;">${escapeHtml(product?.title || `Item ${product?.itemId || "-"}`)}</div>
                        <div style="margin-top:6px;font-size:13px;color:#7c7fa1;">${escapeHtml(String(product?.quantity || 0))} unidades vendidas &bull; ID ${escapeHtml(String(product?.itemId || "-"))}</div>
                      </div>
                    </div>
                  `,
                )
                .join("") || `<div style="border:1px dashed #e8e2f6;border-radius:18px;padding:18px;color:#7c7fa1;">Sem produtos com giro no recorte atual.</div>`}
            </div>
          </div>

          <div style="flex:0 0 280px;min-width:280px;border:1px solid #eadfff;border-radius:28px;padding:20px;background:linear-gradient(180deg,#ffffff 0%,#fcfbff 100%);">
            <div style="font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#7c7fa1;">Ads</div>
            <div style="margin-top:10px;font-size:24px;font-weight:800;color:#23293f;">Anuncios fora da meta</div>
            <div style="margin-top:14px;font-size:34px;font-weight:800;color:#23293f;">${escapeHtml(String(dashboard?.ads?.outsideTargetCount || 0))}</div>
            <div style="margin-top:8px;font-size:13px;line-height:1.6;color:#51607b;">
              ${
                Number(dashboard?.ads?.outsideTargetCount || 0) === 1 &&
                dashboard?.ads?.outsideTargetSingleItemId
                  ? `Ha 1 anuncio fora da meta. ID do anuncio fora: ${escapeHtml(String(dashboard.ads.outsideTargetSingleItemId))}.`
                  : `Ha ${escapeHtml(String(dashboard?.ads?.outsideTargetCount || 0))} anuncio(s) fora da meta neste momento.`
              }
            </div>
            <div style="margin-top:10px;font-size:13px;line-height:1.6;color:#51607b;">
              Fora da meta significa que o anuncio esta investindo acima do limite definido para eficiencia.
            </div>
            <div style="margin-top:12px;border:1px solid #efeaf9;border-radius:18px;padding:14px;background:#fbfaff;">
              <div style="font-size:12px;font-weight:800;color:#5b4c82;text-transform:uppercase;letter-spacing:.08em;">Meta usada</div>
              <div style="margin-top:8px;font-size:18px;font-weight:800;color:#23293f;">${escapeHtml(dashboard?.ads?.targetLabel || "--")}</div>
              <div style="margin-top:6px;font-size:12px;line-height:1.6;color:#7c7fa1;">${escapeHtml(dashboard?.ads?.targetExplanation || "")}</div>
            </div>
          </div>
        </div>
      </div>
    `
    : "";

  const operationsHtml =
    meta.hideOperations || dashboard
      ? ""
      : `
        <div style="margin-top:24px;">
          <div style="font-size:18px;font-weight:800;color:#ea580c;margin-bottom:10px;">Operacao de envio</div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;">
            <div style="flex:1 1 140px;border:1px solid #fdba74;border-radius:14px;padding:14px;text-align:center;">
              <div style="font-size:24px;font-weight:800;">${escapeHtml(String(report?.shipping?.overdue || 0))}</div>
              <div style="font-size:13px;color:#6b7280;">Envio atrasado</div>
            </div>
            <div style="flex:1 1 140px;border:1px solid #fdba74;border-radius:14px;padding:14px;text-align:center;">
              <div style="font-size:24px;font-weight:800;">${escapeHtml(String(report?.shipping?.today || 0))}</div>
              <div style="font-size:13px;color:#6b7280;">Enviar hoje</div>
            </div>
            <div style="flex:1 1 140px;border:1px solid #fdba74;border-radius:14px;padding:14px;text-align:center;">
              <div style="font-size:24px;font-weight:800;">${escapeHtml(String(report?.shipping?.week || 0))}</div>
              <div style="font-size:13px;color:#6b7280;">Enviar em 7 dias</div>
            </div>
            <div style="flex:1 1 140px;border:1px solid #fdba74;border-radius:14px;padding:14px;text-align:center;">
              <div style="font-size:24px;font-weight:800;">${escapeHtml(String(report?.shipping?.later || 0))}</div>
              <div style="font-size:13px;color:#6b7280;">Proximas datas</div>
            </div>
          </div>
        </div>
      `;

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#f7f5ff;padding:32px;color:#1f2937;">
      <div style="max-width:1080px;margin:0 auto;background:#ffffff;border-radius:28px;overflow:hidden;border:1px solid #e8def8;box-shadow:0 18px 40px rgba(91,76,130,.08);">
        <div style="background:linear-gradient(135deg,#6d28d9 0%,#a855f7 52%,#c084fc 100%);padding:26px 30px;color:#ffffff;">
          <div style="font-size:20px;font-weight:800;letter-spacing:.06em;margin-bottom:14px;">DACHBYTE Seller</div>
          <div style="font-size:30px;font-weight:800;line-height:1.08;">${escapeHtml(
            meta.title || "Confira seu resumo de vendas",
          )}</div>
          <div style="margin-top:8px;font-size:14px;opacity:.94;">
            Empresa: ${escapeHtml(companyName || "DACHBYTE Seller")} &bull; Periodo: ${escapeHtml(report?.period?.currentLabel || "-")}
          </div>
        </div>

        <div style="padding:28px;">
          <p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#475569;">
            Ola, ${escapeHtml(nome || "time")}. ${escapeHtml(
              meta.intro ||
                "Segue o resumo da sua operacao Shopee. O CSV completo com os pedidos do periodo esta em anexo.",
            )}
          </p>

          <div style="text-align:center;margin:10px 0 18px;">
            <span style="display:inline-block;background:#8b5cf6;color:#ffffff;font-weight:800;padding:10px 18px;border-radius:999px;">
              ${escapeHtml(meta.badgeLabel || "Resumo de vendas")}
            </span>
          </div>

          <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:18px;">
            <div style="flex:1 1 220px;border:1px solid #ddd6fe;border-radius:18px;padding:18px;text-align:center;background:#fcfbff;">
              <div style="font-size:30px;font-weight:800;color:#23293f;">${escapeHtml(String(report?.summary?.ordersCount || 0))}</div>
              <div style="font-size:14px;color:#6b7280;">${escapeHtml(
                meta.ordersLabel || "Pedidos no periodo",
              )}</div>
            </div>
            <div style="flex:1 1 220px;border:1px solid #ddd6fe;border-radius:18px;padding:18px;text-align:center;background:#fcfbff;">
              <div style="font-size:30px;font-weight:800;color:#23293f;">${escapeHtml(
                formatMoney(report?.summary?.gmvCents || 0),
              )}</div>
              <div style="font-size:14px;color:#6b7280;">${escapeHtml(
                meta.salesLabel || "GMV pago no periodo",
              )}</div>
            </div>
            <div style="flex:1 1 220px;border:1px solid #ddd6fe;border-radius:18px;padding:18px;text-align:center;background:#fcfbff;">
              <div style="font-size:26px;font-weight:800;color:#23293f;">${escapeHtml(
                report?.summary?.ordersGrowthLabel || "0%",
              )}</div>
              <div style="font-size:14px;color:#6b7280;">${escapeHtml(
                meta.ordersCompareLabel || "Pedidos vs periodo anterior",
              )}</div>
            </div>
            <div style="flex:1 1 220px;border:1px solid #ddd6fe;border-radius:18px;padding:18px;text-align:center;background:#fcfbff;">
              <div style="font-size:26px;font-weight:800;color:#23293f;">${escapeHtml(
                report?.summary?.salesGrowthLabel || "0%",
              )}</div>
              <div style="font-size:14px;color:#6b7280;">${escapeHtml(
                meta.salesCompareLabel || "GMV vs periodo anterior",
              )}</div>
            </div>
          </div>

          ${dashboardHtml}
          ${monthlyCardsHtml}
          ${monthlyComparisonHtml}
          ${operationsHtml}

          <div style="margin-top:28px;">
            <div style="font-size:18px;font-weight:800;color:#6d28d9;margin-bottom:10px;">${escapeHtml(
              meta.tableTitle || "Pedidos do periodo",
            )}</div>
            <div style="font-size:13px;color:#6b7280;margin-bottom:10px;">
              Exibindo ate 10 pedidos no email. O CSV anexo leva a lista completa do periodo.
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:13px;">
              <thead>
                <tr style="background:#f5f3ff;text-align:left;">
                  <th style="padding:10px 8px;border-bottom:1px solid #ddd6fe;">Pedido</th>
                  <th style="padding:10px 8px;border-bottom:1px solid #ddd6fe;">Status</th>
                  <th style="padding:10px 8px;border-bottom:1px solid #ddd6fe;">Shop</th>
                  <th style="padding:10px 8px;border-bottom:1px solid #ddd6fe;text-align:right;">GMV</th>
                  <th style="padding:10px 8px;border-bottom:1px solid #ddd6fe;">Criado em</th>
                </tr>
              </thead>
              <tbody>
                ${
                  ordersPreview ||
                  `<tr><td colspan="5" style="padding:14px 8px;color:#6b7280;">${escapeHtml(meta.emptyTableText || "Nenhum pedido encontrado no periodo.")}</td></tr>`
                }
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;
}

function buildPatchNotesHtml({ nome, patchNotes }) {
  const version = normalize(patchNotes?.version) || "Sem versao";
  const title = normalize(patchNotes?.title) || `Atualizacao ${version}`;
  const summary = normalize(patchNotes?.summary);
  const newFeatures = Array.isArray(patchNotes?.newFeatures)
    ? patchNotes.newFeatures.filter(Boolean)
    : [];
  const adjustments = Array.isArray(patchNotes?.adjustments)
    ? patchNotes.adjustments.filter(Boolean)
    : [];
  const releaseDate = new Date().toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  const renderParagraphs = (text) => {
    const paragraphs = String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (!paragraphs.length) {
      return `<p style="margin:0;font-size:15px;line-height:1.7;color:#475569;">Sem descricao adicional para esta versao.</p>`;
    }

    return paragraphs
      .map(
        (line) => `
          <p style="margin:0 0 12px;font-size:15px;line-height:1.7;color:#475569;">
            ${escapeHtml(line)}
          </p>
        `,
      )
      .join("");
  };

  const renderList = (items, tone) => {
    const palette =
      tone === "highlight"
        ? {
            border: "#fdba74",
            background: "#fff7ed",
            bullet: "#ea580c",
          }
        : {
            border: "#bfdbfe",
            background: "#eff6ff",
            bullet: "#2563eb",
          };

    if (!items.length) {
      return `
        <div style="border:1px dashed ${palette.border};border-radius:16px;padding:16px;background:${palette.background};color:#64748b;font-size:14px;">
          Nenhum item informado.
        </div>
      `;
    }

    return items
      .map(
        (item) => `
          <div style="display:flex;gap:12px;align-items:flex-start;padding:14px 16px;border:1px solid ${palette.border};border-radius:16px;background:${palette.background};margin-bottom:10px;">
            <div style="width:10px;height:10px;border-radius:999px;background:${palette.bullet};margin-top:7px;flex:0 0 auto;"></div>
            <div style="font-size:14px;line-height:1.6;color:#334155;">${escapeHtml(item)}</div>
          </div>
        `,
      )
      .join("");
  };

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#fff7f0;padding:32px 18px;color:#0f172a;">
      <div style="max-width:760px;margin:0 auto;background:#ffffff;border-radius:28px;overflow:hidden;border:1px solid #fed7c3;box-shadow:0 18px 40px rgba(15,23,42,.08);">
        <div style="background:linear-gradient(135deg,#ea580c 0%,#f97316 52%,#fb923c 100%);padding:28px;color:#ffffff;">
          <div style="font-size:20px;font-weight:800;letter-spacing:.06em;margin-bottom:20px;">DACHBYTE Seller</div>
          <div style="display:inline-block;padding:7px 12px;border-radius:999px;background:rgba(255,255,255,.18);font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">
            Patch Notes &bull; Versao ${escapeHtml(version)}
          </div>
          <h1 style="margin:18px 0 10px;font-size:30px;line-height:1.12;">${escapeHtml(title)}</h1>
          <p style="margin:0;font-size:14px;line-height:1.6;opacity:.96;">
            Ola, ${escapeHtml(nome || "time")}. Confira as novidades e ajustes liberados nesta atualizacao.
          </p>
        </div>

        <div style="padding:28px;">
          <div style="padding:18px 20px;border:1px solid #fed7aa;border-radius:20px;background:#fffaf5;">
            <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#c2410c;margin-bottom:10px;">Resumo da versao</div>
            ${renderParagraphs(summary)}
          </div>

          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-top:18px;">
            <div style="border:1px solid #fed7aa;border-radius:18px;padding:18px;background:#fff7ed;">
              <div style="font-size:13px;color:#9a3412;text-transform:uppercase;letter-spacing:.08em;font-weight:700;">Versao</div>
              <div style="margin-top:8px;font-size:26px;font-weight:800;color:#7c2d12;">${escapeHtml(version)}</div>
            </div>
            <div style="border:1px solid #bfdbfe;border-radius:18px;padding:18px;background:#eff6ff;">
              <div style="font-size:13px;color:#1d4ed8;text-transform:uppercase;letter-spacing:.08em;font-weight:700;">Data de envio</div>
              <div style="margin-top:8px;font-size:20px;font-weight:800;color:#1e3a8a;">${escapeHtml(releaseDate)}</div>
            </div>
          </div>

          <div style="margin-top:24px;">
            <div style="font-size:19px;font-weight:800;color:#9a3412;margin-bottom:12px;">Novas funcionalidades</div>
            ${renderList(newFeatures, "highlight")}
          </div>

          <div style="margin-top:24px;">
            <div style="font-size:19px;font-weight:800;color:#1d4ed8;margin-bottom:12px;">Ajustes e melhorias</div>
            ${renderList(adjustments, "neutral")}
          </div>

          <div style="margin-top:28px;padding-top:18px;border-top:1px solid #e2e8f0;font-size:13px;line-height:1.6;color:#64748b;">
            Esta mensagem foi enviada pela DACHBYTE Seller para comunicar atualizacoes da plataforma Shopee.
          </div>
        </div>
      </div>
    </div>
  `;
}

function buildSupportRequestText({
  subject,
  replyMode,
  phone,
  accountName,
  userName,
  loginEmail,
  shopLabel,
  activeShopId,
  message,
}) {
  return [
    "Ola time,",
    "",
    "Segue uma nova solicitacao aberta pelo painel Shopee.",
    "",
    `Assunto: ${normalize(subject) || "Duvidas"}`,
    `Preferencia de resposta: ${replyMode === "phone" ? "Celular" : "Email"}`,
    `Celular de retorno: ${normalize(phone) || "Nao informado"}`,
    "",
    "Contexto da conta:",
    `Conta: ${normalize(accountName) || "Conta sem nome"}`,
    `Nome: ${normalize(userName) || "Usuario"}`,
    `Email do login: ${normalize(loginEmail) || "Email nao identificado"}`,
    `Loja ativa: ${normalize(shopLabel) || "Nenhuma loja ativa"}`,
    `Shop ID ativo: ${normalize(activeShopId) || "Nao identificado"}`,
    "",
    "Mensagem:",
    normalize(message),
  ].join("\n");
}

function buildSupportRequestHtml({
  subject,
  replyMode,
  phone,
  accountName,
  userName,
  loginEmail,
  shopLabel,
  activeShopId,
  message,
}) {
  const rows = [
    ["Assunto", normalize(subject) || "Duvidas"],
    ["Preferencia de resposta", replyMode === "phone" ? "Celular" : "Email"],
    ["Celular de retorno", normalize(phone) || "Nao informado"],
    ["Conta", normalize(accountName) || "Conta sem nome"],
    ["Nome", normalize(userName) || "Usuario"],
    ["Email do login", normalize(loginEmail) || "Email nao identificado"],
    ["Loja ativa", normalize(shopLabel) || "Nenhuma loja ativa"],
    ["Shop ID ativo", normalize(activeShopId) || "Nao identificado"],
  ];

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#fff7f0;padding:32px;color:#1f2937;">
      <div style="max-width:720px;margin:0 auto;background:#ffffff;border-radius:24px;overflow:hidden;border:1px solid #fed7c3;box-shadow:0 18px 40px rgba(15,23,42,.08);">
        <div style="background:linear-gradient(135deg,#ea580c 0%,#f97316 52%,#fb923c 100%);padding:28px;color:#ffffff;">
          <div style="font-size:20px;font-weight:800;letter-spacing:.06em;margin-bottom:18px;">DACHBYTE Seller</div>
          <div style="display:inline-block;padding:7px 12px;border-radius:999px;background:rgba(255,255,255,.18);font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">
            Suporte Shopee
          </div>
          <h1 style="margin:18px 0 8px;font-size:30px;line-height:1.12;">${escapeHtml(
            normalize(subject) || "Nova solicitacao de suporte",
          )}</h1>
          <p style="margin:0;font-size:14px;line-height:1.6;opacity:.96;">
            Nova mensagem enviada automaticamente pelo modulo Suporte e FAQ.
          </p>
        </div>

        <div style="padding:28px;">
          <div style="border:1px solid #fed7aa;border-radius:20px;padding:18px;background:#fffaf5;">
            <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#c2410c;margin-bottom:12px;">Contexto enviado</div>
            <div style="display:grid;gap:10px;">
              ${rows
                .map(
                  ([label, value]) => `
                    <div style="display:grid;grid-template-columns:180px 1fr;gap:14px;align-items:start;">
                      <div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#9a3412;">${escapeHtml(label)}</div>
                      <div style="font-size:14px;line-height:1.6;color:#334155;">${escapeHtml(value)}</div>
                    </div>
                  `,
                )
                .join("")}
            </div>
          </div>

          <div style="margin-top:22px;border:1px solid #e2e8f0;border-radius:20px;padding:20px;background:#ffffff;">
            <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#475569;margin-bottom:12px;">Mensagem do cliente</div>
            <div style="font-size:15px;line-height:1.75;color:#334155;white-space:pre-wrap;">${escapeHtml(
              normalize(message),
            )}</div>
          </div>
        </div>
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
      subject: "Ative seu acesso DACHBYTE Seller Shopee",
      htmlContent: buildInviteHtml({
        nome: toName,
        activationLink,
        expiresAt,
      }),
      tags: ["invite-activation", "shopee-auth"],
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
      subject: "Redefina sua senha DACHBYTE Seller Shopee",
      htmlContent: buildPasswordResetHtml({
        nome: toName,
        resetLink,
        expiresAt,
      }),
      tags: ["password-reset", "shopee-auth"],
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

async function sendSalesSummaryEmail({
  toEmail,
  toName,
  companyName,
  report,
  attachment,
  subject,
  tags,
}) {
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
      subject:
        normalize(subject) ||
        `Resumo de vendas &bull; ${normalize(companyName) || "DACHBYTE Seller"}`,
      htmlContent: buildSalesSummaryHtmlV2({
        nome: toName,
        companyName,
        report,
      }),
      attachment: attachment ? [attachment] : undefined,
      tags:
        Array.isArray(tags) && tags.length
          ? tags
          : ["sales-summary", "shopee-report"],
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

function buildAddressAlertEmergencyHtml({ nome, companyName, report }) {
  const alerts = Array.isArray(report?.alerts) ? report.alerts : [];

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#fff5ef;padding:32px;color:#1f2937;">
      <div style="max-width:760px;margin:0 auto;background:#ffffff;border-radius:20px;padding:32px;border:1px solid #fed7c3;">
        <p style="margin:0 0 16px;font-size:14px;color:#ee4d2d;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">DACHBYTE Seller &bull; Emergencia operacional Shopee</p>
        <h1 style="margin:0 0 12px;font-size:32px;line-height:1.05;">Troca de endereco detectada em pedido pronto para envio</h1>
        <p style="margin:0 0 18px;font-size:16px;line-height:1.6;">
          Ola, ${escapeHtml(nome || "time")}. O sincronismo de pedidos detectou ${escapeHtml(String(alerts.length))} alerta(s) de possivel troca de endereco na operacao da empresa ${escapeHtml(companyName || "DACHBYTE Seller")}.
        </p>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin:20px 0 26px;">
          <div style="flex:1 1 180px;border:1px solid #fdba74;border-radius:16px;padding:16px;background:#fffaf5;">
            <div style="font-size:13px;color:#6b7280;">Empresa</div>
            <div style="margin-top:8px;font-size:20px;font-weight:800;color:#1f2937;">${escapeHtml(companyName || "DACHBYTE Seller")}</div>
          </div>
          <div style="flex:1 1 180px;border:1px solid #fdba74;border-radius:16px;padding:16px;background:#fffaf5;">
            <div style="font-size:13px;color:#6b7280;">Loja Shopee</div>
            <div style="margin-top:8px;font-size:20px;font-weight:800;color:#1f2937;">${escapeHtml(report?.shopShopeeId || "-")}</div>
          </div>
          <div style="flex:1 1 180px;border:1px solid #fdba74;border-radius:16px;padding:16px;background:#fffaf5;">
            <div style="font-size:13px;color:#6b7280;">Gerado em</div>
            <div style="margin-top:8px;font-size:20px;font-weight:800;color:#1f2937;">${escapeHtml(formatDateTime(report?.generatedAt))}</div>
          </div>
        </div>
        <div style="margin:0 0 22px;padding:16px 18px;border-radius:16px;background:#fff7ed;border:1px solid #fdba74;">
          <div style="font-size:14px;font-weight:800;color:#9a3412;margin-bottom:8px;">Acao recomendada</div>
          <div style="font-size:14px;line-height:1.6;color:#7c2d12;">
            Valide imediatamente a alteracao de endereco antes da expedicao, revise os dados do cliente e alinhe com a operacao para evitar erro logistico.
          </div>
        </div>
        ${alerts
          .map(
            (alert) => `
              <div style="border:1px solid #fed7c3;border-radius:18px;padding:18px;background:#ffffff;margin-top:14px;">
                <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;">
                  <div>
                    <div style="font-size:13px;color:#6b7280;">Pedido</div>
                    <div style="margin-top:4px;font-size:22px;font-weight:800;color:#1f2937;">${escapeHtml(alert?.orderSn || "-")}</div>
                  </div>
                  <div style="text-align:right;">
                    <div style="font-size:13px;color:#6b7280;">Detectado em</div>
                    <div style="margin-top:4px;font-size:14px;font-weight:700;color:#c2410c;">${escapeHtml(alert?.detectedAt || "-")}</div>
                  </div>
                </div>
                <div style="margin-top:16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;">
                  <div style="border:1px solid #e5e7eb;border-radius:14px;padding:14px;background:#f8fafc;">
                    <div style="font-size:13px;color:#6b7280;">Cliente</div>
                    <div style="margin-top:8px;font-size:15px;font-weight:700;color:#1f2937;">${escapeHtml(alert?.customerName || "Nao informado")}</div>
                    <div style="margin-top:6px;font-size:14px;color:#475569;">${escapeHtml(alert?.customerPhone || "Telefone nao informado")}</div>
                  </div>
                  <div style="border:1px solid #fecaca;border-radius:14px;padding:14px;background:#fff1f2;">
                    <div style="font-size:13px;color:#9f1239;">Endereco anterior</div>
                    <div style="margin-top:8px;font-size:14px;line-height:1.6;color:#4c0519;white-space:pre-line;">${escapeHtml(alert?.oldAddress || "Nao havia snapshot anterior disponivel.")}</div>
                  </div>
                  <div style="border:1px solid #fdba74;border-radius:14px;padding:14px;background:#fff7ed;">
                    <div style="font-size:13px;color:#9a3412;">Novo endereco</div>
                    <div style="margin-top:8px;font-size:14px;line-height:1.6;color:#7c2d12;white-space:pre-line;">${escapeHtml(alert?.newAddress || "Endereco novo nao informado.")}</div>
                  </div>
                </div>
              </div>
            `,
          )
          .join("")}
      </div>
    </div>
  `;
}

function buildAddressAlertEmergencyText({ companyName, report }) {
  const alerts = Array.isArray(report?.alerts) ? report.alerts : [];

  return [
    "DACHBYTE SELLER | EMERGENCIA OPERACIONAL SHOPEE",
    "",
    `Empresa: ${companyName || "DACHBYTE Seller"}`,
    `Loja Shopee: ${report?.shopShopeeId || "-"}`,
    `Gerado em: ${formatDateTime(report?.generatedAt)}`,
    `Alertas detectados: ${alerts.length}`,
    "",
    "Acao recomendada: validar imediatamente a alteracao de endereco antes da expedicao.",
    "",
    ...alerts.flatMap((alert, index) => [
      `Alerta ${index + 1}`,
      `Pedido: ${alert?.orderSn || "-"}`,
      `Detectado em: ${alert?.detectedAt || "-"}`,
      `Cliente: ${alert?.customerName || "Nao informado"}`,
      `Telefone: ${alert?.customerPhone || "Telefone nao informado"}`,
      "Endereco anterior:",
      alert?.oldAddress || "Nao havia snapshot anterior disponivel.",
      "Novo endereco:",
      alert?.newAddress || "Endereco novo nao informado.",
      "",
    ]),
  ].join("\n");
}

async function sendAddressAlertEmergencyEmail({
  toEmail,
  toName,
  companyName,
  report,
  subject,
  tags,
}) {
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
      subject:
        normalize(subject) ||
        `EMERGENCIA Shopee - Troca de endereco detectada - ${normalize(companyName) || "DACHBYTE Seller"}`,
      htmlContent: buildAddressAlertEmergencyHtml({
        nome: toName,
        companyName,
        report,
      }),
      textContent: buildAddressAlertEmergencyText({
        companyName,
        report,
      }),
      tags:
        Array.isArray(tags) && tags.length
          ? tags
          : ["address-alert", "emergency", "shopee-sync"],
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

async function sendPatchNotesEmail({
  toEmail,
  toName,
  patchNotes,
  subject,
  tags,
}) {
  if (!isConfigured()) {
    return {
      sent: false,
      skipped: true,
      reason: "Brevo nao configurado.",
    };
  }

  const version = normalize(patchNotes?.version);
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
      subject:
        normalize(subject) ||
        `Patch Notes DACHBYTE Seller${version ? ` &bull; Versao ${version}` : ""}`,
      htmlContent: buildPatchNotesHtml({
        nome: toName,
        patchNotes,
      }),
      tags:
        Array.isArray(tags) && tags.length
          ? tags
          : ["patch-notes", "release-notes"],
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

async function sendSupportRequestEmail({
  toEmail,
  requesterEmail,
  requesterName,
  subject,
  replyMode,
  phone,
  accountName,
  userName,
  loginEmail,
  shopLabel,
  activeShopId,
  message,
  tags,
}) {
  if (!isConfigured()) {
    return {
      sent: false,
      skipped: true,
      reason: "Brevo nao configurado.",
    };
  }

  const normalizedSubject =
    normalize(subject) || "Nova solicitacao de suporte Shopee";

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
          name: "Suporte DACHBYTE",
        },
      ],
      replyTo: normalize(requesterEmail)
        ? {
            email: normalize(requesterEmail),
            name: normalize(requesterName) || normalize(userName) || undefined,
          }
        : undefined,
      subject: normalizedSubject,
      htmlContent: buildSupportRequestHtml({
        subject,
        replyMode,
        phone,
        accountName,
        userName,
        loginEmail,
        shopLabel,
        activeShopId,
        message,
      }),
      textContent: buildSupportRequestText({
        subject,
        replyMode,
        phone,
        accountName,
        userName,
        loginEmail,
        shopLabel,
        activeShopId,
        message,
      }),
      tags:
        Array.isArray(tags) && tags.length
          ? tags
          : ["support-request", "shopee-support"],
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
  buildPatchNotesHtml,
  isConfigured,
  sendAddressAlertEmergencyEmail,
  sendInviteEmail,
  sendPatchNotesEmail,
  sendPasswordResetEmail,
  sendSalesSummaryEmail,
  sendSupportRequestEmail,
};
