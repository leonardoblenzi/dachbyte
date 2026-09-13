import crypto from 'crypto';
import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { generateToken } from '../middleware/auth';
import { sendAccessEmail } from '../services/accessEmailService';
import { sendBrevoEmail } from '../services/emailTransportService';
import {
  evaluateHubLoginAccess,
  revokeHubModuleIdentity,
  syncHubModuleIdentity,
  verifyHubGlobalLogin,
} from '../services/hubAccessService';
import { dbQuery, withDbTransaction } from '../lib/db';
import { shouldPreserveMasterCompanySelection } from '../services/integrationHealthPolicy';

const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PROFILE_IMAGE_BYTES = 350 * 1024;
const BIRTHDAY_TIMEZONE = 'America/Sao_Paulo';
const MASTER_ADMIN_EMAIL = String(
  process.env.MASTER_ADMIN_EMAIL || 'cadastro6@drossiinteriores.com.br',
)
  .trim()
  .toLowerCase();
const SUITE_JWT_SECRET =
  String(process.env.SUITE_JWT_SECRET || '').trim() ||
  String(process.env.ML_JWT_SECRET || '').trim() ||
  String(process.env.JWT_SECRET || '').trim();

type AccessTokenType = 'INVITE' | 'RESET_PASSWORD';

type BirthdayDateParts = {
  day: number;
  month: number;
  year: number;
};

const normalizeString = (value: unknown) => String(value || '').trim();

const normalizeNullableString = (value: unknown) => {
  const normalized = normalizeString(value);
  return normalized || null;
};

const isMasterAdminEmail = (email: string | null | undefined) =>
  shouldPreserveMasterCompanySelection(email, MASTER_ADMIN_EMAIL);

const loadCompanyIdentityForHub = async (companyId: string | null | undefined) => {
  const normalized = String(companyId || '').trim();
  if (!normalized) return null;

  const result = await dbQuery<{
    id: string;
    name: string;
    tenantGlobalId: string | null;
    documentType: string | null;
    documentNumber: string | null;
  }>(
    `
      SELECT
        c."id" AS "id",
        c."name" AS "name",
        c."tenantGlobalId" AS "tenantGlobalId",
        c."documentType" AS "documentType",
        c."documentNumber" AS "documentNumber"
      FROM "Company" c
      WHERE c."id" = $1
      LIMIT 1
    `,
    [normalized],
  );
  const company = result.rows[0] || null;

  if (!company) return null;
  return {
    id: company.id,
    name: company.name,
    tenantGlobalId: company.tenantGlobalId || null,
    documentType: company.documentType || null,
    documentNumber: company.documentNumber || null,
  };
};

const resolveCompanyIdByName = async (companyName: string) => {
  const result = await dbQuery<{ id: string }>(
    `
      SELECT "id"
      FROM "Company"
      WHERE lower("name") = lower($1)
      ORDER BY "createdAt" ASC
      LIMIT 1
    `,
    [String(companyName || '').trim()],
  );

  return result.rows[0]?.id || null;
};

const fallbackUserName = (payload: Record<string, any>, email: string) =>
  normalizeString(payload?.name || payload?.full_name || email) || email;

const provisionTrackingUserFromHubLogin = async (
  email: string,
  hubLogin: { payload?: Record<string, any> | null },
) => {
  const payload = hubLogin.payload || {};
  const tenantGlobalId = normalizeString(payload.tenant_id);
  const userGlobalId = normalizeString(payload.user_id);
  if (!tenantGlobalId || !userGlobalId) return null;

  const companyName = normalizeString(payload.company_name) || 'Empresa Davantti';
  const userName = fallbackUserName(payload, email);
  const documentType = normalizeNullableString(payload.document_type);
  const documentNumber = normalizeNullableString(payload.document_number);
  const role = String(payload.role || '').toLowerCase() === 'owner' ? 'ADMIN' : 'USER';

  return withDbTransaction(async (client) => {
    let company = (
      await client.query<{ id: string; name: string; tenantGlobalId: string | null }>(
        `
          SELECT "id", "name", "tenantGlobalId"
          FROM "Company"
          WHERE "tenantGlobalId" = $1
          LIMIT 1
        `,
        [tenantGlobalId],
      )
    ).rows[0] || null;

    if (!company) {
      company = (
        await client.query<{ id: string; name: string; tenantGlobalId: string | null }>(
          `
            INSERT INTO "Company" (
              "id",
              "name",
              "tenantGlobalId",
              "documentType",
              "documentNumber",
              "cnpj",
              "createdAt"
            ) VALUES ($1,$2,$3,$4,$5,$6,$7)
            RETURNING "id", "name", "tenantGlobalId"
          `,
          [
            crypto.randomUUID(),
            companyName,
            tenantGlobalId,
            documentType,
            documentNumber,
            documentType === 'CNPJ' ? documentNumber : null,
            new Date(),
          ],
        )
      ).rows[0] || null;
    }

    if (!company) return null;

    const existingUser = (
      await client.query<{ id: string; companyId: string | null }>(
        `SELECT "id", "companyId" FROM "User" WHERE lower("email") = lower($1) LIMIT 1`,
        [email],
      )
    ).rows[0] || null;

    if (!existingUser) {
      const temporaryPasswordHash = await bcrypt.hash(crypto.randomUUID(), 10);
      await client.query(
        `
          INSERT INTO "User" (
            "id",
            "name",
            "email",
            "password",
            "role",
            "companyId",
            "userGlobalId",
            "receivePlatformEmails",
            "createdAt",
            "updatedAt"
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `,
        [
          crypto.randomUUID(),
          userName,
          email,
          temporaryPasswordHash,
          role,
          company.id,
          userGlobalId,
          true,
          new Date(),
          new Date(),
        ],
      );
    } else {
      const companyId =
        isMasterAdminEmail(email) && existingUser.companyId
          ? existingUser.companyId
          : company.id;
      await client.query(
        `
          UPDATE "User"
          SET
            "name" = COALESCE(NULLIF($2, ''), "name"),
            "companyId" = $3,
            "userGlobalId" = COALESCE(NULLIF($4, ''), "userGlobalId"),
            "role" = CASE WHEN $6 = 'ADMIN' THEN 'ADMIN' ELSE "role" END,
            "updatedAt" = $5
          WHERE "id" = $1
        `,
        [existingUser.id, userName, companyId, userGlobalId, new Date(), role],
      );
    }

    const userResult = await client.query<{
      id: string;
      email: string;
      name: string;
      role: string;
      companyId: string | null;
      userGlobalId: string | null;
      tenantGlobalId: string | null;
      phone: string | null;
      birthDate: Date | null;
      profileImageData: string | null;
      receivePlatformEmails: boolean | null;
      lastBirthdayCelebrationAt: Date | null;
      password: string;
    }>(
      `
        SELECT
          u."id",
          u."email",
          u."name",
          u."role",
          u."companyId",
          u."userGlobalId",
          c."tenantGlobalId" AS "tenantGlobalId",
          u."phone",
          u."birthDate",
          u."profileImageData",
          u."receivePlatformEmails",
          u."lastBirthdayCelebrationAt",
          u."password"
        FROM "User" u
        LEFT JOIN "Company" c ON c."id" = u."companyId"
        WHERE lower(u."email") = lower($1)
        LIMIT 1
      `,
      [email],
    );

    return userResult.rows[0] || null;
  });
};

const parseBirthdayInput = (value: unknown) => {
  const normalized = normalizeString(value);
  if (!normalized) return null;

  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  const parsed = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
};

const formatBirthdayDate = (value: Date | null | undefined) => {
  if (!value) return null;

  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(
    value.getUTCDate(),
  ).padStart(2, '0')}`;
};

const parseProfileImageData = (value: unknown) => {
  const normalized = normalizeString(value);
  if (!normalized) return null;

  const match = normalized.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match?.[2]) {
    throw new Error('Imagem de perfil invalida. Use uma imagem em formato base64.');
  }

  const imageBuffer = Buffer.from(match[2], 'base64');
  if (!imageBuffer.length) {
    throw new Error('Imagem de perfil invalida.');
  }

  if (imageBuffer.length > MAX_PROFILE_IMAGE_BYTES) {
    throw new Error('A imagem de perfil deve ter no maximo 350KB.');
  }

  const extension = String(match[1] || '').toLowerCase();
  const mimeType = extension === 'jpg' ? 'jpeg' : extension;

  return `data:image/${mimeType};base64,${match[2]}`;
};

const getDatePartsByTimezone = (date: Date, timeZone: string): BirthdayDateParts => {
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  const parts = formatter.formatToParts(date);
  const day = Number(parts.find((part) => part.type === 'day')?.value || 0);
  const month = Number(parts.find((part) => part.type === 'month')?.value || 0);
  const year = Number(parts.find((part) => part.type === 'year')?.value || 0);

  return {
    day,
    month,
    year,
  };
};

const isBirthdayToday = (birthDate: Date | null | undefined, now = new Date()) => {
  if (!birthDate) return false;

  const birthdayParts = {
    day: birthDate.getUTCDate(),
    month: birthDate.getUTCMonth() + 1,
  };
  const todayParts = getDatePartsByTimezone(now, BIRTHDAY_TIMEZONE);

  return (
    birthdayParts.day === todayParts.day &&
    birthdayParts.month === todayParts.month
  );
};

const hasCelebratedBirthdayToday = (
  lastCelebrationAt: Date | null | undefined,
  now = new Date(),
) => {
  if (!lastCelebrationAt) return false;

  const celebrationParts = getDatePartsByTimezone(lastCelebrationAt, BIRTHDAY_TIMEZONE);
  const todayParts = getDatePartsByTimezone(now, BIRTHDAY_TIMEZONE);

  return (
    celebrationParts.day === todayParts.day &&
    celebrationParts.month === todayParts.month &&
    celebrationParts.year === todayParts.year
  );
};

const buildBirthdayCelebrationMessage = (name: string) =>
  `Feliz aniversario, ${name}! Obrigado por fazer parte da jornada do Avantracking. Que seu novo ciclo venha com muita saude, conquistas e entregas de sucesso.`;

const normalizeModuleList = (value: unknown) =>
  Array.isArray(value)
    ? value.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : [];

const getCookieValue = (req: Request, name: string) => {
  const parsedCookie = (req as any).cookies?.[name];
  if (parsedCookie) return String(parsedCookie);

  const rawCookieHeader = String(req.headers.cookie || '');
  const cookies = rawCookieHeader
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean);
  const cookie = cookies.find((item) => item.startsWith(`${name}=`));
  if (!cookie) return '';

  return decodeURIComponent(cookie.slice(name.length + 1));
};

const readSuitePayload = (req: Request) => {
  if (!SUITE_JWT_SECRET) return null;

  const token = getCookieValue(req, 'suite_auth_token').trim();
  if (!token) return null;

  try {
    return jwt.verify(token, SUITE_JWT_SECRET) as Record<string, any>;
  } catch (_error) {
    return null;
  }
};

const hasSuiteTrackingAccess = (payload: Record<string, any>) => {
  const allowedModules = normalizeModuleList(payload.allowed_modules);
  return allowedModules.includes('tracking');
};

const isLegacySuitePayload = (payload: Record<string, any>) => {
  const source = normalizeString(payload.auth_source).toLowerCase();
  const tenantGlobalId = normalizeString(payload.tenant_id).toLowerCase();
  return source.includes('legacy') || tenantGlobalId.startsWith('legacy-tenant-');
};

const buildHubLoginFromSuitePayload = (payload: Record<string, any>) => ({
  payload: (() => {
    const email = normalizeString(payload.email).toLowerCase();
    const rawRole = normalizeString(
      payload.role || payload.account_role || payload.nivel || payload.account_type,
    ).toLowerCase();
    const role =
      email === MASTER_ADMIN_EMAIL ||
      ['owner', 'admin', 'admin_master', 'super_admin', 'master'].includes(rawRole)
        ? 'owner'
        : 'member';

    return {
      tenant_id: normalizeString(payload.tenant_id),
      user_id: normalizeString(payload.user_id),
      email,
      name: normalizeString(payload.name || payload.full_name || payload.email),
      full_name: normalizeString(payload.name || payload.full_name || payload.email),
      company_name: normalizeString(payload.company_name) || 'Empresa Davantti',
      role,
    };
  })(),
});

const createTrackingSessionPayload = async (user: {
  id: string;
  email: string;
  name: string;
  role: string;
  companyId: string | null;
  userGlobalId: string | null;
  tenantGlobalId: string | null;
  phone: string | null;
  birthDate: Date | null;
  profileImageData: string | null;
  receivePlatformEmails: boolean | null;
  lastBirthdayCelebrationAt?: Date | null;
}) => {
  let shouldShowBirthdayCelebration = false;

  if (
    isBirthdayToday(user.birthDate) &&
    !hasCelebratedBirthdayToday(user.lastBirthdayCelebrationAt)
  ) {
    shouldShowBirthdayCelebration = true;
    await dbQuery(
      `UPDATE "User" SET "lastBirthdayCelebrationAt" = $1, "updatedAt" = $2 WHERE "id" = $3`,
      [new Date(), new Date(), user.id],
    );
  }

  const token = generateToken({
    id: user.id,
    email: user.email,
    companyId: user.companyId,
    role: user.role,
    module: 'avantracking',
    isSuperAdmin: isMasterAdminEmail(user.email),
    userGlobalId: user.userGlobalId || null,
    tenantGlobalId: user.tenantGlobalId || null,
  });

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    companyId: user.companyId,
    userGlobalId: user.userGlobalId || null,
    tenantGlobalId: user.tenantGlobalId || null,
    phone: user.phone || null,
    birthDate: formatBirthdayDate(user.birthDate),
    profileImageData: user.profileImageData || null,
    receivePlatformEmails: user.receivePlatformEmails !== false,
    module: 'avantracking',
    isSuperAdmin: isMasterAdminEmail(user.email),
    birthdayCelebration: {
      show: shouldShowBirthdayCelebration,
      message: shouldShowBirthdayCelebration
        ? buildBirthdayCelebrationMessage(user.name)
        : null,
    },
    token,
  };
};

const hashAccessToken = (token: string) =>
  crypto.createHash('sha256').update(token).digest('hex');

const formatExpiryLabel = (expiresAt: Date) => {
  const diffMs = expiresAt.getTime() - Date.now();
  const totalMinutes = Math.max(1, Math.round(diffMs / 60000));

  if (totalMinutes < 60) {
    return `${totalMinutes} minuto(s)`;
  }

  const totalHours = Math.round(totalMinutes / 60);
  if (totalHours < 24) {
    return `${totalHours} hora(s)`;
  }

  const totalDays = Math.round(totalHours / 24);
  return `${totalDays} dia(s)`;
};

const normalizePath = (value: string) => {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }

  const withLeadingSlash = normalized.startsWith('/')
    ? normalized
    : `/${normalized}`;

  return withLeadingSlash.replace(/\/+$/, '');
};

const getConfiguredBasePath = () =>
  process.env.APP_BASE_PATH || process.env.AVANTRACKING_BASE_PATH || '';

const applyBasePathToConfiguredUrl = (configuredUrl: string, basePath: string) => {
  const normalizedBasePath = normalizePath(basePath);
  const normalizedUrl = String(configuredUrl || '').trim().replace(/\/+$/, '');

  if (!normalizedBasePath || !normalizedUrl) {
    return normalizedUrl;
  }

  try {
    const parsedUrl = new URL(normalizedUrl);
    const currentPath = normalizePath(parsedUrl.pathname || '/');

    if (!currentPath || currentPath === '/') {
      parsedUrl.pathname = normalizedBasePath;
      return parsedUrl.toString().replace(/\/+$/, '');
    }

    return normalizedUrl;
  } catch {
    return normalizedUrl.endsWith(normalizedBasePath)
      ? normalizedUrl
      : `${normalizedUrl}${normalizedBasePath}`;
  }
};

const getMountedBasePath = (req: Request) => {
  const originalPath = String(req.originalUrl || '').split('?')[0];
  const currentPath = `${req.baseUrl || ''}${req.path || ''}`;

  if (!originalPath || !currentPath || !originalPath.endsWith(currentPath)) {
    return '';
  }

  return normalizePath(originalPath.slice(0, originalPath.length - currentPath.length));
};

const getAppBaseUrl = (req: Request) => {
  const configuredUrl = process.env.APP_BASE_URL?.trim();
  if (configuredUrl) {
    return applyBasePathToConfiguredUrl(
      configuredUrl,
      getConfiguredBasePath(),
    );
  }

  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocol =
    typeof forwardedProto === 'string' && forwardedProto.trim()
      ? forwardedProto.split(',')[0].trim()
      : req.protocol;

  const requestBasePath = getMountedBasePath(req);
  const envBasePath = normalizePath(getConfiguredBasePath());
  const basePath = requestBasePath || envBasePath;

  return `${protocol}://${req.get('host')}${basePath}`;
};

const buildAccessUrl = (
  req: Request,
  token: string,
  mode: 'invite' | 'reset',
) => {
  const baseUrl = getAppBaseUrl(req);
  const params = new URLSearchParams({
    mode,
    token,
  });

  return `${baseUrl}/?${params.toString()}`;
};

const requireAdmin = (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: 'Usuario nao autenticado' });
    return null;
  }

  if (req.user.role !== 'ADMIN') {
    res.status(403).json({ error: 'Apenas administradores podem realizar esta acao' });
    return null;
  }

  return req.user;
};

const getValidAccessTokenRecord = async (rawToken: string) => {
  const result = await dbQuery<{
    id: string;
    userId: string;
    type: AccessTokenType;
    expiresAt: Date;
    usedAt: Date | null;
    userName: string;
    userEmail: string;
  }>(
    `
      SELECT
        t."id" AS "id",
        t."userId" AS "userId",
        t."type" AS "type",
        t."expiresAt" AS "expiresAt",
        t."usedAt" AS "usedAt",
        u."name" AS "userName",
        u."email" AS "userEmail"
      FROM "UserAccessToken" t
      INNER JOIN "User" u ON u."id" = t."userId"
      WHERE t."tokenHash" = $1
      LIMIT 1
    `,
    [hashAccessToken(rawToken)],
  );
  const accessToken = result.rows[0] || null;

  if (!accessToken) {
    return null;
  }

  if (accessToken.usedAt) {
    return null;
  }

  if (accessToken.expiresAt.getTime() <= Date.now()) {
    return null;
  }

  return accessToken;
};

const createAccessToken = async (
  userId: string,
  type: AccessTokenType,
  ttlMs: number,
) => {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ttlMs);

  await dbQuery(
    `
      INSERT INTO "UserAccessToken" (
        "id",
        "userId",
        "type",
        "tokenHash",
        "expiresAt",
        "createdAt"
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [
      crypto.randomUUID(),
      userId,
      type,
      hashAccessToken(rawToken),
      expiresAt,
      new Date(),
    ],
  );

  return {
    rawToken,
    expiresAt,
  };
};

const issueAndSendAccessEmail = async (
  req: Request,
  user: { id: string; name: string; email: string },
  type: AccessTokenType,
) => {
  const ttlMs = type === 'INVITE' ? INVITE_TOKEN_TTL_MS : RESET_TOKEN_TTL_MS;
  const mode = type === 'INVITE' ? 'invite' : 'reset';

  await dbQuery(
    `
      DELETE FROM "UserAccessToken"
      WHERE "userId" = $1 AND "type" = $2 AND "usedAt" IS NULL
    `,
    [user.id, type],
  );

  const { rawToken, expiresAt } = await createAccessToken(user.id, type, ttlMs);
  const actionUrl = buildAccessUrl(req, rawToken, mode);

  await sendAccessEmail({
    toEmail: user.email,
    toName: user.name,
    accessType: type,
    actionUrl,
    expiresLabel: formatExpiryLabel(expiresAt),
  });
};

export const createSessionFromSuite = async (req: Request, res: Response) => {
  const suitePayload = readSuitePayload(req);
  if (!suitePayload) {
    return res.status(401).json({ error: 'Sessao global nao encontrada.' });
  }

  if (isLegacySuitePayload(suitePayload) && !hasSuiteTrackingAccess(suitePayload)) {
    return res.status(403).json({
      error: 'Usuario sem acesso ao modulo Avantracking no hub.',
      reason: 'tracking_not_allowed',
    });
  }

  const normalizedEmail = normalizeString(suitePayload.email).toLowerCase();
  if (!normalizedEmail) {
    return res.status(403).json({
      error: 'Sessao global sem e-mail de usuario.',
      reason: 'suite_identity_missing',
    });
  }

  try {
    let user = await provisionTrackingUserFromHubLogin(
      normalizedEmail,
      buildHubLoginFromSuitePayload(suitePayload),
    );

    if (!user) {
      const userResult = await dbQuery<{
        id: string;
        email: string;
        name: string;
        role: string;
        companyId: string | null;
        userGlobalId: string | null;
        tenantGlobalId: string | null;
        phone: string | null;
        birthDate: Date | null;
        profileImageData: string | null;
        receivePlatformEmails: boolean | null;
        lastBirthdayCelebrationAt: Date | null;
        password: string;
      }>(
        `
          SELECT
            u."id",
            u."email",
            u."name",
            u."role",
            u."companyId",
            u."userGlobalId",
            c."tenantGlobalId" AS "tenantGlobalId",
            u."phone",
            u."birthDate",
            u."profileImageData",
            u."receivePlatformEmails",
            u."lastBirthdayCelebrationAt",
            u."password"
          FROM "User" u
          LEFT JOIN "Company" c ON c."id" = u."companyId"
          WHERE lower(u."email") = lower($1)
          LIMIT 1
        `,
        [normalizedEmail],
      );
      user = userResult.rows[0] || null;
    }

    if (!user) {
      return res.status(401).json({
        error: 'Nao foi possivel criar sessao local do Avantracking.',
        reason: 'local_user_not_found',
      });
    }

    const trackingCompany = await loadCompanyIdentityForHub(user.companyId);
    const trackingHubAccess = await evaluateHubLoginAccess({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        isSuperAdmin: isMasterAdminEmail(user.email),
      },
      company: trackingCompany,
      moduleSlug: 'tracking',
    });

    if (!trackingHubAccess.allow) {
      return res.status(403).json({
        error:
          trackingHubAccess.message ||
          'Acesso bloqueado pela politica de assinatura da sua conta.',
        reason: trackingHubAccess.reason || 'hub_denied',
      });
    }

    return res.json(await createTrackingSessionPayload(user));
  } catch (error) {
    console.error('Error creating Avantracking session from suite:', error);
    return res.status(500).json({
      error: 'Falha ao criar sessao do Avantracking pelo hub.',
    });
  }
};

// Login legado, mantido apenas para compatibilidade de API.
export const login = async (req: Request, res: Response) => {
  const { email, password } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();

  if (!email || !password) {
    return res.status(400).json({ error: 'Missing email or password' });
  }

  try {
    if (normalizedEmail === 'admin@avantracking.com.br') {
      const defaultAdminCompanyId = await resolveCompanyIdByName('Drossi Interiores');
      const adminExistsResult = await dbQuery<{ id: string; companyId: string | null }>(
        `SELECT "id", "companyId" FROM "User" WHERE lower("email") = lower($1) LIMIT 1`,
        [normalizedEmail],
      );
      const adminExists = adminExistsResult.rows[0] || null;

      if (!adminExists) {
        const hashedAdminPassword = await bcrypt.hash('Alfenas@172839', 10);
        const now = new Date();
        await dbQuery(
          `
            INSERT INTO "User" (
              "id",
              "name",
              "email",
              "password",
              "role",
              "companyId",
              "userGlobalId",
              "receivePlatformEmails",
              "createdAt",
              "updatedAt"
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          `,
          [
            crypto.randomUUID(),
            'Admin',
            'admin@avantracking.com.br',
            hashedAdminPassword,
            'ADMIN',
            defaultAdminCompanyId,
            crypto.randomUUID(),
            true,
            now,
            now,
          ],
        );
      } else if (
        defaultAdminCompanyId &&
        String(adminExists.companyId || '') !== String(defaultAdminCompanyId)
      ) {
        await dbQuery(
          `UPDATE "User" SET "companyId" = $1, "updatedAt" = $2 WHERE "id" = $3`,
          [defaultAdminCompanyId, new Date(), adminExists.id],
        );
      }
    }

    const userResult = await dbQuery<{
      id: string;
      email: string;
      name: string;
      role: string;
      companyId: string | null;
      userGlobalId: string | null;
      tenantGlobalId: string | null;
      phone: string | null;
      birthDate: Date | null;
      profileImageData: string | null;
      receivePlatformEmails: boolean | null;
      lastBirthdayCelebrationAt: Date | null;
      password: string;
    }>(
      `
        SELECT
          u."id",
          u."email",
          u."name",
          u."role",
          u."companyId",
          u."userGlobalId",
          c."tenantGlobalId" AS "tenantGlobalId",
          u."phone",
          u."birthDate",
          u."profileImageData",
          u."receivePlatformEmails",
          u."lastBirthdayCelebrationAt",
          u."password"
        FROM "User" u
        LEFT JOIN "Company" c ON c."id" = u."companyId"
        WHERE u."email" = $1
        LIMIT 1
      `,
      [normalizedEmail],
    );
    let user = userResult.rows[0] || null;

    if (!user) {
      const hubLogin = await verifyHubGlobalLogin({
        email: normalizedEmail,
        password: String(password),
        moduleSlug: 'tracking',
      });
      if (hubLogin.allow) {
        user = await provisionTrackingUserFromHubLogin(normalizedEmail, hubLogin);
      }
      if (!user) {
        return res.status(401).json({
          error: 'Invalid credentials',
          reason: hubLogin.reason || 'user_not_found',
        });
      }
    }

    let hubLogin = null as Awaited<ReturnType<typeof verifyHubGlobalLogin>> | null;
    let isPasswordValid = await bcrypt.compare(String(password), user.password);
    if (!isPasswordValid) {
      hubLogin = await verifyHubGlobalLogin({
        email: normalizedEmail,
        password: String(password),
        moduleSlug: 'tracking',
      });
      if (hubLogin.allow) {
        const provisionedUser = await provisionTrackingUserFromHubLogin(
          normalizedEmail,
          hubLogin,
        );
        if (provisionedUser) {
          user = provisionedUser;
        }
        isPasswordValid = true;
      }
    }

    if (!isPasswordValid) {
      return res.status(401).json({
        error: 'Invalid credentials',
        reason: hubLogin?.reason || 'bad_password',
      });
    }

    const trackingCompany = await loadCompanyIdentityForHub(user.companyId);
    const trackingHubAccess = await evaluateHubLoginAccess({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        isSuperAdmin: isMasterAdminEmail(user.email),
      },
      company: trackingCompany,
      moduleSlug: 'tracking',
    });

    if (!trackingHubAccess.allow) {
      return res.status(403).json({
        error:
          trackingHubAccess.message ||
          'Acesso bloqueado pela politica de assinatura da sua conta.',
        reason: trackingHubAccess.reason || 'hub_denied',
      });
    }

    let shouldShowBirthdayCelebration = false;

    if (
      isBirthdayToday(user.birthDate) &&
      !hasCelebratedBirthdayToday(user.lastBirthdayCelebrationAt)
    ) {
      shouldShowBirthdayCelebration = true;
      await dbQuery(
        `UPDATE "User" SET "lastBirthdayCelebrationAt" = $1, "updatedAt" = $2 WHERE "id" = $3`,
        [new Date(), new Date(), user.id],
      );
    }

    const { password: _, ...userWithoutPassword } = user;
    const token = generateToken({
      id: user.id,
      email: user.email,
      companyId: user.companyId,
      role: user.role,
      module: 'avantracking',
      isSuperAdmin: isMasterAdminEmail(user.email),
      userGlobalId: user.userGlobalId || null,
      tenantGlobalId: user.tenantGlobalId || null,
    });

    res.json({
      ...userWithoutPassword,
      birthDate: formatBirthdayDate(user.birthDate),
      profileImageData: user.profileImageData || null,
      receivePlatformEmails: user.receivePlatformEmails !== false,
      module: 'avantracking',
      isSuperAdmin: isMasterAdminEmail(user.email),
      birthdayCelebration: shouldShowBirthdayCelebration
        ? {
            show: true,
            message: buildBirthdayCelebrationMessage(user.name),
          }
        : {
            show: false,
            message: null,
          },
      token,
    });
  } catch (error) {
    console.error('Error logging in:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Listar usuarios
export const getUsers = async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  try {
    const usersResult = await dbQuery<{
      id: string;
      name: string;
      email: string;
      role: string;
      companyId: string | null;
      companyName: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>(
      `
        SELECT
          u."id",
          u."name",
          u."email",
          u."role",
          u."companyId",
          c."name" AS "companyName",
          u."createdAt",
          u."updatedAt"
        FROM "User" u
        LEFT JOIN "Company" c ON c."id" = u."companyId"
        ORDER BY u."createdAt" DESC
      `,
    );
    const users = usersResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      companyId: row.companyId,
      company: {
        name: row.companyName,
      },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
};

export const getCurrentUserProfile = async (req: Request, res: Response) => {
  if (!req.user?.id) {
    return res.status(401).json({ error: 'Usuario nao autenticado' });
  }

  try {
    const currentUserResult = await dbQuery<{
      id: string;
      name: string;
      email: string;
      role: string;
      companyId: string | null;
      phone: string | null;
      birthDate: Date | null;
      profileImageData: string | null;
      receivePlatformEmails: boolean | null;
    }>(
      `
        SELECT
          "id",
          "name",
          "email",
          "role",
          "companyId",
          "phone",
          "birthDate",
          "profileImageData",
          "receivePlatformEmails"
        FROM "User"
        WHERE "id" = $1
        LIMIT 1
      `,
      [String(req.user.id)],
    );
    const currentUser = currentUserResult.rows[0] || null;

    if (!currentUser) {
      return res.status(404).json({ error: 'Usuario nao encontrado' });
    }

    return res.json({
      user: {
        ...currentUser,
        birthDate: formatBirthdayDate(currentUser.birthDate),
        profileImageData: currentUser.profileImageData || null,
        receivePlatformEmails: currentUser.receivePlatformEmails !== false,
      },
    });
  } catch (error) {
    console.error('Error fetching current user profile:', error);
    return res.status(500).json({ error: 'Falha ao carregar perfil do usuario' });
  }
};

export const updateCurrentUserProfile = async (req: Request, res: Response) => {
  if (!req.user?.id) {
    return res.status(401).json({ error: 'Usuario nao autenticado' });
  }

  const normalizedName = normalizeString(req.body?.name);
  const normalizedPhone = normalizeNullableString(req.body?.phone);
  const normalizedBirthDateInput = normalizeString(req.body?.birthDate);
  const profileImageDataInput = req.body?.profileImageData;
  const receivePlatformEmailsInput = req.body?.receivePlatformEmails;

  if (!normalizedName) {
    return res.status(400).json({ error: 'Nome e obrigatorio.' });
  }

  if (normalizedName.length < 2 || normalizedName.length > 120) {
    return res.status(400).json({ error: 'Nome invalido. Use entre 2 e 120 caracteres.' });
  }

  if (normalizedPhone && normalizedPhone.length > 30) {
    return res.status(400).json({ error: 'Telefone invalido. Limite de 30 caracteres.' });
  }

  let parsedBirthDate: Date | null = null;
  if (normalizedBirthDateInput) {
    parsedBirthDate = parseBirthdayInput(normalizedBirthDateInput);
    if (!parsedBirthDate) {
      return res.status(400).json({ error: 'Data de aniversario invalida. Use o formato YYYY-MM-DD.' });
    }
  }

  let parsedProfileImageData: string | null = null;
  try {
    if (profileImageDataInput === null) {
      parsedProfileImageData = null;
    } else if (profileImageDataInput !== undefined) {
      parsedProfileImageData = parseProfileImageData(profileImageDataInput);
    }
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : 'Imagem de perfil invalida.',
    });
  }

  if (
    receivePlatformEmailsInput !== undefined &&
    typeof receivePlatformEmailsInput !== 'boolean'
  ) {
    return res.status(400).json({
      error: 'A preferencia de e-mail deve ser true ou false.',
    });
  }

  try {
    const updateColumns: string[] = [
      `"name" = $1`,
      `"phone" = $2`,
      `"birthDate" = $3`,
    ];
    const updateValues: unknown[] = [normalizedName, normalizedPhone, parsedBirthDate];
    let nextIndex = 4;

    if (receivePlatformEmailsInput !== undefined) {
      updateColumns.push(`"receivePlatformEmails" = $${nextIndex}`);
      updateValues.push(receivePlatformEmailsInput);
      nextIndex += 1;
    }

    if (profileImageDataInput !== undefined) {
      updateColumns.push(`"profileImageData" = $${nextIndex}`);
      updateValues.push(parsedProfileImageData);
      nextIndex += 1;
    }

    updateColumns.push(`"updatedAt" = $${nextIndex}`);
    updateValues.push(new Date());
    nextIndex += 1;
    updateValues.push(String(req.user.id));

    const updatedUserResult = await dbQuery<{
      id: string;
      name: string;
      email: string;
      role: string;
      companyId: string | null;
      phone: string | null;
      birthDate: Date | null;
      profileImageData: string | null;
      receivePlatformEmails: boolean | null;
    }>(
      `
        UPDATE "User"
        SET ${updateColumns.join(', ')}
        WHERE "id" = $${nextIndex}
        RETURNING
          "id",
          "name",
          "email",
          "role",
          "companyId",
          "phone",
          "birthDate",
          "profileImageData",
          "receivePlatformEmails"
      `,
      updateValues,
    );
    const updatedUser = updatedUserResult.rows[0] || null;

    if (!updatedUser) {
      return res.status(404).json({ error: 'Usuario nao encontrado' });
    }

    return res.json({
      message: 'Perfil atualizado com sucesso.',
      user: {
        ...updatedUser,
        birthDate: formatBirthdayDate(updatedUser.birthDate),
        profileImageData: updatedUser.profileImageData || null,
        receivePlatformEmails: updatedUser.receivePlatformEmails !== false,
      },
    });
  } catch (error) {
    console.error('Error updating current user profile:', error);
    return res.status(500).json({ error: 'Falha ao atualizar perfil do usuario' });
  }
};

export const changeCurrentUserPassword = async (req: Request, res: Response) => {
  if (!req.user?.id) {
    return res.status(401).json({ error: 'Usuario nao autenticado' });
  }

  const currentPassword = normalizeString(req.body?.currentPassword);
  const newPassword = normalizeString(req.body?.newPassword);
  const confirmPassword = normalizeString(req.body?.confirmPassword);

  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({
      error: 'Informe senha atual, nova senha e confirmacao de senha.',
    });
  }

  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({
      error: `A nova senha deve ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`,
    });
  }

  if (newPassword !== confirmPassword) {
    return res.status(400).json({
      error: 'A confirmacao da nova senha nao confere.',
    });
  }

  try {
    const userResult = await dbQuery<{
      id: string;
      name: string;
      email: string;
      password: string;
    }>(
      `
        SELECT "id", "name", "email", "password"
        FROM "User"
        WHERE "id" = $1
        LIMIT 1
      `,
      [String(req.user.id)],
    );
    const user = userResult.rows[0] || null;

    if (!user) {
      return res.status(404).json({ error: 'Usuario nao encontrado' });
    }

    const isPasswordValid = await bcrypt.compare(currentPassword, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ error: 'Senha atual incorreta.' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await dbQuery(
      `UPDATE "User" SET "password" = $1, "updatedAt" = $2 WHERE "id" = $3`,
      [hashedPassword, new Date(), user.id],
    );

    let emailConfirmationSent = false;

    try {
      const now = new Date();
      const changedAt = now.toLocaleString('pt-BR', {
        timeZone: BIRTHDAY_TIMEZONE,
      });

      await sendBrevoEmail({
        to: [{ email: user.email, name: user.name }],
        subject: 'Confirmacao de alteracao de senha - Avantracking',
        htmlContent: `
          <div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.6;">
            <h2 style="margin:0 0 12px;">Senha alterada com sucesso</h2>
            <p style="margin:0 0 10px;">Ola, ${user.name}.</p>
            <p style="margin:0 0 10px;">Sua senha foi alterada em <strong>${changedAt}</strong>.</p>
            <p style="margin:0;">Se voce nao reconhece esta alteracao, entre em contato imediatamente com o suporte do Avantracking.</p>
          </div>
        `,
        textContent: [
          'Senha alterada com sucesso',
          `Ola, ${user.name}.`,
          `Sua senha foi alterada em ${changedAt}.`,
          'Se voce nao reconhece esta alteracao, entre em contato imediatamente com o suporte do Avantracking.',
        ].join('\n'),
      });

      emailConfirmationSent = true;
    } catch (emailError) {
      console.error('Error sending password change confirmation email:', emailError);
    }

    return res.json({
      message: emailConfirmationSent
        ? 'Senha alterada com sucesso. Enviamos a confirmacao para o seu e-mail.'
        : 'Senha alterada com sucesso. Nao foi possivel enviar o e-mail de confirmacao agora.',
      emailConfirmationSent,
    });
  } catch (error) {
    console.error('Error changing current user password:', error);
    return res.status(500).json({ error: 'Falha ao alterar senha do usuario' });
  }
};

// Criar usuario com convite
export const createUser = async (req: Request, res: Response) => {
  const adminUser = requireAdmin(req, res);
  if (!adminUser) return;

  const { name, email, role, companyId } = req.body;
  const effectiveCompanyId = companyId || adminUser.companyId;

  if (!name || !email) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const existingUserResult = await dbQuery<{ id: string }>(
      `SELECT "id" FROM "User" WHERE "email" = $1 LIMIT 1`,
      [String(email)],
    );
    const existingUser = existingUserResult.rows[0] || null;
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const temporaryPassword = crypto.randomBytes(24).toString('hex');
    const hashedPassword = await bcrypt.hash(temporaryPassword, 10);
    const now = new Date();
    const userId = crypto.randomUUID();
    const userRole = role ? String(role) : 'USER';
    const userGlobalId = crypto.randomUUID();
    const createdUserResult = await dbQuery<{
      id: string;
      name: string;
      email: string;
      role: string;
      companyId: string | null;
      userGlobalId: string | null;
      createdAt: Date;
    }>(
      `
        INSERT INTO "User" (
          "id",
          "name",
          "email",
          "password",
          "role",
          "companyId",
          "userGlobalId",
          "receivePlatformEmails",
          "createdAt",
          "updatedAt"
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING
          "id",
          "name",
          "email",
          "role",
          "companyId",
          "userGlobalId",
          "createdAt"
      `,
      [
        userId,
        String(name),
        String(email),
        hashedPassword,
        userRole,
        effectiveCompanyId || null,
        userGlobalId,
        true,
        now,
        now,
      ],
    );
    const user = createdUserResult.rows[0];

    try {
      await issueAndSendAccessEmail(req, user, 'INVITE');
    } catch (emailError) {
      await dbQuery(`DELETE FROM "UserAccessToken" WHERE "userId" = $1`, [user.id]);
      await dbQuery(`DELETE FROM "User" WHERE "id" = $1`, [user.id]);
      throw emailError;
    }

    const company = await loadCompanyIdentityForHub(user.companyId);
    const hubSync = await syncHubModuleIdentity(
      {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
        company,
        moduleSlug: 'tracking',
      },
      { explicit: true },
    );

    res.status(201).json({
      ...user,
      hub_sync: hubSync,
      message: 'Usuario criado e convite enviado por e-mail com sucesso.',
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
};

// Atualizar usuario (incluindo senha)
export const updateUser = async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const { id } = req.params;
  const { name, email, password, role, companyId } = req.body;

  try {
    const updateColumns: string[] = [];
    const updateValues: unknown[] = [];
    let idx = 1;

    if (name) {
      updateColumns.push(`"name" = $${idx}`);
      updateValues.push(String(name));
      idx += 1;
    }
    if (email) {
      updateColumns.push(`"email" = $${idx}`);
      updateValues.push(String(email));
      idx += 1;
    }
    if (role) {
      updateColumns.push(`"role" = $${idx}`);
      updateValues.push(String(role));
      idx += 1;
    }
    if (companyId !== undefined) {
      updateColumns.push(`"companyId" = $${idx}`);
      updateValues.push(companyId || null);
      idx += 1;
    }
    if (password) {
      if (String(password).length < MIN_PASSWORD_LENGTH) {
        return res
          .status(400)
          .json({ error: `Password must have at least ${MIN_PASSWORD_LENGTH} characters` });
      }
      updateColumns.push(`"password" = $${idx}`);
      updateValues.push(await bcrypt.hash(String(password), 10));
      idx += 1;
    }

    if (updateColumns.length === 0) {
      return res.status(400).json({ error: 'No fields provided to update' });
    }

    updateColumns.push(`"updatedAt" = $${idx}`);
    updateValues.push(new Date());
    idx += 1;
    updateValues.push(String(id));

    const userResult = await dbQuery<{
      id: string;
      name: string;
      email: string;
      role: string;
      companyId: string | null;
      userGlobalId: string | null;
    }>(
      `
        UPDATE "User"
        SET ${updateColumns.join(', ')}
        WHERE "id" = $${idx}
        RETURNING "id", "name", "email", "role", "companyId", "userGlobalId"
      `,
      updateValues,
    );
    const user = userResult.rows[0] || null;

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const company = await loadCompanyIdentityForHub(user.companyId);
    const hubSync = await syncHubModuleIdentity({
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      company,
      moduleSlug: 'tracking',
    });

    res.json({ ...user, hub_sync: hubSync });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
};

// Deletar usuario
export const deleteUser = async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const { id } = req.params;

  try {
    const targetResult = await dbQuery<{
      id: string;
      name: string;
      email: string;
      role: string;
      companyId: string | null;
    }>(
      `SELECT "id", "name", "email", "role", "companyId" FROM "User" WHERE "id" = $1 LIMIT 1`,
      [String(id)],
    );
    const target = targetResult.rows[0] || null;
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }
    const company = await loadCompanyIdentityForHub(target.companyId);
    const hubSync = await revokeHubModuleIdentity({
      user: { id: target.id, name: target.name, email: target.email, role: target.role },
      company,
      moduleSlug: 'tracking',
    });

    const deleteResult = await dbQuery<{ id: string }>(
      `
        DELETE FROM "User"
        WHERE "id" = $1
        RETURNING "id"
      `,
      [String(id)],
    );
    if (deleteResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ message: 'User deleted successfully', hub_sync: hubSync });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
};

// Solicitar redefinicao de senha
export const requestPasswordReset = async (req: Request, res: Response) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    const userResult = await dbQuery<{
      id: string;
      name: string;
      email: string;
    }>(
      `
        SELECT "id", "name", "email"
        FROM "User"
        WHERE "email" = $1
        LIMIT 1
      `,
      [String(email)],
    );
    const user = userResult.rows[0] || null;

    if (!user) {
      return res.json({
        message:
          'Se existir uma conta com este e-mail, enviaremos as instrucoes de redefinicao.',
      });
    }

    await issueAndSendAccessEmail(req, user, 'RESET_PASSWORD');

    res.json({
      message:
        'Se existir uma conta com este e-mail, enviaremos as instrucoes de redefinicao.',
    });
  } catch (error) {
    console.error('Error requesting password reset:', error);
    res.status(500).json({ error: 'Failed to request password reset' });
  }
};

// Validar link de convite/reset
export const getAccessLinkDetails = async (req: Request, res: Response) => {
  const { token } = req.params;

  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }

  try {
    const accessToken = await getValidAccessTokenRecord(String(token));

    if (!accessToken) {
      return res.status(400).json({ error: 'Link invalido ou expirado' });
    }

    res.json({
      type: accessToken.type,
      expiresAt: accessToken.expiresAt,
      user: {
        id: accessToken.userId,
        name: accessToken.userName,
        email: accessToken.userEmail,
      },
    });
  } catch (error) {
    console.error('Error validating access link:', error);
    res.status(500).json({ error: 'Failed to validate access link' });
  }
};

// Concluir cadastro/redefinicao de senha
export const completeAccessPassword = async (req: Request, res: Response) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({ error: 'Token and password are required' });
  }

  if (String(password).length < MIN_PASSWORD_LENGTH) {
    return res
      .status(400)
      .json({ error: `A senha deve ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.` });
  }

  try {
    const accessToken = await getValidAccessTokenRecord(String(token));

    if (!accessToken) {
      return res.status(400).json({ error: 'Link invalido ou expirado' });
    }

    const hashedPassword = await bcrypt.hash(String(password), 10);
    const now = new Date();

    await withDbTransaction(async (client) => {
      await client.query(
        `UPDATE "User" SET "password" = $1, "updatedAt" = $2 WHERE "id" = $3`,
        [hashedPassword, now, accessToken.userId],
      );
      await client.query(
        `UPDATE "UserAccessToken" SET "usedAt" = $1 WHERE "id" = $2`,
        [now, accessToken.id],
      );
      await client.query(
        `
          UPDATE "UserAccessToken"
          SET "usedAt" = $1
          WHERE "userId" = $2 AND "id" <> $3 AND "usedAt" IS NULL
        `,
        [now, accessToken.userId, accessToken.id],
      );
    });

    res.json({
      message: 'Senha definida com sucesso. Voce ja pode acessar a plataforma.',
    });
  } catch (error) {
    console.error('Error completing access password:', error);
    res.status(500).json({ error: 'Failed to complete password setup' });
  }
};

// Trocar empresa do usuario logado
export const switchUserCompany = async (req: Request, res: Response) => {
  const { userId, companyId } = req.body;
  const requester = req.user;

  if (!userId || !companyId) {
    return res.status(400).json({ error: 'userId e companyId sao obrigatorios' });
  }

  if (!requester) {
    return res.status(401).json({ error: 'Usuario nao autenticado' });
  }

  if (requester.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Apenas administradores podem trocar de empresa' });
  }

  if (String(requester.id) !== String(userId)) {
    return res.status(403).json({ error: 'Troca de empresa permitida apenas para a propria sessao' });
  }

  try {
    const companyResult = await dbQuery<{
      id: string;
      tenantGlobalId: string | null;
    }>(
      `
        SELECT "id", "tenantGlobalId"
        FROM "Company"
        WHERE "id" = $1
        LIMIT 1
      `,
      [String(companyId)],
    );
    const company = companyResult.rows[0] || null;

    if (!company) {
      return res.status(404).json({ error: 'Empresa nao encontrada' });
    }

    const userResult = await dbQuery<{
      id: string;
      email: string;
      name: string;
      role: string;
      companyId: string | null;
      userGlobalId: string | null;
    }>(
      `
        UPDATE "User"
        SET "companyId" = $1, "updatedAt" = $2
        WHERE "id" = $3
        RETURNING
          "id",
          "email",
          "name",
          "role",
          "companyId",
          "userGlobalId"
      `,
      [String(companyId), new Date(), String(userId)],
    );
    const user = userResult.rows[0] || null;

    if (!user) {
      return res.status(404).json({ error: 'Usuario nao encontrado' });
    }

    const token = generateToken({
      id: user.id,
      email: user.email,
      companyId: user.companyId,
      role: user.role,
      module: 'avantracking',
      isSuperAdmin: isMasterAdminEmail(user.email),
      userGlobalId: user.userGlobalId || null,
      tenantGlobalId: company.tenantGlobalId || null,
    });

    res.json({
      message: 'Empresa alterada com sucesso',
      user: {
        ...user,
        isSuperAdmin: isMasterAdminEmail(user.email),
      },
      token,
    });
  } catch (error) {
    console.error('Error switching user company:', error);
    res.status(500).json({ error: 'Erro ao trocar empresa' });
  }
};
