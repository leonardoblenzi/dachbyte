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

type JetOrderLookupResponse = {
  idOrder: string;
  marketPlaceNumberOrder: string | null;
  marketPlaceID: string | null;
};

const TARGET_COMPANY_NAME = String(process.env.TARGET_COMPANY_NAME || 'MPOZENATO')
  .trim()
  .toUpperCase();
const APPLY_CHANGES = String(process.env.APPLY_CHANGES || '')
  .trim()
  .toLowerCase() === 'true';
const ONLY_ORDER_NUMBERS = String(
  process.env.ONLY_ORDER_NUMBERS || '326136837,326315748',
)
  .split(',')
  .map((item) => String(item || '').trim())
  .filter(Boolean);
const JET_API_KEY = String(process.env.JET_API_KEY || '').trim();
const JET_BASE_URL = String(
  process.env.JET_BASE_URL || 'https://openapi.plataformaneo.com.br',
)
  .trim()
  .replace(/\/+$/, '');
const JET_API_VERSION = String(process.env.JET_API_VERSION || '1').trim() || '1';
const DEFAULT_INTELIPOST_CLIENT_ID = '40115';

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

const parseOrderNumberIdMap = () => {
  const rawValue = String(process.env.ORDER_NUMBER_ID_MAP || '').trim();
  if (!rawValue) {
    return new Map<string, string>();
  }

  try {
    const parsed = JSON.parse(rawValue);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return new Map<string, string>(
        Object.entries(parsed)
          .map(([from, to]) => [String(from).trim(), normalizeDigits(to)] as const)
          .filter(([from, to]) => from.length > 0 && to.length > 0),
      );
    }
  } catch {
    // fallback abaixo para formato csv
  }

  return new Map<string, string>(
    rawValue
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

const listTargetOrders = async (companyId: string) => {
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
      JOIN LATERAL (
        SELECT
          te."status",
          te."description"
        FROM "TrackingEvent" te
        WHERE te."orderId" = o."id"
        ORDER BY te."eventDate" DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE o."companyId" = $1
        AND (
          latest."status" = 'UNKNOWN'
          OR UPPER(COALESCE(latest."description", '')) LIKE 'RASTREAMENTO ANYMARKET: UNKNOWN.%'
          OR UPPER(COALESCE(latest."description", '')) LIKE 'RASTREAMENTO ANYMARKET: UNKNOW.%'
        )
        AND ($2::boolean = false OR o."orderNumber" = ANY($3::text[]))
      ORDER BY o."orderNumber" ASC
    `,
    [companyId, ONLY_ORDER_NUMBERS.length > 0, ONLY_ORDER_NUMBERS],
  );

  return result.rows;
};

const fetchJetOrderById = async (
  idOrder: string,
  apiKey: string,
): Promise<JetOrderLookupResponse | null> => {
  const normalizedId = normalizeDigits(idOrder);
  if (!normalizedId) {
    return null;
  }

  const url = `${JET_BASE_URL}/order/api/v${encodeURIComponent(
    JET_API_VERSION,
  )}/id/${encodeURIComponent(normalizedId)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      apiKey,
    },
  });

  if (!response.ok) {
    return null;
  }

  const payload = await response.json().catch(() => null);
  const result = payload?.result;
  const resolvedIdOrder = normalizeDigits(result?.idOrder);

  if (!resolvedIdOrder) {
    return null;
  }

  return {
    idOrder: resolvedIdOrder,
    marketPlaceNumberOrder: safeString(result?.marketPlaceNumberOrder),
    marketPlaceID: safeString(result?.marketPlaceID),
  };
};

const resolveJetIdForOrder = async (
  order: OrderRow,
  manualMap: Map<string, string>,
  jetApiKey: string,
) => {
  const orderNumber = String(order.orderNumber || '').trim();
  const rawPayload = order.apiRawPayload || {};

  const fromPayload =
    normalizeDigits(rawPayload?.jetOrderId) ||
    normalizeDigits(rawPayload?.jetMeta?.idOrder) ||
    normalizeDigits(rawPayload?.jetMeta?.jetOrderId);
  if (fromPayload) {
    return {
      idOrder: fromPayload,
      source: 'payload' as const,
      confidence: 'high' as const,
    };
  }

  const fromManualMap = manualMap.get(orderNumber) || '';
  if (fromManualMap) {
    return {
      idOrder: fromManualMap,
      source: 'manual_map' as const,
      confidence: 'high' as const,
    };
  }

  if (!jetApiKey) {
    return null;
  }

  const jetOrder = await fetchJetOrderById(orderNumber, jetApiKey);
  if (!jetOrder) {
    return null;
  }

  return {
    idOrder: jetOrder.idOrder,
    source: 'jet_by_id_probe' as const,
    confidence: 'medium' as const,
  };
};

async function main() {
  const manualMap = parseOrderNumberIdMap();
  const company = await resolveCompany();

  if (!company) {
    console.log(`Empresa nao encontrada para o filtro: ${TARGET_COMPANY_NAME}`);
    return;
  }

  const targetOrders = await listTargetOrders(company.id);

  console.log(`Empresa alvo: ${company.name} (${company.id})`);
  console.log(`Modo: ${APPLY_CHANGES ? 'APLICAR ALTERACOES' : 'SIMULACAO (dry-run)'}`);
  console.log(`Pedidos filtrados: ${targetOrders.length}`);
  console.log(`Filtro manual de pedidos: ${ONLY_ORDER_NUMBERS.join(', ') || '(todos)'}`);
  console.log(`Mapeamentos manuais informados: ${manualMap.size}`);
  console.log(`Jet API Key informada: ${JET_API_KEY ? 'SIM' : 'NAO'}`);

  if (targetOrders.length === 0) {
    console.log('Nenhum pedido alvo encontrado com ultimo rastreio ANYMARKET UNKNOWN/UNKNOW.');
    return;
  }

  const trackingService = new TrackingService();
  let swapped = 0;
  let synced = 0;
  let unresolved = 0;
  let conflicts = 0;
  let syncErrors = 0;

  for (const order of targetOrders) {
    const currentOrderNumber = String(order.orderNumber || '').trim();
    const rawPayload = order.apiRawPayload && typeof order.apiRawPayload === 'object'
      ? order.apiRawPayload
      : {};

    console.log('\n---');
    console.log(
      `Pedido ${currentOrderNumber} | id=${order.id} | arquivado=${order.isArchived ? 'SIM' : 'NAO'} | ultimo="${order.latestTrackingDescription || '-'}"`,
    );

    const resolvedJet = await resolveJetIdForOrder(order, manualMap, JET_API_KEY);
    if (!resolvedJet?.idOrder) {
      unresolved += 1;
      console.log('Sem idOrder resolvido para este pedido (forneca ORDER_NUMBER_ID_MAP).');
      continue;
    }

    const targetJetId = normalizeDigits(resolvedJet.idOrder);
    if (!targetJetId) {
      unresolved += 1;
      console.log('idOrder resolvido vazio/invalido.');
      continue;
    }

    if (targetJetId === currentOrderNumber) {
      console.log(`Ja esta no idOrder ${targetJetId} (${resolvedJet.source}).`);
    } else {
      const conflictResult = await dbQuery<{ id: string }>(
        `
          SELECT o."id"
          FROM "Order" o
          WHERE o."companyId" = $1
            AND o."orderNumber" = $2
            AND o."id" <> $3
          LIMIT 1
        `,
        [company.id, targetJetId, order.id],
      );

      if (conflictResult.rows[0]) {
        conflicts += 1;
        console.log(
          `Conflito: ja existe outro pedido com orderNumber ${targetJetId}.`,
        );
        continue;
      }

      const nextPayload = {
        ...rawPayload,
        jetOrderId: targetJetId,
        jetMeta: {
          ...(rawPayload.jetMeta && typeof rawPayload.jetMeta === 'object'
            ? rawPayload.jetMeta
            : {}),
          idOrder: targetJetId,
          previousOrderNumber: currentOrderNumber,
          normalizedAt: new Date().toISOString(),
          normalizedBy: 'script-remap-unknown-tracking',
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
            [order.id, targetJetId, JSON.stringify(nextPayload)],
          );
        });
      }

      swapped += 1;
      console.log(
        `${APPLY_CHANGES ? 'Atualizado' : 'Planejado'}: ${currentOrderNumber} -> ${targetJetId} (${resolvedJet.source}).`,
      );
    }

    const intelipostClientId = company.intelipostIntegrationEnabled === false
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
        orderNumber: normalizeDigits(resolvedJet.idOrder) || order.orderNumber,
        apiRawPayload: {
          ...(rawPayload || {}),
          source: 'INTELIPOST',
        },
      } as any,
    });

    if (!syncResult.success) {
      syncErrors += 1;
      console.log(`Sync Intelipost falhou: ${syncResult.message}`);
      continue;
    }

    synced += 1;
    console.log(`Sync Intelipost OK: ${syncResult.message}`);
  }

  console.log('\n===== Resumo =====');
  console.log(`Pedidos alvo encontrados: ${targetOrders.length}`);
  console.log(`Trocas de orderNumber (planejadas/aplicadas): ${swapped}`);
  console.log(`Sync Intelipost com sucesso: ${synced}`);
  console.log(`Sem idOrder resolvido: ${unresolved}`);
  console.log(`Conflitos de orderNumber: ${conflicts}`);
  console.log(`Falhas no sync Intelipost: ${syncErrors}`);

  if (!APPLY_CHANGES) {
    console.log('\nDry-run finalizado. Para aplicar no banco, execute com APPLY_CHANGES=true.');
    console.log(
      'Se algum pedido ficar "Sem idOrder resolvido", informe ORDER_NUMBER_ID_MAP no formato JSON ou "order:idOrder".',
    );
  }
}

main().catch((error) => {
  console.error('Falha no remapeamento/sync de pedidos ANYMARKET UNKNOWN:', formatError(error));
  process.exitCode = 1;
});
