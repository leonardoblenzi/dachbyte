import { Request, Response } from 'express';
import { dbQuery } from '../lib/db';
import { isDemoCompanyById } from '../services/demoCompanyService';
import { AnymarketApiService } from '../services/anymarketApiService';
import { anymarketRateLimiter } from '../services/anymarketRateLimiter';
import { anymarketSyncService } from '../services/anymarketSyncService';

const DEMO_ANYMARKET_SYNC_DISABLED_MESSAGE =
  'Sincronizacao da Integradora desabilitada para empresa demonstrativa.';

const getUserCompany = (req: Request) => {
  if (!req.user) {
    return { error: 'Usuario nao autenticado', status: 401 as const };
  }

  if (!req.user.companyId) {
    return {
      error: 'Usuario nao vinculado a uma empresa.',
      status: 403 as const,
    };
  }

  return { companyId: req.user.companyId, userId: req.user.id };
};

const isAnymarketIntegrationEnabled = async (companyId: string) => {
  const companyResult = await dbQuery<any>(
    `
      SELECT c."anymarketIntegrationEnabled"
      FROM "Company" c
      WHERE c."id" = $1
      LIMIT 1
    `,
    [companyId],
  );
  const company = companyResult.rows[0] || null;

  return company?.anymarketIntegrationEnabled !== false;
};

export const checkAnymarketStatus = async (req: Request, res: Response) => {
  try {
    const context = getUserCompany(req);
    if ('error' in context) {
      return res.status(context.status).json({ error: context.error });
    }

    if (!(await isAnymarketIntegrationEnabled(context.companyId))) {
      return res.json({
        authorized: false,
        configured: false,
        status: 'offline',
        integrationEnabled: false,
        message: 'Integracao ANYMARKET desativada para esta empresa.',
      });
    }

    const api = new AnymarketApiService(context.companyId);
    const status = await api.getConnectionStatus();

    return res.json({
      authorized: status.authorized,
      configured: status.configured,
      status: status.authorized ? 'online' : 'offline',
      integrationEnabled: true,
      apiBaseUrl: status.apiBaseUrl,
      platform: status.platform,
      message: status.message,
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Erro desconhecido',
    });
  }
};

export const syncAnymarketOrders = async (req: Request, res: Response) => {
  try {
    const context = getUserCompany(req);
    if ('error' in context) {
      return res.status(context.status).json({ error: context.error });
    }

    if (await isDemoCompanyById(context.companyId)) {
      return res.status(400).json({ error: DEMO_ANYMARKET_SYNC_DISABLED_MESSAGE });
    }

    if (!(await isAnymarketIntegrationEnabled(context.companyId))) {
      return res.status(400).json({
        error: 'A integracao ANYMARKET esta desativada para a empresa atual.',
      });
    }

    const api = new AnymarketApiService(context.companyId);
    const connectionStatus = await api.getConnectionStatus();
    if (!connectionStatus.configured || !connectionStatus.authorized) {
      return res.status(400).json({
        error: connectionStatus.message,
      });
    }

    const result = await anymarketSyncService.executeSync(
      context.companyId,
      req.body || {},
    );

    return res.json(result);
  } catch (error) {
    console.error('Erro na sincronizacao com ANYMARKET:', error);
    return res.status(500).json({
      error: 'Erro ao sincronizar com ANYMARKET',
      details: error instanceof Error ? error.message : 'Erro desconhecido',
    });
  }
};

export const getAnymarketRateLimitStats = async (req: Request, res: Response) => {
  const stats = anymarketRateLimiter.getStats();

  return res.json({
    success: true,
    rateLimiter: {
      ...stats,
      status:
        stats.knownRemaining <= 2
          ? 'CRITICAL'
          : stats.knownRemaining <= 10
            ? 'WARNING'
            : 'OK',
    },
  });
};
