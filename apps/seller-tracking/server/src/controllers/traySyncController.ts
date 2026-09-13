import { Request, Response } from 'express';
import { traySyncJobService } from '../services/traySyncJobService';
import { traySyncService } from '../services/traySyncService';
import { trayAuthService } from '../services/trayAuthService';
import { syncReportService } from '../services/syncReportService';
import { isDemoCompanyById } from '../services/demoCompanyService';
import { dbQuery } from '../lib/db';
import {
  integrationOrderStatusService,
  normalizeAnymarketStatusValue,
} from '../services/integrationOrderStatusService';
import { anymarketSyncJobService } from '../services/anymarketSyncJobService';
import { AnymarketApiService } from '../services/anymarketApiService';
import { MagazordApiService } from '../services/magazordApiService';
import { magazordSyncJobService } from '../services/magazordSyncJobService';
import { JetApiService } from '../services/jetApiService';
import { jetSyncJobService } from '../services/jetSyncJobService';

const DEMO_TRAY_SYNC_DISABLED_MESSAGE =
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

const isTrayIntegrationEnabled = async (companyId: string) => {
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

const resolveLightweightIntegrationStatusContext = async (companyId: string) => {
  const companyResult = await dbQuery<any>(
    `
      SELECT
        c."trayIntegrationEnabled",
        c."anymarketIntegrationEnabled",
        c."anymarketToken",
        c."magazordIntegrationEnabled",
        c."magazordApiBaseUrl",
        c."magazordApiUser",
        c."magazordApiPassword",
        c."jetIntegrationEnabled",
        c."jetIntegrationKey",
        c."jetStoreId",
        c."jetUsername",
        c."jetPassword",
        c."jetBearerToken",
        c."blingIntegrationEnabled",
        c."sysempIntegrationEnabled"
      FROM "Company" c
      WHERE c."id" = $1
      LIMIT 1
    `,
    [companyId],
  );
  const company = companyResult.rows[0] || null;

  if (!company) {
    return {
      integration: null,
      integrationLabel: 'Integradora',
      enabled: false,
      authorized: false,
      message: 'Empresa nao encontrada.',
      job: null,
      schedule: traySyncJobService.getDisabledSchedule(),
    };
  }

  if (company.trayIntegrationEnabled) {
    const auth = await trayAuthService.getCurrentAuth(companyId);
    return {
      integration: 'tray' as const,
      integrationLabel: 'Tray',
      enabled: true,
      authorized: Boolean(auth),
      message: auth
        ? 'Integracao Tray online.'
        : 'Nenhuma integracao Tray autorizada para a empresa atual.',
      job: auth ? traySyncJobService.getJob(companyId) : null,
      schedule: auth
        ? traySyncJobService.getSchedule(companyId)
        : traySyncJobService.getDisabledSchedule(),
    };
  }

  if (company.magazordIntegrationEnabled) {
    const hasMagazordConfig = Boolean(
      String(company.magazordApiBaseUrl || '').trim() &&
        String(company.magazordApiUser || '').trim() &&
        String(company.magazordApiPassword || '').trim(),
    );

    return {
      integration: 'magazord' as const,
      integrationLabel: 'Magazord',
      enabled: true,
      authorized: hasMagazordConfig,
      message: hasMagazordConfig
        ? 'Integracao Magazord configurada.'
        : 'Magazord sem configuracao completa de URL, usuario e senha.',
      job: hasMagazordConfig ? magazordSyncJobService.getJob(companyId) : null,
      schedule: magazordSyncJobService.getSchedule(),
    };
  }

  if (company.anymarketIntegrationEnabled) {
    const hasToken = Boolean(String(company.anymarketToken || '').trim());
    return {
      integration: 'anymarket' as const,
      integrationLabel: 'ANYMARKET',
      enabled: true,
      authorized: hasToken,
      message: hasToken
        ? 'Integracao ANYMARKET configurada.'
        : 'ANYMARKET sem configuracao completa de gumgaToken.',
      job: hasToken ? anymarketSyncJobService.getJob(companyId) : null,
      schedule: anymarketSyncJobService.getSchedule(companyId),
    };
  }

  if (company.jetIntegrationEnabled) {
    const hasJetConfig = Boolean(
      String(company.jetIntegrationKey || '').trim(),
    );

    return {
      integration: 'jet' as const,
      integrationLabel: 'JET',
      enabled: true,
      authorized: hasJetConfig,
      message: hasJetConfig
        ? 'Integracao JET configurada.'
        : 'JET sem configuracao completa de Credencial de Integracao JET (apiKey).',
      job: hasJetConfig ? jetSyncJobService.getJob(companyId) : null,
      schedule: jetSyncJobService.getSchedule(),
    };
  }

  if (company.blingIntegrationEnabled) {
    return {
      integration: 'bling' as const,
      integrationLabel: 'Bling ERP',
      enabled: true,
      authorized: false,
      message: 'Integracao Bling ativa sem sync automatico neste endpoint.',
      job: null,
      schedule: traySyncJobService.getDisabledSchedule(),
    };
  }

  if (company.sysempIntegrationEnabled) {
    return {
      integration: 'sysemp' as const,
      integrationLabel: 'SYSEMP',
      enabled: true,
      authorized: false,
      message: 'Integracao SYSEMP ativa sem sync automatico neste endpoint.',
      job: null,
      schedule: traySyncJobService.getDisabledSchedule(),
    };
  }

  return {
    integration: null,
    integrationLabel: 'Integradora',
    enabled: false,
    authorized: false,
    message: 'Nenhuma integradora ativa foi identificada para esta empresa.',
    job: null,
    schedule: traySyncJobService.getDisabledSchedule(),
  };
};

const resolveActiveIntegrationSyncContext = async (companyId: string) => {
  const activeIntegration =
    await integrationOrderStatusService.getOrderImportStatuses(companyId);

  if (activeIntegration.integration === 'tray') {
    const enabled = await isTrayIntegrationEnabled(companyId);
    const auth = enabled ? await trayAuthService.getCurrentAuth(companyId) : null;

    return {
      integration: 'tray' as const,
      integrationLabel: activeIntegration.integrationLabel,
      enabled,
      authorized: Boolean(auth),
      message: auth
        ? 'Integracao Tray online.'
        : enabled
          ? 'Nenhuma integracao Tray autorizada para a empresa atual.'
          : 'A integracao Tray esta desativada para a empresa atual.',
      job: enabled && auth ? traySyncJobService.getJob(companyId) : null,
      schedule:
        enabled && auth
          ? traySyncJobService.getSchedule(companyId)
          : traySyncJobService.getDisabledSchedule(),
    };
  }

  if (activeIntegration.integration === 'anymarket') {
    const api = new AnymarketApiService(companyId);
    const status = await api.getConnectionStatus();

    return {
      integration: 'anymarket' as const,
      integrationLabel: activeIntegration.integrationLabel,
      enabled: status.configured,
      authorized: status.authorized,
      message: status.message,
      job: status.configured ? anymarketSyncJobService.getJob(companyId) : null,
      schedule: anymarketSyncJobService.getSchedule(companyId),
    };
  }

  if (activeIntegration.integration === 'magazord') {
    const api = new MagazordApiService(companyId);
    const status = await api.getConnectionStatus();

    return {
      integration: 'magazord' as const,
      integrationLabel: activeIntegration.integrationLabel,
      enabled: status.configured,
      authorized: status.authorized,
      message: status.message,
      job: status.configured ? magazordSyncJobService.getJob(companyId) : null,
      schedule: magazordSyncJobService.getSchedule(),
    };
  }

  if (activeIntegration.integration === 'jet') {
    const api = new JetApiService(companyId);
    const status = await api.getConnectionStatus();

    return {
      integration: 'jet' as const,
      integrationLabel: activeIntegration.integrationLabel,
      enabled: status.configured,
      authorized: status.authorized,
      message: status.message,
      job: status.configured ? jetSyncJobService.getJob(companyId) : null,
      schedule: jetSyncJobService.getSchedule(),
    };
  }

  return {
    integration: activeIntegration.integration,
    integrationLabel: activeIntegration.integrationLabel,
    enabled: false,
    authorized: false,
    message: 'Nenhuma integradora ativa foi identificada para esta empresa.',
    job: null,
    schedule: traySyncJobService.getDisabledSchedule(),
  };
};

export const syncTrayOrders = async (req: Request, res: Response) => {
  console.log('Iniciando sincronizacao com Tray...');

  try {
    const context = getUserCompany(req);
    if ('error' in context) {
      return res.status(context.status).json({ error: context.error });
    }

    if (await isDemoCompanyById(context.companyId)) {
      return res.status(400).json({ error: DEMO_TRAY_SYNC_DISABLED_MESSAGE });
    }

    if (!(await isTrayIntegrationEnabled(context.companyId))) {
      return res.status(400).json({
        error: 'A integracao da Integradora esta desativada para a empresa atual.',
      });
    }

    const auth = await trayAuthService.getCurrentAuth(context.companyId);
    if (!auth) {
      return res.status(400).json({
        error: 'Nenhuma integracao Tray autorizada para a empresa atual.',
      });
    }

    traySyncJobService.ensureSchedule(context.companyId, context.userId);
    const startedAt = new Date().toISOString();
    const result = await traySyncService.executeSync(context.companyId, req.body || {});
    const finishedAt = new Date().toISOString();

    let report: any = null;
    try {
      report = await syncReportService.sendTraySyncReport({
        companyId: context.companyId,
        userId: context.userId,
        userEmail: req.user?.email,
        userName: req.user?.email,
        trigger: 'manual',
        payload: {
        companyId: context.companyId,
        storeId: result.storeId,
        modified: result.modified,
        statuses: result.statuses,
        ...result.results,
      },
        startedAt,
        finishedAt,
      });
    } catch (reportError) {
      console.error('Falha ao enviar relatorio da sincronizacao direta da Tray:', reportError);
    }

    return res.json({
      ...result,
      report,
    });
  } catch (error) {
    console.error('Erro na sincronizacao com Tray:', error);
    return res.status(500).json({
      error: 'Erro ao sincronizar com Tray',
      details: error instanceof Error ? error.message : 'Erro desconhecido',
    });
  }
};

export const startTraySyncJob = async (req: Request, res: Response) => {
  try {
    const context = getUserCompany(req);
    if ('error' in context) {
      return res.status(context.status).json({ error: context.error });
    }

    if (await isDemoCompanyById(context.companyId)) {
      return res.status(400).json({ error: DEMO_TRAY_SYNC_DISABLED_MESSAGE });
    }

    if (!(await isTrayIntegrationEnabled(context.companyId))) {
      return res.status(400).json({
        error: 'A integracao da Integradora esta desativada para a empresa atual.',
      });
    }

    const auth = await trayAuthService.getCurrentAuth(context.companyId);
    if (!auth) {
      return res.status(400).json({
        error: 'Nenhuma integracao Tray autorizada para a empresa atual.',
      });
    }

    traySyncJobService.ensureSchedule(context.companyId, context.userId);
    const existing = traySyncJobService.getJob(context.companyId);
    if (existing?.status === 'running') {
      return res.json({
        success: true,
        message: 'A sincronizacao da Tray ja esta em andamento.',
        job: existing,
        schedule: traySyncJobService.getSchedule(context.companyId),
      });
    }

    const job = traySyncJobService.startJob(
      context.companyId,
      context.userId,
      req.body || {},
      'manual',
      {
        email: req.user?.email,
        name: req.user?.email,
      },
    );

    return res.json({
      success: true,
      message: 'Sincronizacao da Tray iniciada em segundo plano.',
      job,
      schedule: traySyncJobService.getSchedule(context.companyId),
    });
  } catch (error) {
    console.error('Erro ao iniciar sincronizacao da Tray:', error);
    return res.status(500).json({
      error: 'Erro ao iniciar sincronizacao da Tray',
      details: error instanceof Error ? error.message : 'Erro desconhecido',
    });
  }
};

export const getTraySyncStatus = async (req: Request, res: Response) => {
  try {
    const context = getUserCompany(req);
    if ('error' in context) {
      return res.status(context.status).json({ error: context.error });
    }

    if (await isDemoCompanyById(context.companyId)) {
      return res.json({
        success: true,
        job: null,
        schedule: traySyncJobService.getDisabledSchedule(),
      });
    }

    if (!(await isTrayIntegrationEnabled(context.companyId))) {
      return res.json({
        success: true,
        job: null,
        schedule: traySyncJobService.getDisabledSchedule(),
      });
    }

    const auth = await trayAuthService.getCurrentAuth(context.companyId);
    if (!auth) {
      return res.json({
        success: true,
        job: null,
        schedule: traySyncJobService.getDisabledSchedule(),
      });
    }

    traySyncJobService.ensureSchedule(context.companyId, context.userId);
    return res.json({
      success: true,
      job: traySyncJobService.getJob(context.companyId),
      schedule: traySyncJobService.getSchedule(context.companyId),
    });
  } catch (error) {
    console.error('Erro ao consultar status da sincronizacao da Tray:', error);
    return res.status(500).json({
      error: 'Erro ao consultar status da sincronizacao da Tray',
    });
  }
};

export const startIntegrationSyncJob = async (req: Request, res: Response) => {
  try {
    const context = getUserCompany(req);
    if ('error' in context) {
      return res.status(context.status).json({ error: context.error });
    }

    if (await isDemoCompanyById(context.companyId)) {
      return res.status(400).json({ error: DEMO_TRAY_SYNC_DISABLED_MESSAGE });
    }

    const active = await resolveActiveIntegrationSyncContext(context.companyId);

    if (active.integration === 'tray') {
      if (!active.enabled) {
        return res.status(400).json({
          error: 'A integracao da Integradora esta desativada para a empresa atual.',
        });
      }

      if (!active.authorized) {
        return res.status(400).json({
          error: active.message,
        });
      }

      traySyncJobService.ensureSchedule(context.companyId, context.userId);
      const existing = traySyncJobService.getJob(context.companyId);
      if (existing?.status === 'running') {
        return res.json({
          success: true,
          message: 'A sincronizacao da Integradora ja esta em andamento.',
          integration: active.integration,
          integrationLabel: active.integrationLabel,
          job: existing,
          schedule: traySyncJobService.getSchedule(context.companyId),
        });
      }

      const job = traySyncJobService.startJob(
        context.companyId,
        context.userId,
        req.body || {},
        'manual',
        {
          email: req.user?.email,
          name: req.user?.email,
        },
      );

      return res.json({
        success: true,
        message: 'Sincronizacao da Integradora iniciada em segundo plano.',
        integration: active.integration,
        integrationLabel: active.integrationLabel,
        job,
        schedule: traySyncJobService.getSchedule(context.companyId),
      });
    }

    if (active.integration === 'anymarket') {
      if (!active.enabled || !active.authorized) {
        return res.status(400).json({
          error: active.message,
        });
      }

      const existing = anymarketSyncJobService.getJob(context.companyId);
      if (existing?.status === 'running') {
        return res.json({
          success: true,
          message: 'A sincronizacao da Integradora ja esta em andamento.',
          integration: active.integration,
          integrationLabel: active.integrationLabel,
          job: existing,
          schedule: anymarketSyncJobService.getSchedule(context.companyId),
        });
      }

      const job = anymarketSyncJobService.startJob(
        context.companyId,
        context.userId,
        req.body || {},
        {
          email: req.user?.email,
          name: req.user?.email,
        },
      );

      return res.json({
        success: true,
        message: 'Sincronizacao da Integradora iniciada em segundo plano.',
        integration: active.integration,
        integrationLabel: active.integrationLabel,
        job,
        schedule: anymarketSyncJobService.getSchedule(context.companyId),
      });
    }

    if (active.integration === 'magazord') {
      if (!active.enabled || !active.authorized) {
        return res.status(400).json({
          error: active.message,
        });
      }

      const existing = magazordSyncJobService.getJob(context.companyId);
      if (existing?.status === 'running') {
        return res.json({
          success: true,
          message: 'A sincronizacao da Integradora ja esta em andamento.',
          integration: active.integration,
          integrationLabel: active.integrationLabel,
          job: existing,
          schedule: magazordSyncJobService.getSchedule(),
        });
      }

      const job = magazordSyncJobService.startJob(
        context.companyId,
        context.userId,
        req.body || {},
        {
          email: req.user?.email,
          name: req.user?.email,
        },
      );

      return res.json({
        success: true,
        message: 'Sincronizacao da Integradora iniciada em segundo plano.',
        integration: active.integration,
        integrationLabel: active.integrationLabel,
        job,
        schedule: magazordSyncJobService.getSchedule(),
      });
    }

    if (active.integration === 'jet') {
      if (!active.enabled || !active.authorized) {
        return res.status(400).json({
          error: active.message,
        });
      }

      const existing = jetSyncJobService.getJob(context.companyId);
      if (existing?.status === 'running') {
        return res.json({
          success: true,
          message: 'A sincronizacao da Integradora ja esta em andamento.',
          integration: active.integration,
          integrationLabel: active.integrationLabel,
          job: existing,
          schedule: jetSyncJobService.getSchedule(),
        });
      }

      const job = jetSyncJobService.startJob(
        context.companyId,
        context.userId,
        req.body || {},
        {
          email: req.user?.email,
          name: req.user?.email,
        },
      );

      return res.json({
        success: true,
        message: 'Sincronizacao da Integradora iniciada em segundo plano.',
        integration: active.integration,
        integrationLabel: active.integrationLabel,
        job,
        schedule: jetSyncJobService.getSchedule(),
      });
    }

    return res.status(400).json({
      error: 'Nenhuma integradora ativa com sync manual disponivel foi identificada para esta empresa.',
    });
  } catch (error) {
    console.error('Erro ao iniciar sync da integradora ativa:', error);
    return res.status(500).json({
      error: 'Erro ao iniciar sync da integradora ativa',
    });
  }
};

export const getIntegrationSyncStatus = async (req: Request, res: Response) => {
  try {
    const context = getUserCompany(req);
    if ('error' in context) {
      return res.status(context.status).json({ error: context.error });
    }

    if (await isDemoCompanyById(context.companyId)) {
      return res.json({
        success: true,
        integration: null,
        integrationLabel: 'Integradora',
        authorized: false,
        status: 'offline',
        message: DEMO_TRAY_SYNC_DISABLED_MESSAGE,
        job: null,
        schedule: traySyncJobService.getDisabledSchedule(),
      });
    }

    const active = await resolveLightweightIntegrationStatusContext(
      context.companyId,
    );

    if (active.integration === 'tray' && active.authorized) {
      traySyncJobService.ensureSchedule(context.companyId, context.userId);
    }

    if (active.integration === 'anymarket' && active.authorized) {
      anymarketSyncJobService.ensureSchedule(context.companyId, context.userId);
    }

    return res.json({
      success: true,
      integration: active.integration,
      integrationLabel: active.integrationLabel,
      authorized: active.authorized,
      status: active.authorized ? 'online' : 'offline',
      message: active.message,
      job: active.job,
      schedule: active.schedule,
    });
  } catch (error) {
    console.error('Erro ao consultar status do sync da integradora ativa:', error);
    return res.status(500).json({
      error: 'Erro ao consultar status do sync da integradora ativa',
    });
  }
};

export const cancelIntegrationSyncJob = async (req: Request, res: Response) => {
  try {
    const context = getUserCompany(req);
    if ('error' in context) {
      return res.status(context.status).json({ error: context.error });
    }

    const active = await resolveActiveIntegrationSyncContext(context.companyId);

    if (active.integration === 'tray') {
      const job = traySyncJobService.cancelJob(context.companyId);
      return res.json({
        success: true,
        integration: active.integration,
        integrationLabel: active.integrationLabel,
        message: job
          ? 'Solicitacao de cancelamento enviada para o sync da integradora.'
          : 'Nenhum sync da integradora em andamento para cancelar.',
        job,
        schedule: active.schedule,
      });
    }

    if (active.integration === 'anymarket') {
      const job = anymarketSyncJobService.cancelJob(context.companyId);
      return res.json({
        success: true,
        integration: active.integration,
        integrationLabel: active.integrationLabel,
        message: job
          ? 'Solicitacao de cancelamento enviada para o sync da integradora.'
          : 'Nenhum sync da integradora em andamento para cancelar.',
        job,
        schedule: anymarketSyncJobService.getSchedule(context.companyId),
      });
    }

    if (active.integration === 'magazord') {
      const job = magazordSyncJobService.cancelJob(context.companyId);
      return res.json({
        success: true,
        integration: active.integration,
        integrationLabel: active.integrationLabel,
        message: job
          ? 'Solicitacao de cancelamento enviada para o sync da integradora.'
          : 'Nenhum sync da integradora em andamento para cancelar.',
        job,
        schedule: magazordSyncJobService.getSchedule(),
      });
    }

    if (active.integration === 'jet') {
      const job = jetSyncJobService.cancelJob(context.companyId);
      return res.json({
        success: true,
        integration: active.integration,
        integrationLabel: active.integrationLabel,
        message: job
          ? 'Solicitacao de cancelamento enviada para o sync da integradora.'
          : 'Nenhum sync da integradora em andamento para cancelar.',
        job,
        schedule: jetSyncJobService.getSchedule(),
      });
    }

    return res.status(400).json({
      error: 'Nenhuma integradora ativa foi identificada para esta empresa.',
    });
  } catch (error) {
    console.error('Erro ao cancelar sync da integradora ativa:', error);
    return res.status(500).json({
      error: 'Erro ao cancelar sync da integradora ativa',
    });
  }
};

export const getOrderImportStatusOptions = async (req: Request, res: Response) => {
  try {
    const context = getUserCompany(req);
    if ('error' in context) {
      return res.status(context.status).json({ error: context.error });
    }

    const result = await integrationOrderStatusService.getOrderImportStatuses(
      context.companyId,
    );
    const companyResult = await dbQuery<any>(
      `
        SELECT c."integrationManualStatuses"
        FROM "Company" c
        WHERE c."id" = $1
        LIMIT 1
      `,
      [context.companyId],
    );
    const company = companyResult.rows[0] || null;

    const normalizeForIntegration = (value: string) => {
      if (result.integration === 'anymarket') {
        return normalizeAnymarketStatusValue(value);
      }

      if (result.integration === 'tray') {
        return String(value || '').trim().toLowerCase();
      }

      if (result.integration === 'jet') {
        return String(value || '').trim();
      }

      return String(value || '').trim();
    };

    const configuredManualStatuses = Array.isArray(company?.integrationManualStatuses)
      ? company.integrationManualStatuses
          .map((status: string) => String(status || '').trim())
          .filter(Boolean)
      : [];
    const configuredManualStatusOptions = configuredManualStatuses.map((rawValue: string) => {
      const normalizedValue = normalizeForIntegration(rawValue);
      const matchingStatus = result.statuses.find((status) =>
        normalizeForIntegration(String(status.value || '')) === normalizedValue ||
        normalizeForIntegration(String(status.label || '')) === normalizedValue,
      );

      return matchingStatus || {
        value: normalizedValue,
        label: rawValue,
      };
    });
    const fallbackStatusOptions =
      configuredManualStatusOptions.length > 0
        ? configuredManualStatusOptions
        : result.statuses;

    return res.json({
      success: true,
      ...result,
      manualStatuses: fallbackStatusOptions,
      manualStatusesSource:
        configuredManualStatusOptions.length > 0
          ? 'configured'
          : 'integration_fallback',
    });
  } catch (error) {
    console.error('Erro ao consultar status da integradora ativa:', error);
    return res.status(500).json({
      error: 'Erro ao consultar os status da integradora ativa.',
    });
  }
};


