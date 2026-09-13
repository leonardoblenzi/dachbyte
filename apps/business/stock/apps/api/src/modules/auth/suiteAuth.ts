import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { pool } from '../../db/pool';
import type { AuthContext, JwtUserPayload } from '../../types/auth';

const SUITE_COOKIE_NAME = 'suite_auth_token';
const AUTH_TTL = '24h';

type SuitePayload = {
  tenant_id?: string;
  user_id?: string;
  email?: string;
  name?: string;
  full_name?: string;
  company_name?: string;
  role?: string;
  nivel?: string;
  allowed_modules?: unknown[];
  visible_modules?: unknown[];
  modules?: unknown[];
  exp?: number;
};

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function suiteSecret() {
  return String(process.env.SUITE_JWT_SECRET || process.env.ML_JWT_SECRET || process.env.JWT_SECRET || '').trim();
}

function parseCookies(header: unknown) {
  const cookies = new Map<string, string>();
  String(header || '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => {
      const separator = item.indexOf('=');
      if (separator <= 0) return;
      const key = item.slice(0, separator).trim();
      const value = item.slice(separator + 1).trim();
      if (key) cookies.set(key, decodeURIComponent(value));
    });
  return cookies;
}

function normalizeModuleKey(value: unknown) {
  if (typeof value === 'object' && value !== null) {
    const item = value as Record<string, unknown>;
    return normalizeModuleKey(item.id ?? item.key ?? item.module ?? item.slug);
  }
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function hasVoltStockAccess(payload: SuitePayload) {
  const keys = [payload.allowed_modules, payload.visible_modules, payload.modules]
    .filter(Array.isArray)
    .flatMap((items) => items as unknown[])
    .map(normalizeModuleKey)
    .filter(Boolean);
  return keys.includes('voltstock') || keys.includes('volt_stock');
}

function verifySuiteToken(token: string): SuitePayload | null {
  const secret = suiteSecret();
  if (!token || !secret) return null;

  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  const header = JSON.parse(base64UrlDecode(encodedHeader).toString('utf8')) as { alg?: string };
  if (header.alg !== 'HS256') return null;

  const expected = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  const actual = base64UrlDecode(encodedSignature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  const payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8')) as SuitePayload;
  if (payload.exp && payload.exp * 1000 <= Date.now()) return null;
  if (!hasVoltStockAccess(payload)) return null;
  return payload;
}

function normalizeEmail(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function normalizeSlug(value: unknown, fallback: string) {
  const normalized = String(value || fallback || 'voltstock')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || 'voltstock';
}

function normalizeRole(value: unknown) {
  const role = String(value || '').trim().toLowerCase();
  if (['owner', 'admin', 'administrador', 'admin_master', 'master'].includes(role)) return 'admin';
  if (['gestor', 'manager'].includes(role)) return 'gestor';
  if (['auditor'].includes(role)) return 'auditor';
  return 'operador';
}

async function signAccessToken(app: FastifyInstance, payload: JwtUserPayload) {
  return app.jwt.sign(payload, { expiresIn: AUTH_TTL });
}

export async function createSuiteSession(app: FastifyInstance, suitePayload: SuitePayload) {
  const tenantGlobalId = String(suitePayload.tenant_id || '').trim();
  const userGlobalId = String(suitePayload.user_id || '').trim();
  const email = normalizeEmail(suitePayload.email);
  if (!tenantGlobalId || !userGlobalId || !email) return null;

  const companyName = String(suitePayload.company_name || '').trim() || 'Empresa Volt Stock';
  const userName = String(suitePayload.name || suitePayload.full_name || email).trim();
  const tenantSlug = normalizeSlug(`${companyName}-${tenantGlobalId.slice(0, 12)}`, tenantGlobalId);
  const preferredRole = normalizeRole(suitePayload.role || suitePayload.nivel);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tenantResult = await client.query(
      `
        INSERT INTO tenants (name, slug, status, settings, tenant_global_id)
        VALUES ($1, $2, 'active', '{"source":"suite_login"}'::jsonb, $3)
        ON CONFLICT (tenant_global_id) WHERE tenant_global_id IS NOT NULL
        DO UPDATE SET name = EXCLUDED.name, status = 'active', updated_at = now()
        RETURNING id, slug
      `,
      [companyName, tenantSlug, tenantGlobalId]
    );
    const tenant = tenantResult.rows[0];

    let company = (
      await client.query(
        `
          SELECT id
          FROM companies
          WHERE tenant_id = $1
          ORDER BY created_at ASC
          LIMIT 1
        `,
        [tenant.id]
      )
    ).rows[0] as { id: string } | undefined;

    if (!company) {
      company = (
        await client.query(
          `
            INSERT INTO companies (tenant_id, legal_name, trade_name, status, settings)
            VALUES ($1, $2, $2, 'active', '{"source":"suite_login"}'::jsonb)
            RETURNING id
          `,
          [tenant.id, companyName]
        )
      ).rows[0];
    }
    if (!company?.id) {
      throw new Error('Nao foi possivel preparar a empresa do Volt Stock para a sessao da suite.');
    }

    let branch = (
      await client.query(
        `
          SELECT id
          FROM branches
          WHERE tenant_id = $1 AND company_id = $2
          ORDER BY created_at ASC
          LIMIT 1
        `,
        [tenant.id, company.id]
      )
    ).rows[0] as { id: string } | undefined;

    if (!branch) {
      branch = (
        await client.query(
          `
            INSERT INTO branches (tenant_id, company_id, code, name, timezone, status)
            VALUES ($1, $2, 'MATRIZ', 'Matriz Operacional', 'America/Sao_Paulo', 'active')
            RETURNING id
          `,
          [tenant.id, company.id]
        )
      ).rows[0];
    }
    if (!branch?.id) {
      throw new Error('Nao foi possivel preparar a filial do Volt Stock para a sessao da suite.');
    }

    const passwordSeed = randomBytes(24).toString('base64url');
    const userResult = await client.query(
      `
        INSERT INTO users (tenant_id, email, password_hash, full_name, role, status, user_global_id)
        VALUES ($1, $2, crypt($3, gen_salt('bf', 12)), $4, $5, 'active', $6)
        ON CONFLICT (tenant_id, email)
        DO UPDATE SET full_name = EXCLUDED.full_name,
                      user_global_id = EXCLUDED.user_global_id,
                      status = 'active',
                      updated_at = now()
        RETURNING id, tenant_id, email, full_name, role, user_global_id
      `,
      [tenant.id, email, passwordSeed, userName, preferredRole, userGlobalId]
    );
    const user = userResult.rows[0];

    const accessCount = await client.query(
      'SELECT count(*)::int AS count FROM user_company_access WHERE tenant_id = $1 AND company_id = $2',
      [tenant.id, company.id]
    );
    const accessRole = Number(accessCount.rows[0]?.count || 0) === 0 ? 'admin' : preferredRole;

    await client.query(
      `
        INSERT INTO user_company_access (tenant_id, user_id, company_id, branch_id, role, status)
        VALUES ($1, $2, $3, $4, $5, 'active')
        ON CONFLICT (tenant_id, user_id, company_id, branch_id)
        DO UPDATE SET role = EXCLUDED.role, status = 'active', updated_at = now()
      `,
      [tenant.id, user.id, company.id, branch.id, accessRole]
    );
    await client.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    await client.query('COMMIT');

    const accessToken = await signAccessToken(app, {
      sub: user.id,
      tenantId: tenant.id,
      companyId: company.id,
      branchId: branch.id,
      email,
      role: accessRole
    });

    return {
      accessToken,
      user: {
        id: user.id,
        email,
        fullName: user.full_name,
        role: accessRole,
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        companyId: company.id,
        branchId: branch.id
      },
      auth: {
        tenantId: tenant.id,
        userId: user.id,
        companyId: company.id,
        branchId: branch.id,
        email,
        role: accessRole
      } satisfies AuthContext
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function authenticateFromSuiteCookie(app: FastifyInstance, request: FastifyRequest) {
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies.get(SUITE_COOKIE_NAME) || '';
  const payload = verifySuiteToken(token);
  if (!payload) return null;
  return createSuiteSession(app, payload);
}
