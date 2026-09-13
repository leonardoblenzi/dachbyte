"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrayFreightService = void 0;
const axios_1 = __importDefault(require("axios"));
const trayAuthService_1 = require("./trayAuthService");
const rateLimiter_1 = require("./rateLimiter");
class TrayFreightService {
    companyId;
    constructor(companyId) {
        this.companyId = companyId;
    }
    /**
     * Cotar frete usando API Tray
     */
    async quoteFreight(params) {
        return await rateLimiter_1.trayRateLimiter.execute(async () => {
            try {
                console.log(`💰 Cotando frete para CEP ${params.zipcode}...`);
                // Buscar autenticação
                const auth = await trayAuthService_1.trayAuthService.getAuthData(this.companyId);
                if (!auth) {
                    throw new Error('Loja não autorizada');
                }
                const accessToken = await trayAuthService_1.trayAuthService.getValidAuth(this.companyId);
                if (!accessToken) {
                    throw new Error('Token inválido');
                }
                // Montar parâmetros da query
                const queryParams = {
                    access_token: accessToken,
                    zipcode: params.zipcode
                };
                // Adicionar produtos ao query string
                params.products.forEach((product, index) => {
                    queryParams[`products[${index}][product_id]`] = product.product_id;
                    queryParams[`products[${index}][price]`] = product.price;
                    queryParams[`products[${index}][quantity]`] = product.quantity;
                });
                // Fazer requisição
                const response = await axios_1.default.get(`${auth.apiAddress}/shippings/cotation/`, {
                    params: queryParams,
                    timeout: 30000
                });
                console.log(`✅ Cotação realizada com sucesso`);
                return response.data;
            }
            catch (error) {
                console.error('❌ Erro ao cotar frete:', error.response?.data || error.message);
                throw new Error(`Erro ao cotar frete: ${error.response?.data?.message || error.message}`);
            }
        });
    }
    /**
     * Buscar a opção de frete mais barata
     */
    getCheapestOption(cotation) {
        if (!cotation || cotation.length === 0)
            return null;
        return cotation.reduce((cheapest, current) => {
            const cheapestValue = parseFloat(cheapest.value);
            const currentValue = parseFloat(current.value);
            return currentValue < cheapestValue ? current : cheapest;
        });
    }
    /**
     * Buscar a opção de frete mais rápida
     */
    getFastestOption(cotation) {
        if (!cotation || cotation.length === 0)
            return null;
        return cotation.reduce((fastest, current) => {
            const fastestPeriod = parseInt(fastest.max_period);
            const currentPeriod = parseInt(current.max_period);
            return currentPeriod < fastestPeriod ? current : fastest;
        });
    }
    /**
     * Buscar opção por nome do serviço (ex: "SEDEX", "PAC")
     */
    getOptionByService(cotation, serviceName) {
        if (!cotation || cotation.length === 0)
            return null;
        const normalized = serviceName.toLowerCase();
        return cotation.find(option => option.name.toLowerCase().includes(normalized) ||
            option.identifier.toLowerCase().includes(normalized)) || null;
    }
    normalizeComparableText(value) {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toUpperCase()
            .replace(/[^A-Z0-9]+/g, ' ')
            .trim();
    }
    getOptionComparableTexts(option) {
        return [
            option.carrier_name,
            option.carrier,
            option.transportadora,
            option.shipping_company,
            option.shipment_integrator,
            option.integrator,
            option.name,
            option.identifier,
            option.taxe?.name,
            option.information,
        ]
            .map((value) => this.normalizeComparableText(value))
            .filter(Boolean);
    }
    getPreferredOptionForCarrier(cotation, carrierName, fallbackServiceName) {
        if (!cotation || cotation.length === 0)
            return null;
        const normalizedCarrier = this.normalizeComparableText(carrierName);
        const normalizedFallbackService = this.normalizeComparableText(fallbackServiceName);
        const shouldRequireMatch = Boolean(normalizedCarrier || normalizedFallbackService);
        if (normalizedCarrier) {
            const directMatch = cotation.find((option) => this.getOptionComparableTexts(option).some((text) => text === normalizedCarrier ||
                text.includes(normalizedCarrier) ||
                normalizedCarrier.includes(text))) || null;
            if (directMatch) {
                return directMatch;
            }
        }
        if (normalizedFallbackService) {
            const serviceMatch = cotation.find((option) => this.getOptionComparableTexts(option).some((text) => text === normalizedFallbackService ||
                text.includes(normalizedFallbackService) ||
                normalizedFallbackService.includes(text))) || null;
            if (serviceMatch) {
                return serviceMatch;
            }
        }
        return shouldRequireMatch ? null : this.getCheapestOption(cotation);
    }
}
exports.TrayFreightService = TrayFreightService;
