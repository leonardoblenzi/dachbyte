"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncReportService = void 0;
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const orderStatus_1 = require("../types/orderStatus");
const emailTransportService_1 = require("./emailTransportService");
const db_1 = require("../lib/db");
const publicBaseUrl_1 = require("../utils/publicBaseUrl");
const APP_LOGO_URL = 'https://res.cloudinary.com/dhqxp3tuo/image/upload/v1771249579/ChatGPT_Image_13_de_fev._de_2026_16_40_14_kldj3k.png';
const STATUS_LABELS = {
    PENDING: 'Pendente',
    CREATED: 'Criado',
    SHIPPED: 'Em transito',
    DELIVERY_ATTEMPT: 'Em rota',
    DELIVERED: 'Entregue',
    FAILURE: 'Falha na entrega',
    RETURNED: 'Devolvido',
    CANCELED: 'Cancelado',
    CHANNEL_LOGISTICS: 'Logistica do canal',
};
const escapeHtml = (value) => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const escapeCsv = (value) => {
    const text = String(value ?? '');
    if (/[",;\n]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
};
const RELEVANT_TRACKING_STATUSES = [
    orderStatus_1.OrderStatus.SHIPPED,
    orderStatus_1.OrderStatus.DELIVERY_ATTEMPT,
    orderStatus_1.OrderStatus.DELIVERED,
    orderStatus_1.OrderStatus.FAILURE,
];
const isRelevantTrackingChange = (change) => change.enteredDelivered ||
    change.enteredDelay ||
    change.enteredFailure ||
    change.enteredRoute ||
    (change.previousStatus !== change.currentStatus &&
        RELEVANT_TRACKING_STATUSES.includes(change.currentStatus));
const formatDateTime = (value) => value ? new Date(value).toLocaleString('pt-BR') : '-';
const formatDateOnly = (value) => value ? new Date(value).toLocaleDateString('pt-BR') : '-';
const getReportsDir = (scope = 'sync') => path_1.default.join(__dirname, `../../public/reports/${scope}`);
const buildMetricBars = (metrics) => {
    const maxValue = Math.max(1, ...metrics.map((metric) => metric.value));
    return metrics
        .map((metric) => {
        const width = Math.max(8, Math.round((metric.value / maxValue) * 100));
        return `
        <div style="margin-bottom:14px;">
          <div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:6px;font-size:13px;color:#334155;">
            <span>${escapeHtml(metric.label)}</span>
            <strong>${metric.value}</strong>
          </div>
          <div style="height:10px;border-radius:999px;background:#e2e8f0;overflow:hidden;">
            <div style="width:${width}%;height:100%;border-radius:999px;background:${metric.color};"></div>
          </div>
        </div>
      `;
    })
        .join('');
};
const buildOrderCardHtml = (change) => {
    const trackingEventsHtml = change.trackingEvents.length > 0
        ? change.trackingEvents
            .map((event) => `
              <tr>
                <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(event.status)}</td>
                <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(event.description)}</td>
                <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(formatDateTime(event.eventDate))}</td>
                <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml([event.city, event.state].filter(Boolean).join(' / ') || '-')}</td>
              </tr>
            `)
            .join('')
        : `
        <tr>
          <td colspan="4" style="padding:10px;border-bottom:1px solid #e2e8f0;color:#64748b;">
            Nenhuma movimentacao detalhada retornada pela sincronizacao.
          </td>
        </tr>
      `;
    return `
    <section style="border:1px solid #dbeafe;border-radius:18px;background:#ffffff;padding:20px;margin-bottom:18px;box-shadow:0 10px 30px rgba(15,23,42,0.06);">
      <div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap;">
        <div>
          <h3 style="margin:0 0 6px;font-size:20px;color:#0f172a;">Pedido #${escapeHtml(change.orderNumber)}</h3>
          <p style="margin:0;font-size:14px;color:#475569;">
            ${escapeHtml(change.customerName)}${change.trackingCode ? ` • Rastreio ${escapeHtml(change.trackingCode)}` : ''}
          </p>
        </div>
        <div style="text-align:right;font-size:12px;color:#64748b;">
          <div>Transportadora: <strong style="color:#0f172a;">${escapeHtml(change.freightType || '-')}</strong></div>
          <div>Ultimo sync: <strong style="color:#0f172a;">${escapeHtml(formatDateTime(change.lastApiSync))}</strong></div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:18px;">
        <div style="border:1px solid #e2e8f0;border-radius:14px;padding:14px;background:#f8fafc;">
          <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#64748b;">Status</div>
          <div style="margin-top:8px;font-size:14px;color:#334155;">${escapeHtml(STATUS_LABELS[change.previousStatus])} → <strong>${escapeHtml(STATUS_LABELS[change.currentStatus])}</strong></div>
        </div>
        <div style="border:1px solid #e2e8f0;border-radius:14px;padding:14px;background:#f8fafc;">
          <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#64748b;">Atraso</div>
          <div style="margin-top:8px;font-size:14px;color:#334155;">${change.previousIsDelayed ? 'Em atraso' : 'No prazo'} → <strong>${change.currentIsDelayed ? 'Em atraso' : 'No prazo'}</strong></div>
        </div>
        <div style="border:1px solid #e2e8f0;border-radius:14px;padding:14px;background:#f8fafc;">
          <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#64748b;">Previsao</div>
          <div style="margin-top:8px;font-size:14px;color:#334155;">${escapeHtml(formatDateOnly(change.previousEstimatedDeliveryDate))} → <strong>${escapeHtml(formatDateOnly(change.currentEstimatedDeliveryDate))}</strong></div>
        </div>
      </div>
      <div style="margin-top:18px;padding:14px 16px;border-radius:14px;background:#eff6ff;border:1px solid #bfdbfe;">
        <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#1d4ed8;font-weight:700;">Resumo da alteracao</div>
        <p style="margin:8px 0 0;font-size:14px;line-height:1.7;color:#1e293b;">
          ${change.errorMessage ? `Erro: ${escapeHtml(change.errorMessage)}.` : change.changed ? 'Houve alteracao relevante neste pedido durante a sincronizacao.' : 'O pedido foi consultado, mas sem alteracao relevante de status, prazo ou atraso.'}
          ${change.enteredDelivered ? ' Entrou em entregue.' : ''}
          ${change.enteredDelay ? ' Entrou em atraso.' : ''}
          ${change.enteredFailure ? ' Entrou em falha na entrega.' : ''}
          ${change.enteredRoute ? ' Entrou em rota.' : ''}
          ${change.latestTrackingDescription ? ` Ultima movimentacao: ${escapeHtml(change.latestTrackingDescription)}.` : ''}
        </p>
      </div>
      <div style="margin-top:18px;">
        <h4 style="margin:0 0 10px;font-size:15px;color:#0f172a;">Movimentacoes de rastreio</h4>
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:13px;color:#334155;">
          <thead>
            <tr style="background:#f8fafc;color:#475569;">
              <th align="left" style="padding:10px;border-bottom:1px solid #e2e8f0;">Status</th>
              <th align="left" style="padding:10px;border-bottom:1px solid #e2e8f0;">Descricao</th>
              <th align="left" style="padding:10px;border-bottom:1px solid #e2e8f0;">Data</th>
              <th align="left" style="padding:10px;border-bottom:1px solid #e2e8f0;">Local</th>
            </tr>
          </thead>
          <tbody>
            ${trackingEventsHtml}
          </tbody>
        </table>
      </div>
    </section>
  `;
};
const buildCsvContent = (payload, metadata) => {
    const lines = [
        ['Empresa', metadata.companyName],
        [
            'Tipo de sincronizacao',
            metadata.trigger === 'automatic' ? 'Automatica' : 'Manual',
        ],
        ['Inicio', metadata.startedAt],
        ['Fim', metadata.finishedAt],
        ['Relatorio web', metadata.reportUrl],
        ['CSV', metadata.csvUrl],
        [],
        ['Resumo', 'Antes', 'Depois', 'Variacao'],
        [
            'Entregues',
            payload.before.delivered,
            payload.after.delivered,
            payload.after.delivered - payload.before.delivered,
        ],
        [
            'Em rota',
            payload.before.onRoute,
            payload.after.onRoute,
            payload.after.onRoute - payload.before.onRoute,
        ],
        [
            'Em atraso',
            payload.before.delayed,
            payload.after.delayed,
            payload.after.delayed - payload.before.delayed,
        ],
        [
            'Falhas',
            payload.before.failure,
            payload.after.failure,
            payload.after.failure - payload.before.failure,
        ],
        [
            'Total monitorado',
            payload.before.totalTracked,
            payload.after.totalTracked,
            payload.after.totalTracked - payload.before.totalTracked,
        ],
        [],
        [
            'Pedido',
            'Cliente',
            'Rastreio',
            'Transportadora',
            'Status anterior',
            'Status atual',
            'Atraso anterior',
            'Atraso atual',
            'Previsao anterior',
            'Previsao atual',
            'Entrou entregue',
            'Entrou atraso',
            'Nova falha',
            'Entrou rota',
            'Alterou',
            'Erro',
            'Ultimo status rastreio',
            'Ultima descricao rastreio',
            'Data evento',
            'Status evento',
            'Descricao evento',
            'Cidade evento',
            'UF evento',
        ],
    ];
    for (const change of payload.changes) {
        const events = change.trackingEvents.length > 0 ? change.trackingEvents : [null];
        for (const event of events) {
            lines.push([
                change.orderNumber,
                change.customerName,
                change.trackingCode || '',
                change.freightType || '',
                STATUS_LABELS[change.previousStatus],
                STATUS_LABELS[change.currentStatus],
                change.previousIsDelayed ? 'Sim' : 'Nao',
                change.currentIsDelayed ? 'Sim' : 'Nao',
                formatDateOnly(change.previousEstimatedDeliveryDate),
                formatDateOnly(change.currentEstimatedDeliveryDate),
                change.enteredDelivered ? 'Sim' : 'Nao',
                change.enteredDelay ? 'Sim' : 'Nao',
                change.enteredFailure ? 'Sim' : 'Nao',
                change.enteredRoute ? 'Sim' : 'Nao',
                change.changed ? 'Sim' : 'Nao',
                change.errorMessage || '',
                change.latestTrackingStatus || '',
                change.latestTrackingDescription || '',
                event ? formatDateTime(event.eventDate) : '',
                event?.status || '',
                event?.description || '',
                event?.city || '',
                event?.state || '',
            ]);
        }
    }
    return lines
        .map((line) => line.map((value) => escapeCsv(value)).join(';'))
        .join('\n');
};
const buildReportHtml = (payload, metadata) => {
    const changedOrders = payload.changes.filter((change) => change.changed || change.errorMessage);
    const enteredDelivered = payload.changes.filter((change) => change.enteredDelivered).length;
    const enteredDelay = payload.changes.filter((change) => change.enteredDelay).length;
    const enteredFailure = payload.changes.filter((change) => change.enteredFailure).length;
    const enteredRoute = payload.changes.filter((change) => change.enteredRoute).length;
    const bars = buildMetricBars([
        { label: 'Entregues na sincronizacao', value: enteredDelivered, color: '#10b981' },
        { label: 'Em rota agora', value: payload.after.onRoute, color: '#2563eb' },
        { label: 'Entraram em atraso', value: enteredDelay, color: '#f59e0b' },
        { label: 'Novas falhas', value: enteredFailure, color: '#ef4444' },
        { label: 'Entraram em rota', value: enteredRoute, color: '#7c3aed' },
    ]);
    const orderCards = changedOrders.length > 0
        ? changedOrders.map((change) => buildOrderCardHtml(change)).join('')
        : `
        <section style="border:1px dashed #cbd5e1;border-radius:18px;padding:26px;background:#ffffff;text-align:center;color:#64748b;">
          Nenhuma alteracao relevante de status, atraso ou falha foi detectada nesta sincronizacao.
        </section>
      `;
    const errorsSection = payload.errors.length > 0
        ? `
        <section style="margin-top:22px;border:1px solid #fecaca;background:#fef2f2;border-radius:18px;padding:20px;">
          <h3 style="margin:0 0 12px;color:#b91c1c;">Erros encontrados</h3>
          <ul style="margin:0;padding-left:18px;color:#7f1d1d;line-height:1.7;">
            ${payload.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}
          </ul>
        </section>
      `
        : '';
    return `
<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Relatorio de sincronizacao - ${escapeHtml(metadata.companyName)}</title>
  </head>
  <body style="margin:0;background:#eff6ff;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <div style="padding:32px 16px;background:radial-gradient(circle at top,#1d4ed8 0%,#0f172a 55%);">
      <div style="max-width:1120px;margin:0 auto;">
        <div style="background:#ffffff;border-radius:28px;padding:30px 32px;box-shadow:0 30px 90px rgba(15,23,42,0.28);">
          <div style="display:flex;justify-content:space-between;gap:20px;align-items:flex-start;flex-wrap:wrap;">
            <div style="flex:1;min-width:0;">
              <p style="margin:0;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#2563eb;font-weight:700;">
                Relatorio de sincronizacao ${metadata.trigger === 'automatic' ? 'automatica' : 'manual'}
              </p>
              <h1 style="margin:10px 0 0;font-size:34px;line-height:1.15;color:#0f172a;">
                ${escapeHtml(metadata.companyName)}
              </h1>
              <p style="margin:10px 0 0;color:#475569;line-height:1.7;max-width:760px;">
                Relatorio completo da ultima sincronizacao com resumo executivo, graficos de acompanhamento e detalhamento de cada pedido que mudou de status, entrou em atraso, em rota ou apresentou falha.
              </p>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:14px;">
              <img src="${APP_LOGO_URL}" alt="Avantracking" style="width:112px;max-width:112px;height:auto;display:block;" />
              <div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:flex-end;">
              <a href="${metadata.reportUrl}" style="display:inline-block;padding:14px 20px;border-radius:999px;background:#0f172a;color:#ffffff;text-decoration:none;font-weight:700;">
                Abrir relatorio
              </a>
              <a href="${metadata.csvUrl}" style="display:inline-block;padding:14px 20px;border-radius:999px;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;">
                Baixar CSV
              </a>
              </div>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-top:28px;">
            <div style="padding:18px;border-radius:18px;background:#eff6ff;border:1px solid #bfdbfe;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#1d4ed8;font-weight:700;">Inicio</div><div style="margin-top:8px;font-size:15px;color:#0f172a;">${escapeHtml(metadata.startedAt)}</div></div>
            <div style="padding:18px;border-radius:18px;background:#eff6ff;border:1px solid #bfdbfe;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#1d4ed8;font-weight:700;">Fim</div><div style="margin-top:8px;font-size:15px;color:#0f172a;">${escapeHtml(metadata.finishedAt)}</div></div>
            <div style="padding:18px;border-radius:18px;background:#eff6ff;border:1px solid #bfdbfe;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#1d4ed8;font-weight:700;">Processados</div><div style="margin-top:8px;font-size:15px;color:#0f172a;">${payload.total}</div></div>
            <div style="padding:18px;border-radius:18px;background:#eff6ff;border:1px solid #bfdbfe;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#1d4ed8;font-weight:700;">Com alteracoes</div><div style="margin-top:8px;font-size:15px;color:#0f172a;">${changedOrders.length}</div></div>
          </div>
          <section style="display:grid;grid-template-columns:minmax(0,1.1fr) minmax(320px,0.9fr);gap:20px;margin-top:26px;align-items:start;">
            <div style="border:1px solid #dbeafe;border-radius:22px;padding:22px;background:#f8fbff;">
              <h2 style="margin:0 0 18px;font-size:20px;color:#0f172a;">Grafico de indicadores</h2>
              ${bars}
            </div>
            <div style="border:1px solid #dbeafe;border-radius:22px;padding:22px;background:#f8fbff;">
              <h2 style="margin:0 0 18px;font-size:20px;color:#0f172a;">Comparativo da ultima para a atual</h2>
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:14px;">
                <thead><tr style="color:#64748b;"><th align="left" style="padding:0 0 10px;">Indicador</th><th align="right" style="padding:0 0 10px;">Antes</th><th align="right" style="padding:0 0 10px;">Atual</th><th align="right" style="padding:0 0 10px;">Delta</th></tr></thead>
                <tbody>
                  <tr><td style="padding:8px 0;border-top:1px solid #dbeafe;">Entregues</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.before.delivered}</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.after.delivered}</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.after.delivered - payload.before.delivered}</td></tr>
                  <tr><td style="padding:8px 0;border-top:1px solid #dbeafe;">Em rota</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.before.onRoute}</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.after.onRoute}</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.after.onRoute - payload.before.onRoute}</td></tr>
                  <tr><td style="padding:8px 0;border-top:1px solid #dbeafe;">Em atraso</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.before.delayed}</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.after.delayed}</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.after.delayed - payload.before.delayed}</td></tr>
                  <tr><td style="padding:8px 0;border-top:1px solid #dbeafe;">Falhas</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.before.failure}</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.after.failure}</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.after.failure - payload.before.failure}</td></tr>
                  <tr><td style="padding:8px 0;border-top:1px solid #dbeafe;">Monitorados</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.before.totalTracked}</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.after.totalTracked}</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.after.totalTracked - payload.before.totalTracked}</td></tr>
                </tbody>
              </table>
            </div>
          </section>
          ${errorsSection}
          <section style="margin-top:28px;">
            <h2 style="margin:0 0 18px;font-size:22px;color:#0f172a;">Detalhamento por pedido</h2>
            ${orderCards}
          </section>
        </div>
      </div>
    </div>
  </body>
</html>
  `;
};
const buildEmailHtml = (payload, metadata) => {
    const enteredDelivered = payload.changes.filter((change) => change.enteredDelivered).length;
    const enteredDelay = payload.changes.filter((change) => change.enteredDelay).length;
    const enteredFailure = payload.changes.filter((change) => change.enteredFailure).length;
    const enteredRoute = payload.changes.filter((change) => change.enteredRoute).length;
    const highlights = payload.changes
        .filter((change) => isRelevantTrackingChange(change))
        .slice(0, 8);
    const metrics = [
        { label: 'Entregues', value: enteredDelivered, color: '#10b981' },
        { label: 'Em rota', value: payload.after.onRoute, color: '#2563eb' },
        { label: 'Entraram em atraso', value: enteredDelay, color: '#f59e0b' },
        { label: 'Novas falhas', value: enteredFailure, color: '#ef4444' },
        { label: 'Entraram em rota', value: enteredRoute, color: '#7c3aed' },
    ];
    return `
<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Relatorio de sincronizacao</title>
  </head>
  <body style="margin:0;padding:0;background:#0b1220;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <div style="padding:28px 16px;background:radial-gradient(circle at top,#1d4ed8 0%,#0b1220 58%);">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:760px;margin:0 auto;">
        <tr>
          <td>
            <div style="background:#ffffff;border-radius:24px;overflow:hidden;border:1px solid #dbeafe;box-shadow:0 24px 70px rgba(15,23,42,0.35);">
              <div style="padding:28px 32px 18px;background:linear-gradient(135deg,#0f172a 0%,#1d4ed8 100%);">
                <div style="text-align:right;margin-bottom:12px;">
                  <img src="${APP_LOGO_URL}" alt="Avantracking" style="width:112px;max-width:112px;height:auto;display:inline-block;" />
                </div>
                <div style="flex:1;min-width:0;">
                  <p style="margin:0;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#bfdbfe;">
                    Relatorio ${metadata.trigger === 'automatic' ? 'automatico' : 'manual'} de sincronizacao
                  </p>
                  <h1 style="margin:10px 0 0;font-size:30px;line-height:1.15;color:#ffffff;">
                    ${escapeHtml(metadata.companyName)}
                  </h1>
                  <p style="margin:12px 0 0;font-size:14px;line-height:1.7;color:#dbeafe;">
                    Sincronizacao finalizada em ${escapeHtml(metadata.finishedAt)} com ${payload.success} sucesso(s) e ${payload.failed} falha(s).
                  </p>
                </div>
              </div>
              <div style="padding:28px 32px;">
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;">
                  ${metrics
        .map((metric) => `
                        <div style="border:1px solid #e2e8f0;border-radius:18px;padding:16px;background:#f8fafc;">
                          <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#64748b;">${escapeHtml(metric.label)}</div>
                          <div style="margin-top:8px;font-size:26px;font-weight:700;color:${metric.color};">${metric.value}</div>
                        </div>
                      `)
        .join('')}
                </div>
                <div style="margin-top:24px;padding:20px;border:1px solid #dbeafe;border-radius:18px;background:#f8fbff;">
                  <h2 style="margin:0 0 14px;font-size:18px;color:#0f172a;">Grafico resumido</h2>
                  ${buildMetricBars(metrics)}
                </div>
                <div style="margin-top:24px;padding:20px;border:1px solid #dbeafe;border-radius:18px;background:#f8fbff;">
                  <h2 style="margin:0 0 12px;font-size:18px;color:#0f172a;">Comparativo da ultima para a atual</h2>
                  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:14px;">
                    <tbody>
                      <tr><td style="padding:8px 0;border-top:1px solid #dbeafe;">Entregues</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.before.delivered}</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.after.delivered}</td></tr>
                      <tr><td style="padding:8px 0;border-top:1px solid #dbeafe;">Em rota</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.before.onRoute}</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.after.onRoute}</td></tr>
                      <tr><td style="padding:8px 0;border-top:1px solid #dbeafe;">Em atraso</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.before.delayed}</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.after.delayed}</td></tr>
                      <tr><td style="padding:8px 0;border-top:1px solid #dbeafe;">Falhas</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.before.failure}</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.after.failure}</td></tr>
                    </tbody>
                  </table>
                </div>
                <div style="margin-top:24px;">
                  <h2 style="margin:0 0 12px;font-size:18px;color:#0f172a;">Pedidos com movimentacao relevante</h2>
                  ${highlights.length > 0
        ? highlights
            .map((change) => `
                              <div style="border:1px solid #e2e8f0;border-radius:16px;padding:16px;margin-bottom:12px;background:#ffffff;">
                                <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;">
                                  <strong style="color:#0f172a;">Pedido #${escapeHtml(change.orderNumber)}</strong>
                                  <span style="color:#475569;">${escapeHtml(STATUS_LABELS[change.previousStatus])} → ${escapeHtml(STATUS_LABELS[change.currentStatus])}</span>
                                </div>
                                <p style="margin:8px 0 0;font-size:13px;line-height:1.6;color:#475569;">
                                  ${escapeHtml(change.customerName)}${change.trackingCode ? ` • Rastreio ${escapeHtml(change.trackingCode)}` : ''}${change.latestTrackingDescription ? ` • Ultima movimentacao: ${escapeHtml(change.latestTrackingDescription)}` : ''}${change.errorMessage ? ` • Erro: ${escapeHtml(change.errorMessage)}` : ''}
                                </p>
                              </div>
                            `)
            .join('')
        : '<p style="margin:0;color:#64748b;">Nenhum pedido teve alteracao relevante nesta sincronizacao.</p>'}
                </div>
                <div style="margin-top:28px;text-align:center;">
                  <a href="${metadata.reportUrl}" style="display:inline-block;padding:15px 24px;border-radius:999px;background:linear-gradient(135deg,#2563eb 0%,#0f172a 100%);color:#ffffff;text-decoration:none;font-weight:700;margin-right:8px;">
                    Abrir relatorio completo
                  </a>
                  <a href="${metadata.csvUrl}" style="display:inline-block;padding:15px 24px;border-radius:999px;background:#eff6ff;color:#1d4ed8;text-decoration:none;font-weight:700;border:1px solid #bfdbfe;">
                    Baixar CSV detalhado
                  </a>
                </div>
              </div>
            </div>
          </td>
        </tr>
      </table>
    </div>
  </body>
</html>
  `;
};
const buildEmailText = (payload, metadata) => {
    const enteredDelivered = payload.changes.filter((change) => change.enteredDelivered).length;
    const enteredDelay = payload.changes.filter((change) => change.enteredDelay).length;
    const enteredFailure = payload.changes.filter((change) => change.enteredFailure).length;
    const enteredRoute = payload.changes.filter((change) => change.enteredRoute).length;
    return [
        `Relatorio ${metadata.trigger === 'automatic' ? 'automatico' : 'manual'} de sincronizacao - ${metadata.companyName}`,
        `Inicio: ${metadata.startedAt}`,
        `Fim: ${metadata.finishedAt}`,
        `Processados: ${payload.total}`,
        `Sucessos: ${payload.success}`,
        `Falhas: ${payload.failed}`,
        '',
        `Entregues na sincronizacao: ${enteredDelivered}`,
        `Em rota agora: ${payload.after.onRoute}`,
        `Entraram em atraso: ${enteredDelay}`,
        `Novas falhas: ${enteredFailure}`,
        `Entraram em rota: ${enteredRoute}`,
        '',
        `Relatorio completo: ${metadata.reportUrl}`,
        `CSV detalhado: ${metadata.csvUrl}`,
    ].join('\n');
};
const formatCurrency = (value) => new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
}).format(Number(value || 0));
const summarizeByLabel = (labels) => {
    const counts = new Map();
    for (const rawLabel of labels) {
        const label = String(rawLabel || '').trim();
        if (!label)
            continue;
        counts.set(label, (counts.get(label) || 0) + 1);
    }
    return Array.from(counts.entries())
        .map(([label, count]) => ({ label, count }))
        .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
};
const normalizeUpdateLabel = (label) => {
    const trimmed = String(label || '').trim();
    if (!trimmed)
        return '';
    const detailsIndex = trimmed.indexOf(' (');
    return detailsIndex > 0 ? trimmed.slice(0, detailsIndex) : trimmed;
};
const normalizeSkippedReason = (reason) => {
    const normalized = String(reason || '').trim();
    if (!normalized)
        return '';
    if (normalized.toLowerCase().startsWith('erro na importacao')) {
        return 'Erro na importacao';
    }
    return normalized;
};
const summarizeUpdatedOrders = (orders) => summarizeByLabel(orders.flatMap((order) => Array.isArray(order.updateSummary)
    ? order.updateSummary.map((entry) => normalizeUpdateLabel(entry))
    : []));
const summarizeSkippedOrders = (orders) => summarizeByLabel(orders.map((order) => normalizeSkippedReason(order.reason)));
const buildSummaryListHtml = (items, options) => {
    const maxItems = options?.maxItems ?? 4;
    const marginTop = options?.marginTop ?? 8;
    const listColor = options?.listColor || '#475569';
    const emptyColor = options?.emptyColor || '#64748b';
    const emptyMessage = options?.emptyMessage || 'Sem ocorrencias para esta sincronizacao.';
    if (items.length === 0) {
        return `<p style="margin:${marginTop}px 0 0;font-size:12px;line-height:1.5;color:${emptyColor};">${escapeHtml(emptyMessage)}</p>`;
    }
    return `
    <ul style="margin:${marginTop}px 0 0;padding-left:18px;font-size:12px;line-height:1.55;color:${listColor};">
      ${items
        .slice(0, maxItems)
        .map((item) => `<li>${escapeHtml(item.label)}: <strong>${item.count}</strong> pedido(s)</li>`)
        .join('')}
    </ul>
  `;
};
const buildSummaryText = (items, emptyMessage, maxItems = 4) => {
    if (items.length === 0) {
        return emptyMessage;
    }
    return items
        .slice(0, maxItems)
        .map((item) => `${item.label} (${item.count})`)
        .join(', ');
};
const buildTraySkippedRowsHtml = (orders) => {
    if (orders.length === 0) {
        return `
      <section style="margin-top:24px;border:1px dashed #fcd34d;border-radius:18px;padding:20px;background:#ffffff;">
        <h3 style="margin:0 0 8px;font-size:18px;color:#0f172a;">Pedidos ignorados</h3>
        <p style="margin:0;color:#64748b;">Nenhum pedido foi ignorado nesta sincronizacao.</p>
      </section>
    `;
    }
    return `
    <section style="margin-top:24px;border:1px solid #fde68a;border-radius:18px;padding:20px;background:#ffffff;">
      <h3 style="margin:0 0 14px;font-size:18px;color:#0f172a;">Pedidos ignorados</h3>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:13px;color:#334155;">
        <thead>
          <tr style="background:#fffbeb;color:#92400e;">
            <th align="left" style="padding:10px;border-bottom:1px solid #fde68a;">Pedido</th>
            <th align="left" style="padding:10px;border-bottom:1px solid #fde68a;">Motivo</th>
          </tr>
        </thead>
        <tbody>
          ${orders
        .map((order) => `
                <tr>
                  <td style="padding:8px 10px;border-bottom:1px solid #fde68a;">#${escapeHtml(order.orderNumber)}</td>
                  <td style="padding:8px 10px;border-bottom:1px solid #fde68a;">${escapeHtml(order.reason)}</td>
                </tr>
              `)
        .join('')}
        </tbody>
      </table>
    </section>
  `;
};
const buildTrayOrderRowsHtml = (orders, title) => {
    if (orders.length === 0) {
        return `
      <section style="margin-top:24px;border:1px dashed #cbd5e1;border-radius:18px;padding:20px;background:#ffffff;">
        <h3 style="margin:0 0 8px;font-size:18px;color:#0f172a;">${escapeHtml(title)}</h3>
        <p style="margin:0;color:#64748b;">Nenhum pedido nesta categoria nesta sincronizacao.</p>
      </section>
    `;
    }
    const hasUpdateSummary = orders.some((order) => Array.isArray(order.updateSummary) && order.updateSummary.length > 0);
    return `
    <section style="margin-top:24px;border:1px solid #dbeafe;border-radius:18px;padding:20px;background:#ffffff;">
      <h3 style="margin:0 0 14px;font-size:18px;color:#0f172a;">${escapeHtml(title)}</h3>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:13px;color:#334155;">
        <thead>
          <tr style="background:#f8fafc;color:#475569;">
            <th align="left" style="padding:10px;border-bottom:1px solid #e2e8f0;">Pedido</th>
            <th align="left" style="padding:10px;border-bottom:1px solid #e2e8f0;">Cliente</th>
            <th align="left" style="padding:10px;border-bottom:1px solid #e2e8f0;">Status</th>
            <th align="left" style="padding:10px;border-bottom:1px solid #e2e8f0;">Canal</th>
            <th align="left" style="padding:10px;border-bottom:1px solid #e2e8f0;">Frete</th>
            <th align="left" style="padding:10px;border-bottom:1px solid #e2e8f0;">Rastreio</th>
            <th align="right" style="padding:10px;border-bottom:1px solid #e2e8f0;">Valor</th>
            ${hasUpdateSummary
        ? '<th align="left" style="padding:10px;border-bottom:1px solid #e2e8f0;">Atualizacoes</th>'
        : ''}
          </tr>
        </thead>
        <tbody>
          ${orders
        .map((order) => `
                <tr>
                  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">#${escapeHtml(order.orderNumber)}</td>
                  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(order.customerName)}</td>
                  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(STATUS_LABELS[order.status])}</td>
                  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(order.salesChannel)}</td>
                  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(order.freightType || '-')}</td>
                  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(order.trackingCode || '-')}</td>
                  <td align="right" style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(formatCurrency(order.totalValue))}</td>
                  ${hasUpdateSummary
        ? `<td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(Array.isArray(order.updateSummary) &&
            order.updateSummary.length > 0
            ? order.updateSummary.join(' | ')
            : '-')}</td>`
        : ''}
                </tr>
              `)
        .join('')}
        </tbody>
      </table>
    </section>
  `;
};
const buildTraySyncCsvContent = (payload, metadata) => {
    const lines = [
        ['Empresa', metadata.companyName],
        ['Loja Tray', payload.storeId],
        [
            'Tipo de sincronizacao',
            metadata.trigger === 'automatic' ? 'Automatica' : 'Manual',
        ],
        ['Inicio', metadata.startedAt],
        ['Fim', metadata.finishedAt],
        ['Janela modificada desde', payload.modified],
        ['Status consultados', payload.statuses.join(', ')],
        ['Relatorio web', metadata.reportUrl],
        ['CSV', metadata.csvUrl],
        [],
        ['Indicador', 'Valor'],
        ['Pedidos incluidos', payload.created],
        ['Pedidos atualizados', payload.updated],
        ['Pedidos ignorados', payload.skipped],
        ['Eventos iniciais de rastreio', payload.totalTrackingEvents],
        ['Erros', payload.errors.length],
        [],
        [
            'Tipo',
            'Pedido',
            'Cliente',
            'Status',
            'Canal',
            'Frete',
            'Rastreio',
            'Envio',
            'Prev. entrega',
            'Prev. transportadora',
            'Valor',
            'Atrasado',
            'Atualizacoes',
        ],
    ];
    for (const [label, orders] of [
        ['Incluido', payload.createdOrders],
        ['Atualizado', payload.updatedOrders],
    ]) {
        for (const order of orders) {
            lines.push([
                label,
                order.orderNumber,
                order.customerName,
                STATUS_LABELS[order.status],
                order.salesChannel,
                order.freightType || '',
                order.trackingCode || '',
                formatDateOnly(order.shippingDate),
                formatDateOnly(order.estimatedDeliveryDate),
                formatDateOnly(order.carrierEstimatedDeliveryDate),
                order.totalValue,
                order.isDelayed ? 'Sim' : 'Nao',
                Array.isArray(order.updateSummary) ? order.updateSummary.join(' | ') : '',
            ]);
        }
    }
    if ((payload.skippedOrders || []).length > 0) {
        lines.push([]);
        lines.push(['Tipo', 'Pedido', 'Motivo']);
        for (const skippedOrder of payload.skippedOrders || []) {
            lines.push(['Ignorado', skippedOrder.orderNumber, skippedOrder.reason]);
        }
    }
    if (payload.errors.length > 0) {
        lines.push([]);
        lines.push(['Erros']);
        for (const error of payload.errors) {
            lines.push([error]);
        }
    }
    return lines
        .map((line) => line.map((value) => escapeCsv(value)).join(';'))
        .join('\n');
};
const buildTraySyncReportHtml = (payload, metadata) => {
    const skippedOrders = payload.skippedOrders || [];
    const updatedSummary = summarizeUpdatedOrders(payload.updatedOrders);
    const skippedSummary = summarizeSkippedOrders(skippedOrders);
    const bars = buildMetricBars([
        { label: 'Pedidos incluidos', value: payload.created, color: '#10b981' },
        { label: 'Pedidos atualizados', value: payload.updated, color: '#2563eb' },
        { label: 'Pedidos ignorados', value: payload.skipped, color: '#f59e0b' },
        {
            label: 'Eventos iniciais de rastreio',
            value: payload.totalTrackingEvents,
            color: '#7c3aed',
        },
        { label: 'Erros', value: payload.errors.length, color: '#ef4444' },
    ]);
    const errorsSection = payload.errors.length > 0
        ? `
        <section style="margin-top:24px;border:1px solid #fecaca;background:#fef2f2;border-radius:18px;padding:20px;">
          <h3 style="margin:0 0 12px;color:#b91c1c;">Erros encontrados</h3>
          <ul style="margin:0;padding-left:18px;color:#7f1d1d;line-height:1.7;">
            ${payload.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}
          </ul>
        </section>
      `
        : '';
    return `
<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Relatorio de pedidos - ${escapeHtml(metadata.companyName)}</title>
  </head>
  <body style="margin:0;background:#eff6ff;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <div style="padding:32px 16px;background:radial-gradient(circle at top,#1d4ed8 0%,#0f172a 55%);">
      <div style="max-width:1120px;margin:0 auto;">
        <div style="background:#ffffff;border-radius:28px;padding:30px 32px;box-shadow:0 30px 90px rgba(15,23,42,0.28);">
          <div style="display:flex;justify-content:space-between;gap:20px;align-items:flex-start;flex-wrap:wrap;">
            <div style="flex:1;min-width:0;">
              <p style="margin:0;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#2563eb;font-weight:700;">
                Relatorio de pedidos ${metadata.trigger === 'automatic' ? 'automatico' : 'manual'}
              </p>
              <h1 style="margin:10px 0 0;font-size:34px;line-height:1.15;color:#0f172a;">
                ${escapeHtml(metadata.companyName)}
              </h1>
              <p style="margin:10px 0 0;color:#475569;line-height:1.7;max-width:760px;">
                Sincronizacao da Tray finalizada com detalhamento dos pedidos incluidos e atualizados na plataforma.
              </p>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:14px;">
              <img src="${APP_LOGO_URL}" alt="Avantracking" style="width:112px;max-width:112px;height:auto;display:block;" />
              <div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:flex-end;">
              <a href="${metadata.reportUrl}" style="display:inline-block;padding:14px 20px;border-radius:999px;background:#0f172a;color:#ffffff;text-decoration:none;font-weight:700;">
                Abrir relatorio
              </a>
              <a href="${metadata.csvUrl}" style="display:inline-block;padding:14px 20px;border-radius:999px;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;">
                Baixar CSV
              </a>
              </div>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-top:28px;">
            <div style="padding:18px;border-radius:18px;background:#eff6ff;border:1px solid #bfdbfe;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#1d4ed8;font-weight:700;">Inicio</div><div style="margin-top:8px;font-size:15px;color:#0f172a;">${escapeHtml(metadata.startedAt)}</div></div>
            <div style="padding:18px;border-radius:18px;background:#eff6ff;border:1px solid #bfdbfe;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#1d4ed8;font-weight:700;">Fim</div><div style="margin-top:8px;font-size:15px;color:#0f172a;">${escapeHtml(metadata.finishedAt)}</div></div>
            <div style="padding:18px;border-radius:18px;background:#eff6ff;border:1px solid #bfdbfe;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#1d4ed8;font-weight:700;">Loja Tray</div><div style="margin-top:8px;font-size:15px;color:#0f172a;">${escapeHtml(payload.storeId)}</div></div>
            <div style="padding:18px;border-radius:18px;background:#eff6ff;border:1px solid #bfdbfe;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#1d4ed8;font-weight:700;">Janela</div><div style="margin-top:8px;font-size:15px;color:#0f172a;">Desde ${escapeHtml(payload.modified)}</div></div>
          </div>
          <section style="display:grid;grid-template-columns:minmax(0,1.1fr) minmax(320px,0.9fr);gap:20px;margin-top:26px;align-items:start;">
            <div style="border:1px solid #dbeafe;border-radius:22px;padding:22px;background:#f8fbff;">
              <h2 style="margin:0 0 18px;font-size:20px;color:#0f172a;">Grafico de indicadores</h2>
              ${bars}
            </div>
            <div style="border:1px solid #dbeafe;border-radius:22px;padding:22px;background:#f8fbff;">
              <h2 style="margin:0 0 18px;font-size:20px;color:#0f172a;">Resumo da sincronizacao</h2>
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:14px;">
                <tbody>
                  <tr><td style="padding:8px 0;border-top:1px solid #dbeafe;">Pedidos incluidos</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.created}</td></tr>
                  <tr><td style="padding:8px 0;border-top:1px solid #dbeafe;">Pedidos atualizados</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.updated}</td></tr>
                  <tr><td style="padding:8px 0;border-top:1px solid #dbeafe;">Pedidos ignorados</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.skipped}</td></tr>
                  <tr><td style="padding:8px 0;border-top:1px solid #dbeafe;">Eventos iniciais de rastreio</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${payload.totalTrackingEvents}</td></tr>
                  <tr><td style="padding:8px 0;border-top:1px solid #dbeafe;">Status consultados</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${escapeHtml(payload.statuses.join(', '))}</td></tr>
                </tbody>
              </table>
              <div style="margin-top:16px;padding:14px;border:1px solid #bfdbfe;border-radius:14px;background:#eff6ff;">
                <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#1d4ed8;font-weight:700;">O que foi atualizado</div>
                ${buildSummaryListHtml(updatedSummary, {
        emptyMessage: 'Nenhum pedido atualizado nesta sincronizacao.',
    })}
              </div>
              <div style="margin-top:14px;padding:14px;border:1px solid #fde68a;border-radius:14px;background:#fffbeb;">
                <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#b45309;font-weight:700;">Motivos de pedidos ignorados</div>
                ${buildSummaryListHtml(skippedSummary, {
        emptyMessage: 'Nenhum pedido ignorado nesta sincronizacao.',
        listColor: '#92400e',
        emptyColor: '#92400e',
    })}
              </div>
            </div>
          </section>
          ${errorsSection}
          ${buildTrayOrderRowsHtml(payload.createdOrders, 'Pedidos incluidos')}
          ${buildTrayOrderRowsHtml(payload.updatedOrders, 'Pedidos atualizados')}
          ${buildTraySkippedRowsHtml(skippedOrders)}
        </div>
      </div>
    </div>
  </body>
</html>
  `;
};
const buildTraySyncEmailHtml = (payload, metadata) => {
    const skippedOrders = payload.skippedOrders || [];
    const updatedSummary = summarizeUpdatedOrders(payload.updatedOrders);
    const skippedSummary = summarizeSkippedOrders(skippedOrders);
    return `
<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Relatorio de pedidos</title>
  </head>
  <body style="margin:0;padding:0;background:#0b1220;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <div style="padding:28px 16px;background:radial-gradient(circle at top,#1d4ed8 0%,#0b1220 58%);">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:760px;margin:0 auto;">
        <tr>
          <td>
            <div style="background:#ffffff;border-radius:24px;overflow:hidden;border:1px solid #dbeafe;box-shadow:0 24px 70px rgba(15,23,42,0.35);">
              <div style="padding:28px 32px 18px;background:linear-gradient(135deg,#0f172a 0%,#1d4ed8 100%);">
                <div style="text-align:right;margin-bottom:12px;">
                  <img src="${APP_LOGO_URL}" alt="Avantracking" style="width:112px;max-width:112px;height:auto;display:inline-block;" />
                </div>
                <div style="flex:1;min-width:0;">
                  <p style="margin:0;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#bfdbfe;">
                    Relatorio ${metadata.trigger === 'automatic' ? 'automatico' : 'manual'} de pedidos
                  </p>
                  <h1 style="margin:10px 0 0;font-size:30px;line-height:1.15;color:#ffffff;">
                    ${escapeHtml(metadata.companyName)}
                  </h1>
                  <p style="margin:12px 0 0;font-size:14px;line-height:1.7;color:#dbeafe;">
                    Janela desde ${escapeHtml(payload.modified)}. Incluidos: ${payload.created}. Atualizados: ${payload.updated}. Ignorados: ${payload.skipped}.
                  </p>
                </div>
              </div>
              <div style="padding:28px 32px;">
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;">
                  <div style="border:1px solid #e2e8f0;border-radius:18px;padding:16px;background:#f8fafc;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#64748b;">Incluidos</div><div style="margin-top:8px;font-size:26px;font-weight:700;color:#10b981;">${payload.created}</div></div>
                  <div style="border:1px solid #bfdbfe;border-radius:18px;padding:16px;background:#eff6ff;">
                    <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#1e40af;">Atualizados</div>
                    <div style="margin-top:8px;font-size:26px;font-weight:700;color:#2563eb;">${payload.updated}</div>
                    ${buildSummaryListHtml(updatedSummary, {
        emptyMessage: 'Sem alteracoes em pedidos.',
        maxItems: 3,
        listColor: '#1e3a8a',
        emptyColor: '#1e40af',
        marginTop: 10,
    })}
                  </div>
                  <div style="border:1px solid #fde68a;border-radius:18px;padding:16px;background:#fffbeb;">
                    <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#b45309;">Ignorados</div>
                    <div style="margin-top:8px;font-size:26px;font-weight:700;color:#f59e0b;">${payload.skipped}</div>
                    ${buildSummaryListHtml(skippedSummary, {
        emptyMessage: 'Nenhum pedido ignorado.',
        maxItems: 3,
        listColor: '#92400e',
        emptyColor: '#b45309',
        marginTop: 10,
    })}
                  </div>
                  <div style="border:1px solid #e2e8f0;border-radius:18px;padding:16px;background:#f8fafc;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#64748b;">Erros</div><div style="margin-top:8px;font-size:26px;font-weight:700;color:#ef4444;">${payload.errors.length}</div></div>
                </div>
                <div style="margin-top:24px;padding:20px;border:1px solid #dbeafe;border-radius:18px;background:#f8fbff;">
                  <h2 style="margin:0 0 14px;font-size:18px;color:#0f172a;">Resumo</h2>
                  ${buildMetricBars([
        { label: 'Pedidos incluidos', value: payload.created, color: '#10b981' },
        { label: 'Pedidos atualizados', value: payload.updated, color: '#2563eb' },
        { label: 'Pedidos ignorados', value: payload.skipped, color: '#f59e0b' },
        { label: 'Erros', value: payload.errors.length, color: '#ef4444' },
    ])}
                </div>
                <div style="margin-top:24px;">
                  <h2 style="margin:0 0 12px;font-size:18px;color:#0f172a;">Ultimos pedidos incluidos</h2>
                  ${payload.createdOrders.length > 0
        ? payload.createdOrders
            .slice(0, 8)
            .map((order) => `
                              <div style="border:1px solid #e2e8f0;border-radius:16px;padding:16px;margin-bottom:12px;background:#ffffff;">
                                <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;">
                                  <strong style="color:#0f172a;">Pedido #${escapeHtml(order.orderNumber)}</strong>
                                  <span style="color:#475569;">${escapeHtml(STATUS_LABELS[order.status])}</span>
                                </div>
                                <p style="margin:8px 0 0;font-size:13px;line-height:1.6;color:#475569;">
                                  ${escapeHtml(order.customerName)} â€¢ ${escapeHtml(order.salesChannel)} â€¢ ${escapeHtml(order.freightType || '-')}
                                </p>
                              </div>
                            `)
            .join('')
        : '<p style="margin:0;color:#64748b;">Nenhum pedido novo foi incluido nesta sincronizacao.</p>'}
                </div>
                <div style="margin-top:28px;text-align:center;">
                  <a href="${metadata.reportUrl}" style="display:inline-block;padding:15px 24px;border-radius:999px;background:linear-gradient(135deg,#2563eb 0%,#0f172a 100%);color:#ffffff;text-decoration:none;font-weight:700;margin-right:8px;">
                    Abrir relatorio completo
                  </a>
                  <a href="${metadata.csvUrl}" style="display:inline-block;padding:15px 24px;border-radius:999px;background:#eff6ff;color:#1d4ed8;text-decoration:none;font-weight:700;border:1px solid #bfdbfe;">
                    Baixar CSV detalhado
                  </a>
                </div>
              </div>
            </div>
          </td>
        </tr>
      </table>
    </div>
  </body>
</html>
`;
};
const buildTraySyncEmailText = (payload, metadata) => {
    const skippedOrders = payload.skippedOrders || [];
    const updatedSummaryText = buildSummaryText(summarizeUpdatedOrders(payload.updatedOrders), 'Nenhuma alteracao em pedidos.');
    const skippedSummaryText = buildSummaryText(summarizeSkippedOrders(skippedOrders), 'Nenhum pedido ignorado.');
    return [
        `Relatorio ${metadata.trigger === 'automatic' ? 'automatico' : 'manual'} de pedidos - ${metadata.companyName}`,
        `Loja Tray: ${payload.storeId}`,
        `Inicio: ${metadata.startedAt}`,
        `Fim: ${metadata.finishedAt}`,
        `Janela modificada desde: ${payload.modified}`,
        `Status consultados: ${payload.statuses.join(', ')}`,
        '',
        `Pedidos incluidos: ${payload.created}`,
        `Pedidos atualizados: ${payload.updated}`,
        `O que foi atualizado: ${updatedSummaryText}`,
        `Pedidos ignorados: ${payload.skipped}`,
        `Motivos dos ignorados: ${skippedSummaryText}`,
        `Eventos iniciais de rastreio: ${payload.totalTrackingEvents}`,
        `Erros: ${payload.errors.length}`,
        '',
        `Relatorio completo: ${metadata.reportUrl}`,
        `CSV detalhado: ${metadata.csvUrl}`,
    ].join('\n');
};
class SyncReportService {
    async resolveRecipients(input) {
        const usersResult = await (0, db_1.dbQuery)(`
        SELECT "email", "name", "receivePlatformEmails"
        FROM "User"
        WHERE "companyId" = $1
        ORDER BY "createdAt" ASC
      `, [input.companyId]);
        const users = usersResult.rows;
        const uniqueRecipients = new Map();
        const blockedEmails = new Set();
        for (const user of users) {
            if (!user.email)
                continue;
            const normalizedEmail = user.email.trim().toLowerCase();
            if (!normalizedEmail)
                continue;
            if (user.receivePlatformEmails === false) {
                blockedEmails.add(normalizedEmail);
                continue;
            }
            uniqueRecipients.set(normalizedEmail, {
                email: user.email,
                name: user.name || user.email,
            });
        }
        const fallbackEmail = String(input.fallbackEmail || '').trim().toLowerCase();
        if (fallbackEmail && !blockedEmails.has(fallbackEmail)) {
            uniqueRecipients.set(fallbackEmail, {
                email: String(input.fallbackEmail).trim(),
                name: String(input.fallbackName || input.fallbackEmail || fallbackEmail).trim(),
            });
        }
        if (uniqueRecipients.size === 0 && input.userId) {
            const triggeringUserResult = await (0, db_1.dbQuery)(`
          SELECT "email", "name", "receivePlatformEmails"
          FROM "User"
          WHERE "id" = $1
          LIMIT 1
        `, [input.userId]);
            const triggeringUser = triggeringUserResult.rows[0] || null;
            const normalizedEmail = String(triggeringUser?.email || '').trim().toLowerCase();
            if (normalizedEmail && triggeringUser?.receivePlatformEmails !== false) {
                uniqueRecipients.set(normalizedEmail, {
                    email: String(triggeringUser?.email),
                    name: String(triggeringUser?.name || triggeringUser?.email || normalizedEmail),
                });
            }
        }
        const configuredRecipients = String(process.env.SYNC_REPORT_RECIPIENTS ||
            process.env.REPORT_RECIPIENTS ||
            '')
            .split(',')
            .map((email) => email.trim())
            .filter(Boolean);
        for (const email of configuredRecipients) {
            const normalizedEmail = email.toLowerCase();
            if (blockedEmails.has(normalizedEmail)) {
                continue;
            }
            uniqueRecipients.set(normalizedEmail, {
                email,
                name: email,
            });
        }
        return Array.from(uniqueRecipients.values());
    }
    async getCompanyName(companyId) {
        const result = await (0, db_1.dbQuery)(`
        SELECT "name"
        FROM "Company"
        WHERE "id" = $1
        LIMIT 1
      `, [companyId]);
        return String(result.rows[0]?.name || '').trim() || 'Empresa';
    }
    async sendTrackingSyncReport(input) {
        const companyName = await this.getCompanyName(input.companyId);
        const reportId = crypto_1.default.randomUUID();
        const baseUrl = (0, publicBaseUrl_1.getPublicBaseUrl)();
        const reportUrl = `${baseUrl}/reports/sync/${reportId}.html`;
        const csvUrl = `${baseUrl}/reports/sync/${reportId}.csv`;
        const metadata = {
            companyName,
            trigger: input.trigger,
            reportUrl,
            csvUrl,
            startedAt: formatDateTime(input.startedAt),
            finishedAt: formatDateTime(input.finishedAt),
        };
        const reportHtml = buildReportHtml(input.payload, metadata);
        const reportCsv = buildCsvContent(input.payload, metadata);
        const emailHtml = buildEmailHtml(input.payload, metadata);
        const emailText = buildEmailText(input.payload, metadata);
        const reportsDir = getReportsDir();
        await promises_1.default.mkdir(reportsDir, { recursive: true });
        await Promise.all([
            promises_1.default.writeFile(path_1.default.join(reportsDir, `${reportId}.html`), reportHtml, 'utf8'),
            promises_1.default.writeFile(path_1.default.join(reportsDir, `${reportId}.csv`), reportCsv, 'utf8'),
        ]);
        const recipients = await this.resolveRecipients({
            companyId: input.companyId,
            userId: input.userId,
            fallbackEmail: input.userEmail,
            fallbackName: input.userName,
        });
        if (recipients.length === 0) {
            console.warn(`Nenhum destinatario encontrado para relatorio de sincronizacao da empresa ${input.companyId}.`);
            return {
                reportId,
                reportUrl,
                csvUrl,
                recipients: 0,
            };
        }
        await (0, emailTransportService_1.sendBrevoEmail)({
            to: recipients,
            subject: `Relatorio de sincronizacao - ${companyName}`,
            htmlContent: emailHtml,
            textContent: emailText,
        });
        console.log(`Relatorio de sincronizacao enviado para ${recipients
            .map((recipient) => recipient.email)
            .join(', ')}`);
        return {
            reportId,
            reportUrl,
            csvUrl,
            recipients: recipients.length,
        };
    }
    async sendTraySyncReport(input) {
        const companyName = await this.getCompanyName(input.companyId);
        const reportId = crypto_1.default.randomUUID();
        const baseUrl = (0, publicBaseUrl_1.getPublicBaseUrl)();
        const reportUrl = `${baseUrl}/reports/tray-sync/${reportId}.html`;
        const csvUrl = `${baseUrl}/reports/tray-sync/${reportId}.csv`;
        const metadata = {
            companyName,
            trigger: input.trigger,
            reportUrl,
            csvUrl,
            startedAt: formatDateTime(input.startedAt),
            finishedAt: formatDateTime(input.finishedAt),
        };
        const reportHtml = buildTraySyncReportHtml(input.payload, metadata);
        const reportCsv = buildTraySyncCsvContent(input.payload, metadata);
        const emailHtml = buildTraySyncEmailHtml(input.payload, metadata);
        const emailText = buildTraySyncEmailText(input.payload, metadata);
        const reportsDir = getReportsDir('tray-sync');
        await promises_1.default.mkdir(reportsDir, { recursive: true });
        await Promise.all([
            promises_1.default.writeFile(path_1.default.join(reportsDir, `${reportId}.html`), reportHtml, 'utf8'),
            promises_1.default.writeFile(path_1.default.join(reportsDir, `${reportId}.csv`), reportCsv, 'utf8'),
        ]);
        const recipients = await this.resolveRecipients({
            companyId: input.companyId,
            userId: input.userId,
            fallbackEmail: input.userEmail,
            fallbackName: input.userName,
        });
        if (recipients.length === 0) {
            console.warn(`Nenhum destinatario encontrado para relatorio Tray da empresa ${input.companyId}.`);
            return {
                reportId,
                reportUrl,
                csvUrl,
                recipients: 0,
            };
        }
        await (0, emailTransportService_1.sendBrevoEmail)({
            to: recipients,
            subject: `Relatorio de pedidos - ${companyName}`,
            htmlContent: emailHtml,
            textContent: emailText,
        });
        console.log(`Relatorio de pedidos enviado para ${recipients
            .map((recipient) => recipient.email)
            .join(', ')}`);
        return {
            reportId,
            reportUrl,
            csvUrl,
            recipients: recipients.length,
        };
    }
}
exports.syncReportService = new SyncReportService();
