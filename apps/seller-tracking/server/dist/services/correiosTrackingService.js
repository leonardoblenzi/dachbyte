"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.looksLikeCorreiosObjectCode = exports.isCorreiosCarrier = exports.correiosTrackingService = void 0;
const orderStatus_1 = require("../types/orderStatus");
const readEnv = (value) => String(value || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '');
const CORREIOS_API_BASE_URL = readEnv(process.env.CORREIOS_API_BASE_URL) || 'https://api.correios.com.br';
const CORREIOS_DIRECT_TOKEN_URL = readEnv(process.env.CORREIOS_DIRECT_TOKEN_URL) ||
    `${CORREIOS_API_BASE_URL}/token/v1/autentica`;
const CORREIOS_POSTING_CARD_TOKEN_URL = readEnv(process.env.CORREIOS_POSTING_CARD_TOKEN_URL) ||
    `${CORREIOS_API_BASE_URL}/token/v1/autentica/cartaopostagem`;
const CORREIOS_CONTRACT_TOKEN_URL = readEnv(process.env.CORREIOS_CONTRACT_TOKEN_URL) ||
    `${CORREIOS_API_BASE_URL}/token/v1/autentica/contrato`;
const CORREIOS_TOKEN_URL = readEnv(process.env.CORREIOS_TOKEN_URL) || '';
const CORREIOS_RASTRO_URL = readEnv(process.env.CORREIOS_RASTRO_URL) ||
    `${CORREIOS_API_BASE_URL}/srorastro/v1/objetos`;
const CORREIOS_PUBLIC_TRACKING_BASE_URL = readEnv(process.env.CORREIOS_PUBLIC_TRACKING_BASE_URL) ||
    'https://rastreamento.correios.com.br/app/index.php?objetos=';
const CORREIOS_API_USER = readEnv(process.env.CORREIOS_API_USER) ||
    readEnv(process.env.CORREIOS_USERNAME) ||
    '';
const CORREIOS_API_PASSWORD = readEnv(process.env.CORREIOS_API_PASSWORD) ||
    readEnv(process.env.CORREIOS_PASSWORD) ||
    '';
const CORREIOS_POSTING_CARD = readEnv(process.env.CORREIOS_POSTING_CARD) ||
    readEnv(process.env.CORREIOS_CARTAO_POSTAGEM) ||
    '';
const CORREIOS_CONTRACT = readEnv(process.env.CORREIOS_CONTRACT) ||
    readEnv(process.env.CORREIOS_CONTRATO) ||
    '';
const CORREIOS_DR = readEnv(process.env.CORREIOS_DR) || '';
const CORREIOS_BEARER_TOKEN = readEnv(process.env.CORREIOS_BEARER_TOKEN) ||
    readEnv(process.env.CORREIOS_SUBDELEGATION_KEY) ||
    readEnv(process.env.CORREIOS_API_KEY) ||
    '';
let cachedToken = null;
const normalizeDigits = (value) => String(value || '')
    .replace(/\D/g, '')
    .trim();
const normalizeAlphaNumeric = (value) => String(value || '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .trim();
const normalizeComparableText = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
const safeString = (value) => {
    const normalized = String(value || '').trim();
    return normalized || null;
};
const safeDate = (value) => {
    if (!value)
        return null;
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const parseDateTimeParts = (dateValue, timeValue) => {
    const dateText = String(dateValue || '').trim();
    if (!dateText) {
        return null;
    }
    const dateMatch = dateText.match(/(\d{2})\/(\d{2})\/(\d{2,4})/);
    if (!dateMatch) {
        return safeDate(dateText);
    }
    const timeText = String(timeValue || '').trim();
    const timeMatch = timeText.match(/(\d{2}):(\d{2})(?::(\d{2}))?/);
    const day = Number(dateMatch[1]);
    const month = Number(dateMatch[2]) - 1;
    const rawYear = Number(dateMatch[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    const hour = timeMatch ? Number(timeMatch[1]) : 0;
    const minute = timeMatch ? Number(timeMatch[2]) : 0;
    const second = timeMatch?.[3] ? Number(timeMatch[3]) : 0;
    const parsed = new Date(year, month, day, hour, minute, second);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const parseCarrierForecastFromText = (text) => {
    const normalizedText = String(text || '').trim();
    if (!normalizedText)
        return null;
    const match = normalizedText.match(/previs[aã]o\s+de\s+entrega\s*[:\-]?\s*(\d{2})\/(\d{2})\/(\d{2,4})/i);
    if (!match) {
        return null;
    }
    const day = Number(match[1]);
    const month = Number(match[2]) - 1;
    const rawYear = Number(match[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    const parsedDate = new Date(year, month, day, 23, 59, 59, 999);
    return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
};
const mapCorreiosStatusToEnum = (value) => {
    const normalized = normalizeComparableText(value);
    if (!normalized) {
        return orderStatus_1.OrderStatus.PENDING;
    }
    if (normalized.includes('ENTREGUE')) {
        return orderStatus_1.OrderStatus.DELIVERED;
    }
    if (normalized.includes('SAIU PARA ENTREGA') ||
        normalized.includes('EM ROTA DE ENTREGA') ||
        normalized.includes('OBJETO SAIU PARA ENTREGA')) {
        return orderStatus_1.OrderStatus.DELIVERY_ATTEMPT;
    }
    if (normalized.includes('DEVOLVIDO') ||
        normalized.includes('DEVOLUCAO') ||
        normalized.includes('OBJETO DEVOLVIDO')) {
        return orderStatus_1.OrderStatus.RETURNED;
    }
    if (normalized.includes('TENTATIVA DE ENTREGA') ||
        normalized.includes('NAO ENTREGUE') ||
        normalized.includes('AGUARDANDO RETIRADA') ||
        normalized.includes('DESTINATARIO AUSENTE') ||
        normalized.includes('ENTREGA NAO REALIZADA')) {
        return orderStatus_1.OrderStatus.FAILURE;
    }
    if (normalized.includes('EM TRANSITO') ||
        normalized.includes('ENCAMINHADO') ||
        normalized.includes('RECEBIDO NA UNIDADE') ||
        normalized.includes('UNIDADE DE TRATAMENTO') ||
        normalized.includes('OBJETO POSTADO') ||
        normalized.includes('POSTADO')) {
        return orderStatus_1.OrderStatus.SHIPPED;
    }
    if (normalized.includes('PRE POSTADO') ||
        normalized.includes('PRE POSTAGEM') ||
        normalized.includes('AGUARDANDO POSTAGEM')) {
        return orderStatus_1.OrderStatus.CREATED;
    }
    return orderStatus_1.OrderStatus.PENDING;
};
const extractNestedValue = (source, paths) => {
    for (const path of paths) {
        const value = path
            .split('.')
            .reduce((current, key) => (current == null ? null : current[key]), source);
        if (value !== undefined && value !== null && value !== '') {
            return value;
        }
    }
    return null;
};
const getObjectPayload = (payload) => {
    if (Array.isArray(payload?.objetos) && payload.objetos.length > 0) {
        return payload.objetos[0];
    }
    if (Array.isArray(payload?.objeto) && payload.objeto.length > 0) {
        return payload.objeto[0];
    }
    if (payload?.objeto && typeof payload.objeto === 'object') {
        return payload.objeto;
    }
    return payload;
};
const buildPublicTrackingUrl = (objectCode) => `${CORREIOS_PUBLIC_TRACKING_BASE_URL}${encodeURIComponent(objectCode)}`;
const isCorreiosCarrier = (carrierName) => {
    const normalized = normalizeComparableText(carrierName);
    if (!normalized)
        return false;
    return (normalized === 'CORREIOS' ||
        normalized.includes(' CORREIOS ') ||
        normalized.startsWith('CORREIOS ') ||
        normalized.endsWith(' CORREIOS') ||
        normalized.includes('SEDEX') ||
        normalized.includes('PAC'));
};
exports.isCorreiosCarrier = isCorreiosCarrier;
const looksLikeCorreiosObjectCode = (value) => {
    const normalized = normalizeAlphaNumeric(value);
    return /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(normalized);
};
exports.looksLikeCorreiosObjectCode = looksLikeCorreiosObjectCode;
const isConfigured = () => Boolean(CORREIOS_BEARER_TOKEN) ||
    Boolean(CORREIOS_API_USER && CORREIOS_API_PASSWORD);
const extractTokenFromResponse = (payload) => safeString(payload?.token) ||
    safeString(payload?.jwt) ||
    safeString(payload?.access_token) ||
    safeString(payload?.accessToken) ||
    safeString(payload?.data?.token) ||
    safeString(payload?.data?.jwt) ||
    null;
const resolveTokenExpiryTimestamp = (payload) => {
    const dateCandidates = [
        payload?.expiraEm,
        payload?.data?.expiraEm,
        payload?.expiration,
        payload?.data?.expiration,
    ];
    for (const candidate of dateCandidates) {
        const parsed = safeDate(candidate);
        if (parsed) {
            return parsed.getTime();
        }
    }
    const numericCandidates = [
        payload?.expiresIn,
        payload?.expires_in,
        payload?.data?.expiresIn,
        payload?.data?.expires_in,
    ];
    for (const candidate of numericCandidates) {
        const numericValue = Number(candidate);
        if (Number.isFinite(numericValue) && numericValue > 0) {
            return Date.now() + numericValue * 1000;
        }
    }
    return Date.now() + 10 * 60 * 1000;
};
class CorreiosTrackingService {
    resolveTokenRequestConfigs() {
        const postingCardBody = CORREIOS_POSTING_CARD
            ? {
                numero: CORREIOS_POSTING_CARD,
                ...(CORREIOS_CONTRACT ? { contrato: CORREIOS_CONTRACT } : {}),
                ...(CORREIOS_DR ? { dr: Number(CORREIOS_DR) } : {}),
            }
            : undefined;
        const contractBody = CORREIOS_CONTRACT
            ? {
                numero: CORREIOS_CONTRACT,
                ...(CORREIOS_DR ? { dr: Number(CORREIOS_DR) } : {}),
            }
            : undefined;
        const rawConfigs = [];
        if (CORREIOS_TOKEN_URL) {
            rawConfigs.push({
                url: CORREIOS_TOKEN_URL,
                ...(postingCardBody ? { body: postingCardBody } : {}),
            });
            rawConfigs.push({ url: CORREIOS_TOKEN_URL });
        }
        if (postingCardBody) {
            rawConfigs.push({
                url: CORREIOS_POSTING_CARD_TOKEN_URL,
                body: postingCardBody,
            });
        }
        if (contractBody) {
            rawConfigs.push({
                url: CORREIOS_CONTRACT_TOKEN_URL,
                body: contractBody,
            });
        }
        rawConfigs.push({ url: CORREIOS_DIRECT_TOKEN_URL });
        const uniqueConfigs = new Map();
        for (const config of rawConfigs) {
            const normalizedUrl = String(config.url || '').trim();
            if (!normalizedUrl) {
                continue;
            }
            const key = `${normalizedUrl}::${JSON.stringify(config.body || null)}`;
            if (!uniqueConfigs.has(key)) {
                uniqueConfigs.set(key, {
                    url: normalizedUrl,
                    ...(config.body ? { body: config.body } : {}),
                });
            }
        }
        return Array.from(uniqueConfigs.values());
    }
    isAvailable() {
        return isConfigured();
    }
    shouldUseForCarrier(carrierName) {
        return isCorreiosCarrier(carrierName);
    }
    buildTrackingUrl(objectCode) {
        const normalizedCode = normalizeAlphaNumeric(objectCode);
        if (!normalizedCode || !looksLikeCorreiosObjectCode(normalizedCode)) {
            return null;
        }
        return buildPublicTrackingUrl(normalizedCode);
    }
    async getBearerToken(options) {
        const forceRefresh = options?.forceRefresh === true;
        const hasUserPasswordCredentials = Boolean(CORREIOS_API_USER && CORREIOS_API_PASSWORD);
        if (CORREIOS_BEARER_TOKEN &&
            (!forceRefresh || !hasUserPasswordCredentials)) {
            return CORREIOS_BEARER_TOKEN;
        }
        if (!forceRefresh &&
            cachedToken &&
            cachedToken.expiresAt > Date.now() + 30 * 60 * 1000 &&
            cachedToken.value) {
            return cachedToken.value;
        }
        if (!CORREIOS_API_USER || !CORREIOS_API_PASSWORD) {
            throw new Error('Credenciais dos Correios nao configuradas.');
        }
        const basicToken = Buffer.from(`${CORREIOS_API_USER}:${CORREIOS_API_PASSWORD}`, 'utf-8').toString('base64');
        const tokenConfigs = this.resolveTokenRequestConfigs();
        const authErrors = [];
        for (const { url, body } of tokenConfigs) {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: `Basic ${basicToken}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
            if (!response.ok) {
                authErrors.push(response.status);
                continue;
            }
            const payload = await response.json().catch(() => ({}));
            const token = extractTokenFromResponse(payload);
            if (!token) {
                continue;
            }
            cachedToken = {
                value: token,
                expiresAt: resolveTokenExpiryTimestamp(payload),
            };
            return token;
        }
        if (authErrors.length > 0) {
            const firstStatus = authErrors[0];
            const hasOnlyUnauthorizedStatuses = authErrors.every((status) => status === 401 || status === 403);
            if (hasOnlyUnauthorizedStatuses) {
                throw new Error(`Falha ao autenticar nos Correios: HTTP ${firstStatus}. Verifique usuario, senha e permissao do contrato/cartao.`);
            }
            throw new Error(`Falha ao autenticar nos Correios: HTTP ${firstStatus}`);
        }
        throw new Error('Falha ao autenticar nos Correios: nenhum endpoint retornou token.');
    }
    async requestTracking(normalizedCode, token) {
        return fetch(`${CORREIOS_RASTRO_URL}/${encodeURIComponent(normalizedCode)}?resultado=T`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
            },
        });
    }
    parseEvents(payload) {
        const objectPayload = getObjectPayload(payload);
        const rawEvents = Array.isArray(objectPayload?.eventos)
            ? objectPayload.eventos
            : Array.isArray(payload?.eventos)
                ? payload.eventos
                : [];
        return rawEvents
            .map((event) => {
            const description = safeString(event?.descricaoFrontEnd) ||
                safeString(event?.descricao) ||
                safeString(event?.detalhe) ||
                safeString(event?.mensagem) ||
                'Evento de rastreamento';
            const city = safeString(extractNestedValue(event, [
                'unidade.endereco.cidade',
                'unidade.endereco.cidadeLocalidade',
                'unidade.cidade',
                'cidade',
                'local',
            ])) || null;
            const state = safeString(extractNestedValue(event, [
                'unidade.endereco.uf',
                'unidade.endereco.siglaUf',
                'unidade.uf',
                'uf',
            ])) || null;
            const eventDate = safeDate(extractNestedValue(event, [
                'dtHrCriado',
                'dataHora',
                'data',
                'date',
            ])) ||
                parseDateTimeParts(event?.dtHrCriado, event?.hora) ||
                parseDateTimeParts(event?.data, event?.hora) ||
                new Date();
            return {
                status: safeString(event?.tipo) ||
                    safeString(event?.codigo) ||
                    mapCorreiosStatusToEnum(description),
                description,
                city,
                state: state ? state.toUpperCase().slice(0, 2) : null,
                eventDate,
            };
        })
            .sort((left, right) => right.eventDate.getTime() - left.eventDate.getTime());
    }
    async fetchTrackingByObjectCode(objectCode, carrierName) {
        if (!this.shouldUseForCarrier(carrierName)) {
            return null;
        }
        const normalizedCode = normalizeAlphaNumeric(objectCode);
        if (!normalizedCode || !looksLikeCorreiosObjectCode(normalizedCode)) {
            return null;
        }
        if (!this.isAvailable()) {
            throw new Error('Integracao dos Correios nao configurada.');
        }
        const hasUserPasswordCredentials = Boolean(CORREIOS_API_USER && CORREIOS_API_PASSWORD);
        const token = await this.getBearerToken();
        let response = await this.requestTracking(normalizedCode, token);
        const shouldRetryWithFreshToken = (response.status === 401 || response.status === 403) &&
            hasUserPasswordCredentials;
        if (shouldRetryWithFreshToken) {
            cachedToken = null;
            const refreshedToken = await this.getBearerToken({ forceRefresh: true });
            response = await this.requestTracking(normalizedCode, refreshedToken);
        }
        if (!response.ok) {
            if (response.status === 404) {
                return null;
            }
            if (response.status === 401 || response.status === 403) {
                throw new Error(`A API dos Correios recusou a consulta de rastreio (HTTP ${response.status}). Verifique as credenciais e permissoes da integracao.`);
            }
            throw new Error(`Falha ao consultar rastreio dos Correios: HTTP ${response.status}`);
        }
        const payload = await response.json().catch(() => null);
        if (!payload) {
            return null;
        }
        const events = this.parseEvents(payload);
        const objectPayload = getObjectPayload(payload);
        const latestEvent = events[0] || null;
        const status = latestEvent?.description
            ? mapCorreiosStatusToEnum(latestEvent.description)
            : mapCorreiosStatusToEnum(String(extractNestedValue(objectPayload, [
                'descricaoSituacao',
                'situacao',
                'status',
            ]) || ''));
        const carrierEstimatedDate = safeDate(extractNestedValue(objectPayload, [
            'previsaoEntrega',
            'prazoEntrega',
            'expectedDeliveryDate',
        ])) ||
            events.reduce((current, event) => {
                return current || parseCarrierForecastFromText(event.description);
            }, null);
        return {
            source: 'CORREIOS',
            status,
            trackingUrl: buildPublicTrackingUrl(normalizedCode),
            objectCode: normalizedCode,
            freightType: 'Correios',
            carrierEstimatedDate,
            events,
            rawPayload: payload,
        };
    }
}
exports.correiosTrackingService = new CorreiosTrackingService();
