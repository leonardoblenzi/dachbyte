import { createHash } from 'crypto';
import { TrayFreightService } from './trayFreightService';
import { TrayApiService } from './trayApiService';
import { AnymarketFreightService } from './anymarketFreightService';
import { dbQuery } from '../lib/db';

export const safeString = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};

export const safeNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const normalized =
    typeof value === 'number'
      ? value
      : Number.parseFloat(String(value).replace(/[^\d,.-]/g, '').replace(',', '.'));

  return Number.isFinite(normalized) ? normalized : null;
};

export const safeInteger = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(String(value).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
};

export const normalizeZipCode = (value: unknown) => {
  const digits = String(value || '').replace(/\D/g, '').trim();
  return digits || null;
};

export const buildProductsHash = (productsRaw: unknown) => {
  if (productsRaw === null || productsRaw === undefined) return null;

  try {
    const serialized = typeof productsRaw === 'string' ? productsRaw : JSON.stringify(productsRaw);
    if (!serialized) return null;
    return createHash('sha256').update(serialized).digest('hex');
  } catch {
    return null;
  }
};

export type FreightRequestProduct = {
  product_id: string;
  price: number;
  quantity: number;
};

export type FreightAuditProduct = FreightRequestProduct & {
  name: string | null;
  reference: string | null;
  variant_id: string | null;
  weight: number | null;
  length: number | null;
  width: number | null;
  height: number | null;
};

export type ExtractedTrayOrderProducts = {
  requestProducts: FreightRequestProduct[];
  auditProducts: FreightAuditProduct[];
  source: string | null;
  productsHash: string | null;
};

export type AnymarketFreightRequestProduct = {
  skuId: string;
  amount: number;
  dimensions?: {
    height?: number;
    width?: number;
    weight?: number;
    length?: number;
  };
};

export type AnymarketFreightAuditProduct = {
  skuId: string;
  amount: number;
  name: string | null;
  partnerId: string | null;
  ean: string | null;
  marketplaceItemId: string | null;
  price: number | null;
  discountPrice: number | null;
  height: number | null;
  width: number | null;
  weight: number | null;
  length: number | null;
};

export type ExtractedAnymarketOrderProducts = {
  requestProducts: AnymarketFreightRequestProduct[];
  auditProducts: AnymarketFreightAuditProduct[];
  source: string | null;
  productsHash: string | null;
  marketPlace: string | null;
};

const PRODUCT_COLLECTION_PATHS = [
  'OrderItem',
  'OrderItems',
  'ProductSold',
  'ProductsSold',
  'products',
  'items',
  'order_items',
  'orderItems',
  'Order.OrderItem',
  'Order.OrderItems',
  'Order.ProductSold',
  'Order.ProductsSold',
  'Order.products',
  'Order.items',
  'order.order_items',
  'order.orderItems',
  'order.items',
  'order.products',
];

const PRODUCT_COLLECTION_HINT = /(orderitem|orderitems|productsold|productssold|products|items|order_items|orderitems)/i;

const getValueByPath = (source: any, path: string) =>
  path.split('.').reduce((current, segment) => current?.[segment], source);

const collectProductCollections = (
  rawPayload: any,
): Array<{ source: string; items: any[] }> => {
  const collections = new Map<string, any[]>();

  for (const path of PRODUCT_COLLECTION_PATHS) {
    const value = getValueByPath(rawPayload, path);
    if (Array.isArray(value) && value.length > 0) {
      collections.set(path, value);
    }
  }

  const visit = (node: any, path: string, visited: WeakSet<object>) => {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (visited.has(node)) {
      return;
    }
    visited.add(node);

    if (Array.isArray(node)) {
      if (node.length > 0 && PRODUCT_COLLECTION_HINT.test(path)) {
        collections.set(path || 'root', node);
      }

      node.forEach((item, index) => visit(item, `${path}[${index}]`, visited));
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (Array.isArray(value) && value.length > 0 && PRODUCT_COLLECTION_HINT.test(key)) {
        collections.set(nextPath, value);
      }

      if (value && typeof value === 'object') {
        visit(value, nextPath, visited);
      }
    }
  };

  visit(rawPayload, '', new WeakSet<object>());

  return Array.from(collections.entries()).map(([source, items]) => ({
    source,
    items,
  }));
};

const resolveProductId = (item: any) =>
  safeString(
    item?.product_id ??
      item?.id_product ??
      item?.Product?.id ??
      item?.Product?.product_id ??
      item?.product?.id ??
      item?.product?.product_id ??
      item?.product?.id_product ??
      item?.id,
  );

export const extractTrayOrderProducts = (
  rawPayload: any,
): ExtractedTrayOrderProducts => {
  const candidateCollections = collectProductCollections(rawPayload);

  for (const collection of candidateCollections) {
    const auditProducts = (collection.items as any[])
      .map((entry: any) => {
        const item =
          entry?.OrderItem ||
          entry?.ProductsSold ||
          entry?.ProductSold ||
          entry?.item ||
          entry?.Product ||
          entry?.product ||
          entry;
        const productId = resolveProductId(item);
        const quantity =
          safeInteger(
            item?.quantity ??
              item?.qty ??
              item?.amount ??
              item?.quantity_sold ??
              item?.sold_quantity ??
              1,
          ) || 1;
        const directTotal = safeNumber(
          item?.total ?? item?.subtotal ?? item?.total_price ?? item?.amount,
        );
        const unitPrice =
          safeNumber(
            item?.price ??
              item?.sale_price ??
              item?.price_sale ??
              item?.original_price ??
              item?.unit_price ??
              item?.unit_value ??
              item?.value ??
              item?.Product?.price ??
              item?.product?.price,
          ) ?? (directTotal !== null ? directTotal / quantity : null);

        if (!productId || unitPrice === null || quantity <= 0) {
          return null;
        }

        return {
          product_id: productId,
          price: unitPrice,
          quantity,
          name: safeString(item?.name ?? item?.Product?.name),
          reference: safeString(item?.reference ?? item?.Product?.reference),
          variant_id: safeString(item?.variant_id ?? item?.variation_id),
          weight: safeNumber(item?.weight ?? item?.gross_weight),
          length: safeNumber(item?.length),
          width: safeNumber(item?.width),
          height: safeNumber(item?.height),
        };
      })
      .filter((item): item is FreightAuditProduct => Boolean(item));

    if (auditProducts.length > 0) {
      return {
        requestProducts: auditProducts.map(({ product_id, price, quantity }) => ({
          product_id,
          price,
          quantity,
        })),
        auditProducts,
        source: collection.source,
        productsHash: buildProductsHash(auditProducts),
      };
    }
  }

  return {
    requestProducts: [],
    auditProducts: [],
    source: null,
    productsHash: null,
  };
};

export const buildRecalculatedDetails = (
  cotationOptions: any[],
  selectedOption: any,
  matchedByCarrier: boolean,
  requestedCarrier: string | null | undefined,
  quoteRequest: {
    zipcode: string;
    source: string | null;
    productsHash: string | null;
    products: any[];
  },
) => {
  const normalizeComparableText = (value: unknown) =>
    String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .trim();

  const looksLikeIntegratorLabel = (value: unknown) => {
    const normalized = normalizeComparableText(value);
    if (!normalized) return false;

    return [
      'INTELIPOST',
      'FRETE FACIL',
      'FRETEFACIL',
      'MELHOR ENVIO',
      'KANGU',
      'FRENET',
    ].some((token) => normalized === token || normalized.includes(token));
  };

  const looksLikeGenericServiceLabel = (value: unknown) => {
    const normalized = normalizeComparableText(value);
    if (!normalized) return true;

    return [
      'EMISSAO DE NOTA FISCAL',
      'EMISSAO NOTA FISCAL',
      'NOTA FISCAL',
      'DOCUMENTO FISCAL',
      'COTACAO DE FRETE',
      'FRETE',
    ].some((token) => normalized === token || normalized.includes(token));
  };

  const pickCarrierCandidate = (...candidates: unknown[]) => {
    for (const candidate of candidates) {
      const normalized = safeString(candidate);
      if (!normalized) continue;
      if (looksLikeIntegratorLabel(normalized)) continue;
      if (looksLikeGenericServiceLabel(normalized)) continue;
      return normalized;
    }

    return null;
  };

  const selectedCarrierName =
    (matchedByCarrier ? safeString(requestedCarrier) : null) ||
    pickCarrierCandidate(
      selectedOption?.carrier_name,
      selectedOption?.carrierName,
      selectedOption?.carrier,
      selectedOption?.transportadora,
      selectedOption?.shipping_company,
      selectedOption?.delivery_method?.carrier_name,
      selectedOption?.taxe?.name,
      selectedOption?.name,
      selectedOption?.identifier,
    );

  const selectedServiceName =
    safeString(selectedOption?.serviceName) ||
    safeString(selectedOption?.service_name) ||
    safeString(selectedOption?.service) ||
    safeString(selectedOption?.identifier) ||
    (looksLikeGenericServiceLabel(selectedOption?.name)
      ? null
      : safeString(selectedOption?.name)) ||
    safeString(selectedOption?.delivery_method?.name) ||
    null;

  return {
    selectedOption,
    selectedCarrierName,
    selectedServiceName,
    matchedByCarrier,
    selectionStrategy: matchedByCarrier ? 'carrier_match' : 'best_available_option',
    requestedCarrier: safeString(requestedCarrier),
    optionsCount: cotationOptions.length,
    options: cotationOptions,
    quoteRequest,
  };
};

const hasSelectedOption = (details: any) => {
  if (!details || typeof details !== 'object') {
    return false;
  }

  if (
    details.selectedOption &&
    typeof details.selectedOption === 'object' &&
    Object.keys(details.selectedOption).length > 0
  ) {
    return true;
  }

  return Boolean(
    safeString(details.selectedCarrierName) || safeString(details.selectedServiceName),
  );
};

const normalizeComparableText = (value: unknown) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

const isInvalidStoredCarrierName = (value: unknown) => {
  const normalized = normalizeComparableText(value);
  if (!normalized) return true;

  return [
    'EMISSAO DE NOTA FISCAL',
    'EMISSAO NOTA FISCAL',
    'NOTA FISCAL',
    'DOCUMENTO FISCAL',
    'COTACAO DE FRETE',
    'FRETE',
    'INTELIPOST',
    'FRETE FACIL',
    'FRETEFACIL',
    'MELHOR ENVIO',
    'KANGU',
    'FRENET',
  ].some((token) => normalized === token || normalized.includes(token));
};

export const needsFreightRecalculation = (order: {
  recalculatedFreightValue?: number | null;
  recalculatedFreightDate?: Date | string | null;
  recalculatedFreightDetails?: any;
}) => {
  const details = order?.recalculatedFreightDetails;
  const hasProductsSnapshot =
    Array.isArray(details?.quoteRequest?.products) &&
    details.quoteRequest.products.length > 0;
  const hasValidStoredCarrierName = !isInvalidStoredCarrierName(
    details?.selectedCarrierName,
  );

  return (
    order?.recalculatedFreightValue === null ||
    order?.recalculatedFreightValue === undefined ||
    !order?.recalculatedFreightDate ||
    !hasSelectedOption(details) ||
    !hasProductsSnapshot ||
    !hasValidStoredCarrierName
  );
};

type RecalculateStoredOrderFreightArgs = {
  prisma?: any;
  order: any;
  companyId: string;
  freightService?: TrayFreightService;
  force?: boolean;
};

const persistOrderFreightRecalculation = async ({
  db,
  orderId,
  apiRawPayload,
  recalculatedFreightValue,
  recalculatedFreightDetails,
}: {
  db?: any;
  orderId: string;
  apiRawPayload?: any;
  recalculatedFreightValue: number | null;
  recalculatedFreightDetails: any;
}) => {
  if (db?.order?.update) {
    return db.order.update({
      where: { id: orderId },
      data: {
        ...(apiRawPayload !== undefined ? { apiRawPayload } : {}),
        recalculatedFreightValue,
        recalculatedFreightDate: new Date(),
        recalculatedFreightDetails,
      },
    });
  }

  return dbQuery(
    `
      UPDATE "Order"
      SET
        "apiRawPayload" = CASE
          WHEN $2::jsonb IS NULL THEN "apiRawPayload"
          ELSE $2::jsonb
        END,
        "recalculatedFreightValue" = $3,
        "recalculatedFreightDate" = NOW(),
        "recalculatedFreightDetails" = $4::jsonb,
        "lastUpdate" = NOW()
      WHERE "id" = $1
    `,
    [
      orderId,
      apiRawPayload === undefined ? null : JSON.stringify(apiRawPayload),
      recalculatedFreightValue,
      recalculatedFreightDetails ? JSON.stringify(recalculatedFreightDetails) : null,
    ],
  );
};

const resolveTrayOrderIdentifier = (order: any) =>
  safeString(order?.apiRawPayload?.id) ||
  safeString(order?.apiRawPayload?.Order?.id) ||
  safeString(order?.orderNumber) ||
  null;

const hasNumber = (value: unknown) => safeNumber(value) !== null;

const buildAnymarketDimensions = (item: any) => {
  const height = safeNumber(
    item?.dimensions?.height ?? item?.height ?? item?.sku?.height,
  );
  const width = safeNumber(
    item?.dimensions?.width ?? item?.width ?? item?.sku?.width,
  );
  const weight = safeNumber(
    item?.dimensions?.weight ?? item?.weight ?? item?.sku?.weight,
  );
  const length = safeNumber(
    item?.dimensions?.length ?? item?.length ?? item?.sku?.length,
  );

  if (![height, width, weight, length].some((value) => value !== null)) {
    return undefined;
  }

  return {
    ...(height !== null ? { height } : {}),
    ...(width !== null ? { width } : {}),
    ...(weight !== null ? { weight } : {}),
    ...(length !== null ? { length } : {}),
  };
};

export const extractAnymarketOrderProducts = (
  rawPayload: any,
): ExtractedAnymarketOrderProducts => {
  const items = Array.isArray(rawPayload?.items) ? rawPayload.items : [];

  const auditProducts = items
    .map((item: any) => {
      const sku = item?.sku || {};
      const product = item?.product || {};
      const skuId = safeString(sku?.id ?? item?.skuId ?? sku?.partnerId);
      const amount = safeInteger(item?.amount ?? item?.quantity ?? 1) || 1;
      const dimensions = buildAnymarketDimensions(item);

      if (!skuId || amount <= 0) {
        return null;
      }

      return {
        skuId,
        amount,
        name: safeString(sku?.title ?? product?.title ?? item?.title),
        partnerId: safeString(sku?.partnerId),
        ean: safeString(sku?.ean),
        marketplaceItemId: safeString(item?.marketPlaceId ?? item?.idInMarketPlace),
        price: safeNumber(item?.gross ?? item?.unit ?? product?.price),
        discountPrice: safeNumber(item?.total),
        height: hasNumber(dimensions?.height) ? safeNumber(dimensions?.height) : null,
        width: hasNumber(dimensions?.width) ? safeNumber(dimensions?.width) : null,
        weight: hasNumber(dimensions?.weight) ? safeNumber(dimensions?.weight) : null,
        length: hasNumber(dimensions?.length) ? safeNumber(dimensions?.length) : null,
        dimensions,
      };
    })
    .filter((item): item is AnymarketFreightAuditProduct & { dimensions?: any } => Boolean(item));

  return {
    requestProducts: auditProducts.map((item) => ({
      skuId: item.skuId,
      amount: item.amount,
      ...(item.dimensions ? { dimensions: item.dimensions } : {}),
    })),
    auditProducts: auditProducts.map(({ dimensions, ...item }) => item),
    source: safeString(rawPayload?.source) || 'items',
    productsHash: buildProductsHash(auditProducts),
    marketPlace: safeString(rawPayload?.marketPlace),
  };
};

const resolveFreightProvider = (order: any): 'anymarket' | 'tray' => {
  const source = String(order?.apiRawPayload?.source || '').trim().toUpperCase();

  if (source === 'ANYMARKET') {
    return 'anymarket';
  }

  const rawPayload = order?.apiRawPayload;
  if (
    rawPayload &&
    Array.isArray(rawPayload?.items) &&
    safeString(rawPayload?.marketPlaceId) &&
    safeString(rawPayload?.marketPlace)
  ) {
    return 'anymarket';
  }

  return 'tray';
};

export const recalculateStoredOrderFreight = async ({
  prisma,
  order,
  companyId,
  freightService,
  force = false,
}: RecalculateStoredOrderFreightArgs) => {
  const db = prisma as any;
  if (!force && !needsFreightRecalculation(order)) {
    return {
      skipped: true,
      reason: 'already_recalculated',
      order,
    };
  }

  const zipcode = normalizeZipCode(order?.zipCode);
  if (!zipcode) {
    throw new Error('Pedido sem CEP valido');
  }

  const freightProvider = resolveFreightProvider(order);

  if (freightProvider === 'anymarket') {
    const payloadForRecalculation = order?.apiRawPayload;
    const extractedProducts = extractAnymarketOrderProducts(payloadForRecalculation);
    const marketPlace = safeString(extractedProducts.marketPlace);

    if (!marketPlace) {
      throw new Error(
        'Pedido ANYMARKET sem marketplace valido para recotacao de frete.',
      );
    }

    if (extractedProducts.requestProducts.length === 0) {
      throw new Error(
        'Pedido ANYMARKET sem produtos validos para recotacao. A API /freight/quotes exige skuId e amount reais do pedido.',
      );
    }

    const anymarketFreightService = new AnymarketFreightService(companyId);
    const cotationResult = await anymarketFreightService.quoteFreight({
      zipCode: zipcode,
      marketPlace,
      products: extractedProducts.requestProducts,
    });

    const cotationOptions = Array.isArray(cotationResult?.quotes)
      ? cotationResult.quotes
      : [];
    const defaultFreight = cotationResult?.defaultFreight || null;

    if (cotationOptions.length === 0 && !defaultFreight) {
      throw new Error('Nenhuma opcao de frete disponivel no ANYMARKET para este CEP');
    }

    const cheapestOption = anymarketFreightService.getCheapestOption(cotationOptions);
    const fastestOption = anymarketFreightService.getFastestOption(cotationOptions);
    const matchedOption = anymarketFreightService.getPreferredOptionForCarrier(
      cotationOptions,
      order?.freightType,
    );
    const selectedOption =
      matchedOption || cheapestOption || fastestOption || defaultFreight || cotationOptions[0] || null;
    const quotedValue = selectedOption ? safeNumber(selectedOption.price) : null;
    const recalculatedFreightDetails = buildRecalculatedDetails(
      cotationOptions,
      selectedOption,
      Boolean(matchedOption),
      order?.freightType,
      {
        zipcode,
        source: extractedProducts.source,
        productsHash: extractedProducts.productsHash,
        products: extractedProducts.auditProducts,
      },
    );

    await persistOrderFreightRecalculation({
      db,
      orderId: String(order.id),
      recalculatedFreightValue: quotedValue,
      recalculatedFreightDetails: {
        ...recalculatedFreightDetails,
        provider: 'ANYMARKET',
        marketPlace,
        missingSkus: cotationResult?.missingSkus ?? null,
        defaultFreight,
      },
    });

    return {
      skipped: false,
      order,
      provider: 'ANYMARKET',
      cotationResult,
      cotationOptions,
      cheapestOption,
      fastestOption,
      matchedOption,
      selectedOption,
      quotedValue,
      extractedProducts,
      recalculatedFreightDetails,
      destination: {
        zipcode,
        marketPlace,
      },
    };
  }

  let payloadForRecalculation = order?.apiRawPayload;
  let extractedProducts = extractTrayOrderProducts(payloadForRecalculation);

  if (extractedProducts.requestProducts.length === 0) {
    const trayOrderIdentifier = resolveTrayOrderIdentifier(order);

    if (trayOrderIdentifier) {
      const trayApiService = new TrayApiService(companyId);
      const completeOrderResponse = await trayApiService.getOrderComplete(
        trayOrderIdentifier,
      );
      const completeOrderPayload = completeOrderResponse?.Order || null;

      if (completeOrderPayload) {
        payloadForRecalculation = completeOrderPayload;
        extractedProducts = extractTrayOrderProducts(completeOrderPayload);
      }
    }
  }

  if (extractedProducts.requestProducts.length === 0) {
    throw new Error(
      'Pedido sem produtos validos para recotacao na Tray mesmo apos consultar o pedido completo. A API /shippings/cotation exige product_id, price e quantity reais do pedido.',
    );
  }

  const resolvedFreightService =
    freightService || new TrayFreightService(companyId);
  const cotationResult = await resolvedFreightService.quoteFreight({
    zipcode,
    products: extractedProducts.requestProducts,
  });
  const cotationOptions = Array.isArray(cotationResult?.Shipping?.cotation)
    ? cotationResult.Shipping.cotation
    : [];

  if (cotationOptions.length === 0) {
    throw new Error('Nenhuma opcao de frete disponivel para este CEP');
  }

  const cheapestOption = resolvedFreightService.getCheapestOption(cotationOptions);
  const fastestOption = resolvedFreightService.getFastestOption(cotationOptions);
  const matchedOption = resolvedFreightService.getPreferredOptionForCarrier(
    cotationOptions,
    order?.freightType,
    payloadForRecalculation?.shipment,
  );
  const selectedOption =
    matchedOption || cheapestOption || fastestOption || cotationOptions[0] || null;
  const quotedValue = selectedOption ? safeNumber(selectedOption.value) : null;
  const recalculatedFreightDetails = buildRecalculatedDetails(
    cotationOptions,
    selectedOption,
    Boolean(matchedOption),
    order?.freightType,
    {
      zipcode,
      source: extractedProducts.source,
      productsHash: extractedProducts.productsHash,
      products: extractedProducts.auditProducts,
    },
  );

  await persistOrderFreightRecalculation({
    db,
    orderId: String(order.id),
    apiRawPayload: payloadForRecalculation ?? order?.apiRawPayload ?? null,
    recalculatedFreightValue: quotedValue,
    recalculatedFreightDetails,
  });

  return {
    skipped: false,
    order,
    provider: 'TRAY',
    cotationResult,
    cotationOptions,
    cheapestOption,
    fastestOption,
    matchedOption,
    selectedOption,
    quotedValue,
    extractedProducts,
    recalculatedFreightDetails,
  };
};
