"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.monthlyMovementReportService = void 0;
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const orderStatus_1 = require("../types/orderStatus");
const emailTransportService_1 = require("./emailTransportService");
const db_1 = require("../lib/db");
const publicBaseUrl_1 = require("../utils/publicBaseUrl");
const APP_LOGO_URL = 'https://res.cloudinary.com/dhqxp3tuo/image/upload/v1771249579/ChatGPT_Image_13_de_fev._de_2026_16_40_14_kldj3k.png';
const MONTHLY_REPORT_HOUR = 8;
const MONTHLY_REPORT_DAY = 1;
const MAX_TIMEOUT_MS = 2_147_483_647;
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
const toDateOrNull = (value) => {
    if (!value)
        return null;
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const mapMonthlyOrderRow = (row) => ({
    orderNumber: String(row.orderNumber || ''),
    customerName: String(row.customerName || ''),
    salesChannel: String(row.salesChannel || ''),
    freightType: row.freightType || null,
    status: row.status,
    isDelayed: Boolean(row.isDelayed),
    trackingCode: row.trackingCode || null,
    shippingDate: toDateOrNull(row.shippingDate),
    estimatedDeliveryDate: toDateOrNull(row.estimatedDeliveryDate),
    carrierEstimatedDeliveryDate: toDateOrNull(row.carrierEstimatedDeliveryDate),
    createdAt: toDateOrNull(row.createdAt) || new Date(0),
    lastUpdate: toDateOrNull(row.lastUpdate) || new Date(0),
    lastApiSync: toDateOrNull(row.lastApiSync),
});
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
const formatDateTime = (value) => value ? new Date(value).toLocaleString('pt-BR') : '-';
const formatDateOnly = (value) => value ? new Date(value).toLocaleDateString('pt-BR') : '-';
const formatMonthLabel = (value) => new Intl.DateTimeFormat('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Sao_Paulo',
}).format(value);
const getReportsDir = () => path_1.default.join(__dirname, '../../public/reports/monthly-summary');
const calculateDeltaPercent = (current, previous) => {
    if (previous === 0) {
        return current === 0 ? 0 : 100;
    }
    return Math.round(((current - previous) / previous) * 1000) / 10;
};
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
class MonthlyMovementReportService {
    timeout = null;
    scheduleInitialized = false;
    runningCycleKey = null;
    completedCycleKeys = new Set();
    getClosedMonthCycleKey(referenceDate = new Date()) {
        const closedMonthDate = new Date(referenceDate.getFullYear(), referenceDate.getMonth() - 1, 1);
        return `${closedMonthDate.getFullYear()}-${String(closedMonthDate.getMonth() + 1).padStart(2, '0')}`;
    }
    resolveNextRun() {
        const now = new Date();
        const nextRun = new Date(now.getFullYear(), now.getMonth(), MONTHLY_REPORT_DAY);
        nextRun.setHours(MONTHLY_REPORT_HOUR, 0, 0, 0);
        if (nextRun <= now) {
            nextRun.setMonth(nextRun.getMonth() + 1, MONTHLY_REPORT_DAY);
        }
        return nextRun;
    }
    scheduleNext() {
        if (this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = null;
        }
        const nextRun = this.resolveNextRun();
        const delayMs = Math.max(1000, nextRun.getTime() - Date.now());
        this.timeout = setTimeout(() => {
            if (Date.now() < nextRun.getTime()) {
                this.scheduleNext();
                return;
            }
            void this.run().finally(() => this.scheduleNext());
        }, Math.min(delayMs, MAX_TIMEOUT_MS));
    }
    async initializeSchedule() {
        if (this.scheduleInitialized) {
            return;
        }
        this.scheduleInitialized = true;
        this.scheduleNext();
    }
    normalizeEmail(email) {
        return String(email || '').trim().toLowerCase();
    }
    async resolveRecipients(companyId) {
        const usersResult = await (0, db_1.dbQuery)(`
        SELECT
          u."email",
          u."name"
        FROM "User" u
        WHERE u."companyId" = $1
        ORDER BY u."createdAt" ASC
      `, [companyId]);
        const users = usersResult.rows;
        const recipients = new Map();
        for (const user of users) {
            const normalizedEmail = this.normalizeEmail(user.email);
            if (!normalizedEmail)
                continue;
            recipients.set(normalizedEmail, {
                email: user.email,
                name: user.name || user.email,
            });
        }
        return Array.from(recipients.values());
    }
    buildStatusSummary(currentOrders, previousOrders) {
        return Object.values(orderStatus_1.OrderStatus).map((status) => {
            const currentCount = currentOrders.filter((order) => order.status === status).length;
            const previousCount = previousOrders.filter((order) => order.status === status).length;
            return {
                status,
                label: STATUS_LABELS[status],
                currentCount,
                previousCount,
                delta: currentCount - previousCount,
            };
        });
    }
    getMovementOrders(orders, periodStart, periodEndExclusive) {
        return orders.filter((order) => (order.createdAt >= periodStart &&
            order.createdAt < periodEndExclusive) ||
            (order.lastUpdate >= periodStart &&
                order.lastUpdate < periodEndExclusive) ||
            (order.lastApiSync &&
                order.lastApiSync >= periodStart &&
                order.lastApiSync < periodEndExclusive));
    }
    buildCsvContent(input) {
        const lines = [
            ['Empresa', input.companyName],
            ['Periodo atual', `${formatDateOnly(input.currentPeriodStart)} a ${formatDateOnly(input.currentPeriodEnd)}`],
            ['Periodo anterior', `${formatDateOnly(input.previousPeriodStart)} a ${formatDateOnly(input.previousPeriodEnd)}`],
            ['Relatorio web', input.reportUrl],
            ['CSV', input.csvUrl],
            [],
            ['Indicador', 'Periodo atual', 'Periodo anterior', 'Variacao %'],
            [
                'Pedidos movimentados',
                input.currentMovedOrders.length,
                input.previousMovedOrders.length,
                `${calculateDeltaPercent(input.currentMovedOrders.length, input.previousMovedOrders.length)}%`,
            ],
            [
                'Pedidos criados',
                input.currentCreatedOrders,
                input.previousCreatedOrders,
                `${calculateDeltaPercent(input.currentCreatedOrders, input.previousCreatedOrders)}%`,
            ],
            [
                'Pedidos em atraso',
                input.currentDelayedOrders,
                input.previousDelayedOrders,
                `${calculateDeltaPercent(input.currentDelayedOrders, input.previousDelayedOrders)}%`,
            ],
            ['Total de pedidos na empresa', input.totalOrders, '', ''],
            [],
            ['Status', 'Periodo atual', 'Periodo anterior', 'Delta'],
            ...input.statusSummary.map((item) => [
                item.label,
                item.currentCount,
                item.previousCount,
                item.delta,
            ]),
            [],
            [
                'Periodo',
                'Pedido',
                'Cliente',
                'Status atual',
                'Canal',
                'Transportadora',
                'Rastreio',
                'Atrasado',
                'Envio',
                'Prev. entrega',
                'Prev. transportadora',
                'Criado na plataforma',
                'Ultima atualizacao',
                'Ultimo sync API',
            ],
        ];
        for (const order of input.currentMovedOrders) {
            lines.push([
                'Mes encerrado',
                order.orderNumber,
                order.customerName,
                STATUS_LABELS[order.status],
                order.salesChannel,
                order.freightType || '',
                order.trackingCode || '',
                order.isDelayed ? 'Sim' : 'Nao',
                formatDateOnly(order.shippingDate),
                formatDateOnly(order.estimatedDeliveryDate),
                formatDateOnly(order.carrierEstimatedDeliveryDate),
                formatDateTime(order.createdAt),
                formatDateTime(order.lastUpdate),
                formatDateTime(order.lastApiSync),
            ]);
        }
        for (const order of input.previousMovedOrders) {
            lines.push([
                'Mes anterior',
                order.orderNumber,
                order.customerName,
                STATUS_LABELS[order.status],
                order.salesChannel,
                order.freightType || '',
                order.trackingCode || '',
                order.isDelayed ? 'Sim' : 'Nao',
                formatDateOnly(order.shippingDate),
                formatDateOnly(order.estimatedDeliveryDate),
                formatDateOnly(order.carrierEstimatedDeliveryDate),
                formatDateTime(order.createdAt),
                formatDateTime(order.lastUpdate),
                formatDateTime(order.lastApiSync),
            ]);
        }
        return lines
            .map((line) => line.map((value) => escapeCsv(value)).join(';'))
            .join('\n');
    }
    buildReportHtml(input) {
        const currentLabel = formatMonthLabel(input.currentPeriodStart);
        const previousLabel = formatMonthLabel(input.previousPeriodStart);
        const currentMovementDelta = calculateDeltaPercent(input.currentMovedOrders.length, input.previousMovedOrders.length);
        const currentCreationDelta = calculateDeltaPercent(input.currentCreatedOrders, input.previousCreatedOrders);
        const currentDelayDelta = calculateDeltaPercent(input.currentDelayedOrders, input.previousDelayedOrders);
        const movementRows = input.currentMovedOrders.length > 0
            ? input.currentMovedOrders
                .slice(0, 120)
                .map((order) => `
                <tr>
                  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">#${escapeHtml(order.orderNumber)}</td>
                  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(order.customerName)}</td>
                  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(STATUS_LABELS[order.status])}</td>
                  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(order.salesChannel)}</td>
                  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(order.freightType || '-')}</td>
                  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(formatDateTime(order.lastUpdate))}</td>
                </tr>
              `)
                .join('')
            : `
          <tr>
            <td colspan="6" style="padding:12px 10px;border-bottom:1px solid #e2e8f0;color:#64748b;">
              Nenhum pedido teve movimentacao registrada no mes encerrado.
            </td>
          </tr>
        `;
        return `
<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Relatorio mensal - ${escapeHtml(input.companyName)}</title>
  </head>
  <body style="margin:0;background:#eff6ff;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <div style="padding:32px 16px;background:radial-gradient(circle at top,#1d4ed8 0%,#0f172a 55%);">
      <div style="max-width:1120px;margin:0 auto;">
        <div style="background:#ffffff;border-radius:28px;padding:30px 32px;box-shadow:0 30px 90px rgba(15,23,42,0.28);">
          <div style="display:flex;justify-content:space-between;gap:20px;align-items:flex-start;flex-wrap:wrap;">
            <div>
              <img src="${APP_LOGO_URL}" alt="Avantracking" style="height:56px;max-width:240px;" />
              <p style="margin:16px 0 0;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#2563eb;font-weight:700;">
                Relatorio mensal de movimentacao
              </p>
              <h1 style="margin:10px 0 0;font-size:34px;line-height:1.15;color:#0f172a;">
                ${escapeHtml(input.companyName)}
              </h1>
              <p style="margin:10px 0 0;color:#475569;line-height:1.7;max-width:760px;">
                Fechamento de ${escapeHtml(currentLabel)} com comparativo direto contra ${escapeHtml(previousLabel)}.
              </p>
            </div>
            <div style="display:flex;gap:12px;flex-wrap:wrap;">
              <a href="${input.reportUrl}" style="display:inline-block;padding:14px 20px;border-radius:999px;background:#0f172a;color:#ffffff;text-decoration:none;font-weight:700;">
                Abrir relatorio
              </a>
              <a href="${input.csvUrl}" style="display:inline-block;padding:14px 20px;border-radius:999px;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;">
                Baixar CSV
              </a>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-top:28px;">
            <div style="padding:18px;border-radius:18px;background:#eff6ff;border:1px solid #bfdbfe;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#1d4ed8;font-weight:700;">Mes encerrado</div><div style="margin-top:8px;font-size:15px;color:#0f172a;">${escapeHtml(formatDateOnly(input.currentPeriodStart))} a ${escapeHtml(formatDateOnly(input.currentPeriodEnd))}</div></div>
            <div style="padding:18px;border-radius:18px;background:#eff6ff;border:1px solid #bfdbfe;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#1d4ed8;font-weight:700;">Mes anterior</div><div style="margin-top:8px;font-size:15px;color:#0f172a;">${escapeHtml(formatDateOnly(input.previousPeriodStart))} a ${escapeHtml(formatDateOnly(input.previousPeriodEnd))}</div></div>
            <div style="padding:18px;border-radius:18px;background:#eff6ff;border:1px solid #bfdbfe;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#1d4ed8;font-weight:700;">Pedidos na empresa</div><div style="margin-top:8px;font-size:15px;color:#0f172a;">${input.totalOrders}</div></div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-top:18px;">
            <div style="padding:18px;border-radius:18px;background:#f8fbff;border:1px solid #dbeafe;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#2563eb;font-weight:700;">Movimentados</div><div style="margin-top:8px;font-size:26px;font-weight:700;color:#0f172a;">${input.currentMovedOrders.length}</div><div style="margin-top:6px;font-size:13px;color:#64748b;">Anterior: ${input.previousMovedOrders.length} | Variacao: ${currentMovementDelta}%</div></div>
            <div style="padding:18px;border-radius:18px;background:#f8fbff;border:1px solid #dbeafe;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#2563eb;font-weight:700;">Pedidos criados</div><div style="margin-top:8px;font-size:26px;font-weight:700;color:#0f172a;">${input.currentCreatedOrders}</div><div style="margin-top:6px;font-size:13px;color:#64748b;">Anterior: ${input.previousCreatedOrders} | Variacao: ${currentCreationDelta}%</div></div>
            <div style="padding:18px;border-radius:18px;background:#f8fbff;border:1px solid #dbeafe;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#2563eb;font-weight:700;">Em atraso</div><div style="margin-top:8px;font-size:26px;font-weight:700;color:#0f172a;">${input.currentDelayedOrders}</div><div style="margin-top:6px;font-size:13px;color:#64748b;">Anterior: ${input.previousDelayedOrders} | Variacao: ${currentDelayDelta}%</div></div>
          </div>
          <section style="display:grid;grid-template-columns:minmax(0,1fr) minmax(360px,0.95fr);gap:20px;margin-top:26px;align-items:start;">
            <div style="border:1px solid #dbeafe;border-radius:22px;padding:22px;background:#f8fbff;">
              <h2 style="margin:0 0 18px;font-size:20px;color:#0f172a;">Indices de status no mes encerrado</h2>
              ${buildMetricBars(input.statusSummary.map((item, index) => ({
            label: item.label,
            value: item.currentCount,
            color: ['#64748b', '#2563eb', '#0ea5e9', '#7c3aed', '#10b981', '#ef4444', '#f59e0b', '#334155', '#8b5cf6'][index % 9],
        })))}
            </div>
            <div style="border:1px solid #dbeafe;border-radius:22px;padding:22px;background:#f8fbff;">
              <h2 style="margin:0 0 18px;font-size:20px;color:#0f172a;">Comparativo por status</h2>
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:14px;">
                <thead>
                  <tr>
                    <th align="left" style="padding:0 0 10px;color:#64748b;">Status</th>
                    <th align="right" style="padding:0 0 10px;color:#64748b;">Atual</th>
                    <th align="right" style="padding:0 0 10px;color:#64748b;">Anterior</th>
                    <th align="right" style="padding:0 0 10px;color:#64748b;">Delta</th>
                  </tr>
                </thead>
                <tbody>
                  ${input.statusSummary
            .map((item) => `<tr><td style="padding:8px 0;border-top:1px solid #dbeafe;">${escapeHtml(item.label)}</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${item.currentCount}</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${item.previousCount}</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${item.delta > 0 ? '+' : ''}${item.delta}</td></tr>`)
            .join('')}
                </tbody>
              </table>
            </div>
          </section>
          <section style="margin-top:28px;">
            <h2 style="margin:0 0 18px;font-size:22px;color:#0f172a;">Pedidos com movimentacao no mes encerrado</h2>
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:13px;color:#334155;background:#ffffff;border:1px solid #dbeafe;border-radius:18px;overflow:hidden;">
              <thead>
                <tr style="background:#f8fafc;color:#475569;">
                  <th align="left" style="padding:10px;border-bottom:1px solid #e2e8f0;">Pedido</th>
                  <th align="left" style="padding:10px;border-bottom:1px solid #e2e8f0;">Cliente</th>
                  <th align="left" style="padding:10px;border-bottom:1px solid #e2e8f0;">Status</th>
                  <th align="left" style="padding:10px;border-bottom:1px solid #e2e8f0;">Canal</th>
                  <th align="left" style="padding:10px;border-bottom:1px solid #e2e8f0;">Transportadora</th>
                  <th align="left" style="padding:10px;border-bottom:1px solid #e2e8f0;">Ultima atualizacao</th>
                </tr>
              </thead>
              <tbody>
                ${movementRows}
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </div>
  </body>
</html>
    `;
    }
    buildEmailHtml(input) {
        const currentLabel = formatMonthLabel(input.currentPeriodStart);
        const previousLabel = formatMonthLabel(input.previousPeriodStart);
        const topStatuses = input.statusSummary
            .filter((item) => item.currentCount > 0 || item.previousCount > 0)
            .sort((left, right) => right.currentCount - left.currentCount)
            .slice(0, 5);
        return `
<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Relatorio mensal</title>
  </head>
  <body style="margin:0;padding:0;background:#0b1220;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <div style="padding:28px 16px;background:radial-gradient(circle at top,#1d4ed8 0%,#0b1220 58%);">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:760px;margin:0 auto;">
        <tr>
          <td>
            <div style="background:#ffffff;border-radius:24px;overflow:hidden;border:1px solid #dbeafe;box-shadow:0 24px 70px rgba(15,23,42,0.35);">
              <div style="padding:28px 32px 18px;background:linear-gradient(135deg,#0f172a 0%,#1d4ed8 100%);">
                <img src="${APP_LOGO_URL}" alt="Avantracking" style="height:52px;display:block;max-width:220px;" />
                <p style="margin:18px 0 0;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#bfdbfe;">
                  Relatorio mensal de movimentacao
                </p>
                <h1 style="margin:10px 0 0;font-size:30px;line-height:1.15;color:#ffffff;">
                  ${escapeHtml(input.companyName)}
                </h1>
                <p style="margin:12px 0 0;font-size:14px;line-height:1.7;color:#dbeafe;">
                  Fechamento de ${escapeHtml(currentLabel)} comparado a ${escapeHtml(previousLabel)}.
                </p>
              </div>
              <div style="padding:28px 32px;">
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;">
                  <div style="border:1px solid #e2e8f0;border-radius:18px;padding:16px;background:#f8fafc;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#64748b;">Movimentados</div><div style="margin-top:8px;font-size:26px;font-weight:700;color:#0f172a;">${input.currentMovedOrders.length}</div><div style="margin-top:6px;font-size:12px;color:#64748b;">Anterior: ${input.previousMovedOrders.length}</div></div>
                  <div style="border:1px solid #e2e8f0;border-radius:18px;padding:16px;background:#f8fafc;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#64748b;">Criados</div><div style="margin-top:8px;font-size:26px;font-weight:700;color:#2563eb;">${input.currentCreatedOrders}</div><div style="margin-top:6px;font-size:12px;color:#64748b;">Anterior: ${input.previousCreatedOrders}</div></div>
                  <div style="border:1px solid #e2e8f0;border-radius:18px;padding:16px;background:#f8fafc;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#64748b;">Em atraso</div><div style="margin-top:8px;font-size:26px;font-weight:700;color:#ef4444;">${input.currentDelayedOrders}</div><div style="margin-top:6px;font-size:12px;color:#64748b;">Anterior: ${input.previousDelayedOrders}</div></div>
                </div>
                <div style="margin-top:24px;padding:20px;border:1px solid #dbeafe;border-radius:18px;background:#f8fbff;">
                  <h2 style="margin:0 0 14px;font-size:18px;color:#0f172a;">Principais status do mes encerrado</h2>
                  ${buildMetricBars(topStatuses.map((item, index) => ({
            label: `${item.label} (${item.currentCount})`,
            value: item.currentCount,
            color: ['#64748b', '#2563eb', '#0ea5e9', '#7c3aed', '#10b981'][index % 5],
        })))}
                </div>
                <div style="margin-top:28px;text-align:center;">
                  <a href="${input.reportUrl}" style="display:inline-block;padding:15px 24px;border-radius:999px;background:linear-gradient(135deg,#2563eb 0%,#0f172a 100%);color:#ffffff;text-decoration:none;font-weight:700;margin-right:8px;">
                    Abrir relatorio completo
                  </a>
                  <a href="${input.csvUrl}" style="display:inline-block;padding:15px 24px;border-radius:999px;background:#eff6ff;color:#1d4ed8;text-decoration:none;font-weight:700;border:1px solid #bfdbfe;">
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
    }
    buildEmailText(input) {
        return [
            `Relatorio mensal de movimentacao - ${input.companyName}`,
            `Mes encerrado: ${formatMonthLabel(input.currentPeriodStart)}`,
            `Mes anterior: ${formatMonthLabel(input.previousPeriodStart)}`,
            `Pedidos movimentados: ${input.currentMovedOrders.length} (anterior: ${input.previousMovedOrders.length})`,
            `Pedidos criados: ${input.currentCreatedOrders} (anterior: ${input.previousCreatedOrders})`,
            `Pedidos em atraso: ${input.currentDelayedOrders} (anterior: ${input.previousDelayedOrders})`,
            '',
            `Relatorio completo: ${input.reportUrl}`,
            `CSV detalhado: ${input.csvUrl}`,
        ].join('\n');
    }
    async sendCompanyReport(companyId, sentEmailsInCycle) {
        const companyResult = await (0, db_1.dbQuery)(`
        SELECT c."id", c."name"
        FROM "Company" c
        WHERE c."id" = $1
        LIMIT 1
      `, [companyId]);
        const company = companyResult.rows[0] || null;
        if (!company)
            return;
        const recipients = (await this.resolveRecipients(company.id)).filter((recipient) => !sentEmailsInCycle.has(this.normalizeEmail(recipient.email)));
        if (recipients.length === 0)
            return;
        const now = new Date();
        const currentPeriodStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const currentPeriodEndExclusive = new Date(now.getFullYear(), now.getMonth(), 1);
        const currentPeriodEnd = new Date(currentPeriodEndExclusive.getTime() - 1);
        const previousPeriodStart = new Date(now.getFullYear(), now.getMonth() - 2, 1);
        const previousPeriodEndExclusive = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const previousPeriodEnd = new Date(previousPeriodEndExclusive.getTime() - 1);
        const ordersResult = await (0, db_1.dbQuery)(`
        SELECT
          o."orderNumber",
          o."customerName",
          o."salesChannel",
          o."freightType",
          o."status",
          o."isDelayed",
          o."trackingCode",
          o."shippingDate",
          o."estimatedDeliveryDate",
          o."carrierEstimatedDeliveryDate",
          o."createdAt",
          o."lastUpdate",
          o."lastApiSync"
        FROM "Order" o
        WHERE o."companyId" = $1
        ORDER BY o."lastUpdate" DESC
      `, [company.id]);
        const orders = ordersResult.rows.map(mapMonthlyOrderRow);
        const currentMovedOrders = this.getMovementOrders(orders, currentPeriodStart, currentPeriodEndExclusive);
        const previousMovedOrders = this.getMovementOrders(orders, previousPeriodStart, previousPeriodEndExclusive);
        const currentDelayedOrders = currentMovedOrders.filter((order) => order.isDelayed).length;
        const previousDelayedOrders = previousMovedOrders.filter((order) => order.isDelayed).length;
        const currentCreatedOrders = orders.filter((order) => order.createdAt >= currentPeriodStart &&
            order.createdAt < currentPeriodEndExclusive).length;
        const previousCreatedOrders = orders.filter((order) => order.createdAt >= previousPeriodStart &&
            order.createdAt < previousPeriodEndExclusive).length;
        const statusSummary = this.buildStatusSummary(currentMovedOrders, previousMovedOrders);
        const reportId = crypto_1.default.randomUUID();
        const baseUrl = (0, publicBaseUrl_1.getPublicBaseUrl)();
        const reportUrl = `${baseUrl}/reports/monthly-summary/${reportId}.html`;
        const csvUrl = `${baseUrl}/reports/monthly-summary/${reportId}.csv`;
        const reportInput = {
            companyName: company.name,
            currentPeriodStart,
            currentPeriodEnd,
            previousPeriodStart,
            previousPeriodEnd,
            reportUrl,
            csvUrl,
            totalOrders: orders.length,
            currentMovedOrders,
            previousMovedOrders,
            currentDelayedOrders,
            previousDelayedOrders,
            currentCreatedOrders,
            previousCreatedOrders,
            statusSummary,
        };
        const reportHtml = this.buildReportHtml(reportInput);
        const reportCsv = this.buildCsvContent(reportInput);
        const emailHtml = this.buildEmailHtml(reportInput);
        const emailText = this.buildEmailText(reportInput);
        const reportsDir = getReportsDir();
        await promises_1.default.mkdir(reportsDir, { recursive: true });
        await Promise.all([
            promises_1.default.writeFile(path_1.default.join(reportsDir, `${reportId}.html`), reportHtml, 'utf8'),
            promises_1.default.writeFile(path_1.default.join(reportsDir, `${reportId}.csv`), reportCsv, 'utf8'),
        ]);
        await (0, emailTransportService_1.sendBrevoEmail)({
            to: recipients,
            subject: `Relatorio mensal de movimentacao - ${company.name}`,
            htmlContent: emailHtml,
            textContent: emailText,
        });
        for (const recipient of recipients) {
            const normalizedEmail = this.normalizeEmail(recipient.email);
            if (normalizedEmail) {
                sentEmailsInCycle.add(normalizedEmail);
            }
        }
    }
    async run() {
        const cycleKey = this.getClosedMonthCycleKey();
        if (this.runningCycleKey === cycleKey) {
            return;
        }
        if (this.completedCycleKeys.has(cycleKey)) {
            return;
        }
        this.runningCycleKey = cycleKey;
        try {
            const sentEmailsInCycle = new Set();
            const companiesResult = await (0, db_1.dbQuery)(`
          SELECT DISTINCT c."id"
          FROM "Company" c
          INNER JOIN "User" u ON u."companyId" = c."id"
          ORDER BY c."id" ASC
        `);
            const companies = companiesResult.rows;
            for (const company of companies) {
                try {
                    await this.sendCompanyReport(company.id, sentEmailsInCycle);
                }
                catch (error) {
                    console.error(`Erro ao enviar relatorio mensal da empresa ${company.id}:`, error);
                }
            }
            this.completedCycleKeys.add(cycleKey);
        }
        catch (error) {
            console.error('Erro ao executar relatorio mensal:', error);
        }
        finally {
            this.runningCycleKey = null;
        }
    }
}
exports.monthlyMovementReportService = new MonthlyMovementReportService();
