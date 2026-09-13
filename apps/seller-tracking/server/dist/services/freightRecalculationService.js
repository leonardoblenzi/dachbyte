"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recalculateStoredOrderFreight = exports.extractAnymarketOrderProducts = exports.needsFreightRecalculation = exports.buildRecalculatedDetails = exports.extractTrayOrderProducts = exports.buildProductsHash = exports.normalizeZipCode = exports.safeInteger = exports.safeNumber = exports.safeString = void 0;
const crypto_1 = require("crypto");
const trayFreightService_1 = require("./trayFreightService");
const trayApiService_1 = require("./trayApiService");
const anymarketFreightService_1 = require("./anymarketFreightService");
const db_1 = require("../lib/db");
const safeString = (value) => {
    if (value === null || value === undefined)
        return null;
    const normalized = String(value).trim();
    return normalized ? normalized : null;
};
exports.safeString = safeString;
const safeNumber = (value) => {
    if (value === null || value === undefined || value === '')
        return null;
    const normalized = typeof value === 'number'
        ? value
        : Number.parseFloat(String(value).replace(/[^\d,.-]/g, '').replace(',', '.'));
    return Number.isFinite(normalized) ? normalized : null;
};
exports.safeNumber = safeNumber;
const safeInteger = (value) => {
    if (value === null || value === undefined || value === '')
        return null;
    const parsed = Number.parseInt(String(value).replace(/[^\d-]/g, ''), 10);
    return Number.isFinite(parsed) ? parsed : null;
};
exports.safeInteger = safeInteger;
const normalizeZipCode = (value) => {
    const digits = String(value || '').replace(/\D/g, '').trim();
    return digits || null;
};
exports.normalizeZipCode = normalizeZipCode;
const buildProductsHash = (productsRaw) => {
    if (productsRaw === null || productsRaw === undefined)
        return null;
    try {
        const serialized = typeof productsRaw === 'string' ? productsRaw : JSON.stringify(productsRaw);
        if (!serialized)
            return null;
        return (0, crypto_1.createHash)('sha256').update(serialized).digest('hex');
    }
    catch {
        return null;
    }
};
exports.buildProductsHash = buildProductsHash;
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
const getValueByPath = (source, path) => path.split('.').reduce((current, segment) => current?.[segment], source);
const collectProductCollections = (rawPayload) => {
    const collections = new Map();
    for (const path of PRODUCT_COLLECTION_PATHS) {
        const value = getValueByPath(rawPayload, path);
        if (Array.isArray(value) && value.length > 0) {
            collections.set(path, value);
        }
    }
    const visit = (node, path, visited) => {
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
    visit(rawPayload, '', new WeakSet());
    return Array.from(collections.entries()).map(([source, items]) => ({
        source,
        items,
    }));
};
const resolveProductId = (item) => (0, exports.safeString)(item?.product_id ??
    item?.id_product ??
    item?.Product?.id ??
    item?.Product?.product_id ??
    item?.product?.id ??
    item?.product?.product_id ??
    item?.product?.id_product ??
    item?.id);
const extractTrayOrderProducts = (rawPayload) => {
    const candidateCollections = collectProductCollections(rawPayload);
    for (const collection of candidateCollections) {
        const auditProducts = collection.items
            .map((entry) => {
            const item = entry?.OrderItem ||
                entry?.ProductsSold ||
                entry?.ProductSold ||
                entry?.item ||
                entry?.Product ||
                entry?.product ||
                entry;
            const productId = resolveProductId(item);
            const quantity = (0, exports.safeInteger)(item?.quantity ??
                item?.qty ??
                item?.amount ??
                item?.quantity_sold ??
                item?.sold_quantity ??
                1) || 1;
            const directTotal = (0, exports.safeNumber)(item?.total ?? item?.subtotal ?? item?.total_price ?? item?.amount);
            const unitPrice = (0, exports.safeNumber)(item?.price ??
                item?.sale_price ??
                item?.price_sale ??
                item?.original_price ??
                item?.unit_price ??
                item?.unit_value ??
                item?.value ??
                item?.Product?.price ??
                item?.product?.price) ?? (directTotal !== null ? directTotal / quantity : null);
            if (!productId || unitPrice === null || quantity <= 0) {
                return null;
            }
            return {
                product_id: productId,
                price: unitPrice,
                quantity,
                name: (0, exports.safeString)(item?.name ?? item?.Product?.name),
                reference: (0, exports.safeString)(item?.reference ?? item?.Product?.reference),
                variant_id: (0, exports.safeString)(item?.variant_id ?? item?.variation_id),
                weight: (0, exports.safeNumber)(item?.weight ?? item?.gross_weight),
                length: (0, exports.safeNumber)(item?.length),
                width: (0, exports.safeNumber)(item?.width),
                height: (0, exports.safeNumber)(item?.height),
            };
        })
            .filter((item) => Boolean(item));
        if (auditProducts.length > 0) {
            return {
                requestProducts: auditProducts.map(({ product_id, price, quantity }) => ({
                    product_id,
                    price,
                    quantity,
                })),
                auditProducts,
                source: collection.source,
                productsHash: (0, exports.buildProductsHash)(auditProducts),
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
exports.extractTrayOrderProducts = extractTrayOrderProducts;
const buildRecalculatedDetails = (cotationOptions, selectedOption, matchedByCarrier, requestedCarrier, quoteRequest) => {
    const normalizeComparableText = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, ' ')
        .trim();
    const looksLikeIntegratorLabel = (value) => {
        const normalized = normalizeComparableText(value);
        if (!normalized)
            return false;
        return [
            'INTELIPOST',
            'FRETE FACIL',
            'FRETEFACIL',
            'MELHOR ENVIO',
            'KANGU',
            'FRENET',
        ].some((token) => normalized === token || normalized.includes(token));
    };
    const looksLikeGenericServiceLabel = (value) => {
        const normalized = normalizeComparableText(value);
        if (!normalized)
            return true;
        return [
            'EMISSAO DE NOTA FISCAL',
            'EMISSAO NOTA FISCAL',
            'NOTA FISCAL',
            'DOCUMENTO FISCAL',
            'COTACAO DE FRETE',
            'FRETE',
        ].some((token) => normalized === token || normalized.includes(token));
    };
    const pickCarrierCandidate = (...candidates) => {
        for (const candidate of candidates) {
            const normalized = (0, exports.safeString)(candidate);
            if (!normalized)
                continue;
            if (looksLikeIntegratorLabel(normalized))
                continue;
            if (looksLikeGenericServiceLabel(normalized))
                continue;
            return normalized;
        }
        return null;
    };
    const selectedCarrierName = (matchedByCarrier ? (0, exports.safeString)(requestedCarrier) : null) ||
        pickCarrierCandidate(selectedOption?.carrier_name, selectedOption?.carrierName, selectedOption?.carrier, selectedOption?.transportadora, selectedOption?.shipping_company, selectedOption?.delivery_method?.carrier_name, selectedOption?.taxe?.name, selectedOption?.name, selectedOption?.identifier);
    const selectedServiceName = (0, exports.safeString)(selectedOption?.serviceName) ||
        (0, exports.safeString)(selectedOption?.service_name) ||
        (0, exports.safeString)(selectedOption?.service) ||
        (0, exports.safeString)(selectedOption?.identifier) ||
        (looksLikeGenericServiceLabel(selectedOption?.name)
            ? null
            : (0, exports.safeString)(selectedOption?.name)) ||
        (0, exports.safeString)(selectedOption?.delivery_method?.name) ||
        null;
    return {
        selectedOption,
        selectedCarrierName,
        selectedServiceName,
        matchedByCarrier,
        selectionStrategy: matchedByCarrier ? 'carrier_match' : 'best_available_option',
        requestedCarrier: (0, exports.safeString)(requestedCarrier),
        optionsCount: cotationOptions.length,
        options: cotationOptions,
        quoteRequest,
    };
};
exports.buildRecalculatedDetails = buildRecalculatedDetails;
const hasSelectedOption = (details) => {
    if (!details || typeof details !== 'object') {
        return false;
    }
    if (details.selectedOption &&
        typeof details.selectedOption === 'object' &&
        Object.keys(details.selectedOption).length > 0) {
        return true;
    }
    return Boolean((0, exports.safeString)(details.selectedCarrierName) || (0, exports.safeString)(details.selectedServiceName));
};
const normalizeComparableText = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
const isInvalidStoredCarrierName = (value) => {
    const normalized = normalizeComparableText(value);
    if (!normalized)
        return true;
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
const needsFreightRecalculation = (order) => {
    const details = order?.recalculatedFreightDetails;
    const hasProductsSnapshot = Array.isArray(details?.quoteRequest?.products) &&
        details.quoteRequest.products.length > 0;
    const hasValidStoredCarrierName = !isInvalidStoredCarrierName(details?.selectedCarrierName);
    return (order?.recalculatedFreightValue === null ||
        order?.recalculatedFreightValue === undefined ||
        !order?.recalculatedFreightDate ||
        !hasSelectedOption(details) ||
        !hasProductsSnapshot ||
        !hasValidStoredCarrierName);
};
exports.needsFreightRecalculation = needsFreightRecalculation;
const persistOrderFreightRecalculation = async ({ db, orderId, apiRawPayload, recalculatedFreightValue, recalculatedFreightDetails, }) => {
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
    return (0, db_1.dbQuery)(`
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
    `, [
        orderId,
        apiRawPayload === undefined ? null : JSON.stringify(apiRawPayload),
        recalculatedFreightValue,
        recalculatedFreightDetails ? JSON.stringify(recalculatedFreightDetails) : null,
    ]);
};
const resolveTrayOrderIdentifier = (order) => (0, exports.safeString)(order?.apiRawPayload?.id) ||
    (0, exports.safeString)(order?.apiRawPayload?.Order?.id) ||
    (0, exports.safeString)(order?.orderNumber) ||
    null;
const hasNumber = (value) => (0, exports.safeNumber)(value) !== null;
const buildAnymarketDimensions = (item) => {
    const height = (0, exports.safeNumber)(item?.dimensions?.height ?? item?.height ?? item?.sku?.height);
    const width = (0, exports.safeNumber)(item?.dimensions?.width ?? item?.width ?? item?.sku?.width);
    const weight = (0, exports.safeNumber)(item?.dimensions?.weight ?? item?.weight ?? item?.sku?.weight);
    const length = (0, exports.safeNumber)(item?.dimensions?.length ?? item?.length ?? item?.sku?.length);
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
const extractAnymarketOrderProducts = (rawPayload) => {
    const items = Array.isArray(rawPayload?.items) ? rawPayload.items : [];
    const auditProducts = items
        .map((item) => {
        const sku = item?.sku || {};
        const product = item?.product || {};
        const skuId = (0, exports.safeString)(sku?.id ?? item?.skuId ?? sku?.partnerId);
        const amount = (0, exports.safeInteger)(item?.amount ?? item?.quantity ?? 1) || 1;
        const dimensions = buildAnymarketDimensions(item);
        if (!skuId || amount <= 0) {
            return null;
        }
        return {
            skuId,
            amount,
            name: (0, exports.safeString)(sku?.title ?? product?.title ?? item?.title),
            partnerId: (0, exports.safeString)(sku?.partnerId),
            ean: (0, exports.safeString)(sku?.ean),
            marketplaceItemId: (0, exports.safeString)(item?.marketPlaceId ?? item?.idInMarketPlace),
            price: (0, exports.safeNumber)(item?.gross ?? item?.unit ?? product?.price),
            discountPrice: (0, exports.safeNumber)(item?.total),
            height: hasNumber(dimensions?.height) ? (0, exports.safeNumber)(dimensions?.height) : null,
            width: hasNumber(dimensions?.width) ? (0, exports.safeNumber)(dimensions?.width) : null,
            weight: hasNumber(dimensions?.weight) ? (0, exports.safeNumber)(dimensions?.weight) : null,
            length: hasNumber(dimensions?.length) ? (0, exports.safeNumber)(dimensions?.length) : null,
            dimensions,
        };
    })
        .filter((item) => Boolean(item));
    return {
        requestProducts: auditProducts.map((item) => ({
            skuId: item.skuId,
            amount: item.amount,
            ...(item.dimensions ? { dimensions: item.dimensions } : {}),
        })),
        auditProducts: auditProducts.map(({ dimensions, ...item }) => item),
        source: (0, exports.safeString)(rawPayload?.source) || 'items',
        productsHash: (0, exports.buildProductsHash)(auditProducts),
        marketPlace: (0, exports.safeString)(rawPayload?.marketPlace),
    };
};
exports.extractAnymarketOrderProducts = extractAnymarketOrderProducts;
const resolveFreightProvider = (order) => {
    const source = String(order?.apiRawPayload?.source || '').trim().toUpperCase();
    if (source === 'ANYMARKET') {
        return 'anymarket';
    }
    const rawPayload = order?.apiRawPayload;
    if (rawPayload &&
        Array.isArray(rawPayload?.items) &&
        (0, exports.safeString)(rawPayload?.marketPlaceId) &&
        (0, exports.safeString)(rawPayload?.marketPlace)) {
        return 'anymarket';
    }
    return 'tray';
};
const recalculateStoredOrderFreight = async ({ prisma, order, companyId, freightService, force = false, }) => {
    const db = prisma;
    if (!force && !(0, exports.needsFreightRecalculation)(order)) {
        return {
            skipped: true,
            reason: 'already_recalculated',
            order,
        };
    }
    const zipcode = (0, exports.normalizeZipCode)(order?.zipCode);
    if (!zipcode) {
        throw new Error('Pedido sem CEP valido');
    }
    const freightProvider = resolveFreightProvider(order);
    if (freightProvider === 'anymarket') {
        const payloadForRecalculation = order?.apiRawPayload;
        const extractedProducts = (0, exports.extractAnymarketOrderProducts)(payloadForRecalculation);
        const marketPlace = (0, exports.safeString)(extractedProducts.marketPlace);
        if (!marketPlace) {
            throw new Error('Pedido ANYMARKET sem marketplace valido para recotacao de frete.');
        }
        if (extractedProducts.requestProducts.length === 0) {
            throw new Error('Pedido ANYMARKET sem produtos validos para recotacao. A API /freight/quotes exige skuId e amount reais do pedido.');
        }
        const anymarketFreightService = new anymarketFreightService_1.AnymarketFreightService(companyId);
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
        const matchedOption = anymarketFreightService.getPreferredOptionForCarrier(cotationOptions, order?.freightType);
        const selectedOption = matchedOption || cheapestOption || fastestOption || defaultFreight || cotationOptions[0] || null;
        const quotedValue = selectedOption ? (0, exports.safeNumber)(selectedOption.price) : null;
        const recalculatedFreightDetails = (0, exports.buildRecalculatedDetails)(cotationOptions, selectedOption, Boolean(matchedOption), order?.freightType, {
            zipcode,
            source: extractedProducts.source,
            productsHash: extractedProducts.productsHash,
            products: extractedProducts.auditProducts,
        });
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
    let extractedProducts = (0, exports.extractTrayOrderProducts)(payloadForRecalculation);
    if (extractedProducts.requestProducts.length === 0) {
        const trayOrderIdentifier = resolveTrayOrderIdentifier(order);
        if (trayOrderIdentifier) {
            const trayApiService = new trayApiService_1.TrayApiService(companyId);
            const completeOrderResponse = await trayApiService.getOrderComplete(trayOrderIdentifier);
            const completeOrderPayload = completeOrderResponse?.Order || null;
            if (completeOrderPayload) {
                payloadForRecalculation = completeOrderPayload;
                extractedProducts = (0, exports.extractTrayOrderProducts)(completeOrderPayload);
            }
        }
    }
    if (extractedProducts.requestProducts.length === 0) {
        throw new Error('Pedido sem produtos validos para recotacao na Tray mesmo apos consultar o pedido completo. A API /shippings/cotation exige product_id, price e quantity reais do pedido.');
    }
    const resolvedFreightService = freightService || new trayFreightService_1.TrayFreightService(companyId);
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
    const matchedOption = resolvedFreightService.getPreferredOptionForCarrier(cotationOptions, order?.freightType, payloadForRecalculation?.shipment);
    const selectedOption = matchedOption || cheapestOption || fastestOption || cotationOptions[0] || null;
    const quotedValue = selectedOption ? (0, exports.safeNumber)(selectedOption.value) : null;
    const recalculatedFreightDetails = (0, exports.buildRecalculatedDetails)(cotationOptions, selectedOption, Boolean(matchedOption), order?.freightType, {
        zipcode,
        source: extractedProducts.source,
        productsHash: extractedProducts.productsHash,
        products: extractedProducts.auditProducts,
    });
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
exports.recalculateStoredOrderFreight = recalculateStoredOrderFreight;
