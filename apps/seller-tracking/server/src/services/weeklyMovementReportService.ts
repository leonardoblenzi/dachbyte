import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { OrderStatus } from '../types/orderStatus';
import { sendBrevoEmail } from './emailTransportService';
import { dbQuery } from '../lib/db';
import { getPublicBaseUrl } from '../utils/publicBaseUrl';
const APP_LOGO_URL =
  'https://res.cloudinary.com/dhqxp3tuo/image/upload/v1771249579/ChatGPT_Image_13_de_fev._de_2026_16_40_14_kldj3k.png';
const WEEKLY_REPORT_HOUR = 15;
const WEEKLY_REPORT_WEEKDAY = 5;
const MAX_TIMEOUT_MS = 2_147_483_647;

const STATUS_LABELS: Record<OrderStatus, string> = {
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

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const escapeCsv = (value: unknown) => {
  const text = String(value ?? '');
  if (/[",;\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
};

const formatDateTime = (value: Date | string | null) =>
  value ? new Date(value).toLocaleString('pt-BR') : '-';

const formatDateOnly = (value: Date | string | null) =>
  value ? new Date(value).toLocaleDateString('pt-BR') : '-';

const getReportsDir = () =>
  path.join(__dirname, '../../public/reports/weekly-summary');

const buildMetricBars = (
  metrics: Array<{ label: string; value: number; color: string }>,
) => {
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

type WeeklyReportOrder = {
  orderNumber: string;
  customerName: string;
  salesChannel: string;
  freightType: string | null;
  status: OrderStatus;
  isDelayed: boolean;
  trackingCode: string | null;
  shippingDate: Date | null;
  estimatedDeliveryDate: Date | null;
  carrierEstimatedDeliveryDate: Date | null;
  createdAt: Date;
  lastUpdate: Date;
  lastApiSync: Date | null;
};

const toDateOrNull = (value: unknown) => {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const mapWeeklyOrderRow = (row: any): WeeklyReportOrder => ({
  orderNumber: String(row.orderNumber || ''),
  customerName: String(row.customerName || ''),
  salesChannel: String(row.salesChannel || ''),
  freightType: row.freightType || null,
  status: row.status as OrderStatus,
  isDelayed: Boolean(row.isDelayed),
  trackingCode: row.trackingCode || null,
  shippingDate: toDateOrNull(row.shippingDate),
  estimatedDeliveryDate: toDateOrNull(row.estimatedDeliveryDate),
  carrierEstimatedDeliveryDate: toDateOrNull(row.carrierEstimatedDeliveryDate),
  createdAt: toDateOrNull(row.createdAt) || new Date(0),
  lastUpdate: toDateOrNull(row.lastUpdate) || new Date(0),
  lastApiSync: toDateOrNull(row.lastApiSync),
});

class WeeklyMovementReportService {
  private timeout: NodeJS.Timeout | null = null;
  private scheduleInitialized = false;

  private resolveNextRun() {
    const now = new Date();
    const nextRun = new Date(now);
    nextRun.setHours(WEEKLY_REPORT_HOUR, 0, 0, 0);

    const currentDay = nextRun.getDay();
    let dayDiff = WEEKLY_REPORT_WEEKDAY - currentDay;

    if (dayDiff < 0 || (dayDiff === 0 && nextRun <= now)) {
      dayDiff += 7;
    }

    nextRun.setDate(nextRun.getDate() + dayDiff);
    return nextRun;
  }

  private scheduleNext() {
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

  private async resolveRecipients(companyId: string) {
    const usersResult = await dbQuery<any>(
      `
        SELECT
          u."email",
          u."name"
        FROM "User" u
        WHERE u."companyId" = $1
        ORDER BY u."createdAt" ASC
      `,
      [companyId],
    );
    const users = usersResult.rows;

    const recipients = new Map<string, { email: string; name: string }>();

    for (const user of users) {
      const normalizedEmail = String(user.email || '').trim().toLowerCase();
      if (!normalizedEmail) continue;

      recipients.set(normalizedEmail, {
        email: user.email,
        name: user.name || user.email,
      });
    }

    return Array.from(recipients.values());
  }

  private buildStatusSummary(orders: WeeklyReportOrder[]) {
    const summary = Object.values(OrderStatus).map((status) => ({
      status,
      label: STATUS_LABELS[status],
      count: orders.filter((order) => order.status === status).length,
    }));

    return summary;
  }

  private buildCsvContent(input: {
    companyName: string;
    periodStart: Date;
    periodEnd: Date;
    reportUrl: string;
    csvUrl: string;
    totalOrders: number;
    delayedOrders: number;
    movedOrders: WeeklyReportOrder[];
    statusSummary: Array<{ status: OrderStatus; label: string; count: number }>;
  }) {
    const lines: unknown[][] = [
      ['Empresa', input.companyName],
      ['Periodo inicial', formatDateOnly(input.periodStart)],
      ['Periodo final', formatDateOnly(input.periodEnd)],
      ['Relatorio web', input.reportUrl],
      ['CSV', input.csvUrl],
      [],
      ['Indicador', 'Valor'],
      ['Total de pedidos na empresa', input.totalOrders],
      ['Pedidos com movimentacao nos ultimos 7 dias', input.movedOrders.length],
      ['Pedidos em atraso', input.delayedOrders],
      [],
      ['Status', 'Quantidade'],
      ...input.statusSummary.map((item) => [item.label, item.count]),
      [],
      [
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

    for (const order of input.movedOrders) {
      lines.push([
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

  private buildReportHtml(input: {
    companyName: string;
    periodStart: Date;
    periodEnd: Date;
    reportUrl: string;
    csvUrl: string;
    totalOrders: number;
    delayedOrders: number;
    movedOrders: WeeklyReportOrder[];
    statusSummary: Array<{ status: OrderStatus; label: string; count: number }>;
  }) {
    const bars = buildMetricBars(
      input.statusSummary.map((item, index) => ({
        label: item.label,
        value: item.count,
        color: ['#64748b', '#2563eb', '#0ea5e9', '#7c3aed', '#10b981', '#ef4444', '#f59e0b', '#334155', '#8b5cf6'][index % 9],
      })),
    );

    const movementRows =
      input.movedOrders.length > 0
        ? input.movedOrders
            .map(
              (order) => `
                <tr>
                  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">#${escapeHtml(order.orderNumber)}</td>
                  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(order.customerName)}</td>
                  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(STATUS_LABELS[order.status])}</td>
                  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(order.salesChannel)}</td>
                  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(order.freightType || '-')}</td>
                  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(formatDateTime(order.lastUpdate))}</td>
                </tr>
              `,
            )
            .join('')
        : `
          <tr>
            <td colspan="6" style="padding:12px 10px;border-bottom:1px solid #e2e8f0;color:#64748b;">
              Nenhum pedido teve movimentacao registrada nos ultimos 7 dias.
            </td>
          </tr>
        `;

    return `
<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Relatorio semanal - ${escapeHtml(input.companyName)}</title>
  </head>
  <body style="margin:0;background:#eff6ff;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <div style="padding:32px 16px;background:radial-gradient(circle at top,#1d4ed8 0%,#0f172a 55%);">
      <div style="max-width:1120px;margin:0 auto;">
        <div style="background:#ffffff;border-radius:28px;padding:30px 32px;box-shadow:0 30px 90px rgba(15,23,42,0.28);">
          <div style="display:flex;justify-content:space-between;gap:20px;align-items:flex-start;flex-wrap:wrap;">
            <div>
              <img src="${APP_LOGO_URL}" alt="Avantracking" style="height:56px;max-width:240px;" />
              <p style="margin:16px 0 0;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#2563eb;font-weight:700;">
                Relatorio semanal de movimentacao
              </p>
              <h1 style="margin:10px 0 0;font-size:34px;line-height:1.15;color:#0f172a;">
                ${escapeHtml(input.companyName)}
              </h1>
              <p style="margin:10px 0 0;color:#475569;line-height:1.7;max-width:760px;">
                Consolidado dos ultimos 7 dias com indices gerais de status e pedidos que tiveram movimentacao na empresa.
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
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-top:28px;">
            <div style="padding:18px;border-radius:18px;background:#eff6ff;border:1px solid #bfdbfe;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#1d4ed8;font-weight:700;">Periodo</div><div style="margin-top:8px;font-size:15px;color:#0f172a;">${escapeHtml(formatDateOnly(input.periodStart))} a ${escapeHtml(formatDateOnly(input.periodEnd))}</div></div>
            <div style="padding:18px;border-radius:18px;background:#eff6ff;border:1px solid #bfdbfe;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#1d4ed8;font-weight:700;">Pedidos na empresa</div><div style="margin-top:8px;font-size:15px;color:#0f172a;">${input.totalOrders}</div></div>
            <div style="padding:18px;border-radius:18px;background:#eff6ff;border:1px solid #bfdbfe;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#1d4ed8;font-weight:700;">Movimentados em 7 dias</div><div style="margin-top:8px;font-size:15px;color:#0f172a;">${input.movedOrders.length}</div></div>
            <div style="padding:18px;border-radius:18px;background:#eff6ff;border:1px solid #bfdbfe;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#1d4ed8;font-weight:700;">Em atraso</div><div style="margin-top:8px;font-size:15px;color:#0f172a;">${input.delayedOrders}</div></div>
          </div>
          <section style="display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,0.9fr);gap:20px;margin-top:26px;align-items:start;">
            <div style="border:1px solid #dbeafe;border-radius:22px;padding:22px;background:#f8fbff;">
              <h2 style="margin:0 0 18px;font-size:20px;color:#0f172a;">Indices de status</h2>
              ${bars}
            </div>
            <div style="border:1px solid #dbeafe;border-radius:22px;padding:22px;background:#f8fbff;">
              <h2 style="margin:0 0 18px;font-size:20px;color:#0f172a;">Resumo por status</h2>
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:14px;">
                <tbody>
                  ${input.statusSummary
                    .map(
                      (item) => `<tr><td style="padding:8px 0;border-top:1px solid #dbeafe;">${escapeHtml(item.label)}</td><td align="right" style="padding:8px 0;border-top:1px solid #dbeafe;">${item.count}</td></tr>`,
                    )
                    .join('')}
                </tbody>
              </table>
            </div>
          </section>
          <section style="margin-top:28px;">
            <h2 style="margin:0 0 18px;font-size:22px;color:#0f172a;">Pedidos com movimentacao nos ultimos 7 dias</h2>
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

  private buildEmailHtml(input: {
    companyName: string;
    periodStart: Date;
    periodEnd: Date;
    reportUrl: string;
    csvUrl: string;
    totalOrders: number;
    delayedOrders: number;
    movedOrders: WeeklyReportOrder[];
    statusSummary: Array<{ status: OrderStatus; label: string; count: number }>;
  }) {
    const topStatuses = input.statusSummary
      .filter((item) => item.count > 0)
      .sort((left, right) => right.count - left.count)
      .slice(0, 5);

    return `
<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Relatorio semanal</title>
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
                  Relatorio semanal de movimentacao
                </p>
                <h1 style="margin:10px 0 0;font-size:30px;line-height:1.15;color:#ffffff;">
                  ${escapeHtml(input.companyName)}
                </h1>
                <p style="margin:12px 0 0;font-size:14px;line-height:1.7;color:#dbeafe;">
                  Periodo: ${escapeHtml(formatDateOnly(input.periodStart))} a ${escapeHtml(formatDateOnly(input.periodEnd))}. Movimentados: ${input.movedOrders.length}. Em atraso: ${input.delayedOrders}.
                </p>
              </div>
              <div style="padding:28px 32px;">
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;">
                  <div style="border:1px solid #e2e8f0;border-radius:18px;padding:16px;background:#f8fafc;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#64748b;">Pedidos</div><div style="margin-top:8px;font-size:26px;font-weight:700;color:#0f172a;">${input.totalOrders}</div></div>
                  <div style="border:1px solid #e2e8f0;border-radius:18px;padding:16px;background:#f8fafc;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#64748b;">Movimentados</div><div style="margin-top:8px;font-size:26px;font-weight:700;color:#2563eb;">${input.movedOrders.length}</div></div>
                  <div style="border:1px solid #e2e8f0;border-radius:18px;padding:16px;background:#f8fafc;"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#64748b;">Em atraso</div><div style="margin-top:8px;font-size:26px;font-weight:700;color:#ef4444;">${input.delayedOrders}</div></div>
                </div>
                <div style="margin-top:24px;padding:20px;border:1px solid #dbeafe;border-radius:18px;background:#f8fbff;">
                  <h2 style="margin:0 0 14px;font-size:18px;color:#0f172a;">Principais status</h2>
                  ${buildMetricBars(
                    topStatuses.map((item, index) => ({
                      label: item.label,
                      value: item.count,
                      color: ['#64748b', '#2563eb', '#0ea5e9', '#7c3aed', '#10b981'][index % 5],
                    })),
                  )}
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

  private buildEmailText(input: {
    companyName: string;
    periodStart: Date;
    periodEnd: Date;
    reportUrl: string;
    csvUrl: string;
    totalOrders: number;
    delayedOrders: number;
    movedOrders: WeeklyReportOrder[];
  }) {
    return [
      `Relatorio semanal de movimentacao - ${input.companyName}`,
      `Periodo: ${formatDateOnly(input.periodStart)} a ${formatDateOnly(input.periodEnd)}`,
      `Total de pedidos: ${input.totalOrders}`,
      `Pedidos com movimentacao nos ultimos 7 dias: ${input.movedOrders.length}`,
      `Pedidos em atraso: ${input.delayedOrders}`,
      '',
      `Relatorio completo: ${input.reportUrl}`,
      `CSV detalhado: ${input.csvUrl}`,
    ].join('\n');
  }

  private async sendCompanyReport(companyId: string) {
    const companyResult = await dbQuery<any>(
      `
        SELECT c."id", c."name"
        FROM "Company" c
        WHERE c."id" = $1
        LIMIT 1
      `,
      [companyId],
    );
    const company = companyResult.rows[0] || null;

    if (!company) return;

    const recipients = await this.resolveRecipients(company.id);
    if (recipients.length === 0) return;

    const periodEnd = new Date();
    const periodStart = new Date();
    periodStart.setDate(periodStart.getDate() - 7);
    periodStart.setHours(0, 0, 0, 0);

    const ordersResult = await dbQuery<any>(
      `
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
      `,
      [company.id],
    );
    const orders = ordersResult.rows.map(mapWeeklyOrderRow);

    const movedOrders = orders.filter(
      (order) =>
        order.createdAt >= periodStart ||
        order.lastUpdate >= periodStart ||
        (order.lastApiSync && order.lastApiSync >= periodStart),
    );

    const delayedOrders = orders.filter((order) => order.isDelayed).length;
    const statusSummary = this.buildStatusSummary(orders);
    const reportId = crypto.randomUUID();
    const baseUrl = getPublicBaseUrl();
    const reportUrl = `${baseUrl}/reports/weekly-summary/${reportId}.html`;
    const csvUrl = `${baseUrl}/reports/weekly-summary/${reportId}.csv`;
    const reportInput = {
      companyName: company.name,
      periodStart,
      periodEnd,
      reportUrl,
      csvUrl,
      totalOrders: orders.length,
      delayedOrders,
      movedOrders,
      statusSummary,
    };

    const reportHtml = this.buildReportHtml(reportInput);
    const reportCsv = this.buildCsvContent(reportInput);
    const emailHtml = this.buildEmailHtml(reportInput);
    const emailText = this.buildEmailText(reportInput);
    const reportsDir = getReportsDir();

    await fs.mkdir(reportsDir, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(reportsDir, `${reportId}.html`), reportHtml, 'utf8'),
      fs.writeFile(path.join(reportsDir, `${reportId}.csv`), reportCsv, 'utf8'),
    ]);

    await sendBrevoEmail({
      to: recipients,
      subject: `Relatorio semanal de movimentacao - ${company.name}`,
      htmlContent: emailHtml,
      textContent: emailText,
    });
  }

  async run() {
    try {
      const companiesResult = await dbQuery<any>(
        `
          SELECT DISTINCT c."id"
          FROM "Company" c
          INNER JOIN "User" u ON u."companyId" = c."id"
          ORDER BY c."id" ASC
        `,
      );
      const companies = companiesResult.rows;

      for (const company of companies) {
        try {
          await this.sendCompanyReport(company.id);
        } catch (error) {
          console.error(
            `Erro ao enviar relatorio semanal da empresa ${company.id}:`,
            error,
          );
        }
      }
    } catch (error) {
      console.error('Erro ao executar relatorio semanal:', error);
    }
  }
}

export const weeklyMovementReportService = new WeeklyMovementReportService();
