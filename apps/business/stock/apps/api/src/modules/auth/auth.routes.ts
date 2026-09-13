import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { loginSchema, refreshTokenSchema } from '@voltstock/shared';
import { pool } from '../../db/pool';
import { authenticate } from '../../http/authenticate';
import type { JwtUserPayload } from '../../types/auth';
import { authenticateFromSuiteCookie } from './suiteAuth';

function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function signAccessToken(app: FastifyInstance, payload: JwtUserPayload) {
  return app.jwt.sign(payload, { expiresIn: '15m' });
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/suite-session', async (request, reply) => {
    const suiteSession = await authenticateFromSuiteCookie(app, request);
    if (!suiteSession) {
      return reply.code(204).send();
    }

    return {
      accessToken: suiteSession.accessToken,
      refreshToken: '',
      user: suiteSession.user
    };
  });

  app.post('/login', async (request, reply) => {
    const input = loginSchema.parse(request.body);

    const result = await pool.query(
      `
        SELECT
          u.id,
          u.tenant_id,
          u.email,
          u.full_name,
          u.role,
          a.company_id,
          a.branch_id,
          t.slug AS tenant_slug
        FROM users u
        JOIN tenants t ON t.id = u.tenant_id
        JOIN user_company_access a ON a.tenant_id = u.tenant_id AND a.user_id = u.id AND a.status = 'active'
        WHERE u.email = $1
          AND u.status = 'active'
          AND t.status = 'active'
          AND u.password_hash = crypt($2, u.password_hash)
          AND ($3::text IS NULL OR t.slug = $3)
        ORDER BY CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END, u.created_at ASC
        LIMIT 1
      `,
      [input.email, input.password, input.tenantSlug ?? null]
    );

    if (!result.rowCount) {
      return reply.code(401).send({ error: 'invalid_credentials', message: 'E-mail ou senha invalidos.' });
    }

    const user = result.rows[0];
    const accessToken = await signAccessToken(app, {
      sub: user.id,
      tenantId: user.tenant_id,
      companyId: user.company_id,
      branchId: user.branch_id ?? undefined,
      email: user.email,
      role: user.role
    });

    const refreshToken = randomBytes(48).toString('base64url');
    await pool.query(
      `
        INSERT INTO refresh_tokens (tenant_id, user_id, token_hash, expires_at)
        VALUES ($1, $2, $3, now() + interval '30 days')
      `,
      [user.tenant_id, user.id, hashRefreshToken(refreshToken)]
    );
    await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        tenantId: user.tenant_id,
        tenantSlug: user.tenant_slug,
        companyId: user.company_id,
        branchId: user.branch_id
      }
    };
  });

  app.post('/refresh', async (request, reply) => {
    const input = refreshTokenSchema.parse(request.body);
    const tokenHash = hashRefreshToken(input.refreshToken);

    const result = await pool.query(
      `
        SELECT
          rt.id AS refresh_token_id,
          u.id,
          u.tenant_id,
          u.email,
          u.full_name,
          u.role,
          a.company_id,
          a.branch_id
        FROM refresh_tokens rt
        JOIN users u ON u.id = rt.user_id AND u.tenant_id = rt.tenant_id
        JOIN user_company_access a ON a.tenant_id = u.tenant_id AND a.user_id = u.id AND a.status = 'active'
        WHERE rt.token_hash = $1
          AND rt.revoked_at IS NULL
          AND rt.expires_at > now()
          AND u.status = 'active'
        LIMIT 1
      `,
      [tokenHash]
    );

    if (!result.rowCount) {
      return reply.code(401).send({ error: 'invalid_refresh', message: 'Refresh token invalido.' });
    }

    const user = result.rows[0];
    const accessToken = await signAccessToken(app, {
      sub: user.id,
      tenantId: user.tenant_id,
      companyId: user.company_id,
      branchId: user.branch_id ?? undefined,
      email: user.email,
      role: user.role
    });

    return { accessToken };
  });

  app.post('/logout', { preHandler: [authenticate] }, async (request) => {
    const body = refreshTokenSchema.partial().parse(request.body ?? {});

    if (body.refreshToken) {
      await pool.query(
        `
          UPDATE refresh_tokens
          SET revoked_at = now()
          WHERE tenant_id = $1 AND user_id = $2 AND token_hash = $3
        `,
        [request.auth.tenantId, request.auth.userId, hashRefreshToken(body.refreshToken)]
      );
    }

    return { ok: true };
  });
}
