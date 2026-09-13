"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrayApiService = void 0;
const axios_1 = __importDefault(require("axios"));
const trayAuthService_1 = require("./trayAuthService");
const rateLimiter_1 = require("./rateLimiter");
const syncCancellation_1 = require("../utils/syncCancellation");
const orderShippingAvailabilityService_1 = require("./orderShippingAvailabilityService");
const SHIPPING_HINT_PATTERN = /shipping|shipment|shipments|frete|envio|delivery|cotation|cotacao|quotation|transport/i;
const normalizeMoney = (value) => {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    const raw = String(value).trim();
    const normalized = raw.includes(',')
        ? raw.replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, '')
        : raw.replace(/[^\d.-]/g, '');
    if (!normalized) {
        return null;
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
};
const pickFirstString = (values) => {
    for (const value of values) {
        const normalized = String(value || '').trim();
        if (normalized) {
            return normalized;
        }
    }
    return null;
};
const parseIsoDateOnly = (value) => {
    const normalized = String(value || '').trim();
    const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
        return null;
    }
    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    const day = Number(match[3]);
    const parsed = new Date(Date.UTC(year, monthIndex, day, 12, 0, 0));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const parsePositiveDays = (value) => {
    const normalized = String(value ?? '').trim();
    if (!/^\d+$/.test(normalized)) {
        return null;
    }
    const days = Number(normalized);
    if (!Number.isFinite(days) || days <= 0 || days > 365) {
        return null;
    }
    return days;
};
const parseTrayEstimatedDeliveryDate = (input) => {
    const rawValue = String(input.estimatedDeliveryDate ?? '').trim();
    if (!rawValue || rawValue === '0000-00-00') {
        return null;
    }
    const candidateDateText = rawValue.slice(0, 10);
    const parsedDate = parseIsoDateOnly(candidateDateText);
    if (parsedDate) {
        return parsedDate;
    }
    const days = parsePositiveDays(input.estimatedDeliveryDate) ??
        parsePositiveDays(input.deliveryTime);
    if (days === null) {
        return null;
    }
    const parsedOrderDate = parseIsoDateOnly(String(input.orderDate ?? '').trim().slice(0, 10)) ||
        null;
    const baseDate = parsedOrderDate || new Date();
    const projectedDate = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate() + days, 12, 0, 0));
    return Number.isNaN(projectedDate.getTime()) ? null : projectedDate;
};
const normalizeComparableText = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLowerCase();
const candidateMatchesPaidCarrier = (candidate, references) => {
    const normalizedReferences = references
        .map((value) => normalizeComparableText(value))
        .filter(Boolean);
    if (!normalizedReferences.length) {
        return false;
    }
    const normalizedCandidateFields = [
        candidate.shipmentType,
        candidate.serviceCode,
        candidate.serviceName,
        candidate.integrator,
    ]
        .map((value) => normalizeComparableText(value))
        .filter(Boolean);
    if (!normalizedCandidateFields.length) {
        return false;
    }
    return normalizedReferences.some((reference) => normalizedCandidateFields.some((field) => field === reference ||
        field.includes(reference) ||
        reference.includes(field)));
};
const collectTrayQuoteCandidates = (node, path = 'root', visited = new WeakSet()) => {
    if (!node || typeof node !== 'object') {
        return [];
    }
    if (visited.has(node)) {
        return [];
    }
    visited.add(node);
    const candidates = [];
    if (Array.isArray(node)) {
        for (const [index, item] of node.entries()) {
            candidates.push(...collectTrayQuoteCandidates(item, `${path}[${index}]`, visited));
        }
        return candidates;
    }
    const keys = Object.keys(node);
    const contextHasShippingHint = SHIPPING_HINT_PATTERN.test(path) ||
        keys.some((key) => SHIPPING_HINT_PATTERN.test(key));
    if (contextHasShippingHint) {
        const candidateValue = normalizeMoney(node.value) ??
            normalizeMoney(node.price) ??
            normalizeMoney(node.cost) ??
            normalizeMoney(node.freight_value) ??
            normalizeMoney(node.shipment_value) ??
            normalizeMoney(node.total) ??
            normalizeMoney(node.taxe?.value);
        const candidateCarrierName = pickFirstString([
            node.carrier_name,
            node.carrier,
            node.transportadora,
            node.shipping_company,
            node.delivery_method?.name,
            node.name,
            node.taxe?.name,
        ]);
        const candidateServiceName = pickFirstString([
            node.service_name,
            node.service,
            node.identifier,
            node.description,
            node.name,
        ]);
        if (candidateValue !== null) {
            candidates.push({
                value: candidateValue,
                carrierName: candidateCarrierName,
                serviceName: candidateServiceName,
                estimatedDeliveryDate: pickFirstString([
                    node.estimated_delivery_date,
                    node.delivery_date,
                    node.deadline,
                ]),
                raw: node,
            });
        }
    }
    for (const [key, value] of Object.entries(node)) {
        if (value && typeof value === 'object') {
            candidates.push(...collectTrayQuoteCandidates(value, `${path}.${key}`, visited));
        }
    }
    return candidates;
};
const extractCheapestTrayQuote = (trayOrder) => {
    const candidates = collectTrayQuoteCandidates(trayOrder)
        .filter((candidate) => candidate.value >= 0)
        .sort((left, right) => left.value - right.value);
    const cheapest = candidates[0] || null;
    if (!cheapest) {
        return {
            quotedFreightValue: null,
            quotedFreightDate: null,
            quotedFreightDetails: null,
        };
    }
    return {
        quotedFreightValue: cheapest.value,
        quotedFreightDate: new Date(),
        quotedFreightDetails: {
            selectedOption: cheapest.raw,
            selectedCarrierName: cheapest.carrierName,
            selectedServiceName: cheapest.serviceName,
            selectedEstimatedDeliveryDate: cheapest.estimatedDeliveryDate,
            optionsCount: candidates.length,
            options: candidates.map((candidate) => ({
                value: candidate.value,
                carrierName: candidate.carrierName,
                serviceName: candidate.serviceName,
                estimatedDeliveryDate: candidate.estimatedDeliveryDate,
            })),
        },
    };
};
const normalizeInteger = (value) => {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const parsed = Number.parseInt(String(value).replace(/[^\d-]/g, ''), 10);
    return Number.isFinite(parsed) ? parsed : null;
};
const collectOriginalQuoteCandidates = (node, path = 'root', visited = new WeakSet()) => {
    if (!node || typeof node !== 'object') {
        return [];
    }
    if (visited.has(node)) {
        return [];
    }
    visited.add(node);
    const candidates = [];
    if (Array.isArray(node)) {
        for (const [index, item] of node.entries()) {
            candidates.push(...collectOriginalQuoteCandidates(item, `${path}[${index}]`, visited));
        }
        return candidates;
    }
    const keys = Object.keys(node);
    const contextHasShippingHint = SHIPPING_HINT_PATTERN.test(path) ||
        keys.some((key) => SHIPPING_HINT_PATTERN.test(key));
    if (contextHasShippingHint) {
        const quotationId = pickFirstString([
            node.id_quotation,
            node.quotation_id,
        ]);
        const shippingId = pickFirstString([node.shipping_id, node.id]);
        const hasStrongReference = Boolean(quotationId || shippingId);
        if (hasStrongReference) {
            candidates.push({
                quotationId,
                shippingId,
                shipmentType: pickFirstString([
                    node.shipment,
                    node.shipment_type,
                    node.type,
                ]),
                serviceCode: pickFirstString([
                    node.identifier,
                    node.service_code,
                    node.shipping_id,
                ]),
                serviceName: pickFirstString([
                    node.service_name,
                    node.service,
                    node.name,
                    node.description,
                ]),
                integrator: pickFirstString([
                    node.shipment_integrator,
                    node.integrator,
                ]),
                estimatedDeliveryDate: pickFirstString([
                    node.estimated_delivery_date,
                    node.delivery_date,
                    node.deadline,
                ]),
                minPeriod: normalizeInteger(node.min_period),
                maxPeriod: normalizeInteger(node.max_period),
                value: normalizeMoney(node.value) ??
                    normalizeMoney(node.freight_value) ??
                    normalizeMoney(node.shipment_value) ??
                    normalizeMoney(node.taxe?.value),
                raw: node,
            });
        }
    }
    for (const [key, value] of Object.entries(node)) {
        if (value && typeof value === 'object') {
            candidates.push(...collectOriginalQuoteCandidates(value, `${path}.${key}`, visited));
        }
    }
    return candidates;
};
const extractOriginalCheckoutQuote = (trayOrder) => {
    const orderQuotationId = pickFirstString([
        trayOrder?.id_quotation,
        trayOrder?.quotation_id,
    ]);
    const orderShippingId = pickFirstString([
        trayOrder?.shipping_id,
        trayOrder?.id_shipping,
    ]);
    const paidCarrierReferences = [
        trayOrder?.shipment,
        trayOrder?.shipment_integrator,
        trayOrder?.delivery_method?.name,
        trayOrder?.Shipping?.name,
        trayOrder?.shipping_service,
    ].filter(Boolean);
    const candidates = collectOriginalQuoteCandidates(trayOrder);
    const selectedCandidate = candidates.find((candidate) => orderQuotationId &&
        candidate.quotationId &&
        candidate.quotationId === orderQuotationId) ||
        candidates.find((candidate) => orderShippingId &&
            candidate.shippingId &&
            candidate.shippingId === orderShippingId) ||
        candidates.find((candidate) => candidateMatchesPaidCarrier(candidate, paidCarrierReferences)) ||
        candidates.find((candidate) => candidate.quotationId) ||
        null;
    if (!selectedCandidate) {
        return {
            originalQuotedFreightValue: null,
            originalQuotedFreightDate: null,
            originalQuotedFreightDetails: orderQuotationId
                ? {
                    quotationId: orderQuotationId,
                    shippingId: orderShippingId,
                    shipment: pickFirstString([trayOrder?.shipment]),
                    shipmentIntegrator: pickFirstString([trayOrder?.shipment_integrator]),
                    deliveryTime: pickFirstString([trayOrder?.delivery_time]),
                    source: 'tray_order_reference_only',
                }
                : null,
            originalQuotedFreightQuotationId: orderQuotationId,
        };
    }
    return {
        originalQuotedFreightValue: selectedCandidate.value,
        originalQuotedFreightDate: new Date(),
        originalQuotedFreightDetails: {
            quotationId: selectedCandidate.quotationId,
            shippingId: selectedCandidate.shippingId,
            shipmentType: selectedCandidate.shipmentType,
            serviceCode: selectedCandidate.serviceCode,
            serviceName: selectedCandidate.serviceName,
            integrator: selectedCandidate.integrator,
            estimatedDeliveryDate: selectedCandidate.estimatedDeliveryDate,
            minPeriod: selectedCandidate.minPeriod,
            maxPeriod: selectedCandidate.maxPeriod,
            selectedOption: selectedCandidate.raw,
            source: 'tray_order_payload',
        },
        originalQuotedFreightQuotationId: selectedCandidate.quotationId || orderQuotationId,
    };
};
class TrayApiService {
    companyId;
    manualToken;
    constructor(companyId, manualToken) {
        this.companyId = companyId;
        this.manualToken = manualToken;
    }
    async getClient() {
        const auth = await trayAuthService_1.trayAuthService.getValidAuthData(this.companyId);
        if (!auth) {
            throw new Error('Loja nao autorizada. Execute o fluxo OAuth primeiro.');
        }
        const client = axios_1.default.create({
            baseURL: auth.apiAddress,
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json',
            },
        });
        return {
            client,
            apiAddress: auth.apiAddress,
            accessToken: this.manualToken || auth.accessToken,
        };
    }
    async listOrders(params = {}) {
        return rateLimiter_1.trayRateLimiter.execute(async () => {
            try {
                const { client, accessToken } = await this.getClient();
                const response = await client.get('/orders', {
                    params: {
                        access_token: accessToken,
                        page: params.page || 1,
                        limit: params.limit || 50,
                        status: params.status,
                        modified: params.modified,
                    },
                });
                return response.data;
            }
            catch (error) {
                console.error('Erro ao listar pedidos da Tray:', error.response?.data || error.message);
                throw new Error(`Erro na API Tray: ${error.response?.data?.message || error.message}`);
            }
        });
    }
    async getOrderComplete(orderId) {
        return rateLimiter_1.trayRateLimiter.execute(async () => {
            try {
                const { client, accessToken } = await this.getClient();
                const response = await client.get(`/orders/${orderId}/complete`, {
                    params: {
                        access_token: accessToken,
                    },
                });
                return response.data;
            }
            catch (error) {
                console.error(`Erro ao buscar pedido ${orderId}:`, error.response?.data || error.message);
                throw new Error(`Erro na API Tray: ${error.response?.data?.message || error.message}`);
            }
        });
    }
    async getProductById(productId) {
        return rateLimiter_1.trayRateLimiter.execute(async () => {
            try {
                const { client, accessToken } = await this.getClient();
                const response = await client.get(`/products/${productId}`, {
                    params: {
                        access_token: accessToken,
                    },
                });
                const payload = response?.data;
                if (!payload) {
                    return null;
                }
                if (payload?.Product && typeof payload.Product === 'object') {
                    return payload.Product;
                }
                if (payload?.Products?.[0]?.Product) {
                    return payload.Products[0].Product;
                }
                return payload;
            }
            catch {
                return null;
            }
        });
    }
    async syncAllOrders(params = {}, hooks) {
        const statusLabel = String(params.status || 'todos');
        console.log(`Iniciando etapa da Tray para status "${statusLabel}"...`);
        console.log('Rate limit ativo: 180 requisicoes/minuto');
        let importedOrdersCount = 0;
        let currentPage = 1;
        let hasMorePages = true;
        while (hasMorePages) {
            if (hooks?.shouldCancel?.()) {
                throw new syncCancellation_1.SyncCancellationError();
            }
            console.log(`Buscando pagina ${currentPage} para status "${statusLabel}"...`);
            hooks?.onLog?.(`Buscando pagina ${currentPage} da Tray para status "${statusLabel}".`);
            const stats = rateLimiter_1.trayRateLimiter.getStats();
            console.log(`Rate limit: ${stats.requestsInWindow}/${stats.maxRequests} (${stats.utilizationPercent}%)`);
            hooks?.onLog?.(`Rate limit Tray: ${stats.requestsInWindow}/${stats.maxRequests} (${stats.utilizationPercent}%).`);
            const response = await this.listOrders({
                ...params,
                page: currentPage,
                limit: 50,
            });
            const orders = response.Orders || [];
            console.log(`${orders.length} pedidos encontrados na pagina ${currentPage} para status "${statusLabel}"`);
            hooks?.onLog?.(`${orders.length} pedido(s) encontrados na pagina ${currentPage} para status "${statusLabel}".`);
            const pageOrders = [];
            const completeOrderTasks = orders.map(async (orderWrapper) => {
                if (hooks?.shouldCancel?.()) {
                    throw new syncCancellation_1.SyncCancellationError();
                }
                const orderId = orderWrapper.Order.id;
                if (params.skipOrderNumbers?.has(String(orderId))) {
                    console.log(`Pedido ${orderId} ja existe no banco, pulando...`);
                    hooks?.onLog?.(`Pedido ${orderId} ja existe no banco e foi ignorado.`);
                    return;
                }
                try {
                    const completeData = await this.getOrderComplete(orderId);
                    pageOrders.push(completeData.Order);
                    importedOrdersCount += 1;
                }
                catch (error) {
                    console.error(`Erro ao buscar pedido ${orderId}, pulando...`);
                    hooks?.onLog?.(`Erro ao buscar pedido ${orderId}; item ignorado.`);
                }
            });
            await Promise.all(completeOrderTasks);
            if (hooks?.shouldCancel?.()) {
                throw new syncCancellation_1.SyncCancellationError();
            }
            if (pageOrders.length > 0) {
                await hooks?.onOrdersBatch?.(pageOrders);
            }
            const { total, limit } = response.paging;
            const totalPages = Math.ceil(total / limit);
            hasMorePages = currentPage < totalPages;
            currentPage += 1;
        }
        console.log(`Total de ${importedOrdersCount} pedidos retornados pela Tray para o status "${statusLabel}"`);
        hooks?.onLog?.(`Total de ${importedOrdersCount} pedido(s) novo(s) retornados pela Tray para o status "${statusLabel}".`);
        const finalStats = rateLimiter_1.trayRateLimiter.getStats();
        console.log(`Estatisticas finais: ${finalStats.requestsInWindow} requisicoes utilizadas (${finalStats.utilizationPercent}%)`);
        return importedOrdersCount;
    }
    mapTrayOrderToSystem(trayOrder, options) {
        const customer = trayOrder.Customer || {};
        const mainAddress = customer.CustomerAddresses?.[0]?.CustomerAddress || {};
        const statusMap = {
            'PEDIDO CADASTRADO': 'PENDING',
            'A ENVIAR': 'PENDING',
            '5- AGUARDANDO FATURAMENTO': 'PENDING',
            'AGUARDANDO ENVIO': 'CREATED',
            ENVIADO: 'SHIPPED',
            FINALIZADO: 'DELIVERED',
            ENTREGUE: 'DELIVERED',
            CANCELADO: 'CANCELED',
            DEVOLVIDO: 'RETURNED',
            'EM SEPARACAO': 'CREATED',
            'EM SEPARAÇÃO': 'CREATED',
        };
        const trayStatus = (trayOrder.status || 'A ENVIAR').toUpperCase();
        const mappedStatus = statusMap[trayStatus] || 'PENDING';
        const salesChannel = 'Tray - ' + (trayOrder.point_sale || 'LOJA VIRTUAL');
        const orderInvoice = trayOrder.OrderInvoice?.[0]?.OrderInvoice ||
            trayOrder.OrderInvoice?.[0] ||
            null;
        const invoiceAccessKey = orderInvoice?.access_key ||
            orderInvoice?.accessKey ||
            orderInvoice?.key ||
            null;
        const invoiceXmlUrl = orderInvoice?.xml ||
            orderInvoice?.xml_url ||
            orderInvoice?.invoice_xml_url ||
            orderInvoice?.link_xml ||
            null;
        const trayEstimatedDeliveryDate = parseTrayEstimatedDeliveryDate({
            estimatedDeliveryDate: trayOrder.estimated_delivery_date,
            orderDate: trayOrder.date,
            deliveryTime: trayOrder.delivery_time,
        });
        const trayOrderBaseDate = new Date(trayOrder.date);
        const shippingAvailability = (0, orderShippingAvailabilityService_1.resolveOrderShippingAvailabilityFromTray)(trayOrder, Number.isNaN(trayOrderBaseDate.getTime()) ? new Date() : trayOrderBaseDate);
        const cheapestQuote = extractCheapestTrayQuote(trayOrder);
        const originalCheckoutQuote = extractOriginalCheckoutQuote(trayOrder);
        return {
            orderNumber: String(trayOrder.id),
            invoiceNumber: orderInvoice?.number || orderInvoice?.id || null,
            invoiceAccessKey,
            invoiceXmlUrl,
            trackingCode: trayOrder.sending_code || null,
            customerName: customer.name || 'Desconhecido',
            corporateName: customer.company_name || null,
            cpf: customer.cpf || null,
            cnpj: customer.cnpj || null,
            phone: customer.phone || null,
            mobile: customer.cellphone || null,
            salesChannel,
            freightType: trayOrder.shipment || 'Nao informado',
            freightValue: parseFloat(trayOrder.shipment_value || '0'),
            originalQuotedFreightValue: originalCheckoutQuote.originalQuotedFreightValue,
            originalQuotedFreightDate: originalCheckoutQuote.originalQuotedFreightDate,
            originalQuotedFreightDetails: originalCheckoutQuote.originalQuotedFreightDetails,
            originalQuotedFreightQuotationId: originalCheckoutQuote.originalQuotedFreightQuotationId,
            recalculatedFreightValue: null,
            recalculatedFreightDate: null,
            recalculatedFreightDetails: null,
            quotedFreightValue: cheapestQuote.quotedFreightValue,
            quotedFreightDate: cheapestQuote.quotedFreightDate,
            quotedFreightDetails: cheapestQuote.quotedFreightDetails,
            shippingDate: trayOrder.shipment_date && trayOrder.shipment_date !== '0000-00-00'
                ? new Date(trayOrder.shipment_date)
                : new Date(trayOrder.date),
            address: mainAddress.address || customer.address || '',
            number: mainAddress.number || customer.number || '',
            complement: mainAddress.complement || customer.complement || null,
            neighborhood: mainAddress.neighborhood || customer.neighborhood || '',
            city: mainAddress.city || customer.city || '',
            state: mainAddress.state || customer.state || '',
            zipCode: (mainAddress.zip_code || customer.zip_code || '').replace('-', ''),
            totalValue: parseFloat(trayOrder.total || '0'),
            recipient: mainAddress.recipient || customer.name || null,
            maxShippingDeadline: shippingAvailability.sendDate || trayEstimatedDeliveryDate,
            estimatedDeliveryDate: trayEstimatedDeliveryDate,
            carrierEstimatedDeliveryDate: null,
            status: mappedStatus,
            isDelayed: false,
            apiRawPayload: {
                ...trayOrder,
                shippingAvailability: shippingAvailability.maxDays !== null
                    ? {
                        mode: shippingAvailability.mode,
                        maxDays: shippingAvailability.maxDays,
                        sendDate: shippingAvailability.sendDate
                            ? shippingAvailability.sendDate.toISOString()
                            : null,
                        items: shippingAvailability.items,
                    }
                    : null,
            },
            trackingHistory: [
                {
                    status: mappedStatus,
                    description: `Pedido ${trayOrder.status || 'criado'}`,
                    date: new Date(trayOrder.date),
                    city: mainAddress.city || customer.city || '',
                    state: mainAddress.state || customer.state || '',
                },
            ],
        };
    }
}
exports.TrayApiService = TrayApiService;
