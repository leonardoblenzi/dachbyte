"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOrderImportStatusOptions = exports.cancelIntegrationSyncJob = exports.getIntegrationSyncStatus = exports.startIntegrationSyncJob = exports.getTraySyncStatus = exports.startTraySyncJob = exports.syncTrayOrders = void 0;
const traySyncJobService_1 = require("../services/traySyncJobService");
const traySyncService_1 = require("../services/traySyncService");
const trayAuthService_1 = require("../services/trayAuthService");
const syncReportService_1 = require("../services/syncReportService");
const demoCompanyService_1 = require("../services/demoCompanyService");
const db_1 = require("../lib/db");
const integrationOrderStatusService_1 = require("../services/integrationOrderStatusService");
const anymarketSyncJobService_1 = require("../services/anymarketSyncJobService");
const anymarketApiService_1 = require("../services/anymarketApiService");
const magazordApiService_1 = require("../services/magazordApiService");
const magazordSyncJobService_1 = require("../services/magazordSyncJobService");
const jetApiService_1 = require("../services/jetApiService");
const jetSyncJobService_1 = require("../services/jetSyncJobService");
const DEMO_TRAY_SYNC_DISABLED_MESSAGE = 'Sincronizacao da Integradora desabilitada para empresa demonstrativa.';
const getUserCompany = (req) => {
    if (!req.user) {
        return { error: 'Usuario nao autenticado', status: 401 };
    }
    if (!req.user.companyId) {
        return {
            error: 'Usuario nao vinculado a uma empresa.',
            status: 403,
        };
    }
    return { companyId: req.user.companyId, userId: req.user.id };
};
const isTrayIntegrationEnabled = async (companyId) => {
    const companyResult = await (0, db_1.dbQuery)(`
      SELECT c."trayIntegrationEnabled"
      FROM "Company" c
      WHERE c."id" = $1
      LIMIT 1
    `, [companyId]);
    const company = companyResult.rows[0] || null;
    return company?.trayIntegrationEnabled !== false;
};
const resolveLightweightIntegrationStatusContext = async (companyId) => {
    const companyResult = await (0, db_1.dbQuery)(`
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
    `, [companyId]);
    const company = companyResult.rows[0] || null;
    if (!company) {
        return {
            integration: null,
            integrationLabel: 'Integradora',
            enabled: false,
            authorized: false,
            message: 'Empresa nao encontrada.',
            job: null,
            schedule: traySyncJobService_1.traySyncJobService.getDisabledSchedule(),
        };
    }
    if (company.trayIntegrationEnabled) {
        const auth = await trayAuthService_1.trayAuthService.getCurrentAuth(companyId);
        return {
            integration: 'tray',
            integrationLabel: 'Tray',
            enabled: true,
            authorized: Boolean(auth),
            message: auth
                ? 'Integracao Tray online.'
                : 'Nenhuma integracao Tray autorizada para a empresa atual.',
            job: auth ? traySyncJobService_1.traySyncJobService.getJob(companyId) : null,
            schedule: auth
                ? traySyncJobService_1.traySyncJobService.getSchedule(companyId)
                : traySyncJobService_1.traySyncJobService.getDisabledSchedule(),
        };
    }
    if (company.magazordIntegrationEnabled) {
        const hasMagazordConfig = Boolean(String(company.magazordApiBaseUrl || '').trim() &&
            String(company.magazordApiUser || '').trim() &&
            String(company.magazordApiPassword || '').trim());
        return {
            integration: 'magazord',
            integrationLabel: 'Magazord',
            enabled: true,
            authorized: hasMagazordConfig,
            message: hasMagazordConfig
                ? 'Integracao Magazord configurada.'
                : 'Magazord sem configuracao completa de URL, usuario e senha.',
            job: hasMagazordConfig ? magazordSyncJobService_1.magazordSyncJobService.getJob(companyId) : null,
            schedule: magazordSyncJobService_1.magazordSyncJobService.getSchedule(),
        };
    }
    if (company.anymarketIntegrationEnabled) {
        const hasToken = Boolean(String(company.anymarketToken || '').trim());
        return {
            integration: 'anymarket',
            integrationLabel: 'ANYMARKET',
            enabled: true,
            authorized: hasToken,
            message: hasToken
                ? 'Integracao ANYMARKET configurada.'
                : 'ANYMARKET sem configuracao completa de gumgaToken.',
            job: hasToken ? anymarketSyncJobService_1.anymarketSyncJobService.getJob(companyId) : null,
            schedule: anymarketSyncJobService_1.anymarketSyncJobService.getSchedule(companyId),
        };
    }
    if (company.jetIntegrationEnabled) {
        const hasJetConfig = Boolean(String(company.jetIntegrationKey || '').trim());
        return {
            integration: 'jet',
            integrationLabel: 'JET',
            enabled: true,
            authorized: hasJetConfig,
            message: hasJetConfig
                ? 'Integracao JET configurada.'
                : 'JET sem configuracao completa de Credencial de Integracao JET (apiKey).',
            job: hasJetConfig ? jetSyncJobService_1.jetSyncJobService.getJob(companyId) : null,
            schedule: jetSyncJobService_1.jetSyncJobService.getSchedule(),
        };
    }
    if (company.blingIntegrationEnabled) {
        return {
            integration: 'bling',
            integrationLabel: 'Bling ERP',
            enabled: true,
            authorized: false,
            message: 'Integracao Bling ativa sem sync automatico neste endpoint.',
            job: null,
            schedule: traySyncJobService_1.traySyncJobService.getDisabledSchedule(),
        };
    }
    if (company.sysempIntegrationEnabled) {
        return {
            integration: 'sysemp',
            integrationLabel: 'SYSEMP',
            enabled: true,
            authorized: false,
            message: 'Integracao SYSEMP ativa sem sync automatico neste endpoint.',
            job: null,
            schedule: traySyncJobService_1.traySyncJobService.getDisabledSchedule(),
        };
    }
    return {
        integration: null,
        integrationLabel: 'Integradora',
        enabled: false,
        authorized: false,
        message: 'Nenhuma integradora ativa foi identificada para esta empresa.',
        job: null,
        schedule: traySyncJobService_1.traySyncJobService.getDisabledSchedule(),
    };
};
const resolveActiveIntegrationSyncContext = async (companyId) => {
    const activeIntegration = await integrationOrderStatusService_1.integrationOrderStatusService.getOrderImportStatuses(companyId);
    if (activeIntegration.integration === 'tray') {
        const enabled = await isTrayIntegrationEnabled(companyId);
        const auth = enabled ? await trayAuthService_1.trayAuthService.getCurrentAuth(companyId) : null;
        return {
            integration: 'tray',
            integrationLabel: activeIntegration.integrationLabel,
            enabled,
            authorized: Boolean(auth),
            message: auth
                ? 'Integracao Tray online.'
                : enabled
                    ? 'Nenhuma integracao Tray autorizada para a empresa atual.'
                    : 'A integracao Tray esta desativada para a empresa atual.',
            job: enabled && auth ? traySyncJobService_1.traySyncJobService.getJob(companyId) : null,
            schedule: enabled && auth
                ? traySyncJobService_1.traySyncJobService.getSchedule(companyId)
                : traySyncJobService_1.traySyncJobService.getDisabledSchedule(),
        };
    }
    if (activeIntegration.integration === 'anymarket') {
        const api = new anymarketApiService_1.AnymarketApiService(companyId);
        const status = await api.getConnectionStatus();
        return {
            integration: 'anymarket',
            integrationLabel: activeIntegration.integrationLabel,
            enabled: status.configured,
            authorized: status.authorized,
            message: status.message,
            job: status.configured ? anymarketSyncJobService_1.anymarketSyncJobService.getJob(companyId) : null,
            schedule: anymarketSyncJobService_1.anymarketSyncJobService.getSchedule(companyId),
        };
    }
    if (activeIntegration.integration === 'magazord') {
        const api = new magazordApiService_1.MagazordApiService(companyId);
        const status = await api.getConnectionStatus();
        return {
            integration: 'magazord',
            integrationLabel: activeIntegration.integrationLabel,
            enabled: status.configured,
            authorized: status.authorized,
            message: status.message,
            job: status.configured ? magazordSyncJobService_1.magazordSyncJobService.getJob(companyId) : null,
            schedule: magazordSyncJobService_1.magazordSyncJobService.getSchedule(),
        };
    }
    if (activeIntegration.integration === 'jet') {
        const api = new jetApiService_1.JetApiService(companyId);
        const status = await api.getConnectionStatus();
        return {
            integration: 'jet',
            integrationLabel: activeIntegration.integrationLabel,
            enabled: status.configured,
            authorized: status.authorized,
            message: status.message,
            job: status.configured ? jetSyncJobService_1.jetSyncJobService.getJob(companyId) : null,
            schedule: jetSyncJobService_1.jetSyncJobService.getSchedule(),
        };
    }
    return {
        integration: activeIntegration.integration,
        integrationLabel: activeIntegration.integrationLabel,
        enabled: false,
        authorized: false,
        message: 'Nenhuma integradora ativa foi identificada para esta empresa.',
        job: null,
        schedule: traySyncJobService_1.traySyncJobService.getDisabledSchedule(),
    };
};
const syncTrayOrders = async (req, res) => {
    console.log('Iniciando sincronizacao com Tray...');
    try {
        const context = getUserCompany(req);
        if ('error' in context) {
            return res.status(context.status).json({ error: context.error });
        }
        if (await (0, demoCompanyService_1.isDemoCompanyById)(context.companyId)) {
            return res.status(400).json({ error: DEMO_TRAY_SYNC_DISABLED_MESSAGE });
        }
        if (!(await isTrayIntegrationEnabled(context.companyId))) {
            return res.status(400).json({
                error: 'A integracao da Integradora esta desativada para a empresa atual.',
            });
        }
        const auth = await trayAuthService_1.trayAuthService.getCurrentAuth(context.companyId);
        if (!auth) {
            return res.status(400).json({
                error: 'Nenhuma integracao Tray autorizada para a empresa atual.',
            });
        }
        traySyncJobService_1.traySyncJobService.ensureSchedule(context.companyId, context.userId);
        const startedAt = new Date().toISOString();
        const result = await traySyncService_1.traySyncService.executeSync(context.companyId, req.body || {});
        const finishedAt = new Date().toISOString();
        let report = null;
        try {
            report = await syncReportService_1.syncReportService.sendTraySyncReport({
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
        }
        catch (reportError) {
            console.error('Falha ao enviar relatorio da sincronizacao direta da Tray:', reportError);
        }
        return res.json({
            ...result,
            report,
        });
    }
    catch (error) {
        console.error('Erro na sincronizacao com Tray:', error);
        return res.status(500).json({
            error: 'Erro ao sincronizar com Tray',
            details: error instanceof Error ? error.message : 'Erro desconhecido',
        });
    }
};
exports.syncTrayOrders = syncTrayOrders;
const startTraySyncJob = async (req, res) => {
    try {
        const context = getUserCompany(req);
        if ('error' in context) {
            return res.status(context.status).json({ error: context.error });
        }
        if (await (0, demoCompanyService_1.isDemoCompanyById)(context.companyId)) {
            return res.status(400).json({ error: DEMO_TRAY_SYNC_DISABLED_MESSAGE });
        }
        if (!(await isTrayIntegrationEnabled(context.companyId))) {
            return res.status(400).json({
                error: 'A integracao da Integradora esta desativada para a empresa atual.',
            });
        }
        const auth = await trayAuthService_1.trayAuthService.getCurrentAuth(context.companyId);
        if (!auth) {
            return res.status(400).json({
                error: 'Nenhuma integracao Tray autorizada para a empresa atual.',
            });
        }
        traySyncJobService_1.traySyncJobService.ensureSchedule(context.companyId, context.userId);
        const existing = traySyncJobService_1.traySyncJobService.getJob(context.companyId);
        if (existing?.status === 'running') {
            return res.json({
                success: true,
                message: 'A sincronizacao da Tray ja esta em andamento.',
                job: existing,
                schedule: traySyncJobService_1.traySyncJobService.getSchedule(context.companyId),
            });
        }
        const job = traySyncJobService_1.traySyncJobService.startJob(context.companyId, context.userId, req.body || {}, 'manual', {
            email: req.user?.email,
            name: req.user?.email,
        });
        return res.json({
            success: true,
            message: 'Sincronizacao da Tray iniciada em segundo plano.',
            job,
            schedule: traySyncJobService_1.traySyncJobService.getSchedule(context.companyId),
        });
    }
    catch (error) {
        console.error('Erro ao iniciar sincronizacao da Tray:', error);
        return res.status(500).json({
            error: 'Erro ao iniciar sincronizacao da Tray',
            details: error instanceof Error ? error.message : 'Erro desconhecido',
        });
    }
};
exports.startTraySyncJob = startTraySyncJob;
const getTraySyncStatus = async (req, res) => {
    try {
        const context = getUserCompany(req);
        if ('error' in context) {
            return res.status(context.status).json({ error: context.error });
        }
        if (await (0, demoCompanyService_1.isDemoCompanyById)(context.companyId)) {
            return res.json({
                success: true,
                job: null,
                schedule: traySyncJobService_1.traySyncJobService.getDisabledSchedule(),
            });
        }
        if (!(await isTrayIntegrationEnabled(context.companyId))) {
            return res.json({
                success: true,
                job: null,
                schedule: traySyncJobService_1.traySyncJobService.getDisabledSchedule(),
            });
        }
        const auth = await trayAuthService_1.trayAuthService.getCurrentAuth(context.companyId);
        if (!auth) {
            return res.json({
                success: true,
                job: null,
                schedule: traySyncJobService_1.traySyncJobService.getDisabledSchedule(),
            });
        }
        traySyncJobService_1.traySyncJobService.ensureSchedule(context.companyId, context.userId);
        return res.json({
            success: true,
            job: traySyncJobService_1.traySyncJobService.getJob(context.companyId),
            schedule: traySyncJobService_1.traySyncJobService.getSchedule(context.companyId),
        });
    }
    catch (error) {
        console.error('Erro ao consultar status da sincronizacao da Tray:', error);
        return res.status(500).json({
            error: 'Erro ao consultar status da sincronizacao da Tray',
        });
    }
};
exports.getTraySyncStatus = getTraySyncStatus;
const startIntegrationSyncJob = async (req, res) => {
    try {
        const context = getUserCompany(req);
        if ('error' in context) {
            return res.status(context.status).json({ error: context.error });
        }
        if (await (0, demoCompanyService_1.isDemoCompanyById)(context.companyId)) {
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
            traySyncJobService_1.traySyncJobService.ensureSchedule(context.companyId, context.userId);
            const existing = traySyncJobService_1.traySyncJobService.getJob(context.companyId);
            if (existing?.status === 'running') {
                return res.json({
                    success: true,
                    message: 'A sincronizacao da Integradora ja esta em andamento.',
                    integration: active.integration,
                    integrationLabel: active.integrationLabel,
                    job: existing,
                    schedule: traySyncJobService_1.traySyncJobService.getSchedule(context.companyId),
                });
            }
            const job = traySyncJobService_1.traySyncJobService.startJob(context.companyId, context.userId, req.body || {}, 'manual', {
                email: req.user?.email,
                name: req.user?.email,
            });
            return res.json({
                success: true,
                message: 'Sincronizacao da Integradora iniciada em segundo plano.',
                integration: active.integration,
                integrationLabel: active.integrationLabel,
                job,
                schedule: traySyncJobService_1.traySyncJobService.getSchedule(context.companyId),
            });
        }
        if (active.integration === 'anymarket') {
            if (!active.enabled || !active.authorized) {
                return res.status(400).json({
                    error: active.message,
                });
            }
            const existing = anymarketSyncJobService_1.anymarketSyncJobService.getJob(context.companyId);
            if (existing?.status === 'running') {
                return res.json({
                    success: true,
                    message: 'A sincronizacao da Integradora ja esta em andamento.',
                    integration: active.integration,
                    integrationLabel: active.integrationLabel,
                    job: existing,
                    schedule: anymarketSyncJobService_1.anymarketSyncJobService.getSchedule(context.companyId),
                });
            }
            const job = anymarketSyncJobService_1.anymarketSyncJobService.startJob(context.companyId, context.userId, req.body || {}, {
                email: req.user?.email,
                name: req.user?.email,
            });
            return res.json({
                success: true,
                message: 'Sincronizacao da Integradora iniciada em segundo plano.',
                integration: active.integration,
                integrationLabel: active.integrationLabel,
                job,
                schedule: anymarketSyncJobService_1.anymarketSyncJobService.getSchedule(context.companyId),
            });
        }
        if (active.integration === 'magazord') {
            if (!active.enabled || !active.authorized) {
                return res.status(400).json({
                    error: active.message,
                });
            }
            const existing = magazordSyncJobService_1.magazordSyncJobService.getJob(context.companyId);
            if (existing?.status === 'running') {
                return res.json({
                    success: true,
                    message: 'A sincronizacao da Integradora ja esta em andamento.',
                    integration: active.integration,
                    integrationLabel: active.integrationLabel,
                    job: existing,
                    schedule: magazordSyncJobService_1.magazordSyncJobService.getSchedule(),
                });
            }
            const job = magazordSyncJobService_1.magazordSyncJobService.startJob(context.companyId, context.userId, req.body || {}, {
                email: req.user?.email,
                name: req.user?.email,
            });
            return res.json({
                success: true,
                message: 'Sincronizacao da Integradora iniciada em segundo plano.',
                integration: active.integration,
                integrationLabel: active.integrationLabel,
                job,
                schedule: magazordSyncJobService_1.magazordSyncJobService.getSchedule(),
            });
        }
        if (active.integration === 'jet') {
            if (!active.enabled || !active.authorized) {
                return res.status(400).json({
                    error: active.message,
                });
            }
            const existing = jetSyncJobService_1.jetSyncJobService.getJob(context.companyId);
            if (existing?.status === 'running') {
                return res.json({
                    success: true,
                    message: 'A sincronizacao da Integradora ja esta em andamento.',
                    integration: active.integration,
                    integrationLabel: active.integrationLabel,
                    job: existing,
                    schedule: jetSyncJobService_1.jetSyncJobService.getSchedule(),
                });
            }
            const job = jetSyncJobService_1.jetSyncJobService.startJob(context.companyId, context.userId, req.body || {}, {
                email: req.user?.email,
                name: req.user?.email,
            });
            return res.json({
                success: true,
                message: 'Sincronizacao da Integradora iniciada em segundo plano.',
                integration: active.integration,
                integrationLabel: active.integrationLabel,
                job,
                schedule: jetSyncJobService_1.jetSyncJobService.getSchedule(),
            });
        }
        return res.status(400).json({
            error: 'Nenhuma integradora ativa com sync manual disponivel foi identificada para esta empresa.',
        });
    }
    catch (error) {
        console.error('Erro ao iniciar sync da integradora ativa:', error);
        return res.status(500).json({
            error: 'Erro ao iniciar sync da integradora ativa',
        });
    }
};
exports.startIntegrationSyncJob = startIntegrationSyncJob;
const getIntegrationSyncStatus = async (req, res) => {
    try {
        const context = getUserCompany(req);
        if ('error' in context) {
            return res.status(context.status).json({ error: context.error });
        }
        if (await (0, demoCompanyService_1.isDemoCompanyById)(context.companyId)) {
            return res.json({
                success: true,
                integration: null,
                integrationLabel: 'Integradora',
                authorized: false,
                status: 'offline',
                message: DEMO_TRAY_SYNC_DISABLED_MESSAGE,
                job: null,
                schedule: traySyncJobService_1.traySyncJobService.getDisabledSchedule(),
            });
        }
        const active = await resolveLightweightIntegrationStatusContext(context.companyId);
        if (active.integration === 'tray' && active.authorized) {
            traySyncJobService_1.traySyncJobService.ensureSchedule(context.companyId, context.userId);
        }
        if (active.integration === 'anymarket' && active.authorized) {
            anymarketSyncJobService_1.anymarketSyncJobService.ensureSchedule(context.companyId, context.userId);
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
    }
    catch (error) {
        console.error('Erro ao consultar status do sync da integradora ativa:', error);
        return res.status(500).json({
            error: 'Erro ao consultar status do sync da integradora ativa',
        });
    }
};
exports.getIntegrationSyncStatus = getIntegrationSyncStatus;
const cancelIntegrationSyncJob = async (req, res) => {
    try {
        const context = getUserCompany(req);
        if ('error' in context) {
            return res.status(context.status).json({ error: context.error });
        }
        const active = await resolveActiveIntegrationSyncContext(context.companyId);
        if (active.integration === 'tray') {
            const job = traySyncJobService_1.traySyncJobService.cancelJob(context.companyId);
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
            const job = anymarketSyncJobService_1.anymarketSyncJobService.cancelJob(context.companyId);
            return res.json({
                success: true,
                integration: active.integration,
                integrationLabel: active.integrationLabel,
                message: job
                    ? 'Solicitacao de cancelamento enviada para o sync da integradora.'
                    : 'Nenhum sync da integradora em andamento para cancelar.',
                job,
                schedule: anymarketSyncJobService_1.anymarketSyncJobService.getSchedule(context.companyId),
            });
        }
        if (active.integration === 'magazord') {
            const job = magazordSyncJobService_1.magazordSyncJobService.cancelJob(context.companyId);
            return res.json({
                success: true,
                integration: active.integration,
                integrationLabel: active.integrationLabel,
                message: job
                    ? 'Solicitacao de cancelamento enviada para o sync da integradora.'
                    : 'Nenhum sync da integradora em andamento para cancelar.',
                job,
                schedule: magazordSyncJobService_1.magazordSyncJobService.getSchedule(),
            });
        }
        if (active.integration === 'jet') {
            const job = jetSyncJobService_1.jetSyncJobService.cancelJob(context.companyId);
            return res.json({
                success: true,
                integration: active.integration,
                integrationLabel: active.integrationLabel,
                message: job
                    ? 'Solicitacao de cancelamento enviada para o sync da integradora.'
                    : 'Nenhum sync da integradora em andamento para cancelar.',
                job,
                schedule: jetSyncJobService_1.jetSyncJobService.getSchedule(),
            });
        }
        return res.status(400).json({
            error: 'Nenhuma integradora ativa foi identificada para esta empresa.',
        });
    }
    catch (error) {
        console.error('Erro ao cancelar sync da integradora ativa:', error);
        return res.status(500).json({
            error: 'Erro ao cancelar sync da integradora ativa',
        });
    }
};
exports.cancelIntegrationSyncJob = cancelIntegrationSyncJob;
const getOrderImportStatusOptions = async (req, res) => {
    try {
        const context = getUserCompany(req);
        if ('error' in context) {
            return res.status(context.status).json({ error: context.error });
        }
        const result = await integrationOrderStatusService_1.integrationOrderStatusService.getOrderImportStatuses(context.companyId);
        const companyResult = await (0, db_1.dbQuery)(`
        SELECT c."integrationManualStatuses"
        FROM "Company" c
        WHERE c."id" = $1
        LIMIT 1
      `, [context.companyId]);
        const company = companyResult.rows[0] || null;
        const normalizeForIntegration = (value) => {
            if (result.integration === 'anymarket') {
                return (0, integrationOrderStatusService_1.normalizeAnymarketStatusValue)(value);
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
                .map((status) => String(status || '').trim())
                .filter(Boolean)
            : [];
        const configuredManualStatusOptions = configuredManualStatuses.map((rawValue) => {
            const normalizedValue = normalizeForIntegration(rawValue);
            const matchingStatus = result.statuses.find((status) => normalizeForIntegration(String(status.value || '')) === normalizedValue ||
                normalizeForIntegration(String(status.label || '')) === normalizedValue);
            return matchingStatus || {
                value: normalizedValue,
                label: rawValue,
            };
        });
        const fallbackStatusOptions = configuredManualStatusOptions.length > 0
            ? configuredManualStatusOptions
            : result.statuses;
        return res.json({
            success: true,
            ...result,
            manualStatuses: fallbackStatusOptions,
            manualStatusesSource: configuredManualStatusOptions.length > 0
                ? 'configured'
                : 'integration_fallback',
        });
    }
    catch (error) {
        console.error('Erro ao consultar status da integradora ativa:', error);
        return res.status(500).json({
            error: 'Erro ao consultar os status da integradora ativa.',
        });
    }
};
exports.getOrderImportStatusOptions = getOrderImportStatusOptions;
