import fs from 'fs';
import path from 'path';
import { dbQuery, withDbTransaction } from '../lib/db';
import { TrackingService } from '../services/trackingService';

type CompanyRow = {
  id: string;
  name: string;
  intelipostIntegrationEnabled: boolean;
  intelipostClientId: string | null;
};

type OrderRow = {
  id: string;
  companyId: string;
  orderNumber: string;
  isArchived: boolean;
  status: string;
  invoiceNumber: string | null;
  trackingCode: string | null;
  customerName: string | null;
  freightType: string | null;
  isDelayed: boolean;
  estimatedDeliveryDate: Date | null;
  carrierEstimatedDeliveryDate: Date | null;
  lastApiSync: Date | null;
  apiRawPayload: any;
  latestTrackingStatus: string | null;
  latestTrackingDescription: string | null;
};

type JetCsvRow = Record<string, string>;

const TARGET_COMPANY_NAME = String(process.env.TARGET_COMPANY_NAME || 'MPOZENATO')
  .trim()
  .toUpperCase();
const APPLY_CHANGES = String(process.env.APPLY_CHANGES || '')
  .trim()
  .toLowerCase() === 'true';
const INCLUDE_ARCHIVED = String(process.env.INCLUDE_ARCHIVED || 'true')
  .trim()
  .toLowerCase() !== 'false';
const ONLY_UNKNOWN_TRACKING = String(process.env.ONLY_UNKNOWN_TRACKING || 'true')
  .trim()
  .toLowerCase() !== 'false';
const DEFAULT_INTELIPOST_CLIENT_ID = '40115';
const MAP_CSV_PATH = String(process.env.MAP_CSV_PATH || '').trim();
const ORDER_NUMBER_ID_MAP_RAW = String(process.env.ORDER_NUMBER_ID_MAP || '').trim();

const normalizeDigits = (value: unknown) =>
  String(value || '')
    .replace(/\D/g, '')
    .trim();

const safeString = (value: unknown) => {
  const normalized = String(value || '').trim();
  return normalized || null;
};

const formatError = (error: unknown) =>
  error instanceof Error ? error.message : 'Erro desconhecido';

const normalizeKey = (value: string) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .toLowerCase();

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  return ['1', 'true', 'yes', 'sim'].includes(normalized);
};

const parseCsvLine = (line: string, delimiter: string) => {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      fields.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  fields.push(current.trim());
  return fields;
};

const parseJetCsv = (csvContent: string) => {
  const rows = csvContent
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (rows.length === 0) {
    return [] as JetCsvRow[];
  }

  const headerLine = rows[0];
  const semicolonCount = (headerLine.match(/;/g) || []).length;
  const commaCount = (headerLine.match(/,/g) || []).length;
  const delimiter = semicolonCount > commaCount ? ';' : ',';

  const headers = parseCsvLine(headerLine, delimiter).map((header) =>
    normalizeKey(header),
  );

  const parsedRows: JetCsvRow[] = [];

  for (const line of rows.slice(1)) {
    const cols = parseCsvLine(line, delimiter);
    const row: JetCsvRow = {};

    for (let index = 0; index < headers.length; index += 1) {
      const header = headers[index];
      if (!header) continue;
      row[header] = String(cols[index] || '').trim();
    }

    parsedRows.push(row);
  }

  return parsedRows;
};

const parseManualMap = (raw: string) => {
  if (!raw) return new Map<string, string>();

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return new Map<string, string>(
        Object.entries(parsed)
          .map(([from, to]) => [String(from).trim(), normalizeDigits(to)] as const)
          .filter(([from, to]) => from.length > 0 && to.length > 0),
      );
    }
  } catch {
    // fallback csv below
  }

  return new Map<string, string>(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [from, to] = entry.split(':');
        return [String(from || '').trim(), normalizeDigits(to)] as const;
      })
      .filter(([from, to]) => from.length > 0 && to.length > 0),
  );
};

const resolveCompany = async () => {
  const result = await dbQuery<CompanyRow>(
    `
      SELECT
        c."id",
        c."name",
        c."intelipostIntegrationEnabled",
        c."intelipostClientId"
      FROM "Company" c
      WHERE UPPER(c."name") = $1
      LIMIT 1
    `,
    [TARGET_COMPANY_NAME],
  );

  return result.rows[0] || null;
};

const listCompanyOrders = async (companyId: string) => {
  const result = await dbQuery<OrderRow>(
    `
      SELECT
        o."id",
        o."companyId",
        o."orderNumber",
        o."isArchived",
        o."status",
        o."invoiceNumber",
        o."trackingCode",
        o."customerName",
        o."freightType",
        o."isDelayed",
        o."estimatedDeliveryDate",
        o."carrierEstimatedDeliveryDate",
        o."lastApiSync",
        o."apiRawPayload",
        latest."status" AS "latestTrackingStatus",
        latest."description" AS "latestTrackingDescription"
      FROM "Order" o
      LEFT JOIN LATERAL (
        SELECT
          te."status",
          te."description"
        FROM "TrackingEvent" te
        WHERE te."orderId" = o."id"
        ORDER BY te."eventDate" DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE o."companyId" = $1
        AND ($2::boolean = true OR o."isArchived" = false)
        AND (
          $3::boolean = false
          OR latest."status" = 'UNKNOWN'
          OR UPPER(COALESCE(latest."description", '')) LIKE 'RASTREAMENTO ANYMARKET: UNKNOWN.%'
          OR UPPER(COALESCE(latest."description", '')) LIKE 'RASTREAMENTO ANYMARKET: UNKNOW.%'
        )
      ORDER BY o."orderNumber" ASC
    `,
    [companyId, INCLUDE_ARCHIVED, ONLY_UNKNOWN_TRACKING],
  );

  return result.rows;
};

const buildMapFromCsvRows = (rows: JetCsvRow[]) => {
  const mapping = new Map<string, string>();

  for (const row of rows) {
    const idOrder =
      normalizeDigits(row.idorder) ||
      normalizeDigits(row.idpedido) ||
      normalizeDigits(row.id);

    if (!idOrder) continue;

    const candidates = [
      safeString(row.marketplacenumberorder),
      safeString(row.marketplacenumber),
      safeString(row.marketplaceid),
      safeString(row.marketplace_order_number),
      safeString(row.numberordermarketplace),
      safeString(row.pedidomarketplace),
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      if (!mapping.has(candidate)) {
        mapping.set(candidate, idOrder);
      }
    }
  }

  return mapping;
};

async function main() {
  const company = await resolveCompany();
  if (!company) {
    console.log(`Empresa nao encontrada para o filtro: ${TARGET_COMPANY_NAME}`);
    return;
  }

  const manualMap = parseManualMap(ORDER_NUMBER_ID_MAP_RAW);
  let csvMap = new Map<string, string>();

  if (MAP_CSV_PATH) {
    const absoluteCsvPath = path.resolve(MAP_CSV_PATH);
    if (!fs.existsSync(absoluteCsvPath)) {
      throw new Error(`Arquivo CSV nao encontrado: ${absoluteCsvPath}`);
    }

    const csvContent = fs.readFileSync(absoluteCsvPath, 'utf8');
    const csvRows = parseJetCsv(csvContent);
    csvMap = buildMapFromCsvRows(csvRows);
    console.log(`CSV carregado: ${absoluteCsvPath}`);
    console.log(`Linhas do CSV: ${csvRows.length}`);
    console.log(`Mapeamentos identificados no CSV: ${csvMap.size}`);
  }

  const mergedMap = new Map<string, string>(csvMap);
  for (const [key, value] of manualMap.entries()) {
    mergedMap.set(key, value);
  }

  const orders = await listCompanyOrders(company.id);
  console.log(`Empresa alvo: ${company.name} (${company.id})`);
  console.log(`Modo: ${APPLY_CHANGES ? 'APLICAR ALTERACOES' : 'SIMULACAO (dry-run)'}`);
  console.log(`Incluir arquivados: ${INCLUDE_ARCHIVED ? 'SIM' : 'NAO'}`);
  console.log(`Filtrar UNKNOWN: ${ONLY_UNKNOWN_TRACKING ? 'SIM' : 'NAO'}`);
  console.log(`Pedidos candidatos: ${orders.length}`);
  console.log(`Mapeamento final disponivel: ${mergedMap.size}`);

  const trackingService = new TrackingService();
  let swapped = 0;
  let synced = 0;
  let missingMap = 0;
  let conflicts = 0;
  let syncErrors = 0;

  for (const order of orders) {
    const currentOrderNumber = String(order.orderNumber || '').trim();
    const targetIdOrder = normalizeDigits(mergedMap.get(currentOrderNumber) || '');

    if (!targetIdOrder) {
      missingMap += 1;
      continue;
    }

    const payload = order.apiRawPayload && typeof order.apiRawPayload === 'object'
      ? order.apiRawPayload
      : {};

    if (targetIdOrder !== currentOrderNumber) {
      const conflictResult = await dbQuery<{ id: string }>(
        `
          SELECT o."id"
          FROM "Order" o
          WHERE o."companyId" = $1
            AND o."orderNumber" = $2
            AND o."id" <> $3
          LIMIT 1
        `,
        [company.id, targetIdOrder, order.id],
      );

      if (conflictResult.rows[0]) {
        conflicts += 1;
        continue;
      }

      const nextPayload = {
        ...payload,
        jetOrderId: targetIdOrder,
        jetMeta: {
          ...(payload.jetMeta && typeof payload.jetMeta === 'object' ? payload.jetMeta : {}),
          idOrder: targetIdOrder,
          previousOrderNumber: currentOrderNumber,
          normalizedAt: new Date().toISOString(),
          normalizedBy: 'script-remap-from-jet-csv',
        },
      };

      if (APPLY_CHANGES) {
        await withDbTransaction(async (client) => {
          await client.query(
            `
              UPDATE "Order"
              SET
                "orderNumber" = $2,
                "apiRawPayload" = $3::jsonb,
                "lastUpdate" = NOW()
              WHERE "id" = $1
            `,
            [order.id, targetIdOrder, JSON.stringify(nextPayload)],
          );
        });
      }

      swapped += 1;
    }

    const intelipostClientId =
      company.intelipostIntegrationEnabled === false
        ? ''
        : String(company.intelipostClientId || DEFAULT_INTELIPOST_CLIENT_ID).trim();

    const syncResult = await trackingService.syncOrder(order.id, company.id, {
      forceFinalized: true,
      companyTrackingConfig: {
        intelipostClientId,
        intelipostIntegrationEnabled: true,
        sswRequireEnabled: false,
        correiosIntegrationEnabled: false,
        sswRequireCnpjs: [],
      } as any,
      orderSnapshot: {
        ...order,
        isArchived: false,
        orderNumber: targetIdOrder || order.orderNumber,
        apiRawPayload: {
          ...(payload || {}),
          source: 'INTELIPOST',
        },
      } as any,
    });

    if (!syncResult.success) {
      syncErrors += 1;
      continue;
    }

    synced += 1;
  }

  console.log('\n===== Resumo =====');
  console.log(`Pedidos analisados: ${orders.length}`);
  console.log(`Trocas de numero (planejadas/aplicadas): ${swapped}`);
  console.log(`Sem mapeamento no CSV/manual: ${missingMap}`);
  console.log(`Conflitos de orderNumber: ${conflicts}`);
  console.log(`Sync Intelipost com sucesso: ${synced}`);
  console.log(`Falhas no sync Intelipost: ${syncErrors}`);

  if (!APPLY_CHANGES) {
    console.log(
      '\nDry-run finalizado. Para aplicar alteracoes, execute novamente com APPLY_CHANGES=true.',
    );
  }
}

main().catch((error) => {
  console.error('Falha no script de remapeamento/sync via CSV JET:', formatError(error));
  process.exitCode = 1;
});
