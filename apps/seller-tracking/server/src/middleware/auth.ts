import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { dbQuery } from '../lib/db';

const JWT_SECRET =
  process.env.AVANTRACKING_JWT_SECRET ||
  process.env.JWT_SECRET ||
  'your-secret-key-change-in-production';
const HUB_DISABLED_VALUES = new Set([
  '',
  '0',
  'false',
  'null',
  'undefined',
  'off',
  'none',
  'disabled',
  '(not set)',
]);

function normalizeHubConfigValue(raw: unknown): string {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (HUB_DISABLED_VALUES.has(value.toLowerCase())) {
    return '';
  }
  return value;
}

const HUB_BASE_URL = normalizeHubConfigValue(process.env.HUB_BASE_URL).replace(/\/+$/, '');
const HUB_INTERNAL_TOKEN = normalizeHubConfigValue(process.env.HUB_INTERNAL_TOKEN);
const HUB_BYPASS_ADMIN_WITHOUT_COMPANY =
  String(process.env.AVANTRACKING_HUB_BYPASS_ADMIN_WITHOUT_COMPANY ?? 'true').toLowerCase() ===
  'true';
const HUB_BILLING_ALLOW_TTL_MS = Number(
  process.env.HUB_BILLING_ALLOW_TTL_MS || 5 * 60 * 1000,
);
const HUB_BILLING_NEAR_EXPIRATION_TTL_MS = Number(
  process.env.HUB_BILLING_NEAR_EXPIRATION_TTL_MS || 60 * 1000,
);
const HUB_BILLING_DENY_TTL_MS = Number(
  process.env.HUB_BILLING_DENY_TTL_MS || 30 * 1000,
);
const HUB_BILLING_NEAR_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;

type HubBillingAccessResult = {
  allow: boolean;
  reason?: string;
  status?: string | null;
  identity?: { userGlobalId: string | null; tenantGlobalId: string | null };
  accessPayload?: Record<string, unknown>;
  cached?: boolean;
  stale?: boolean;
};

const hubBillingCache = new Map<
  string,
  {
    result: HubBillingAccessResult;
    expiresAt: number;
    subscriptionExpiresAt: number | null;
  }
>();

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        companyId: string | null;
        role: string;
        module?: 'avantracking';
        isSuperAdmin?: boolean;
        userGlobalId?: string | null;
        tenantGlobalId?: string | null;
      };
      hubAccess?: Record<string, unknown> | null;
    }
  }
}

type DecodedTokenPayload = {
  id?: string;
  email?: string;
  companyId?: string | null;
  role?: string;
  module?: 'avantracking';
  isSuperAdmin?: boolean;
  userGlobalId?: string | null;
  tenantGlobalId?: string | null;
};

function getHubBillingCacheKey(identity: {
  userGlobalId: string | null;
  tenantGlobalId: string | null;
}): string {
  return [
    String(identity?.tenantGlobalId || '').trim(),
    String(identity?.userGlobalId || '').trim(),
    'tracking',
  ].join(':');
}

function parseHubAccessExpiration(payload: Record<string, unknown> | undefined): number | null {
  const raw =
    payload?.expires_at ||
    payload?.ends_at ||
    payload?.expiresAt ||
    null;
  if (!raw) return null;
  const time = new Date(String(raw)).getTime();
  return Number.isFinite(time) ? time : null;
}

function getHubBillingCacheTtl(result: HubBillingAccessResult): number {
  if (!result.allow) return HUB_BILLING_DENY_TTL_MS;
  const expiresAt = parseHubAccessExpiration(result.accessPayload);
  const now = Date.now();
  if (expiresAt && expiresAt <= now) return 0;
  const baseTtl =
    expiresAt && expiresAt - now <= HUB_BILLING_NEAR_EXPIRATION_MS
      ? HUB_BILLING_NEAR_EXPIRATION_TTL_MS
      : HUB_BILLING_ALLOW_TTL_MS;
  return expiresAt ? Math.max(0, Math.min(baseTtl, expiresAt - now)) : baseTtl;
}

function readFreshHubBillingCache(cacheKey: string): HubBillingAccessResult | null {
  const entry = hubBillingCache.get(cacheKey);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return { ...entry.result, cached: true };
}

function readStaleAllowedHubBillingCache(cacheKey: string): HubBillingAccessResult | null {
  const entry = hubBillingCache.get(cacheKey);
  if (!entry?.result?.allow) return null;
  if (entry.subscriptionExpiresAt && entry.subscriptionExpiresAt <= Date.now()) return null;
  return { ...entry.result, cached: true, stale: true };
}

function writeHubBillingCache(cacheKey: string, result: HubBillingAccessResult): void {
  const ttl = getHubBillingCacheTtl(result);
  if (ttl <= 0) {
    hubBillingCache.delete(cacheKey);
    return;
  }
  hubBillingCache.set(cacheKey, {
    result,
    expiresAt: Date.now() + ttl,
    subscriptionExpiresAt: parseHubAccessExpiration(result.accessPayload),
  });
}

function isAdminRole(role: unknown): boolean {
  const normalized = String(role || '').trim().toUpperCase();
  return normalized === 'ADMIN' || normalized === 'ADMIN_SUPER';
}

function canBypassBillingGateForCompanySwitching(
  req: Request,
  payload: DecodedTokenPayload,
): boolean {
  if (!isAdminRole(payload.role)) {
    return false;
  }

  const normalizedBaseUrl = String(req.baseUrl || '').trim();
  const normalizedPath = String(req.path || '').trim();
  const normalizedMethod = String(req.method || '').trim().toUpperCase();
  const originalPathWithoutQuery = String(req.originalUrl || '')
    .split('?')[0]
    .trim();
  const requestPath = `${normalizedBaseUrl}${normalizedPath}` || originalPathWithoutQuery;
  const normalizedRequestPath = requestPath.replace(/\/+$/, '') || '/';

  // Permite que admins sempre consigam listar empresas para trocar de conta
  if (
    normalizedMethod === 'GET' &&
    (normalizedRequestPath === '/api/companies' ||
      normalizedRequestPath === '/api/users/me')
  ) {
    return true;
  }

  // Permite que admins troquem para outra empresa mesmo com tenant atual bloqueado
  if (
    normalizedMethod === 'POST' &&
    normalizedRequestPath === '/api/users/switch-company'
  ) {
    return true;
  }

  return false;
}

function isHubConfigured(): boolean {
  return Boolean(HUB_BASE_URL && HUB_INTERNAL_TOKEN);
}

function shouldFailClosedHubGate(): boolean {
  const raw = String(
    process.env.AVANTRACKING_HUB_GATE_MODE ||
      process.env.HUB_AUTH_MODE ||
      process.env.HUB_ENFORCEMENT ||
      'hybrid',
  )
    .trim()
    .toLowerCase();

  return ['strict', 'enforce', 'enabled'].includes(raw);
}

function allowHubGateBypass(
  reason: string,
  identity?: { userGlobalId: string | null; tenantGlobalId: string | null },
  extra: Partial<HubBillingAccessResult> = {},
): HubBillingAccessResult {
  return {
    allow: true,
    reason,
    identity,
    accessPayload: {
      allow: true,
      bypass: true,
      module: 'tracking',
      reason,
      ...(extra.accessPayload || {}),
    },
    ...extra,
  };
}

async function resolveHubIdentity(payload: DecodedTokenPayload): Promise<{
  userGlobalId: string | null;
  tenantGlobalId: string | null;
  companyName: string | null;
}> {
  const userGlobalIdFromToken = String(payload.userGlobalId || '').trim() || null;
  const tenantGlobalIdFromToken = String(payload.tenantGlobalId || '').trim() || null;

  if (userGlobalIdFromToken && tenantGlobalIdFromToken) {
    return {
      userGlobalId: userGlobalIdFromToken,
      tenantGlobalId: tenantGlobalIdFromToken,
      companyName: null,
    };
  }

  const userId = String(payload.id || '').trim();
  if (!userId) {
    return {
      userGlobalId: userGlobalIdFromToken,
      tenantGlobalId: tenantGlobalIdFromToken,
      companyName: null,
    };
  }

  const result = await dbQuery<{
    userGlobalId: string | null;
    companyName: string | null;
    tenantGlobalId: string | null;
  }>(
    `
      SELECT
        u."userGlobalId" AS "userGlobalId",
        c."name" AS "companyName",
        c."tenantGlobalId" AS "tenantGlobalId"
      FROM "User" u
      LEFT JOIN "Company" c ON c."id" = u."companyId"
      WHERE u."id" = $1
      LIMIT 1
    `,
    [userId],
  );
  const user = result.rows[0] || null;

  return {
    userGlobalId: String(user?.userGlobalId || userGlobalIdFromToken || '').trim() || null,
    tenantGlobalId:
      String(user?.tenantGlobalId || tenantGlobalIdFromToken || '').trim() ||
      null,
    companyName: String(user?.companyName || '').trim() || null,
  };
}

export async function checkHubAccess(
  req: Request,
  payload: DecodedTokenPayload,
): Promise<HubBillingAccessResult> {
  if (!isHubConfigured()) {
    return { allow: true, reason: 'hub_not_configured' };
  }

  if (
    HUB_BYPASS_ADMIN_WITHOUT_COMPANY &&
    String(payload.role || '').toUpperCase() === 'ADMIN' &&
    !payload.companyId
  ) {
    return { allow: true, reason: 'admin_without_company_bypass' };
  }

  const identity = await resolveHubIdentity(payload);
  if (!identity.userGlobalId || !identity.tenantGlobalId) {
    if (!shouldFailClosedHubGate()) {
      return allowHubGateBypass('billing_identity_missing', identity);
    }
    return {
      allow: false,
      reason: 'billing_identity_missing',
      identity,
    };
  }

  const cacheKey = getHubBillingCacheKey(identity);
  const cachedAccess = readFreshHubBillingCache(cacheKey);
  if (cachedAccess) {
    return cachedAccess;
  }

  try {
    const syncResponse = await fetch(`${HUB_BASE_URL}/v1/internal/identity/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${HUB_INTERNAL_TOKEN}`,
      },
      body: JSON.stringify({
        tenant_id: identity.tenantGlobalId,
        company_name: identity.companyName || 'Davantti Tracking',
        user_id: identity.userGlobalId,
        full_name: String(payload.email || payload.id || 'Usuario Tracking').trim(),
        email: String(payload.email || '').trim().toLowerCase(),
        role:
          String(payload.role || '').toUpperCase() === 'ADMIN' || payload.isSuperAdmin
            ? 'owner'
            : 'operator',
        module: 'tracking',
        modules: ['tracking'],
      }),
    }).catch(() => null);

    const syncPayload = syncResponse
      ? ((await syncResponse.json().catch(() => ({}))) as Record<string, unknown>)
      : {};
    if (
      syncResponse &&
      !syncResponse.ok &&
      (syncResponse.status === 401 || syncResponse.status === 403)
    ) {
      return { allow: true, reason: 'hub_auth_invalid_bypass', identity };
    }
    const effectiveTenantId = String(
      syncPayload?.tenant_id || identity.tenantGlobalId || '',
    ).trim();
    const effectiveUserId = String(
      syncPayload?.user_id || identity.userGlobalId || '',
    ).trim();

    const response = await fetch(`${HUB_BASE_URL}/v1/access/check`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${HUB_INTERNAL_TOKEN}`,
      },
      body: JSON.stringify({
        tenant_id: effectiveTenantId,
        user_id: effectiveUserId,
        module: 'tracking',
        action: `${req.method} ${req.path || ''}`.trim(),
      }),
    });

    const accessPayload = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    if (!response.ok) {
      const staleAccess = readStaleAllowedHubBillingCache(cacheKey);
      if (staleAccess) {
        return staleAccess;
      }
      if (response.status === 401 || response.status === 403) {
        return { allow: true, reason: 'hub_auth_invalid_bypass', identity };
      }
      return { allow: true, reason: 'hub_access_check_failed_soft_allow', identity };
    }

    if (!accessPayload?.allow) {
      const reason =
        String(accessPayload?.reason || '').trim() ||
        'subscription_inactive_or_module_not_allowed';
      const deniedAccess: HubBillingAccessResult = {
        allow: false,
        reason,
        status: String(accessPayload?.status || '').trim() || null,
        identity,
        accessPayload,
      };
      writeHubBillingCache(cacheKey, deniedAccess);
      return deniedAccess;
    }

    const allowedAccess: HubBillingAccessResult = { allow: true, identity, accessPayload };
    writeHubBillingCache(cacheKey, allowedAccess);
    return allowedAccess;
  } catch (error) {
    console.error('[AVANTRACKING] Hub billing gate failure:', error);
    const staleAccess = readStaleAllowedHubBillingCache(cacheKey);
    if (staleAccess) {
      return staleAccess;
    }
    return { allow: true, reason: 'hub_access_check_failed_soft_allow', identity };
  }
}

export const authenticateToken = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token nao fornecido' });
  }

  jwt.verify(token, JWT_SECRET, async (err, decoded) => {
    if (err) {
      if (err.name === 'TokenExpiredError') {
        const expiredAt =
          err instanceof jwt.TokenExpiredError ? err.expiredAt : undefined;
        console.warn('Token expired:', expiredAt);
        return res.status(401).json({
          error: 'Token expirado',
          code: 'TOKEN_EXPIRED',
        });
      }

      console.error('Token verification failed:', err.message);
      return res.status(403).json({
        error: 'Token invalido',
        code: 'TOKEN_INVALID',
      });
    }

    const decodedPayload = (decoded || {}) as DecodedTokenPayload;
    const billing = await checkHubAccess(req, decodedPayload);
    if (!billing.allow) {
      if (canBypassBillingGateForCompanySwitching(req, decodedPayload)) {
        req.user = {
          ...(decodedPayload as any),
          userGlobalId:
            billing.identity?.userGlobalId ?? decodedPayload.userGlobalId ?? null,
          tenantGlobalId:
            billing.identity?.tenantGlobalId ??
            decodedPayload.tenantGlobalId ??
            null,
        };
        req.hubAccess = billing.accessPayload || null;
        return next();
      }

      return res.status(402).json({
        error: 'Pagamento pendente para este modulo.',
        code: 'PAYMENT_REQUIRED',
        reason: billing.reason || null,
        status: billing.status || null,
      });
    }

    req.user = {
      ...(decodedPayload as any),
      userGlobalId: billing.identity?.userGlobalId ?? decodedPayload.userGlobalId ?? null,
      tenantGlobalId:
        billing.identity?.tenantGlobalId ?? decodedPayload.tenantGlobalId ?? null,
    };
    req.hubAccess = billing.accessPayload || null;
    next();
  });
};

export const generateToken = (payload: {
  id: string;
  email: string;
  companyId: string | null;
  role: string;
  module?: 'avantracking';
  isSuperAdmin?: boolean;
  userGlobalId?: string | null;
  tenantGlobalId?: string | null;
}): string => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
};
