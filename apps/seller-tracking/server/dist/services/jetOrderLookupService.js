"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.jetOrderLookupService = void 0;
const readEnv = (value) => String(value || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '');
const JET_OPENAPI_TIMEOUT_MS = (() => {
    const parsed = Number(process.env.JET_OPENAPI_TIMEOUT_MS);
    if (!Number.isFinite(parsed))
        return 15_000;
    return Math.min(120_000, Math.max(2_000, Math.floor(parsed)));
})();
const HEADER_API_KEY = readEnv(process.env.JET_OPENAPI_HEADER_API_KEY) ||
    readEnv(process.env.JET_OPENAPI_HEADER_INTEGRATION_KEY) ||
    'apiKey';
const HEADER_STORE_ID = readEnv(process.env.JET_OPENAPI_HEADER_STORE_ID) || 'storeId';
const HEADER_USERNAME = readEnv(process.env.JET_OPENAPI_HEADER_USERNAME) || 'username';
const HEADER_PASSWORD = readEnv(process.env.JET_OPENAPI_HEADER_PASSWORD) || 'password';
const applyApiKeyHeader = (headers, apiKey) => {
    headers.apiKey = apiKey;
    if (HEADER_API_KEY.toLowerCase() !== 'apikey') {
        headers[HEADER_API_KEY] = apiKey;
    }
};
const LOOKUP_ID_KEYS = ['idOrder', 'idorder', 'idPedido', 'idpedido', 'id_pedido'];
const pickFirstString = (...values) => {
    for (const value of values) {
        const normalized = String(value || '').trim();
        if (normalized)
            return normalized;
    }
    return null;
};
const extractJetIdFromString = (value) => {
    const idOrderMatch = value.match(/[?&]idOrder=(\d+)/i);
    if (idOrderMatch?.[1])
        return idOrderMatch[1];
    const idPedidoMatch = value.match(/[?&]idPedido=(\d+)/i);
    if (idPedidoMatch?.[1])
        return idPedidoMatch[1];
    return null;
};
const extractJetIdFromPayload = (source) => {
    if (!source)
        return null;
    const queue = [source];
    const visited = new Set();
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current || visited.has(current))
            continue;
        visited.add(current);
        if (typeof current === 'string') {
            const fromString = extractJetIdFromString(current);
            if (fromString)
                return fromString;
            continue;
        }
        if (typeof current === 'number' || typeof current === 'boolean') {
            continue;
        }
        if (Array.isArray(current)) {
            for (const item of current) {
                queue.push(item);
            }
            continue;
        }
        if (typeof current === 'object') {
            for (const key of Object.keys(current)) {
                const keyNormalized = key.trim().toLowerCase();
                if (LOOKUP_ID_KEYS.includes(key) || LOOKUP_ID_KEYS.includes(keyNormalized)) {
                    const candidate = pickFirstString(current[key]);
                    if (candidate)
                        return candidate;
                }
            }
            for (const key of Object.keys(current)) {
                queue.push(current[key]);
            }
        }
    }
    return null;
};
const buildLookupUrl = (template, params) => template
    .replace(/\{marketPlaceNumber\}/gi, encodeURIComponent(params.marketPlaceNumber || ''))
    .replace(/\{marketPlaceId\}/gi, encodeURIComponent(params.marketPlaceId || ''))
    .replace(/\{shippingId\}/gi, encodeURIComponent(params.shippingId || ''));
const buildHeaders = (config) => {
    const headers = {
        Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
    };
    const integrationKey = pickFirstString(config.jetIntegrationKey);
    const storeId = pickFirstString(config.jetStoreId);
    const username = pickFirstString(config.jetUsername);
    const password = pickFirstString(config.jetPassword);
    const bearerToken = pickFirstString(config.jetBearerToken);
    if (integrationKey)
        applyApiKeyHeader(headers, integrationKey);
    if (storeId)
        headers[HEADER_STORE_ID] = storeId;
    if (username)
        headers[HEADER_USERNAME] = username;
    if (password)
        headers[HEADER_PASSWORD] = password;
    if (bearerToken) {
        headers.Authorization = `Bearer ${bearerToken}`;
    }
    else if (username || password) {
        const encoded = Buffer.from(`${username || ''}:${password || ''}`, 'utf8').toString('base64');
        headers.Authorization = `Basic ${encoded}`;
    }
    return headers;
};
class JetOrderLookupService {
    cache = new Map();
    isConfigured(config) {
        const lookupUrlTemplate = pickFirstString(config.jetOrderLookupUrlTemplate);
        return Boolean(config.jetIntegrationEnabled === true && lookupUrlTemplate);
    }
    buildCacheKey(params, config) {
        return [
            String(config.companyId || ''),
            pickFirstString(config.jetOrderLookupUrlTemplate) || '',
            pickFirstString(config.jetIntegrationKey) || '',
            pickFirstString(config.jetStoreId) || '',
            pickFirstString(config.jetUsername) || '',
            pickFirstString(config.jetBearerToken) || '',
            params.marketPlaceNumber || '',
            params.marketPlaceId || '',
            params.shippingId || '',
        ].join('|');
    }
    async lookupFromAnyMarketPayload(rawPayload, config) {
        if (!this.isConfigured(config))
            return null;
        const marketPlaceNumber = pickFirstString(rawPayload?.id, rawPayload?.marketPlaceNumber);
        const marketPlaceNumberFromJet = pickFirstString(rawPayload?.marketPlaceNumberOrder, rawPayload?.marketplaceNumberOrder, rawPayload?.marketPlaceOrderNumber, rawPayload?.marketplaceOrderNumber, rawPayload?.jetMeta?.marketPlaceNumberOrder);
        const effectiveMarketPlaceNumber = marketPlaceNumberFromJet || marketPlaceNumber;
        const marketPlaceId = pickFirstString(rawPayload?.marketPlaceId, rawPayload?.marketplaceId, rawPayload?.anymarketMeta?.primaryItem?.marketplaceItemId);
        const shippingId = pickFirstString(rawPayload?.shippingId);
        if (!effectiveMarketPlaceNumber && !marketPlaceId && !shippingId) {
            return null;
        }
        const cacheKey = this.buildCacheKey({
            marketPlaceNumber: effectiveMarketPlaceNumber,
            marketPlaceId,
            shippingId,
        }, config);
        const cached = this.cache.get(cacheKey);
        if (cached) {
            return cached;
        }
        const requestPromise = this.requestLookup({
            marketPlaceNumber: effectiveMarketPlaceNumber,
            marketPlaceId,
            shippingId,
        }, config);
        this.cache.set(cacheKey, requestPromise);
        try {
            return await requestPromise;
        }
        catch (error) {
            this.cache.delete(cacheKey);
            throw error;
        }
    }
    async requestLookup(params, config) {
        const lookupTemplate = pickFirstString(config.jetOrderLookupUrlTemplate);
        if (!lookupTemplate)
            return null;
        const lookupUrl = buildLookupUrl(lookupTemplate, params);
        if (!lookupUrl || lookupUrl.includes('{')) {
            return null;
        }
        const abortController = new AbortController();
        const timeout = setTimeout(() => abortController.abort(), JET_OPENAPI_TIMEOUT_MS);
        try {
            const response = await fetch(lookupUrl, {
                method: 'GET',
                headers: buildHeaders(config),
                signal: abortController.signal,
            });
            if (!response.ok) {
                throw new Error(`JET OpenAPI HTTP ${response.status}`);
            }
            const bodyText = await response.text();
            let parsedBody = null;
            try {
                parsedBody = bodyText ? JSON.parse(bodyText) : null;
            }
            catch {
                parsedBody = bodyText;
            }
            const jetOrderId = extractJetIdFromPayload(parsedBody);
            return {
                jetOrderId,
                lookupUrl,
            };
        }
        finally {
            clearTimeout(timeout);
        }
    }
}
exports.jetOrderLookupService = new JetOrderLookupService();
