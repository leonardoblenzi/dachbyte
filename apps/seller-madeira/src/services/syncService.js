"use strict";

const { randomUUID } = require("crypto");
const {
  getOrCreateDefaultWorkspace,
  getWorkspaceById,
  queryRows,
  withClient,
  toNumber,
} = require("./databaseService");
const { storeCatalogSnapshot } = require("./catalogCacheService");
const { createMadeiraApiClient } = require("./madeiraApiClient");

const client = createMadeiraApiClient();

const ORDER_STATUS_ROUTE_VALUES = [
  "new",
  "approved",
  "received",
  "invoiced",
  "shipped",
  "delivered",
  "cancelled",
];

function sanitizeText(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatLocalDateKey(dateLike) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateValue(value) {
  const normalized = sanitizeText(value);
  if (!normalized) return null;

  const isoCandidate = new Date(normalized);
  if (!Number.isNaN(isoCandidate.getTime())) {
    return isoCandidate.toISOString();
  }

  const localDateMatch = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (localDateMatch) {
    const [, day, month, year] = localDateMatch;
    return new Date(`${year}-${month}-${day}T00:00:00-03:00`).toISOString();
  }

  return null;
}

function parseArrayPayload(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function readMetaCount(payload) {
  const candidates = [
    payload?.meta?.count,
    payload?.meta?.total,
    payload?.pagination?.total,
    payload?.pagination?.total_records,
    payload?.pagination?.count,
  ];

  for (const value of candidates) {
    const parsed = Number.parseInt(String(value || ""), 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }

  return null;
}

async function fetchOffsetPaginatedPages(fetchPage, options = {}) {
  const requestedLimit = parsePositiveInt(options.limit, 100);
  const limit = Math.max(1, Math.min(requestedLimit, 300));
  let offset = Math.max(0, Number.parseInt(String(options.offset || 0), 10) || 0);
  const maxPages = parsePositiveInt(options.maxPages, 60);
  const items = [];
  let pageCount = 0;
  let totalHint = null;
  const pageFingerprints = new Set();
  let sameFingerprintStreak = 0;
  let lastFingerprint = null;

  while (pageCount < maxPages) {
    const result = await fetchPage({ limit, offset });
    const payload = result?.data || null;
    const chunk = parseArrayPayload(payload);

    if (totalHint == null) {
      totalHint = readMetaCount(payload);
    }

    if (!chunk.length) break;

    const firstKey = sanitizeText(
      chunk[0]?.id ||
      chunk[0]?.id_produto ||
      chunk[0]?.id_pedido ||
      chunk[0]?.sku ||
      chunk[0]?.session_id,
    ) || "first";
    const lastKey = sanitizeText(
      chunk[chunk.length - 1]?.id ||
      chunk[chunk.length - 1]?.id_produto ||
      chunk[chunk.length - 1]?.id_pedido ||
      chunk[chunk.length - 1]?.sku ||
      chunk[chunk.length - 1]?.session_id,
    ) || "last";
    const fingerprint = `${chunk.length}:${firstKey}:${lastKey}`;
    if (pageFingerprints.has(fingerprint)) break;
    pageFingerprints.add(fingerprint);
    if (lastFingerprint && lastFingerprint === fingerprint) {
      sameFingerprintStreak += 1;
    } else {
      sameFingerprintStreak = 0;
      lastFingerprint = fingerprint;
    }
    if (sameFingerprintStreak >= 1) break;

    items.push(...chunk);
    pageCount += 1;
    offset += chunk.length;
    if (totalHint != null && items.length >= totalHint) break;
  }

  return {
    items,
    pages: pageCount,
    limit,
    totalHint,
  };
}

function toSettledWarning(label, result) {
  const reason = result?.reason;
  return `${label}: ${reason?.message || "falha ao consultar endpoint."}`;
}

function mapRemoteProductStatus(source) {
  switch (source) {
    case "published":
      return "published";
    case "pending":
      return "queued";
    case "publishing":
      return "validating";
    case "nonCommercialized":
      return "failed";
    default:
      return "draft";
  }
}

function buildCategoryName(remoteProduct) {
  const levels = [
    remoteProduct?.nivel_1,
    remoteProduct?.nivel_2,
    remoteProduct?.nivel_3,
    remoteProduct?.nivel_4,
    remoteProduct?.nivel_5,
    remoteProduct?.nivel_6,
    remoteProduct?.nivel_7,
  ]
    .map((value) => sanitizeText(value))
    .filter(Boolean);

  if (levels.length) {
    return levels[levels.length - 1];
  }

  return sanitizeText(remoteProduct?.nome_categoria) || sanitizeText(remoteProduct?.categoria);
}

function normalizeRemoteImages(images) {
  if (!Array.isArray(images)) return [];

  return images
    .map((image) => {
      if (typeof image === "string") return image;
      return sanitizeText(image?.url || image?.imagem || image?.src);
    })
    .filter(Boolean);
}

function normalizeRemoteAttributes(attributes) {
  if (!Array.isArray(attributes)) return [];

  return attributes
    .map((attribute) => ({
      name: sanitizeText(attribute?.nome || attribute?.name),
      value: sanitizeText(attribute?.valor || attribute?.value),
    }))
    .filter((attribute) => attribute.name && attribute.value);
}

function normalizePublishedProduct(remoteProduct, source) {
  return {
    externalId:
      sanitizeText(remoteProduct?.id_produto) ||
      sanitizeText(remoteProduct?.id_produto_seller) ||
      sanitizeText(remoteProduct?.id),
    categoryExternalId: sanitizeText(remoteProduct?.id_categoria),
    categoryName: buildCategoryName(remoteProduct),
    sku: sanitizeText(remoteProduct?.sku),
    ean: sanitizeText(remoteProduct?.ean),
    title: sanitizeText(remoteProduct?.nome) || sanitizeText(remoteProduct?.titulo),
    description: sanitizeText(remoteProduct?.descricao),
    status: mapRemoteProductStatus(source),
    currentPrice: toNumber(
      remoteProduct?.preco_por ?? remoteProduct?.preco ?? remoteProduct?.preco_atual,
    ),
    compareAtPrice:
      remoteProduct?.preco_de == null ? null : toNumber(remoteProduct?.preco_de),
    stock: Number.parseInt(String(remoteProduct?.estoque ?? 0), 10) || 0,
    weightGrams:
      remoteProduct?.peso == null ? null : Math.round(toNumber(remoteProduct?.peso) * 1000),
    heightCm:
      remoteProduct?.altura == null ? null : Math.round(toNumber(remoteProduct?.altura)),
    widthCm:
      remoteProduct?.largura == null ? null : Math.round(toNumber(remoteProduct?.largura)),
    lengthCm:
      remoteProduct?.profundidade == null
        ? null
        : Math.round(toNumber(remoteProduct?.profundidade)),
    images: normalizeRemoteImages(remoteProduct?.imagens || remoteProduct?.images),
    attributes: normalizeRemoteAttributes(
      remoteProduct?.atributos || remoteProduct?.attributes,
    ),
    payload: {
      syncSource: source,
      externalProductId:
        sanitizeText(remoteProduct?.id_produto) ||
        sanitizeText(remoteProduct?.id) ||
        null,
      categoryExternalId: sanitizeText(remoteProduct?.id_categoria) || null,
      lastMarketplaceUpdate:
        parseDateValue(remoteProduct?.datahora_atualizacao) ||
        parseDateValue(remoteProduct?.datahora_cadastro) ||
        null,
    },
  };
}

function inferOrderStatus(remoteOrder, explicitRouteStatus) {
  const route = sanitizeText(explicitRouteStatus)?.toLowerCase();

  if (route === "cancelled") return "cancelled";
  if (route === "delivered") return "delivered";
  if (route === "shipped") return "shipped";
  if (route === "invoiced") return "ready_to_ship";
  if (route === "approved" || route === "received") return "awaiting_invoice";
  if (route === "new") return "imported";

  if (parseDateValue(remoteOrder?.datahora_cancelamento)) return "cancelled";
  if (parseDateValue(remoteOrder?.datahora_entrega)) return "delivered";
  if (parseDateValue(remoteOrder?.datahora_rastreamento)) return "shipped";
  if (parseDateValue(remoteOrder?.datahora_faturamento)) return "ready_to_ship";
  if (parseDateValue(remoteOrder?.datahora_aprovacao)) return "awaiting_invoice";

  const numericStatus = String(remoteOrder?.status || "").trim();
  if (numericStatus === "8") return "delivered";
  if (numericStatus === "7") return "shipped";
  if (numericStatus === "6") return "ready_to_ship";
  if (numericStatus === "9") return "cancelled";

  return "imported";
}

function mapRemoteThreadStatus(remoteThread) {
  const slug = String(remoteThread?.status?.slug || "").trim().toLowerCase();

  if (slug === "awaiting_answer_seller") return "waiting_seller";
  if (slug === "awaiting_answer_customer") return "waiting_marketplace";
  if (slug.includes("final")) return "closed";
  if (slug.includes("resolved")) return "resolved";
  return "open";
}

function mapRemoteFinancialStatus(remoteEntry) {
  const status = String(remoteEntry?.status || "").trim().toLowerCase();

  if (status.includes("repass")) return "paid";
  if (status.includes("pago")) return "paid";
  if (status.includes("liber")) return "released";
  if (status.includes("bloque")) return "blocked";
  if (status.includes("disput")) return "disputed";
  if (status.includes("cancel")) return "cancelled";
  return "pending";
}

function parseFinancialDetail(detailing) {
  if (!detailing) return [];
  if (Array.isArray(detailing)) return detailing;

  if (typeof detailing === "string") {
    try {
      const parsed = JSON.parse(detailing);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}

function summarizeFinancialDetail(remoteEntry) {
  const items = parseFinancialDetail(remoteEntry?.detalhamento);
  let grossAmount = 0;
  let feeAmount = 0;

  items.forEach((item) => {
    const description = String(item?.descricao || item?.descricao_lancamento || "")
      .trim()
      .toLowerCase();
    const value = toNumber(item?.valor);

    if (description.includes("venda")) {
      grossAmount += value;
    } else if (description.includes("comiss")) {
      feeAmount += Math.abs(value);
    } else if (value > 0) {
      grossAmount += value;
    } else if (value < 0) {
      feeAmount += Math.abs(value);
    }
  });

  if (!grossAmount && toNumber(remoteEntry?.valor) > 0) {
    grossAmount = toNumber(remoteEntry?.valor);
  }

  return {
    grossAmount,
    feeAmount,
    netAmount: toNumber(remoteEntry?.valor),
    details: items,
  };
}

async function createSyncRun(domain, requestedBy, context, workspaceId) {
  const workspace =
    workspaceId && String(workspaceId).trim()
      ? await getWorkspaceById(String(workspaceId).trim())
      : await getOrCreateDefaultWorkspace();
  const runId = `madsync_${randomUUID()}`;

  await withClient(async (clientConnection) => {
    await clientConnection.query(
      `
        insert into "MadSyncRun" (
          "id",
          "workspaceId",
          "domain",
          "status",
          "requestedBy",
          "summary",
          "startedAt",
          "createdAt",
          "updatedAt"
        )
        values ($1, $2, $3::"MadSyncDomain", 'running', $4, $5::jsonb, now(), now(), now())
      `,
      [runId, workspace.id, domain, requestedBy || null, JSON.stringify(context || {})],
    );
  });

  return { runId, workspace };
}

async function finishSyncRun(runId, payload) {
  await withClient(async (clientConnection) => {
    await clientConnection.query(
      `
        update "MadSyncRun"
        set
          "status" = $2::"MadSyncStatus",
          "itemsTotal" = $3,
          "itemsProcessed" = $4,
          "itemsFailed" = $5,
          "summary" = $6::jsonb,
          "errorMessage" = $7,
          "finishedAt" = now(),
          "updatedAt" = now()
        where "id" = $1
      `,
      [
        runId,
        payload.status,
        payload.itemsTotal || 0,
        payload.itemsProcessed || 0,
        payload.itemsFailed || 0,
        JSON.stringify(payload.summary || {}),
        payload.errorMessage || null,
      ],
    );
  });
}

async function upsertCategory(clientConnection, remoteCategory) {
  const externalId = sanitizeText(remoteCategory?.id_categoria || remoteCategory?.externalId);
  if (!externalId) return null;

  const path =
    sanitizeText(remoteCategory?.nome_completo_fc) ||
    [
      remoteCategory?.nivel_1,
      remoteCategory?.nivel_2,
      remoteCategory?.nivel_3,
      remoteCategory?.nivel_4,
      remoteCategory?.nivel_5,
      remoteCategory?.nivel_6,
      remoteCategory?.nivel_7,
    ]
      .map((value) => sanitizeText(value))
      .filter(Boolean)
      .join(" / ");

  const name =
    sanitizeText(remoteCategory?.nivel_7) ||
    sanitizeText(remoteCategory?.nivel_6) ||
    sanitizeText(remoteCategory?.nivel_5) ||
    sanitizeText(remoteCategory?.nivel_4) ||
    sanitizeText(remoteCategory?.nivel_3) ||
    sanitizeText(remoteCategory?.nivel_2) ||
    sanitizeText(remoteCategory?.nivel_1) ||
    sanitizeText(remoteCategory?.name) ||
    `Categoria ${externalId}`;

  const result = await clientConnection.query(
    `
      insert into "MadCategory" (
        "id",
        "externalId",
        "parentExternalId",
        "name",
        "path",
        "isLeaf",
        "attributesSchema",
        "metadata",
        "createdAt",
        "updatedAt"
      )
      values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, now(), now())
      on conflict ("externalId")
      do update set
        "parentExternalId" = excluded."parentExternalId",
        "name" = excluded."name",
        "path" = excluded."path",
        "isLeaf" = excluded."isLeaf",
        "attributesSchema" = excluded."attributesSchema",
        "metadata" = excluded."metadata",
        "updatedAt" = now()
      returning "id", "externalId", "name"
    `,
    [
      `madcat_${randomUUID()}`,
      externalId,
      sanitizeText(remoteCategory?.parentExternalId || remoteCategory?.id_nivel_6),
      name,
      path || name,
      true,
      null,
      JSON.stringify({
        source: "madeiramadeira",
        commissionRate: remoteCategory?.comissionamento ?? null,
        raw: remoteCategory,
      }),
    ],
  );

  return result.rows[0] || null;
}

async function syncCategoriesForProducts(products) {
  const categoryInputs = new Map();

  (products || []).forEach((product) => {
    const externalId = sanitizeText(product?.id_categoria);
    if (!externalId || categoryInputs.has(externalId)) return;

    categoryInputs.set(externalId, {
      id_categoria: externalId,
      nivel_1: product?.nivel_1,
      nivel_2: product?.nivel_2,
      nivel_3: product?.nivel_3,
      nivel_4: product?.nivel_4,
      nivel_5: product?.nivel_5,
      nivel_6: product?.nivel_6,
      nivel_7: product?.nivel_7,
      nome_completo_fc: product?.nome_completo_fc,
    });
  });

  if (!categoryInputs.size) return 0;

  await withClient(async (clientConnection) => {
    for (const category of categoryInputs.values()) {
      await upsertCategory(clientConnection, category);
    }
  });

  return categoryInputs.size;
}

async function findLocalOrderId(clientConnection, workspaceId, externalId) {
  if (!externalId) return null;

  const existing = await clientConnection.query(
    `
      select "id"
      from "MadOrder"
      where "workspaceId" = $1
        and "externalId" = $2
      limit 1
    `,
    [workspaceId, externalId],
  );

  return existing.rows[0]?.id || null;
}

async function upsertOrder(clientConnection, workspaceId, remoteOrder, explicitRouteStatus) {
  const externalId = sanitizeText(remoteOrder?.id_pedido);
  if (!externalId) return null;

  const existingId = await findLocalOrderId(clientConnection, workspaceId, externalId);
  const orderId = existingId || `madord_${randomUUID()}`;
  const localStatus = inferOrderStatus(remoteOrder, explicitRouteStatus);
  const firstShipment = Array.isArray(remoteOrder?.envio) ? remoteOrder.envio[0] : null;
  const freightMode = remoteOrder?.cotacao_info ? "callback" : null;

  await clientConnection.query(
    `
      insert into "MadOrder" (
        "id",
        "workspaceId",
        "externalId",
        "externalCode",
        "status",
        "buyerName",
        "buyerDocument",
        "buyerEmail",
        "shippingMethod",
        "freightMode",
        "subtotalAmount",
        "freightAmount",
        "discountAmount",
        "totalAmount",
        "currency",
        "rawPayload",
        "importedAt",
        "approvedAt",
        "shippedAt",
        "deliveredAt",
        "cancelledAt",
        "createdAt",
        "updatedAt"
      )
      values (
        $1, $2, $3, $4, $5::"MadOrderStatus", $6, $7, $8, $9,
        $10::"MadFreightMode", $11, $12, $13, $14, 'BRL', $15::jsonb,
        coalesce($16::timestamptz, now()), $17::timestamptz, $18::timestamptz,
        $19::timestamptz, $20::timestamptz, now(), now()
      )
      on conflict ("workspaceId", "externalId")
      do update set
        "externalCode" = excluded."externalCode",
        "status" = excluded."status",
        "buyerName" = excluded."buyerName",
        "buyerDocument" = excluded."buyerDocument",
        "buyerEmail" = excluded."buyerEmail",
        "shippingMethod" = excluded."shippingMethod",
        "freightMode" = excluded."freightMode",
        "subtotalAmount" = excluded."subtotalAmount",
        "freightAmount" = excluded."freightAmount",
        "discountAmount" = excluded."discountAmount",
        "totalAmount" = excluded."totalAmount",
        "rawPayload" = excluded."rawPayload",
        "importedAt" = excluded."importedAt",
        "approvedAt" = excluded."approvedAt",
        "shippedAt" = excluded."shippedAt",
        "deliveredAt" = excluded."deliveredAt",
        "cancelledAt" = excluded."cancelledAt",
        "updatedAt" = now()
    `,
    [
      orderId,
      workspaceId,
      externalId,
      sanitizeText(remoteOrder?.pedido_wd || remoteOrder?.pedido_mm || remoteOrder?.order_seller),
      localStatus,
      sanitizeText(remoteOrder?.comprador?.nome),
      sanitizeText(remoteOrder?.comprador?.documento),
      sanitizeText(remoteOrder?.comprador?.email),
      sanitizeText(firstShipment?.nome_transportadora || remoteOrder?.shippingMethod),
      freightMode,
      toNumber(remoteOrder?.subtotal),
      toNumber(remoteOrder?.frete),
      0,
      toNumber(remoteOrder?.total),
      JSON.stringify({
        source: "madeiramadeira",
        routeStatus: explicitRouteStatus || null,
        remote: remoteOrder,
      }),
      parseDateValue(remoteOrder?.data_criacao) || parseDateValue(remoteOrder?.data_criacao_loja),
      parseDateValue(remoteOrder?.datahora_aprovacao),
      parseDateValue(remoteOrder?.datahora_rastreamento),
      parseDateValue(remoteOrder?.datahora_entrega),
      parseDateValue(remoteOrder?.datahora_cancelamento),
    ],
  );

  await clientConnection.query('delete from "MadOrderItem" where "orderId" = $1', [orderId]);

  const items = Array.isArray(remoteOrder?.skus) ? remoteOrder.skus : [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    await clientConnection.query(
      `
        insert into "MadOrderItem" (
          "id",
          "orderId",
          "lineNumber",
          "sku",
          "title",
          "quantity",
          "unitPrice",
          "totalPrice",
          "metadata",
          "createdAt",
          "updatedAt"
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now(), now())
      `,
      [
        `maditem_${randomUUID()}`,
        orderId,
        index + 1,
        sanitizeText(item?.skuseller || item?.sku) || `linha-${index + 1}`,
        sanitizeText(item?.nome) || "Item sem titulo",
        Number.parseInt(String(item?.quantidade || 0), 10) || 0,
        toNumber(item?.valor_unitario),
        toNumber(item?.total),
        JSON.stringify(item || {}),
      ],
    );
  }

  const quotes = Array.isArray(remoteOrder?.cotacao_info) ? remoteOrder.cotacao_info : [];
  for (const quote of quotes) {
    const requestId =
      sanitizeText(quote?.id_cotacao) ||
      sanitizeText(quote?.estivativa_transporte_id) ||
      `${externalId}-${sanitizeText(quote?.sku) || "quote"}`;

    await clientConnection.query(
      `
        insert into "MadFreightQuote" (
          "id",
          "workspaceId",
          "orderId",
          "externalRequestId",
          "mode",
          "status",
          "destinationZip",
          "serviceName",
          "carrierName",
          "quotedAmount",
          "deliveryDays",
          "responseTimeMs",
          "requestPayload",
          "responsePayload",
          "requestedAt",
          "respondedAt",
          "createdAt",
          "updatedAt"
        )
        values (
          $1, $2, $3, $4, 'callback', 'quoted', $5, $6, $7, $8, $9, $10,
          $11::jsonb, $12::jsonb, now(), now(), now(), now()
        )
        on conflict ("workspaceId", "externalRequestId")
        do update set
          "orderId" = excluded."orderId",
          "serviceName" = excluded."serviceName",
          "carrierName" = excluded."carrierName",
          "quotedAmount" = excluded."quotedAmount",
          "deliveryDays" = excluded."deliveryDays",
          "responsePayload" = excluded."responsePayload",
          "respondedAt" = now(),
          "updatedAt" = now()
      `,
      [
        `madfrt_${randomUUID()}`,
        workspaceId,
        orderId,
        requestId,
        sanitizeText(remoteOrder?.dados_entrega?.cep) || "00000000",
        sanitizeText(quote?.metodo_transporte_display || quote?.metodo_transporte),
        sanitizeText(quote?.metodo_transporte || quote?.metodo_transporte_id),
        toNumber(quote?.total),
        Number.parseInt(String(quote?.prazo || 0), 10) || null,
        null,
        JSON.stringify({
          orderExternalId: externalId,
        }),
        JSON.stringify(quote || {}),
      ],
    );
  }

  return orderId;
}

async function syncCatalog(options = {}) {
  const limit = Math.max(100, parsePositiveInt(options.limit, 100));
  const offset = Math.max(0, Number.parseInt(String(options.offset || 0), 10) || 0);
  const requestedMaxPages = Number.parseInt(String(options.maxPages || ""), 10);
  const hasMaxPagesOverride = Number.isFinite(requestedMaxPages) && requestedMaxPages > 0;
  const defaultMaxPages = options.syncScope === "all" ? 3 : 8;
  const maxPages = Math.max(
    1,
    Math.min(12, hasMaxPagesOverride ? requestedMaxPages : defaultMaxPages),
  );
  const { runId, workspace } = await createSyncRun(
    "catalog",
    options.requestedBy,
    { limit, offset, maxPages },
    options.workspaceId,
  );

  try {
    const warnings = [];
    let categoriesSynced = 0;
    let categories = [];

    try {
      const categoriesResult = await client.listCategories(
        { limit: 1000, offset: 0 },
        { workspaceId: options.workspaceId, actingUserEmail: options.actingUserEmail },
      );
      categories = parseArrayPayload(categoriesResult.data);
      categoriesSynced = categories.length;
    } catch (error) {
      warnings.push(`Categorias nao sincronizadas: ${error.message}`);
    }

    const [publishedResult, pendingResult, publishingResult, nonCommercializedResult] =
      await Promise.allSettled([
        fetchOffsetPaginatedPages(
          ({ limit: pageLimit, offset: pageOffset }) =>
            client.listProductsBySituation(
              { situation: "publicados", limit: pageLimit, offset: pageOffset },
              { workspaceId: options.workspaceId, actingUserEmail: options.actingUserEmail },
            ),
          { limit, offset, maxPages },
        ),
        fetchOffsetPaginatedPages(
          ({ limit: pageLimit, offset: pageOffset }) =>
            client.listProductsBySituation(
              { situation: "pendentes", limit: pageLimit, offset: pageOffset },
              { workspaceId: options.workspaceId, actingUserEmail: options.actingUserEmail },
            ),
          { limit, offset, maxPages },
        ),
        fetchOffsetPaginatedPages(
          ({ limit: pageLimit, offset: pageOffset }) =>
            client.listPublishingProducts(
              { limit: pageLimit, offset: pageOffset },
              { workspaceId: options.workspaceId, actingUserEmail: options.actingUserEmail },
            ),
          { limit, offset, maxPages },
        ),
        fetchOffsetPaginatedPages(
          ({ limit: pageLimit, offset: pageOffset }) =>
            client.listNonCommercializedProducts(
              { limit: pageLimit, offset: pageOffset },
              { workspaceId: options.workspaceId, actingUserEmail: options.actingUserEmail },
            ),
          { limit, offset, maxPages },
        ),
      ]);

    if (publishedResult.status === "rejected") {
      warnings.push(toSettledWarning("Produtos publicados", publishedResult));
    }

    if (pendingResult.status === "rejected") {
      warnings.push(toSettledWarning("Produtos pendentes", pendingResult));
    }

    if (publishingResult.status === "rejected") {
      warnings.push(toSettledWarning("Produtos em publicacao", publishingResult));
    }

    if (nonCommercializedResult.status === "rejected") {
      warnings.push(toSettledWarning("Produtos nao comercializados", nonCommercializedResult));
    }

    const batches = [
      {
        source: "published",
        items:
          publishedResult.status === "fulfilled"
            ? publishedResult.value.items
            : [],
      },
      {
        source: "pending",
        items:
          pendingResult.status === "fulfilled"
            ? pendingResult.value.items
            : [],
      },
      {
        source: "publishing",
        items:
          publishingResult.status === "fulfilled"
            ? publishingResult.value.items
            : [],
      },
      {
        source: "nonCommercialized",
        items:
          nonCommercializedResult.status === "fulfilled"
            ? nonCommercializedResult.value.items
            : [],
      },
    ];

    if (!batches.some((batch) => batch.items.length) && warnings.length) {
      throw new Error(warnings.join(" | "));
    }

    const normalizedProductsMap = new Map();
    for (const batch of batches) {
      for (const remoteProduct of batch.items) {
        const normalized = normalizePublishedProduct(remoteProduct, batch.source);
        if (!normalized.sku || !normalized.title) continue;
        const dedupeKey = `${normalized.sku}::${batch.source}`;
        normalizedProductsMap.set(dedupeKey, normalized);
      }
    }
    const normalizedProducts = Array.from(normalizedProductsMap.values());

    storeCatalogSnapshot(workspace.id, {
      categories,
      products: normalizedProducts,
      syncedAt: new Date().toISOString(),
    });

    const processed = normalizedProducts.length;

    const summary = {
      categoriesSynced,
      publishedFetched: batches[0].items.length,
      pendingFetched: batches[1].items.length,
      publishingFetched: batches[2].items.length,
      nonCommercializedFetched: batches[3].items.length,
      warnings,
    };

    await finishSyncRun(runId, {
      status: warnings.length ? "partial" : "success",
      itemsTotal: processed,
      itemsProcessed: processed,
      itemsFailed: 0,
      summary,
    });

    return { ok: true, runId, summary };
  } catch (error) {
    await finishSyncRun(runId, {
      status: "failed",
      itemsTotal: 0,
      itemsProcessed: 0,
      itemsFailed: 1,
      summary: {},
      errorMessage: error.message,
    });
    throw error;
  }
}

async function syncOrders(options = {}) {
  const limit = parsePositiveInt(options.limit, 50);
  const offset = Math.max(0, Number.parseInt(String(options.offset || 0), 10) || 0);
  const { runId, workspace } = await createSyncRun(
    "orders",
    options.requestedBy,
    { limit, offset },
    options.workspaceId,
  );

  try {
    const responses = await Promise.allSettled([
      client.listOrders({ limit, offset }, { workspaceId: options.workspaceId, actingUserEmail: options.actingUserEmail }),
      ...ORDER_STATUS_ROUTE_VALUES.map((status) =>
        client.listOrdersByStatus(
          { status, limit, offset },
          { workspaceId: options.workspaceId, actingUserEmail: options.actingUserEmail },
        ),
      ),
    ]);

    const warnings = [];

    const groupedOrders = new Map();
    const allResponses = [
      {
        routeStatus: null,
        payload: responses[0]?.status === "fulfilled" ? responses[0].value : null,
      },
      ...ORDER_STATUS_ROUTE_VALUES.map((status, index) => ({
        routeStatus: status,
        payload:
          responses[index + 1]?.status === "fulfilled"
            ? responses[index + 1].value
            : null,
      })),
    ];

    if (responses[0]?.status === "rejected") {
      warnings.push(toSettledWarning("Lista geral de pedidos", responses[0]));
    }

    ORDER_STATUS_ROUTE_VALUES.forEach((status, index) => {
      const result = responses[index + 1];
      if (result?.status === "rejected") {
        warnings.push(toSettledWarning(`Pedidos ${status}`, result));
      }
    });

    for (const response of allResponses) {
      if (!response.payload) continue;
      for (const item of parseArrayPayload(response.payload.data)) {
        const externalId = sanitizeText(item?.id_pedido);
        if (!externalId) continue;

        if (!groupedOrders.has(externalId)) {
          groupedOrders.set(externalId, {
            ...item,
            __routeStatus: response.routeStatus,
          });
        } else {
          const existing = groupedOrders.get(externalId);
          groupedOrders.set(externalId, {
            ...existing,
            ...item,
            __routeStatus: existing.__routeStatus || response.routeStatus,
          });
        }
      }
    }

    if (!groupedOrders.size && warnings.length) {
      throw new Error(warnings.join(" | "));
    }

    let processed = 0;
    await withClient(async (clientConnection) => {
      await clientConnection.query("begin");

      try {
        for (const order of groupedOrders.values()) {
          await upsertOrder(clientConnection, workspace.id, order, order.__routeStatus);
          processed += 1;
        }

        await clientConnection.query("commit");
      } catch (error) {
        await clientConnection.query("rollback");
        throw error;
      }
    });

    const summary = {
      fetchedOrders: groupedOrders.size,
      routesChecked: 1 + ORDER_STATUS_ROUTE_VALUES.length,
      limit,
      offset,
      warnings,
    };

    await finishSyncRun(runId, {
      status: warnings.length ? "partial" : "success",
      itemsTotal: processed,
      itemsProcessed: processed,
      itemsFailed: 0,
      summary,
    });

    return { ok: true, runId, summary };
  } catch (error) {
    await finishSyncRun(runId, {
      status: "failed",
      itemsTotal: 0,
      itemsProcessed: 0,
      itemsFailed: 1,
      summary: {},
      errorMessage: error.message,
    });
    throw error;
  }
}

async function syncFinance(options = {}) {
  const today = new Date();
  const defaultDateTo = formatLocalDateKey(today);
  const defaultDateFrom = formatLocalDateKey(new Date(today.getFullYear(), today.getMonth(), 1));

  const dateFrom = sanitizeText(options.dateFrom) || defaultDateFrom;
  const dateTo = sanitizeText(options.dateTo) || defaultDateTo;
  const limit = parsePositiveInt(options.limit, 100);
  const offset = Math.max(0, Number.parseInt(String(options.offset || 0), 10) || 0);
  const type = sanitizeText(options.type) || "7";
  const { runId, workspace } = await createSyncRun(
    "finance",
    options.requestedBy,
    { dateFrom, dateTo, limit, offset, type },
    options.workspaceId,
  );

  try {
    const result = await client.listFinancialLaunches(
      { dateFrom, dateTo, limit, offset, type },
      { workspaceId: options.workspaceId, actingUserEmail: options.actingUserEmail },
    );

    const entries = parseArrayPayload(result.data);
    let processed = 0;

    await withClient(async (clientConnection) => {
      await clientConnection.query("begin");

      try {
        for (const remoteEntry of entries) {
          const externalId = sanitizeText(remoteEntry?.id_lancamento_financeiro);
          if (!externalId) continue;

          const linkedOrderId = await findLocalOrderId(
            clientConnection,
            workspace.id,
            sanitizeText(remoteEntry?.id_pedido),
          );
          const values = summarizeFinancialDetail(remoteEntry);

          await clientConnection.query(
            `
              insert into "MadFinancialEntry" (
                "id",
                "workspaceId",
                "orderId",
                "externalId",
                "type",
                "status",
                "description",
                "grossAmount",
                "feeAmount",
                "netAmount",
                "releaseDate",
                "paidAt",
                "payload",
                "createdAt",
                "updatedAt"
              )
              values (
                $1, $2, $3, $4, $5, $6::"MadFinancialStatus", $7, $8, $9, $10,
                $11::timestamptz, $12::timestamptz, $13::jsonb, now(), now()
              )
              on conflict ("workspaceId", "externalId")
              do update set
                "orderId" = excluded."orderId",
                "type" = excluded."type",
                "status" = excluded."status",
                "description" = excluded."description",
                "grossAmount" = excluded."grossAmount",
                "feeAmount" = excluded."feeAmount",
                "netAmount" = excluded."netAmount",
                "releaseDate" = excluded."releaseDate",
                "paidAt" = excluded."paidAt",
                "payload" = excluded."payload",
                "updatedAt" = now()
            `,
            [
              `madfin_${randomUUID()}`,
              workspace.id,
              linkedOrderId,
              externalId,
              sanitizeText(remoteEntry?.tipo_lancamento) || "Financeiro",
              mapRemoteFinancialStatus(remoteEntry),
              sanitizeText(remoteEntry?.descricao),
              values.grossAmount,
              values.feeAmount,
              values.netAmount,
              parseDateValue(remoteEntry?.data_liberacao || remoteEntry?.data_previsao_pagamento),
              parseDateValue(remoteEntry?.data_pagamento),
              JSON.stringify({
                source: "madeiramadeira",
                details: values.details,
                remote: remoteEntry,
              }),
            ],
          );

          processed += 1;
        }

        await clientConnection.query("commit");
      } catch (error) {
        await clientConnection.query("rollback");
        throw error;
      }
    });

    const summary = {
      fetchedEntries: entries.length,
      dateFrom,
      dateTo,
      type,
    };

    await finishSyncRun(runId, {
      status: "success",
      itemsTotal: processed,
      itemsProcessed: processed,
      itemsFailed: 0,
      summary,
    });

    return { ok: true, runId, summary };
  } catch (error) {
    await finishSyncRun(runId, {
      status: "failed",
      itemsTotal: 0,
      itemsProcessed: 0,
      itemsFailed: 1,
      summary: {},
      errorMessage: error.message,
    });
    throw error;
  }
}

async function syncMessaging(options = {}) {
  const page = parsePositiveInt(options.page, 1);
  const limit = parsePositiveInt(options.limit, 50);
  const status = sanitizeText(options.status);
  const { runId, workspace } = await createSyncRun(
    "messaging",
    options.requestedBy,
    { page, limit, status },
    options.workspaceId,
  );

  try {
    const statusesToTry = status ? [status] : [null, "2", "1", "3"];
    const sessionMap = new Map();
    let totalPagesFetched = 0;

    for (const statusCandidate of statusesToTry) {
      let currentPage = page;
      let pagesVisited = 0;

      while (pagesVisited < 200) {
        const result = await client.listSellerSessionHistoric(
          { page: currentPage, limit, status: statusCandidate },
          { workspaceId: options.workspaceId, actingUserEmail: options.actingUserEmail },
        );
        const chunk = parseArrayPayload(result.data);
        totalPagesFetched += 1;
        pagesVisited += 1;

        for (const session of chunk) {
          const key = sanitizeText(session?.session_id);
          if (!key) continue;
          sessionMap.set(key, session);
        }

        const pagination = result.data?.pagination || {};
        const current = Number.parseInt(String(pagination.current_page || currentPage), 10) || currentPage;
        const last = Number.parseInt(String(pagination.last_page || pagination.total_pages || 0), 10) || 0;
        const hasNextByPagination = last > 0 ? current < last : false;

        if (!chunk.length) break;
        if (hasNextByPagination) {
          currentPage += 1;
          continue;
        }
        if (chunk.length < limit) break;
        currentPage += 1;
      }
    }

    const sessions = Array.from(sessionMap.values());
    let processed = 0;

    await withClient(async (clientConnection) => {
      await clientConnection.query("begin");

      try {
        for (const session of sessions) {
          const externalThreadId = sanitizeText(session?.session_id);
          if (!externalThreadId) continue;

          const orderId = await findLocalOrderId(
            clientConnection,
            workspace.id,
            sanitizeText(session?.order),
          );

          await clientConnection.query(
            `
              insert into "MadMessageThread" (
                "id",
                "workspaceId",
                "orderId",
                "externalThreadId",
                "counterpartName",
                "status",
                "unreadCount",
                "lastMessageAt",
                "metadata",
                "createdAt",
                "updatedAt"
              )
              values (
                $1, $2, $3, $4, $5, $6::"MadThreadStatus", $7, $8::timestamptz,
                $9::jsonb, now(), now()
              )
              on conflict ("workspaceId", "externalThreadId")
              do update set
                "orderId" = excluded."orderId",
                "counterpartName" = excluded."counterpartName",
                "status" = excluded."status",
                "unreadCount" = excluded."unreadCount",
                "lastMessageAt" = excluded."lastMessageAt",
                "metadata" = excluded."metadata",
                "updatedAt" = now()
            `,
            [
              `madthr_${randomUUID()}`,
              workspace.id,
              orderId,
              externalThreadId,
              sanitizeText(session?.customer_name || session?.order_seller || session?.order),
              mapRemoteThreadStatus(session),
              session?.status?.slug === "awaiting_answer_seller" ? 1 : 0,
              parseDateValue(session?.created_at || session?.order_date),
              JSON.stringify({
                source: "madeiramadeira",
                remote: session,
              }),
            ],
          );

          processed += 1;
        }

        await clientConnection.query("commit");
      } catch (error) {
        await clientConnection.query("rollback");
        throw error;
      }
    });

    const summary = {
      fetchedSessions: sessions.length,
      page,
      limit,
      status,
      pagesFetched: totalPagesFetched,
    };

    await finishSyncRun(runId, {
      status: "success",
      itemsTotal: processed,
      itemsProcessed: processed,
      itemsFailed: 0,
      summary,
    });

    return { ok: true, runId, summary };
  } catch (error) {
    await finishSyncRun(runId, {
      status: "failed",
      itemsTotal: 0,
      itemsProcessed: 0,
      itemsFailed: 1,
      summary: {},
      errorMessage: error.message,
    });
    throw error;
  }
}

async function syncAllDomains(options = {}) {
  const errors = [];
  const includeMessaging = Boolean(options.includeMessaging);

  const operations = [
    ["catalog", () => syncCatalog({ ...(options.catalog || {}), syncScope: "all" })],
    ["orders", () => syncOrders(options.orders || {})],
    ["finance", () => syncFinance(options.finance || {})],
  ];

  if (includeMessaging) {
    operations.push(["messaging", () => syncMessaging(options.messaging || {})]);
  }

  const settled = await Promise.all(
    operations.map(async ([domain, action]) => {
      try {
        const result = await action();
        return { domain, ok: true, ...result };
      } catch (error) {
        errors.push({ domain, message: error.message });
        return { domain, ok: false, error: error.message };
      }
    }),
  );

  const results = settled;

  return {
    ok: errors.length === 0,
    partial: errors.length > 0 && results.some((result) => result.ok),
    results,
    errors,
  };
}

async function listSyncRuns(params = {}) {
  const workspace =
    params.workspaceId && String(params.workspaceId).trim()
      ? await getWorkspaceById(String(params.workspaceId).trim())
      : await getOrCreateDefaultWorkspace();
  const limit = parsePositiveInt(params.limit, 12);

  const rows = await queryRows(
    `
      select
        "id",
        "domain"::text as "domain",
        "status"::text as "status",
        "requestedBy",
        "itemsTotal",
        "itemsProcessed",
        "itemsFailed",
        "summary",
        "errorMessage",
        "startedAt",
        "finishedAt"
      from "MadSyncRun"
      where "workspaceId" = $1
      order by "startedAt" desc
      limit $2
    `,
    [workspace.id, limit],
  );

  return {
    workspace,
    total: rows.length,
    items: rows,
  };
}

module.exports = {
  listSyncRuns,
  syncAllDomains,
  syncCatalog,
  syncFinance,
  syncMessaging,
  syncOrders,
};

