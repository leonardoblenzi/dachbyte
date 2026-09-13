"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnymarketFreightService = void 0;
const axios_1 = __importDefault(require("axios"));
const db_1 = require("../lib/db");
const anymarketRateLimiter_1 = require("./anymarketRateLimiter");
const ANYMARKET_PRODUCTION_BASE_URL = 'https://api.anymarket.com.br/v2';
const safeString = (value) => {
    const normalized = String(value || '').trim();
    return normalized || null;
};
const safeNumber = (value) => {
    if (value === null || value === undefined || value === '')
        return null;
    const parsed = typeof value === 'number'
        ? value
        : Number(String(value).replace(/[^\d,.-]/g, '').replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
};
const normalizeComparableText = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
class AnymarketFreightService {
    companyId;
    constructor(companyId) {
        this.companyId = companyId;
    }
    async getToken() {
        const companyResult = await (0, db_1.dbQuery)(`
        SELECT
          c."anymarketIntegrationEnabled",
          c."anymarketToken"
        FROM "Company" c
        WHERE c."id" = $1
        LIMIT 1
      `, [this.companyId]);
        const company = companyResult.rows[0] || null;
        if (!company) {
            throw new Error('Empresa nao encontrada.');
        }
        if (company.anymarketIntegrationEnabled === false) {
            throw new Error('A integracao ANYMARKET esta desativada para esta empresa.');
        }
        const token = safeString(company.anymarketToken);
        if (!token) {
            throw new Error('gumgaToken do ANYMARKET nao configurado para esta empresa.');
        }
        return token;
    }
    async quoteFreight(params) {
        return anymarketRateLimiter_1.anymarketRateLimiter.execute(async () => {
            const gumgaToken = await this.getToken();
            try {
                const response = await axios_1.default.post(`${ANYMARKET_PRODUCTION_BASE_URL}/freight/quotes`, {
                    zipCode: params.zipCode,
                    marketPlace: params.marketPlace,
                    ...(typeof params.additionalPercentual === 'number'
                        ? { additionalPercentual: params.additionalPercentual }
                        : {}),
                    ...(typeof params.timeout === 'number' ? { timeout: params.timeout } : {}),
                    products: params.products,
                }, {
                    headers: {
                        'Content-Type': 'application/json',
                        gumgaToken,
                    },
                    timeout: Math.max(5_000, params.timeout ?? 30_000),
                });
                return {
                    data: response.data,
                    headers: response.headers,
                };
            }
            catch (error) {
                const details = error?.response?.data?.message ||
                    error?.response?.data?.error ||
                    error?.message ||
                    'Erro desconhecido ao cotar frete no ANYMARKET.';
                const wrappedError = new Error(`Erro ao cotar frete no ANYMARKET: ${details}`);
                wrappedError.response = error?.response;
                throw wrappedError;
            }
        });
    }
    getCheapestOption(quotes) {
        if (!Array.isArray(quotes) || quotes.length === 0)
            return null;
        return quotes.reduce((cheapest, current) => {
            const cheapestValue = safeNumber(cheapest?.price) ?? Number.POSITIVE_INFINITY;
            const currentValue = safeNumber(current?.price) ?? Number.POSITIVE_INFINITY;
            return currentValue < cheapestValue ? current : cheapest;
        });
    }
    getFastestOption(quotes) {
        if (!Array.isArray(quotes) || quotes.length === 0)
            return null;
        return quotes.reduce((fastest, current) => {
            const fastestTime = safeNumber(fastest?.deliveryTime) ?? Number.POSITIVE_INFINITY;
            const currentTime = safeNumber(current?.deliveryTime) ?? Number.POSITIVE_INFINITY;
            return currentTime < fastestTime ? current : fastest;
        });
    }
    getPreferredOptionForCarrier(quotes, carrierName, fallbackServiceName) {
        if (!Array.isArray(quotes) || quotes.length === 0)
            return null;
        const normalizedCarrier = normalizeComparableText(carrierName);
        const normalizedFallbackService = normalizeComparableText(fallbackServiceName);
        const shouldRequireMatch = Boolean(normalizedCarrier || normalizedFallbackService);
        if (normalizedCarrier) {
            const byCarrier = quotes.find((option) => {
                const carrier = normalizeComparableText(option?.carrierName);
                const service = normalizeComparableText(option?.serviceName);
                return (carrier === normalizedCarrier ||
                    carrier.includes(normalizedCarrier) ||
                    normalizedCarrier.includes(carrier) ||
                    service === normalizedCarrier ||
                    service.includes(normalizedCarrier) ||
                    normalizedCarrier.includes(service));
            }) || null;
            if (byCarrier) {
                return byCarrier;
            }
        }
        if (normalizedFallbackService) {
            const byService = quotes.find((option) => {
                const service = normalizeComparableText(option?.serviceName);
                return (service === normalizedFallbackService ||
                    service.includes(normalizedFallbackService) ||
                    normalizedFallbackService.includes(service));
            }) || null;
            if (byService) {
                return byService;
            }
        }
        return shouldRequireMatch ? null : this.getCheapestOption(quotes);
    }
}
exports.AnymarketFreightService = AnymarketFreightService;
