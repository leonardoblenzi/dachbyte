import { Request, Response } from 'express';
import { trayAuthService } from '../services/trayAuthService';
import { dbQuery } from '../lib/db';

const isTrayIntegrationEnabled = async (companyId?: string | null) => {
  if (!companyId) return false;

  const companyResult = await dbQuery<any>(
    `
      SELECT c."trayIntegrationEnabled"
      FROM "Company" c
      WHERE c."id" = $1
      LIMIT 1
    `,
    [companyId],
  );
  const company = companyResult.rows[0] || null;

  return company?.trayIntegrationEnabled !== false;
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

const getRequestOrigin = (req: Request) => {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocol =
    typeof forwardedProto === 'string' && forwardedProto.trim()
      ? forwardedProto.split(',')[0].trim()
      : req.protocol;

  return `${protocol}://${req.get('host')}`;
};

const getMountedBasePath = (req: Request) => {
  const originalPath = String(req.originalUrl || '').split('?')[0];
  const currentPath = `${req.baseUrl || ''}${req.path || ''}`;

  if (!originalPath || !currentPath || !originalPath.endsWith(currentPath)) {
    return '';
  }

  return normalizePath(originalPath.slice(0, originalPath.length - currentPath.length));
};

const getRequestBasePath = (req: Request) => {
  const mountedBasePath = getMountedBasePath(req);
  if (mountedBasePath) {
    return mountedBasePath;
  }

  return normalizePath(getConfiguredBasePath());
};

const getAppBaseUrl = (req: Request) => {
  const configuredBaseUrl = String(
    process.env.APP_BASE_URL || process.env.FRONTEND_URL || '',
  ).trim();

  if (configuredBaseUrl) {
    return applyBasePathToConfiguredUrl(
      configuredBaseUrl,
      getConfiguredBasePath(),
    );
  }

  return `${getRequestOrigin(req)}${getRequestBasePath(req)}`;
};

const getTrayCallbackUrl = (req: Request) => {
  return `${getAppBaseUrl(req)}/tray/callback/auth`;
};

const getIntegrationReturnUrl = (req: Request, status: 'connected' | 'error') => {
  const params = new URLSearchParams({
    view: 'admin',
    tab: 'integration',
    tray: status,
  });

  return `${getAppBaseUrl(req)}/?${params.toString()}`;
};

export const startTrayAuthorization = async (req: Request, res: Response) => {
  const { url } = req.query;

  if (!req.user) {
    return res.status(401).json({ error: 'Usuario nao autenticado' });
  }

  if (!req.user.companyId) {
    return res.status(403).json({
      error: 'Usuario nao vinculado a uma empresa.',
    });
  }

  if (!(await isTrayIntegrationEnabled(req.user.companyId))) {
    return res.status(400).json({
      error: 'A integracao da Integradora esta desativada para esta empresa.',
    });
  }

  if (!url) {
    return res.status(400).json({ error: 'A URL da loja Tray e obrigatoria' });
  }

  try {
    const companyToken = trayAuthService.signCompanyContext(
      req.user.companyId,
      req.user.id,
    );
    const authUrl = trayAuthService.getAuthorizationUrl(String(url), {
      companyToken,
      callbackUrl: getTrayCallbackUrl(req),
      fallbackOrigin: getRequestOrigin(req),
    });
    return res.json({ authUrl });
  } catch (error) {
    return res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : 'Erro ao iniciar autorizacao da Tray',
    });
  }
};

/**
 * GET /api/tray/callback
 * Landing page opcional de instalacao
 */
export const showInstallPage = (req: Request, res: Response) => {
  const { url, adm_user, store, company_token } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'A URL da loja Tray e obrigatoria' });
  }

  const normalizedStoreUrl = trayAuthService.normalizeStoreUrl(String(url));
  const authUrl = trayAuthService.getAuthorizationUrl(normalizedStoreUrl, {
    companyToken:
      typeof company_token === 'string' && company_token.trim()
        ? company_token.trim()
        : undefined,
    callbackUrl: getTrayCallbackUrl(req),
    fallbackOrigin: getRequestOrigin(req),
  });

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Instalar Integracao Tray</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          display: flex;
          justify-content: center;
          align-items: center;
          height: 100vh;
          margin: 0;
        }
        .container {
          background: white;
          border-radius: 16px;
          padding: 40px;
          max-width: 520px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          text-align: center;
        }
        h1 {
          color: #333;
          margin-bottom: 20px;
        }
        p {
          color: #666;
          line-height: 1.6;
        }
        button {
          background: #667eea;
          color: white;
          border: none;
          padding: 15px 40px;
          border-radius: 8px;
          font-size: 16px;
          font-weight: bold;
          cursor: pointer;
          margin-top: 20px;
          transition: all 0.3s;
        }
        button:hover {
          background: #5568d3;
          transform: translateY(-2px);
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Integracao de Pedidos Tray</h1>
        <p>Conecte sua loja Tray com o sistema para sincronizar pedidos.</p>
        <p><strong>Loja:</strong> ${normalizedStoreUrl}</p>
        ${store ? `<p><strong>Store:</strong> ${store}</p>` : ''}
        ${adm_user ? `<p><strong>Usuario:</strong> ${adm_user}</p>` : ''}
        <button onclick="authorize()">Autorizar agora</button>
      </div>
      <script>
        function authorize() {
          window.location.href = ${JSON.stringify(authUrl)};
        }
      </script>
    </body>
    </html>
  `;

  res.send(html);
};

/**
 * GET /api/tray/callback/auth
 * Receber codigo de autorizacao e gerar token
 */
export const handleAuthCallback = async (req: Request, res: Response) => {
  try {
    const { code, api_address, store, store_host, adm_user, company_token } = req.query;

    const companyToken =
      typeof company_token === 'string' && company_token.trim()
        ? company_token.trim()
        : '';
    const context = trayAuthService.verifyCompanyContext(companyToken);

    if (!code || !api_address || !store || !context?.companyId) {
      return res.redirect(getIntegrationReturnUrl(req, 'error'));
    }

    const authData = await trayAuthService.generateAccessToken(
      String(code),
      String(api_address),
    );

    const expirationDate =
      (authData as any).date_expiration_access_token || authData.date_expiration;
    const refreshTokenExpirationDate = (authData as any).date_expiration_refresh_token;

    const resolvedStoreId = String((authData as any).store_id || store);
    const resolvedApiAddress = String((authData as any).api_host || api_address);

    await trayAuthService.saveAuth(context.companyId, {
      storeId: resolvedStoreId,
      apiAddress: resolvedApiAddress,
      accessToken: authData.access_token,
      refreshToken: authData.refresh_token,
      expiresAt: trayAuthService.parseExpirationDate(expirationDate),
      refreshTokenExpiresAt: refreshTokenExpirationDate
        ? trayAuthService.parseExpirationDate(refreshTokenExpirationDate)
        : null,
      code: String(code),
      storeName: String(store_host || store),
    });

    const redirectUrl = getIntegrationReturnUrl(req, 'connected');
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Conectando ao app</title>
        <meta charset="utf-8" />
        <style>
          body {
            margin: 0;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #0f172a;
            color: #e2e8f0;
            font-family: Arial, sans-serif;
          }
          .card {
            width: min(420px, calc(100vw - 32px));
            background: #111827;
            border: 1px solid rgba(148, 163, 184, 0.2);
            border-radius: 18px;
            padding: 32px;
            text-align: center;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.35);
          }
          h1 {
            margin: 0 0 12px;
            font-size: 22px;
          }
          p {
            margin: 0;
            color: #94a3b8;
            line-height: 1.5;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Integracao Tray conectada</h1>
          <p>Redirecionando para a area de Integracao do app...</p>
          <p style="margin-top:12px;font-size:13px;color:#cbd5e1;">
            Loja ${String(store)}${adm_user ? ` • Usuario ${String(adm_user)}` : ''}
          </p>
        </div>
        <script>
          const target = ${JSON.stringify(redirectUrl)};
          if (window.opener && !window.opener.closed) {
            window.opener.location.href = target;
            window.close();
          } else {
            window.location.href = target;
          }
        </script>
      </body>
      </html>
    `;

    return res.send(html);
  } catch (error) {
    console.error('Erro no callback da Tray:', error);
    return res.redirect(getIntegrationReturnUrl(req, 'error'));
  }
};

/**
 * GET /api/tray/status
 * Verificar status da autenticacao atual
 */
export const checkAuthStatus = async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Usuario nao autenticado' });
    }

    if (!req.user.companyId) {
      return res.status(403).json({
        error: 'Usuario nao vinculado a uma empresa.',
      });
    }

    const storeId =
      typeof req.query.storeId === 'string' && req.query.storeId.trim()
        ? req.query.storeId.trim()
        : undefined;

    if (!(await isTrayIntegrationEnabled(req.user.companyId))) {
      return res.json({
        authorized: false,
        status: 'offline',
        storeId: null,
        storeName: null,
        updatedAt: null,
        integrationEnabled: false,
        message: 'Integracao da Integradora desativada para esta empresa.',
      });
    }

    const auth = await trayAuthService.getCurrentAuth(req.user.companyId, storeId);

    if (!auth) {
      return res.json({
        authorized: false,
        status: 'offline',
        storeId: null,
        storeName: null,
        updatedAt: null,
        integrationEnabled: true,
        message: 'Nenhuma integracao Tray autorizada.',
      });
    }

    let isAuthorized = false;

    try {
      isAuthorized = Boolean(await trayAuthService.getValidAuth(req.user.companyId));
    } catch (error) {
      console.error('Erro ao validar token atual da Tray:', error);
      isAuthorized = false;
    }

    return res.json({
      authorized: isAuthorized,
      status: isAuthorized ? 'online' : 'offline',
      storeId: auth.storeId,
      storeName: auth.storeName || null,
      updatedAt: auth.updatedAt,
      integrationEnabled: true,
      message: isAuthorized
        ? 'Integracao Tray online.'
        : 'Integracao Tray offline ou com token expirado.',
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Erro desconhecido',
    });
  }
};
