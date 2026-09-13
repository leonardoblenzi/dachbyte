"use strict";

const { randomUUID } = require("crypto");
const {
  getOrCreateDefaultWorkspace,
  getWorkspaceById,
  queryOne,
  queryRows,
  toNullableNumber,
  toNumber,
  withClient,
} = require("./databaseService");
const {
  getCachedCatalogOverview,
  getCachedProduct,
  getCatalogCacheSnapshot,
  listCachedProducts,
  upsertCachedProduct,
} = require("./catalogCacheService");

const PRODUCT_STATUSES = new Set([
  "draft",
  "queued",
  "validating",
  "published",
  "paused",
  "failed",
  "archived",
]);

const ORDER_STATUSES = new Set([
  "imported",
  "awaiting_invoice",
  "ready_to_ship",
  "shipped",
  "delivered",
  "cancelled",
  "returned",
  "refunded",
  "on_hold",
]);

const FINANCIAL_STATUSES = new Set([
  "pending",
  "released",
  "paid",
  "blocked",
  "disputed",
  "cancelled",
]);

const THREAD_STATUSES = new Set([
  "open",
  "waiting_seller",
  "waiting_marketplace",
  "resolved",
  "closed",
]);

function createValidationError(message, details) {
  const error = new Error(message);
  error.status = 400;
  error.details = details || null;
  return error;
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeEnum(value, allowedValues, fallback) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  return allowedValues.has(normalized) ? normalized : fallback;
}

function sanitizeText(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function sanitizeJson(value, fallback = null) {
  if (value == null || value === "") {
    return fallback;
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  return value;
}

function mapProductRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    categoryId: row.categoryId,
    categoryName: row.categoryName || null,
    categoryExternalId: row.categoryExternalId || null,
    externalId: row.externalId || null,
    sku: row.sku,
    ean: row.ean || null,
    title: row.title,
    description: row.description || null,
    status: row.status,
    currentPrice: toNumber(row.currentPrice),
    compareAtPrice: toNullableNumber(row.compareAtPrice),
    stock: Number(row.stock || 0),
    weightGrams: row.weightGrams == null ? null : Number(row.weightGrams),
    heightCm: row.heightCm == null ? null : Number(row.heightCm),
    widthCm: row.widthCm == null ? null : Number(row.widthCm),
    lengthCm: row.lengthCm == null ? null : Number(row.lengthCm),
    imageCount: Number(row.imageCount || 0),
    attributeCount: Number(row.attributeCount || 0),
    soldUnits: Number(row.soldUnits || 0),
    revenueAmount: toNumber(row.revenueAmount),
    payload: row.payload || null,
    marketplacePayload: row.marketplacePayload || null,
    lastSyncedAt: row.lastSyncedAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapOrderRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    externalId: row.externalId,
    externalCode: row.externalCode || null,
    status: row.status,
    buyerName: row.buyerName || null,
    buyerEmail: row.buyerEmail || null,
    buyerDocument: row.buyerDocument || null,
    shippingMethod: row.shippingMethod || null,
    freightMode: row.freightMode || null,
    subtotalAmount: toNumber(row.subtotalAmount),
    freightAmount: toNumber(row.freightAmount),
    discountAmount: toNumber(row.discountAmount),
    totalAmount: toNumber(row.totalAmount),
    currency: row.currency || "BRL",
    itemCount: Number(row.itemCount || 0),
    units: Number(row.units || 0),
    threadCount: Number(row.threadCount || 0),
    importedAt: row.importedAt,
    approvedAt: row.approvedAt || null,
    shippedAt: row.shippedAt || null,
    deliveredAt: row.deliveredAt || null,
    cancelledAt: row.cancelledAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    rawPayload: row.rawPayload || null,
  };
}

function mapFreightRow(row) {
  return {
    id: row.id,
    orderId: row.orderId || null,
    externalRequestId: row.externalRequestId || null,
    mode: row.mode,
    status: row.status,
    destinationZip: row.destinationZip,
    serviceName: row.serviceName || null,
    carrierName: row.carrierName || null,
    quotedAmount: toNullableNumber(row.quotedAmount),
    deliveryDays: row.deliveryDays == null ? null : Number(row.deliveryDays),
    responseTimeMs: row.responseTimeMs == null ? null : Number(row.responseTimeMs),
    requestedAt: row.requestedAt,
    respondedAt: row.respondedAt || null,
    expiresAt: row.expiresAt || null,
    requestPayload: row.requestPayload || null,
    responsePayload: row.responsePayload || null,
  };
}

function mapFinancialRow(row) {
  return {
    id: row.id,
    orderId: row.orderId || null,
    externalId: row.externalId || null,
    type: row.type,
    status: row.status,
    description: row.description || null,
    grossAmount: toNumber(row.grossAmount),
    feeAmount: toNumber(row.feeAmount),
    netAmount: toNumber(row.netAmount),
    releaseDate: row.releaseDate || null,
    paidAt: row.paidAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    payload: row.payload || null,
  };
}

function mapThreadRow(row) {
  return {
    id: row.id,
    orderId: row.orderId || null,
    externalThreadId: row.externalThreadId || null,
    counterpartName: row.counterpartName || null,
    status: row.status,
    unreadCount: Number(row.unreadCount || 0),
    lastMessageAt: row.lastMessageAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: row.metadata || null,
    messageCount: Number(row.messageCount || 0),
    lastMessagePreview: row.lastMessagePreview || null,
  };
}

async function resolveCategory(client, categoryInput) {
  if (!categoryInput) {
    return null;
  }

  const categoryId = sanitizeText(categoryInput.categoryId);
  const categoryExternalId = sanitizeText(
    categoryInput.categoryExternalId || categoryInput.externalId,
  );
  const categoryName = sanitizeText(categoryInput.categoryName || categoryInput.name);

  if (categoryId) {
    const existing = await client.query(
      `
        select "id", "externalId", "name"
        from "MadCategory"
        where "id" = $1
        limit 1
      `,
      [categoryId],
    );

    return existing.rows[0] || null;
  }

  if (!categoryExternalId) {
    return null;
  }

  const result = await client.query(
    `
      insert into "MadCategory" (
        "id",
        "externalId",
        "name",
        "path",
        "isLeaf",
        "metadata",
        "createdAt",
        "updatedAt"
      )
      values ($1, $2, $3, $4, true, $5::jsonb, now(), now())
      on conflict ("externalId")
      do update set
        "name" = coalesce(excluded."name", "MadCategory"."name"),
        "updatedAt" = now()
      returning "id", "externalId", "name"
    `,
    [
      `madcat_${randomUUID()}`,
      categoryExternalId,
      categoryName || `Categoria ${categoryExternalId}`,
      categoryName || null,
      JSON.stringify({
        source: "manual",
      }),
    ],
  );

  return result.rows[0] || null;
}

async function listLocalCategories(params = {}) {
  const workspace =
    params.workspaceId && String(params.workspaceId).trim()
      ? await getWorkspaceById(String(params.workspaceId).trim())
      : await getOrCreateDefaultWorkspace();
  const snapshot = getCatalogCacheSnapshot(workspace.id);
  const search = sanitizeText(params.search)?.toLowerCase() || "";
  const limit = toPositiveInt(params.limit, 100);
  const offset = Math.max(0, Number.parseInt(String(params.offset || 0), 10) || 0);

  let rows = snapshot.categories.map((category, index) => ({
    id: sanitizeText(category?.id) || `madcache_cat_${index + 1}`,
    externalId: sanitizeText(category?.id_categoria || category?.externalId),
    parentExternalId: sanitizeText(category?.parentExternalId || category?.id_nivel_6),
    name:
      sanitizeText(category?.nivel_7) ||
      sanitizeText(category?.nivel_6) ||
      sanitizeText(category?.nivel_5) ||
      sanitizeText(category?.nivel_4) ||
      sanitizeText(category?.nivel_3) ||
      sanitizeText(category?.nivel_2) ||
      sanitizeText(category?.nivel_1) ||
      sanitizeText(category?.name) ||
      "Sem categoria",
    path: sanitizeText(category?.nome_completo_fc || category?.path),
    isLeaf: true,
    attributesSchema: null,
    metadata: category,
    createdAt: snapshot.syncedAt,
    updatedAt: snapshot.syncedAt,
  }));

  if (search) {
    rows = rows.filter((row) =>
      [row.name, row.path, row.externalId]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(search)),
    );
  }

  const paged = rows.slice(offset, offset + limit);

  return {
    workspace,
    total: rows.length,
    limit,
    offset,
    items: paged,
  };
}

async function listLocalProducts(params = {}) {
  const workspace =
    params.workspaceId && String(params.workspaceId).trim()
      ? await getWorkspaceById(String(params.workspaceId).trim())
      : await getOrCreateDefaultWorkspace();
  const cached = listCachedProducts({
    workspaceId: workspace.id,
    search: params.search,
    status: params.status,
    stockState: params.stockState,
    priceMin: params.priceMin,
    priceMax: params.priceMax,
    sort: params.sort,
    limit: params.limit,
    offset: params.offset,
  });

  return {
    workspace,
    total: cached.total,
    limit: cached.limit,
    offset: cached.offset,
    items: cached.items,
  };
}

async function getLocalProduct(identifier, options = {}) {
  const workspace =
    options.workspaceId && String(options.workspaceId).trim()
      ? await getWorkspaceById(String(options.workspaceId).trim())
      : await getOrCreateDefaultWorkspace();
  const normalizedIdentifier = sanitizeText(identifier);

  if (!normalizedIdentifier) {
    return null;
  }

  const product = getCachedProduct(workspace.id, normalizedIdentifier);
  if (!product) {
    return null;
  }
  product.marketplaceSubmission = buildMarketplaceProductPayload(product);
  return product;
}

function normalizeProductImages(images) {
  if (!Array.isArray(images)) {
    return null;
  }

  return images
    .map((image, index) => {
      if (typeof image === "string") {
        return {
          url: sanitizeText(image),
          altText: null,
          position: index,
          isPrimary: index === 0,
        };
      }

      return {
        url: sanitizeText(image?.url),
        altText: sanitizeText(image?.altText),
        position: Number.isFinite(Number(image?.position))
          ? Number(image.position)
          : index,
        isPrimary: Boolean(image?.isPrimary ?? index === 0),
      };
    })
    .filter((image) => image.url);
}

function normalizeProductAttributes(attributes) {
  if (!Array.isArray(attributes)) {
    return null;
  }

  return attributes
    .map((attribute) => ({
      externalAttributeId: sanitizeText(
        attribute?.externalAttributeId || attribute?.id,
      ),
      name: sanitizeText(attribute?.name || attribute?.nome),
      value: sanitizeText(attribute?.value || attribute?.valor),
      unit: sanitizeText(attribute?.unit),
    }))
    .filter((attribute) => attribute.name && attribute.value);
}

function extractBrand(input, attributes) {
  const explicitBrand = sanitizeText(input?.brand || input?.marca);
  if (explicitBrand) {
    return explicitBrand;
  }

  const matched = (attributes || []).find(
    (attribute) => String(attribute.name || "").toLowerCase() === "marca",
  );

  return sanitizeText(matched?.value);
}

function buildMarketplaceProductPayload(product) {
  const attributes = Array.isArray(product.attributes) ? product.attributes : [];
  const images = Array.isArray(product.images) ? product.images : [];
  const payload = product.payload && typeof product.payload === "object" ? product.payload : {};

  return {
    id_categoria: product.categoryExternalId ? Number(product.categoryExternalId) : null,
    nome: product.title,
    descricao: product.description || "",
    ean: product.ean || "",
    sku: product.sku,
    marca: sanitizeText(payload.brand) || extractBrand(product, attributes) || "",
    preco_de:
      product.compareAtPrice != null ? Number(product.compareAtPrice) : Number(product.currentPrice),
    preco_por: Number(product.currentPrice),
    estoque: Number(product.stock || 0),
    altura: product.heightCm == null ? 0 : Number(product.heightCm),
    largura: product.widthCm == null ? 0 : Number(product.widthCm),
    profundidade: product.lengthCm == null ? 0 : Number(product.lengthCm),
    peso:
      product.weightGrams == null ? 0 : Number((Number(product.weightGrams) / 1000).toFixed(3)),
    imagens: images.map((image) => image.url),
    atributos: attributes.map((attribute) => ({
      nome: attribute.name,
      valor: attribute.value,
    })),
    unidade_fracionada: 1,
    unidade: sanitizeText(payload.unit) || "unidade",
  };
}

async function saveLocalProduct(input, options = {}) {
  const workspace =
    options.workspaceId && String(options.workspaceId).trim()
      ? await getWorkspaceById(String(options.workspaceId).trim())
      : await getOrCreateDefaultWorkspace();
  const sku = sanitizeText(input?.sku);
  const title = sanitizeText(input?.title || input?.nome);

  if (!sku || !title) {
    throw createValidationError("Produto precisa ter `sku` e `title`.", {
      required: ["sku", "title"],
    });
  }

  const productId = sanitizeText(options.productId || input?.id);
  const normalizedImages = normalizeProductImages(input?.images || input?.imagens);
  const normalizedAttributes = normalizeProductAttributes(
    input?.attributes || input?.atributos,
  );
  const currentPrice = toNumber(input?.currentPrice ?? input?.preco_por);
  const compareAtPrice = toNullableNumber(input?.compareAtPrice ?? input?.preco_de);
  const payload = sanitizeJson(input?.payload, null);
  const explicitMarketplacePayload = sanitizeJson(input?.marketplacePayload, null);

  const status = normalizeEnum(input?.status, PRODUCT_STATUSES, "draft");
  const stock = Number.parseInt(String(input?.stock ?? input?.estoque ?? 0), 10) || 0;
  const weightGrams =
    input?.weightGrams != null
      ? Number(input.weightGrams)
      : input?.peso != null
        ? Math.round(Number(input.peso) * 1000)
        : null;
  const heightCm =
    input?.heightCm != null
      ? Number(input.heightCm)
      : input?.altura != null
        ? Number(input.altura)
        : null;
  const widthCm =
    input?.widthCm != null
      ? Number(input.widthCm)
      : input?.largura != null
        ? Number(input.largura)
        : null;
  const lengthCm =
    input?.lengthCm != null
      ? Number(input.lengthCm)
      : input?.profundidade != null
        ? Number(input.profundidade)
        : null;

  const categoryExternalId =
    sanitizeText(input?.categoryExternalId || input?.id_categoria || input?.externalCategoryId);
  const categoryName =
    sanitizeText(input?.categoryName || input?.categoriaNome) ||
    (categoryExternalId ? `Categoria ${categoryExternalId}` : "Sem categoria");

  const resolvedProductId = productId || `madcache_${sku}`;
  const computedMarketplacePayload =
    explicitMarketplacePayload ||
    buildMarketplaceProductPayload({
      sku,
      title,
      description: sanitizeText(input?.description || input?.descricao),
      ean: sanitizeText(input?.ean),
      currentPrice,
      compareAtPrice,
      stock,
      weightGrams,
      heightCm,
      widthCm,
      lengthCm,
      categoryExternalId,
      images: normalizedImages || [],
      attributes: normalizedAttributes || [],
      payload,
    });

  const product = upsertCachedProduct(workspace.id, {
    id: resolvedProductId,
    workspaceId: workspace.id,
    externalId: sanitizeText(input?.externalId),
    categoryExternalId,
    categoryName,
    sku,
    ean: sanitizeText(input?.ean),
    title,
    description: sanitizeText(input?.description || input?.descricao),
    status,
    currentPrice,
    compareAtPrice,
    stock,
    weightGrams,
    heightCm,
    widthCm,
    lengthCm,
    payload,
    marketplacePayload: computedMarketplacePayload,
    images: normalizedImages || [],
    attributes: normalizedAttributes || [],
  });

  product.marketplaceSubmission = buildMarketplaceProductPayload(product);
  return product;
}

async function getCatalogOverview(params = {}) {
  const workspace =
    params.workspaceId && String(params.workspaceId).trim()
      ? await getWorkspaceById(String(params.workspaceId).trim())
      : await getOrCreateDefaultWorkspace();
  const overview = getCachedCatalogOverview(workspace.id);

  return {
    workspace,
    syncedAt: overview.syncedAt,
    summary: overview.summary,
    byStatus: overview.byStatus,
    topCategories: overview.topCategories,
  };
}

async function listLocalOrders(params = {}) {
  const workspace =
    params.workspaceId && String(params.workspaceId).trim()
      ? await getWorkspaceById(String(params.workspaceId).trim())
      : await getOrCreateDefaultWorkspace();
  const search = sanitizeText(params.search);
  const status = normalizeEnum(params.status, ORDER_STATUSES, null);
  const dateFrom = sanitizeText(params.dateFrom);
  const dateTo = sanitizeText(params.dateTo);
  const limit = toPositiveInt(params.limit, 20);
  const offset = Math.max(0, Number.parseInt(String(params.offset || 0), 10) || 0);

  const filters = ['o."workspaceId" = $1'];
  const values = [workspace.id];

  if (search) {
    values.push(`%${search.toLowerCase()}%`);
    filters.push(
      `(lower(o."externalId") like $${values.length} or lower(coalesce(o."externalCode", '')) like $${values.length} or lower(coalesce(o."buyerName", '')) like $${values.length})`,
    );
  }

  if (status) {
    values.push(status);
    filters.push(`o."status" = $${values.length}::"MadOrderStatus"`);
  }

  if (dateFrom) {
    values.push(`${dateFrom}T00:00:00.000Z`);
    filters.push(`coalesce(o."approvedAt", o."importedAt", o."createdAt") >= $${values.length}`);
  }

  if (dateTo) {
    values.push(`${dateTo}T23:59:59.999Z`);
    filters.push(`coalesce(o."approvedAt", o."importedAt", o."createdAt") <= $${values.length}`);
  }

  const whereClause = `where ${filters.join(" and ")}`;
  const countRow = await queryOne(
    `select count(*)::int as count from "MadOrder" o ${whereClause}`,
    values,
  );

  const rows = await queryRows(
    `
      select
        o.*,
        coalesce(items."itemCount", 0)::int as "itemCount",
        coalesce(items."units", 0)::int as "units",
        coalesce(threads."threadCount", 0)::int as "threadCount"
      from "MadOrder" o
      left join lateral (
        select count(*) as "itemCount", coalesce(sum("quantity"), 0) as "units"
        from "MadOrderItem"
        where "orderId" = o."id"
      ) items on true
      left join lateral (
        select count(*) as "threadCount"
        from "MadMessageThread"
        where "orderId" = o."id"
      ) threads on true
      ${whereClause}
      order by coalesce(o."approvedAt", o."importedAt", o."createdAt") desc
      limit $${values.length + 1}
      offset $${values.length + 2}
    `,
    [...values, limit, offset],
  );

  return {
    workspace,
    total: Number(countRow?.count || 0),
    limit,
    offset,
    items: rows.map(mapOrderRow),
  };
}

async function getLocalOrder(identifier, options = {}) {
  const workspace =
    options.workspaceId && String(options.workspaceId).trim()
      ? await getWorkspaceById(String(options.workspaceId).trim())
      : await getOrCreateDefaultWorkspace();
  const normalizedIdentifier = sanitizeText(identifier);

  if (!normalizedIdentifier) {
    return null;
  }

  const row = await queryOne(
    `
      select *
      from "MadOrder"
      where "workspaceId" = $1
        and ("id" = $2 or "externalId" = $2 or coalesce("externalCode", '') = $2)
      limit 1
    `,
    [workspace.id, normalizedIdentifier],
  );

  if (!row) {
    return null;
  }

  const [items, freightQuotes, financialEntries, threads] = await Promise.all([
    queryRows(
      `
        select
          "id",
          "lineNumber",
          "sku",
          "title",
          "quantity",
          "unitPrice",
          "totalPrice",
          "metadata"
        from "MadOrderItem"
        where "orderId" = $1
        order by "lineNumber" asc
      `,
      [row.id],
    ),
    queryRows(
      `
        select *
        from "MadFreightQuote"
        where "orderId" = $1
        order by "requestedAt" desc
      `,
      [row.id],
    ),
    queryRows(
      `
        select *
        from "MadFinancialEntry"
        where "orderId" = $1
        order by coalesce("paidAt", "releaseDate", "createdAt") desc
      `,
      [row.id],
    ),
    queryRows(
      `
        select
          t.*,
          coalesce(msg."messageCount", 0)::int as "messageCount",
          msg."lastMessagePreview"
        from "MadMessageThread" t
        left join lateral (
          select
            count(*) as "messageCount",
            (
              select left(coalesce(m2."content", ''), 120)
              from "MadMessage" m2
              where m2."threadId" = t."id"
              order by coalesce(m2."sentAt", m2."createdAt") desc
              limit 1
            ) as "lastMessagePreview"
          from "MadMessage" m
          where m."threadId" = t."id"
        ) msg on true
        where t."orderId" = $1
        order by coalesce(t."lastMessageAt", t."updatedAt") desc
      `,
      [row.id],
    ),
  ]);

  const order = mapOrderRow({
    ...row,
    itemCount: items.length,
    units: items.reduce((total, item) => total + Number(item.quantity || 0), 0),
    threadCount: threads.length,
  });

  order.items = items.map((item) => ({
    ...item,
    quantity: Number(item.quantity || 0),
    unitPrice: toNumber(item.unitPrice),
    totalPrice: toNumber(item.totalPrice),
  }));
  order.freightQuotes = freightQuotes.map(mapFreightRow);
  order.financialEntries = financialEntries.map(mapFinancialRow);
  order.threads = threads.map(mapThreadRow);
  return order;
}

async function getOrdersOverview(params = {}) {
  const workspace =
    params.workspaceId && String(params.workspaceId).trim()
      ? await getWorkspaceById(String(params.workspaceId).trim())
      : await getOrCreateDefaultWorkspace();

  const [statusRows, summary] = await Promise.all([
    queryRows(
      `
        select "status"::text as "status", count(*)::int as "count"
        from "MadOrder"
        where "workspaceId" = $1
        group by "status"
        order by count(*) desc, "status" asc
      `,
      [workspace.id],
    ),
    queryOne(
      `
        select
          count(*)::int as "totalOrders",
          count(*) filter (where "status" in ('imported', 'awaiting_invoice', 'ready_to_ship', 'shipped', 'on_hold'))::int as "openOrders",
          count(*) filter (where "status" = 'delivered')::int as "deliveredOrders",
          count(*) filter (where "status" = 'cancelled')::int as "cancelledOrders",
          coalesce(sum("totalAmount"), 0)::numeric as "grossRevenue",
          coalesce(avg(nullif("totalAmount", 0)), 0)::numeric as "averageTicket"
        from "MadOrder"
        where "workspaceId" = $1
      `,
      [workspace.id],
    ),
  ]);

  return {
    workspace,
    summary: {
      totalOrders: Number(summary?.totalOrders || 0),
      openOrders: Number(summary?.openOrders || 0),
      deliveredOrders: Number(summary?.deliveredOrders || 0),
      cancelledOrders: Number(summary?.cancelledOrders || 0),
      grossRevenue: toNumber(summary?.grossRevenue),
      averageTicket: toNumber(summary?.averageTicket),
    },
    byStatus: statusRows.map((row) => ({
      status: row.status,
      count: Number(row.count || 0),
    })),
  };
}

async function listFreightQuotes(params = {}) {
  const workspace =
    params.workspaceId && String(params.workspaceId).trim()
      ? await getWorkspaceById(String(params.workspaceId).trim())
      : await getOrCreateDefaultWorkspace();
  const limit = toPositiveInt(params.limit, 20);
  const offset = Math.max(0, Number.parseInt(String(params.offset || 0), 10) || 0);

  const rows = await queryRows(
    `
      select *
      from "MadFreightQuote"
      where "workspaceId" = $1
      order by "requestedAt" desc
      limit $2
      offset $3
    `,
    [workspace.id, limit, offset],
  );

  const countRow = await queryOne(
    `
      select count(*)::int as count
      from "MadFreightQuote"
      where "workspaceId" = $1
    `,
    [workspace.id],
  );

  return {
    workspace,
    total: Number(countRow?.count || 0),
    limit,
    offset,
    items: rows.map(mapFreightRow),
  };
}

async function getFreightOverview(params = {}) {
  const workspace =
    params.workspaceId && String(params.workspaceId).trim()
      ? await getWorkspaceById(String(params.workspaceId).trim())
      : await getOrCreateDefaultWorkspace();

  const [summary, carriers] = await Promise.all([
    queryOne(
      `
        select
          count(*)::int as "totalQuotes",
          count(*) filter (where "status" = 'quoted')::int as "quotedQuotes",
          count(*) filter (where "responseTimeMs" <= 1500)::int as "withinSlaQuotes",
          coalesce(avg("quotedAmount"), 0)::numeric as "averageQuotedAmount",
          coalesce(avg("responseTimeMs"), 0)::numeric as "averageResponseTimeMs"
        from "MadFreightQuote"
        where "workspaceId" = $1
      `,
      [workspace.id],
    ),
    queryRows(
      `
        select
          coalesce("carrierName", 'Nao informado') as "carrierName",
          count(*)::int as "count",
          coalesce(avg("responseTimeMs"), 0)::numeric as "averageResponseTimeMs"
        from "MadFreightQuote"
        where "workspaceId" = $1
        group by coalesce("carrierName", 'Nao informado')
        order by count(*) desc, "carrierName" asc
        limit 5
      `,
      [workspace.id],
    ),
  ]);

  const totalQuotes = Number(summary?.totalQuotes || 0);
  const withinSlaQuotes = Number(summary?.withinSlaQuotes || 0);

  return {
    workspace,
    summary: {
      totalQuotes,
      quotedQuotes: Number(summary?.quotedQuotes || 0),
      withinSlaQuotes,
      averageQuotedAmount: toNumber(summary?.averageQuotedAmount),
      averageResponseTimeMs: toNumber(summary?.averageResponseTimeMs),
      slaRate: totalQuotes > 0 ? Number(((withinSlaQuotes / totalQuotes) * 100).toFixed(2)) : 0,
    },
    topCarriers: carriers.map((row) => ({
      carrierName: row.carrierName,
      count: Number(row.count || 0),
      averageResponseTimeMs: toNumber(row.averageResponseTimeMs),
    })),
  };
}

async function listFinancialEntries(params = {}) {
  const workspace =
    params.workspaceId && String(params.workspaceId).trim()
      ? await getWorkspaceById(String(params.workspaceId).trim())
      : await getOrCreateDefaultWorkspace();
  const status = normalizeEnum(params.status, FINANCIAL_STATUSES, null);
  const search = sanitizeText(params.search);
  const dateFrom = sanitizeText(params.dateFrom);
  const dateTo = sanitizeText(params.dateTo);
  const limit = toPositiveInt(params.limit, 20);
  const offset = Math.max(0, Number.parseInt(String(params.offset || 0), 10) || 0);

  const filters = ['"workspaceId" = $1'];
  const values = [workspace.id];

  if (status) {
    values.push(status);
    filters.push(`"status" = $${values.length}::"MadFinancialStatus"`);
  }

  if (search) {
    values.push(`%${search.toLowerCase()}%`);
    filters.push(`(
      lower(coalesce("description", '')) like $${values.length}
      or lower(coalesce("externalId", '')) like $${values.length}
    )`);
  }

  if (dateFrom) {
    values.push(`${dateFrom}T00:00:00.000Z`);
    filters.push(`coalesce("paidAt", "releaseDate", "createdAt") >= $${values.length}`);
  }

  if (dateTo) {
    values.push(`${dateTo}T23:59:59.999Z`);
    filters.push(`coalesce("paidAt", "releaseDate", "createdAt") <= $${values.length}`);
  }

  const whereClause = `where ${filters.join(" and ")}`;
  const rows = await queryRows(
    `
      select *
      from "MadFinancialEntry"
      ${whereClause}
      order by coalesce("paidAt", "releaseDate", "createdAt") desc
      limit $${values.length + 1}
      offset $${values.length + 2}
    `,
    [...values, limit, offset],
  );

  const countRow = await queryOne(
    `
      select count(*)::int as count
      from "MadFinancialEntry"
      ${whereClause}
    `,
    values,
  );

  return {
    workspace,
    total: Number(countRow?.count || 0),
    limit,
    offset,
    items: rows.map(mapFinancialRow),
  };
}

async function getFinanceOverview(params = {}) {
  const workspace =
    params.workspaceId && String(params.workspaceId).trim()
      ? await getWorkspaceById(String(params.workspaceId).trim())
      : await getOrCreateDefaultWorkspace();

  const [summary, byStatus] = await Promise.all([
    queryOne(
      `
        select
          count(*)::int as "totalEntries",
          coalesce(sum("grossAmount"), 0)::numeric as "grossAmount",
          coalesce(sum("feeAmount"), 0)::numeric as "feeAmount",
          coalesce(sum("netAmount"), 0)::numeric as "netAmount",
          count(*) filter (where "status" = 'paid')::int as "paidEntries",
          count(*) filter (where "status" = 'pending')::int as "pendingEntries"
        from "MadFinancialEntry"
        where "workspaceId" = $1
      `,
      [workspace.id],
    ),
    queryRows(
      `
        select "status"::text as "status", count(*)::int as "count"
        from "MadFinancialEntry"
        where "workspaceId" = $1
        group by "status"
        order by count(*) desc, "status" asc
      `,
      [workspace.id],
    ),
  ]);

  return {
    workspace,
    summary: {
      totalEntries: Number(summary?.totalEntries || 0),
      grossAmount: toNumber(summary?.grossAmount),
      feeAmount: toNumber(summary?.feeAmount),
      netAmount: toNumber(summary?.netAmount),
      paidEntries: Number(summary?.paidEntries || 0),
      pendingEntries: Number(summary?.pendingEntries || 0),
    },
    byStatus: byStatus.map((row) => ({
      status: row.status,
      count: Number(row.count || 0),
    })),
  };
}

async function listMessageThreads(params = {}) {
  const workspace =
    params.workspaceId && String(params.workspaceId).trim()
      ? await getWorkspaceById(String(params.workspaceId).trim())
      : await getOrCreateDefaultWorkspace();
  const status = normalizeEnum(params.status, THREAD_STATUSES, null);
  const search = sanitizeText(params.search);
  const unreadOnly =
    String(params.unreadOnly || "")
      .trim()
      .toLowerCase() === "true";
  const limit = toPositiveInt(params.limit, 20);
  const offset = Math.max(0, Number.parseInt(String(params.offset || 0), 10) || 0);

  const filters = ['t."workspaceId" = $1'];
  const values = [workspace.id];

  if (status) {
    values.push(status);
    filters.push(`t."status" = $${values.length}::"MadThreadStatus"`);
  }

  if (search) {
    values.push(`%${search.toLowerCase()}%`);
    filters.push(`(
      lower(coalesce(t."externalThreadId", '')) like $${values.length}
      or lower(coalesce(t."counterpartName", '')) like $${values.length}
      or exists (
        select 1
        from "MadMessage" mx
        where mx."threadId" = t."id"
          and lower(coalesce(mx."content", '')) like $${values.length}
      )
    )`);
  }

  if (unreadOnly) {
    filters.push(`coalesce(t."unreadCount", 0) > 0`);
  }

  const whereClause = `where ${filters.join(" and ")}`;
  const rows = await queryRows(
    `
      select
        t.*,
        coalesce(msg."messageCount", 0)::int as "messageCount",
        msg."lastMessagePreview"
      from "MadMessageThread" t
      left join lateral (
        select
          count(*) as "messageCount",
          (
            select left(coalesce(m2."content", ''), 120)
            from "MadMessage" m2
            where m2."threadId" = t."id"
            order by coalesce(m2."sentAt", m2."createdAt") desc
            limit 1
          ) as "lastMessagePreview"
        from "MadMessage" m
        where m."threadId" = t."id"
      ) msg on true
      ${whereClause}
      order by coalesce(t."lastMessageAt", t."updatedAt") desc
      limit $${values.length + 1}
      offset $${values.length + 2}
    `,
    [...values, limit, offset],
  );

  const countRow = await queryOne(
    `
      select count(*)::int as count
      from "MadMessageThread" t
      ${whereClause}
    `,
    values,
  );

  return {
    workspace,
    total: Number(countRow?.count || 0),
    limit,
    offset,
    items: rows.map(mapThreadRow),
  };
}

async function getMessagingOverview(params = {}) {
  const workspace =
    params.workspaceId && String(params.workspaceId).trim()
      ? await getWorkspaceById(String(params.workspaceId).trim())
      : await getOrCreateDefaultWorkspace();

  const [summary, byStatus] = await Promise.all([
    queryOne(
      `
        select
          count(*)::int as "totalThreads",
          count(*) filter (where "status" in ('open', 'waiting_seller', 'waiting_marketplace'))::int as "openThreads",
          coalesce(sum("unreadCount"), 0)::int as "unreadMessages",
          count(*) filter (where "lastMessageAt" >= now() - interval '7 days')::int as "recentThreads"
        from "MadMessageThread"
        where "workspaceId" = $1
      `,
      [workspace.id],
    ),
    queryRows(
      `
        select "status"::text as "status", count(*)::int as "count"
        from "MadMessageThread"
        where "workspaceId" = $1
        group by "status"
        order by count(*) desc, "status" asc
      `,
      [workspace.id],
    ),
  ]);

  return {
    workspace,
    summary: {
      totalThreads: Number(summary?.totalThreads || 0),
      openThreads: Number(summary?.openThreads || 0),
      unreadMessages: Number(summary?.unreadMessages || 0),
      recentThreads: Number(summary?.recentThreads || 0),
    },
    byStatus: byStatus.map((row) => ({
      status: row.status,
      count: Number(row.count || 0),
    })),
  };
}

module.exports = {
  buildMarketplaceProductPayload,
  getCatalogOverview,
  getFinanceOverview,
  getFreightOverview,
  getLocalOrder,
  getLocalProduct,
  getMessagingOverview,
  getOrdersOverview,
  listFinancialEntries,
  listFreightQuotes,
  listLocalCategories,
  listLocalOrders,
  listLocalProducts,
  listMessageThreads,
  saveLocalProduct,
};
