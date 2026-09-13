"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.trayAuthService = exports.TrayAuthService = exports.isTrayReconnectRequiredError = exports.formatTrayRefreshFailure = exports.TrayAuthRefreshError = void 0;
const axios_1 = __importDefault(require("axios"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const crypto_1 = __importDefault(require("crypto"));
const db_1 = require("../lib/db");
class TrayAuthRefreshError extends Error {
    reconnectRequired;
    constructor(message, reconnectRequired) {
        super(message);
        this.name = 'TrayAuthRefreshError';
        this.reconnectRequired = reconnectRequired;
    }
}
exports.TrayAuthRefreshError = TrayAuthRefreshError;
const formatTrayRefreshFailure = (error) => {
    const status = Number(error?.response?.status || error?.status || 0);
    const body = error?.response?.data || error?.data || {};
    const code = String(body?.code || body?.error_code || '').trim();
    const message = String(body?.message || body?.error || error?.message || '').trim();
    const details = [
        status ? `HTTP ${status}` : null,
        code ? `codigo ${code}` : null,
    ]
        .filter(Boolean)
        .join(', ');
    return `Tray recusou a renovacao do token${details ? ` (${details})` : ''}${message ? `: ${message}` : '.'}`;
};
exports.formatTrayRefreshFailure = formatTrayRefreshFailure;
const isPermanentTrayAuthenticationFailure = (error) => {
    const status = Number(error?.response?.status || error?.status || 0);
    const body = error?.response?.data || error?.data || {};
    const code = String(body?.code || body?.error_code || '').trim();
    const message = String(body?.message || error?.message || '').toLowerCase();
    return (status === 400 ||
        status === 401 ||
        status === 403 ||
        code === '1099' ||
        message.includes('invalid or expired token') ||
        message.includes('token invalido') ||
        message.includes('token expirado'));
};
const isTrayReconnectRequiredError = (error) => error instanceof TrayAuthRefreshError && error.reconnectRequired;
exports.isTrayReconnectRequiredError = isTrayReconnectRequiredError;
class TrayAuthService {
    consumerKey;
    consumerSecret;
    jwtSecret;
    authCache = new Map();
    refreshLocks = new Map();
    constructor() {
        this.consumerKey = process.env.TRAY_CONSUMER_KEY || '';
        this.consumerSecret = process.env.TRAY_CONSUMER_SECRET || '';
        this.jwtSecret =
            process.env.AVANTRACKING_JWT_SECRET ||
                process.env.JWT_SECRET ||
                'your-secret-key-change-in-production';
    }
    normalizeStoreUrl(storeUrl) {
        let normalized = String(storeUrl || '').trim();
        if (!/^https?:\/\//i.test(normalized)) {
            normalized = `https://${normalized}`;
        }
        normalized = normalized.replace(/\/+$/, '');
        normalized = normalized.replace(/\/web_api$/i, '');
        return normalized;
    }
    normalizeApiAddress(apiAddress) {
        let normalized = String(apiAddress || '').trim();
        if (!normalized) {
            return '';
        }
        if (!/^https?:\/\//i.test(normalized)) {
            normalized = `https://${normalized}`;
        }
        normalized = normalized.replace(/\/+$/, '');
        if (!/\/web_api$/i.test(normalized)) {
            normalized = `${normalized}/web_api`;
        }
        return normalized;
    }
    buildCallbackUrl(options) {
        const configuredCallbackUrl = String(options?.configuredCallbackUrl || process.env.TRAY_CALLBACK_URL || '').trim();
        if (!configuredCallbackUrl) {
            return '';
        }
        let callbackUrl;
        try {
            callbackUrl = new URL(configuredCallbackUrl);
        }
        catch {
            if (!options?.fallbackOrigin) {
                return '';
            }
            callbackUrl = new URL(configuredCallbackUrl, options.fallbackOrigin);
        }
        if (options?.companyToken) {
            callbackUrl.searchParams.set('company_token', options.companyToken);
        }
        return callbackUrl.toString();
    }
    signCompanyContext(companyId, userId) {
        return jsonwebtoken_1.default.sign({
            type: 'tray-company-context',
            companyId,
            userId,
        }, this.jwtSecret, { expiresIn: '2h' });
    }
    verifyCompanyContext(token) {
        try {
            const decoded = jsonwebtoken_1.default.verify(token, this.jwtSecret);
            if (!decoded ||
                typeof decoded !== 'object' ||
                decoded.type !== 'tray-company-context' ||
                typeof decoded.companyId !== 'string' ||
                typeof decoded.userId !== 'string') {
                return null;
            }
            return {
                type: 'tray-company-context',
                companyId: decoded.companyId,
                userId: decoded.userId,
            };
        }
        catch {
            return null;
        }
    }
    getAuthorizationUrl(storeUrl, options) {
        const callbackUrl = encodeURIComponent(this.buildCallbackUrl({
            configuredCallbackUrl: options?.callbackUrl,
            companyToken: options?.companyToken,
            fallbackOrigin: options?.fallbackOrigin,
        }));
        const normalizedStoreUrl = this.normalizeStoreUrl(storeUrl);
        return `${normalizedStoreUrl}/auth.php?response_type=code&consumer_key=${this.consumerKey}&callback=${callbackUrl}`;
    }
    async generateAccessToken(code, apiAddress) {
        try {
            console.log('Gerando access_token da Tray...');
            const normalizedApiAddress = this.normalizeApiAddress(apiAddress);
            if (!normalizedApiAddress) {
                throw new Error('api_address invalido para gerar token da Tray.');
            }
            const body = new URLSearchParams();
            body.set('consumer_key', this.consumerKey);
            body.set('consumer_secret', this.consumerSecret);
            body.set('code', code);
            const response = await axios_1.default.post(`${normalizedApiAddress}/auth`, body.toString(), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            });
            console.log('Access token da Tray gerado com sucesso');
            return response.data;
        }
        catch (error) {
            console.error('Erro ao gerar access_token da Tray:', error.response?.data || error.message);
            throw new Error(`Erro ao gerar token: ${error.response?.data?.message || error.message}`);
        }
    }
    async refreshAccessToken(refreshToken, apiAddress) {
        const normalizedApiAddress = this.normalizeApiAddress(apiAddress);
        if (!normalizedApiAddress) {
            throw new Error('api_address invalido para renovar token da Tray.');
        }
        try {
            console.log('Renovando access_token da Tray...');
            const response = await axios_1.default.get(`${normalizedApiAddress}/auth`, {
                params: {
                    refresh_token: refreshToken,
                },
            });
            console.log('Access token da Tray renovado com sucesso');
            return response.data;
        }
        catch (error) {
            const message = (0, exports.formatTrayRefreshFailure)(error);
            console.error(message, error.response?.data || error.message);
            throw new TrayAuthRefreshError(message, isPermanentTrayAuthenticationFailure(error));
        }
    }
    async saveAuth(companyId, authData) {
        const savedResult = await (0, db_1.dbQuery)(`
        INSERT INTO "TrayAuth" (
          "id",
          "storeId",
          "storeName",
          "apiAddress",
          "accessToken",
          "refreshToken",
          "code",
          "expiresAt",
          "refreshTokenExpiresAt",
          "companyId",
          "createdAt",
          "updatedAt"
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          NOW(),
          NOW()
        )
        ON CONFLICT ("companyId")
        DO UPDATE SET
          "storeId" = EXCLUDED."storeId",
          "storeName" = EXCLUDED."storeName",
          "apiAddress" = EXCLUDED."apiAddress",
          "accessToken" = EXCLUDED."accessToken",
          "refreshToken" = EXCLUDED."refreshToken",
          "code" = EXCLUDED."code",
          "expiresAt" = EXCLUDED."expiresAt",
          "refreshTokenExpiresAt" = EXCLUDED."refreshTokenExpiresAt",
          "updatedAt" = NOW()
        RETURNING *
      `, [
            crypto_1.default.randomUUID(),
            authData.storeId,
            authData.storeName || null,
            authData.apiAddress,
            authData.accessToken,
            authData.refreshToken || null,
            authData.code || null,
            authData.expiresAt,
            authData.refreshTokenExpiresAt || null,
            companyId,
        ]);
        const saved = savedResult.rows[0];
        this.authCache.set(companyId, {
            accessToken: saved.accessToken,
            apiAddress: this.normalizeApiAddress(saved.apiAddress),
            expiresAt: saved.expiresAt,
        });
        return saved;
    }
    async getValidAuth(companyId) {
        const authData = await this.getValidAuthData(companyId);
        return authData?.accessToken || null;
    }
    async getValidAuthData(companyId, options) {
        const refreshBeforeMs = Math.max(0, Number(options?.refreshBeforeMs || 60 * 1000));
        const cached = this.authCache.get(companyId);
        if (cached && !this.isExpired(cached.expiresAt, refreshBeforeMs)) {
            return cached;
        }
        const pendingRefresh = this.refreshLocks.get(companyId);
        if (pendingRefresh) {
            return pendingRefresh;
        }
        const refreshPromise = this.resolveValidAuthData(companyId, refreshBeforeMs);
        this.refreshLocks.set(companyId, refreshPromise);
        try {
            return await refreshPromise;
        }
        finally {
            this.refreshLocks.delete(companyId);
        }
    }
    async getAuthData(companyId) {
        const result = await (0, db_1.dbQuery)(`
        SELECT *
        FROM "TrayAuth"
        WHERE "companyId" = $1
        LIMIT 1
      `, [companyId]);
        return result.rows[0] || null;
    }
    async getCompaniesWithAuth() {
        const authRowsResult = await (0, db_1.dbQuery)(`
        SELECT ta."companyId"
        FROM "TrayAuth" ta
        WHERE ta."companyId" IS NOT NULL
      `);
        const authRows = authRowsResult.rows;
        return authRows
            .map((row) => row.companyId)
            .filter((companyId) => Boolean(companyId));
    }
    async getCurrentAuth(companyId, storeId) {
        const auth = await this.getAuthData(companyId);
        if (!auth) {
            return null;
        }
        if (storeId && auth.storeId !== storeId) {
            return null;
        }
        return auth;
    }
    parseExpirationDate(dateStr) {
        const normalized = String(dateStr || '').trim();
        if (!normalized) {
            return new Date(Date.now() + 5 * 60 * 1000);
        }
        if (/[zZ]|[+-]\d{2}:\d{2}$/.test(normalized)) {
            return new Date(normalized.replace(' ', 'T'));
        }
        return new Date(normalized.replace(' ', 'T') + '-03:00');
    }
    isExpired(expiresAt, refreshBeforeMs = 60 * 1000) {
        return Date.now() >= expiresAt.getTime() - refreshBeforeMs;
    }
    async resolveValidAuthData(companyId, refreshBeforeMs) {
        const auth = await this.getAuthData(companyId);
        if (!auth) {
            console.log('Nenhuma autenticacao Tray encontrada');
            return null;
        }
        const normalizedApiAddress = this.normalizeApiAddress(auth.apiAddress);
        if (!normalizedApiAddress) {
            console.log('api_address da Tray invalido ou ausente no banco');
            return null;
        }
        if (!this.isExpired(auth.expiresAt, refreshBeforeMs)) {
            const current = {
                accessToken: auth.accessToken,
                apiAddress: normalizedApiAddress,
                expiresAt: auth.expiresAt,
            };
            this.authCache.set(companyId, current);
            return current;
        }
        console.log('Token da Tray expirado, renovando...');
        if (!auth.refreshToken) {
            console.log('Sem refresh_token da Tray disponivel');
            return null;
        }
        if (auth.refreshTokenExpiresAt &&
            Date.now() >= new Date(auth.refreshTokenExpiresAt).getTime()) {
            throw new TrayAuthRefreshError('O refresh token da Tray expirou. Reconecte a integracao Tray.', true);
        }
        const renewed = await this.refreshAccessToken(auth.refreshToken, normalizedApiAddress);
        const renewedData = {
            accessToken: renewed.access_token,
            apiAddress: this.normalizeApiAddress(renewed.api_host || normalizedApiAddress),
            expiresAt: this.parseExpirationDate(renewed.date_expiration_access_token || renewed.date_expiration),
            refreshTokenExpiresAt: renewed.date_expiration_refresh_token
                ? this.parseExpirationDate(renewed.date_expiration_refresh_token)
                : auth.refreshTokenExpiresAt || null,
        };
        await this.saveAuth(companyId, {
            storeId: String(renewed.store_id || auth.storeId),
            apiAddress: renewedData.apiAddress,
            accessToken: renewedData.accessToken,
            refreshToken: renewed.refresh_token || auth.refreshToken,
            expiresAt: renewedData.expiresAt,
            refreshTokenExpiresAt: renewedData.refreshTokenExpiresAt,
            storeName: auth.storeName || undefined,
        });
        return renewedData;
    }
}
exports.TrayAuthService = TrayAuthService;
exports.trayAuthService = new TrayAuthService();
