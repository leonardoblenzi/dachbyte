import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { dbQuery } from '../lib/db';

interface TrayAuthResponse {
  message?: string;
  code?: string;
  access_token: string;
  refresh_token?: string;
  date_expiration: string;
  date_expiration_access_token?: string;
  date_expiration_refresh_token?: string;
  date_activated?: string;
  api_host: string;
  store_id?: string | number;
}

interface TrayCompanyContextPayload {
  type: 'tray-company-context';
  companyId: string;
  userId: string;
}

export class TrayAuthRefreshError extends Error {
  readonly reconnectRequired: boolean;

  constructor(message: string, reconnectRequired: boolean) {
    super(message);
    this.name = 'TrayAuthRefreshError';
    this.reconnectRequired = reconnectRequired;
  }
}

export const formatTrayRefreshFailure = (error: any) => {
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

  return `Tray recusou a renovacao do token${details ? ` (${details})` : ''}${
    message ? `: ${message}` : '.'
  }`;
};
const isPermanentTrayAuthenticationFailure = (error: any) => {
  const status = Number(error?.response?.status || error?.status || 0);
  const body = error?.response?.data || error?.data || {};
  const code = String(body?.code || body?.error_code || '').trim();
  const message = String(body?.message || error?.message || '').toLowerCase();

  return (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    code === '1099' ||
    message.includes('invalid or expired token') ||
    message.includes('token invalido') ||
    message.includes('token expirado')
  );
};

export const isTrayReconnectRequiredError = (error: unknown) =>
  error instanceof TrayAuthRefreshError && error.reconnectRequired;

export class TrayAuthService {
  private consumerKey: string;
  private consumerSecret: string;
  private jwtSecret: string;
  private authCache = new Map<
    string,
    { accessToken: string; apiAddress: string; expiresAt: Date }
  >();
  private refreshLocks = new Map<
    string,
    Promise<{ accessToken: string; apiAddress: string; expiresAt: Date } | null>
  >();

  constructor() {
    this.consumerKey = process.env.TRAY_CONSUMER_KEY || '';
    this.consumerSecret = process.env.TRAY_CONSUMER_SECRET || '';
    this.jwtSecret =
      process.env.AVANTRACKING_JWT_SECRET ||
      process.env.JWT_SECRET ||
      'your-secret-key-change-in-production';
  }

  normalizeStoreUrl(storeUrl: string): string {
    let normalized = String(storeUrl || '').trim();

    if (!/^https?:\/\//i.test(normalized)) {
      normalized = `https://${normalized}`;
    }

    normalized = normalized.replace(/\/+$/, '');
    normalized = normalized.replace(/\/web_api$/i, '');

    return normalized;
  }

  normalizeApiAddress(apiAddress: string): string {
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

  private buildCallbackUrl(options?: {
    configuredCallbackUrl?: string;
    companyToken?: string;
    fallbackOrigin?: string;
  }) {
    const configuredCallbackUrl = String(
      options?.configuredCallbackUrl || process.env.TRAY_CALLBACK_URL || '',
    ).trim();
    if (!configuredCallbackUrl) {
      return '';
    }

    let callbackUrl: URL;
    try {
      callbackUrl = new URL(configuredCallbackUrl);
    } catch {
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

  signCompanyContext(companyId: string, userId: string) {
    return jwt.sign(
      {
        type: 'tray-company-context',
        companyId,
        userId,
      } satisfies TrayCompanyContextPayload,
      this.jwtSecret,
      { expiresIn: '2h' },
    );
  }

  verifyCompanyContext(token: string): TrayCompanyContextPayload | null {
    try {
      const decoded = jwt.verify(token, this.jwtSecret);
      if (
        !decoded ||
        typeof decoded !== 'object' ||
        decoded.type !== 'tray-company-context' ||
        typeof decoded.companyId !== 'string' ||
        typeof decoded.userId !== 'string'
      ) {
        return null;
      }

      return {
        type: 'tray-company-context',
        companyId: decoded.companyId,
        userId: decoded.userId,
      };
    } catch {
      return null;
    }
  }

  getAuthorizationUrl(
    storeUrl: string,
    options?: {
      companyToken?: string;
      callbackUrl?: string;
      fallbackOrigin?: string;
    },
  ): string {
    const callbackUrl = encodeURIComponent(
      this.buildCallbackUrl({
        configuredCallbackUrl: options?.callbackUrl,
        companyToken: options?.companyToken,
        fallbackOrigin: options?.fallbackOrigin,
      }),
    );
    const normalizedStoreUrl = this.normalizeStoreUrl(storeUrl);

    return `${normalizedStoreUrl}/auth.php?response_type=code&consumer_key=${this.consumerKey}&callback=${callbackUrl}`;
  }

  async generateAccessToken(
    code: string,
    apiAddress: string,
  ): Promise<TrayAuthResponse> {
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

      const response = await axios.post(`${normalizedApiAddress}/auth`, body.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      console.log('Access token da Tray gerado com sucesso');
      return response.data;
    } catch (error: any) {
      console.error(
        'Erro ao gerar access_token da Tray:',
        error.response?.data || error.message,
      );
      throw new Error(
        `Erro ao gerar token: ${error.response?.data?.message || error.message}`,
      );
    }
  }

  async refreshAccessToken(
    refreshToken: string,
    apiAddress: string,
  ): Promise<TrayAuthResponse> {
    const normalizedApiAddress = this.normalizeApiAddress(apiAddress);

    if (!normalizedApiAddress) {
      throw new Error('api_address invalido para renovar token da Tray.');
    }

    try {
      console.log('Renovando access_token da Tray...');

      const response = await axios.get(`${normalizedApiAddress}/auth`, {
        params: {
          refresh_token: refreshToken,
        },
      });

      console.log('Access token da Tray renovado com sucesso');
      return response.data;
    } catch (error: any) {
      const message = formatTrayRefreshFailure(error);
      console.error(message, error.response?.data || error.message);
      throw new TrayAuthRefreshError(
        message,
        isPermanentTrayAuthenticationFailure(error),
      );
    }
  }

  async saveAuth(companyId: string, authData: {
    storeId: string;
    apiAddress: string;
    accessToken: string;
    refreshToken?: string;
    expiresAt: Date;
    refreshTokenExpiresAt?: Date | null;
    code?: string;
    storeName?: string;
  }) {
    const savedResult = await dbQuery<any>(
      `
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
      `,
      [
        crypto.randomUUID(),
        authData.storeId,
        authData.storeName || null,
        authData.apiAddress,
        authData.accessToken,
        authData.refreshToken || null,
        authData.code || null,
        authData.expiresAt,
        authData.refreshTokenExpiresAt || null,
        companyId,
      ],
    );
    const saved = savedResult.rows[0];

    this.authCache.set(companyId, {
      accessToken: saved.accessToken,
      apiAddress: this.normalizeApiAddress(saved.apiAddress),
      expiresAt: saved.expiresAt,
    });

    return saved;
  }

  async getValidAuth(companyId: string): Promise<string | null> {
    const authData = await this.getValidAuthData(companyId);
    return authData?.accessToken || null;
  }

  async getValidAuthData(
    companyId: string,
    options?: { refreshBeforeMs?: number },
  ) {
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
    } finally {
      this.refreshLocks.delete(companyId);
    }
  }

  async getAuthData(companyId: string) {
    const result = await dbQuery<any>(
      `
        SELECT *
        FROM "TrayAuth"
        WHERE "companyId" = $1
        LIMIT 1
      `,
      [companyId],
    );
    return result.rows[0] || null;
  }

  async getCompaniesWithAuth() {
    const authRowsResult = await dbQuery<any>(
      `
        SELECT ta."companyId"
        FROM "TrayAuth" ta
        WHERE ta."companyId" IS NOT NULL
      `,
    );
    const authRows = authRowsResult.rows;

    return authRows
      .map((row) => row.companyId)
      .filter((companyId): companyId is string => Boolean(companyId));
  }

  async getCurrentAuth(companyId: string, storeId?: string) {
    const auth = await this.getAuthData(companyId);

    if (!auth) {
      return null;
    }

    if (storeId && auth.storeId !== storeId) {
      return null;
    }

    return auth;
  }

  parseExpirationDate(dateStr: string): Date {
    const normalized = String(dateStr || '').trim();

    if (!normalized) {
      return new Date(Date.now() + 5 * 60 * 1000);
    }

    if (/[zZ]|[+-]\d{2}:\d{2}$/.test(normalized)) {
      return new Date(normalized.replace(' ', 'T'));
    }

    return new Date(normalized.replace(' ', 'T') + '-03:00');
  }

  private isExpired(expiresAt: Date, refreshBeforeMs = 60 * 1000): boolean {
    return Date.now() >= expiresAt.getTime() - refreshBeforeMs;
  }

  private async resolveValidAuthData(companyId: string, refreshBeforeMs: number) {
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

    if (
      auth.refreshTokenExpiresAt &&
      Date.now() >= new Date(auth.refreshTokenExpiresAt).getTime()
    ) {
      throw new TrayAuthRefreshError(
        'O refresh token da Tray expirou. Reconecte a integracao Tray.',
        true,
      );
    }

    const renewed = await this.refreshAccessToken(
      auth.refreshToken,
      normalizedApiAddress,
    );

    const renewedData = {
      accessToken: renewed.access_token,
      apiAddress: this.normalizeApiAddress(renewed.api_host || normalizedApiAddress),
      expiresAt: this.parseExpirationDate(
        renewed.date_expiration_access_token || renewed.date_expiration,
      ),
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

export const trayAuthService = new TrayAuthService();
