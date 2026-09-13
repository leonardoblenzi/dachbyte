"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCompanyUsageSummary = exports.updateCurrentCompanyIntegration = exports.getCurrentCompany = exports.deleteCompany = exports.createCompany = exports.getCompanies = void 0;
const crypto_1 = __importDefault(require("crypto"));
const db_1 = require("../lib/db");
const normalizeSswRequireCnpjs = (value) => {
    if (!Array.isArray(value))
        return [];
    const normalized = value
        .map((item) => String(item || '').replace(/\D/g, '').trim())
        .filter(Boolean);
    return Array.from(new Set(normalized));
};
const normalizeIntegrationCarrierExceptions = (value) => {
    if (!Array.isArray(value))
        return [];
    return Array.from(new Set(value
        .map((item) => String(item || '').trim())
        .filter(Boolean)));
};
const normalizeIntegrationManualStatuses = (value) => {
    if (!Array.isArray(value))
        return [];
    return Array.from(new Set(value
        .map((item) => String(item || '').trim())
        .filter(Boolean)));
};
const normalizeIntegrationAutoSyncStatuses = (value) => {
    if (!Array.isArray(value))
        return [];
    return Array.from(new Set(value
        .map((item) => String(item || '').trim())
        .filter(Boolean)));
};
const normalizeBooleanSetting = (value) => {
    if (value === undefined)
        return undefined;
    return Boolean(value);
};
const ERP_INTEGRATION_FIELDS = [
    'trayIntegrationEnabled',
    'anymarketIntegrationEnabled',
    'blingIntegrationEnabled',
    'magazordIntegrationEnabled',
    'sysempIntegrationEnabled',
    'jetIntegrationEnabled',
];
const buildErpIntegrationUpdate = (values) => {
    const providedEntries = ERP_INTEGRATION_FIELDS.filter((field) => values[field] !== undefined);
    if (providedEntries.length === 0) {
        return {};
    }
    return providedEntries.reduce((accumulator, field) => {
        accumulator[field] = Boolean(values[field]);
        return accumulator;
    }, {});
};
const resolveActiveErpFields = (values) => ERP_INTEGRATION_FIELDS.filter((field) => values[field] === true);
const normalizeOptionalString = (value) => {
    if (value === undefined || value === null)
        return undefined;
    const normalized = String(value).trim();
    return normalized || null;
};
const normalizeShippingCutoffTime = (value) => {
    if (value === undefined)
        return undefined;
    if (value === null)
        return null;
    const normalized = String(value).trim();
    if (!normalized) {
        return null;
    }
    const match = normalized.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (!match) {
        return '__INVALID__';
    }
    return `${match[1]}:${match[2]}`;
};
const normalizeIdentityDocumentNumber = (value) => {
    if (value === undefined || value === null)
        return null;
    const normalized = String(value).replace(/\D/g, "").trim();
    return normalized || null;
};
const normalizeIdentityDocumentType = (value, documentNumber) => {
    const normalized = String(value || "").trim().toUpperCase();
    if (normalized === "CPF" || normalized === "CNPJ")
        return normalized;
    if (documentNumber?.length === 11)
        return "CPF";
    if (documentNumber?.length === 14)
        return "CNPJ";
    return null;
};
const parseDateOrNull = (value) => {
    const parsed = new Date(String(value || ''));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const parseDatabaseHost = (databaseUrl) => {
    const normalized = String(databaseUrl || '').trim();
    if (!normalized)
        return null;
    try {
        const parsed = new URL(normalized);
        return parsed.host || null;
    }
    catch {
        return 'URL invalida';
    }
};
const requireAdminUser = (req, res) => {
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
const sanitizeCompanyResponse = (company) => {
    const { magazordApiPassword, anymarketToken, intelipostApiKey, jetIntegrationKey, jetUsername, jetPassword, jetBearerToken, ...safeCompany } = company || {};
    return {
        ...safeCompany,
        intelipostApiKeyConfigured: Boolean(intelipostApiKey),
        magazordApiPasswordConfigured: Boolean(magazordApiPassword),
        anymarketTokenConfigured: Boolean(anymarketToken),
        jetIntegrationKeyConfigured: Boolean(jetIntegrationKey),
        jetUsernameConfigured: Boolean(jetUsername),
        jetPasswordConfigured: Boolean(jetPassword),
        jetBearerTokenConfigured: Boolean(jetBearerToken),
    };
};
const mapCompanyRowToResponse = (row) => sanitizeCompanyResponse({
    id: row.id,
    name: row.name,
    cnpj: row.cnpj,
    tenantGlobalId: row.tenantGlobalId,
    documentType: row.documentType,
    documentNumber: row.documentNumber,
    trayIntegrationEnabled: row.trayIntegrationEnabled,
    anymarketIntegrationEnabled: row.anymarketIntegrationEnabled,
    blingIntegrationEnabled: row.blingIntegrationEnabled,
    magazordIntegrationEnabled: row.magazordIntegrationEnabled,
    sysempIntegrationEnabled: row.sysempIntegrationEnabled,
    jetIntegrationEnabled: row.jetIntegrationEnabled,
    intelipostIntegrationEnabled: row.intelipostIntegrationEnabled,
    sswRequireEnabled: row.sswRequireEnabled,
    correiosIntegrationEnabled: row.correiosIntegrationEnabled,
    intelipostClientId: row.intelipostClientId,
    intelipostApiKey: row.intelipostApiKey,
    magazordApiBaseUrl: row.magazordApiBaseUrl,
    magazordApiUser: row.magazordApiUser,
    jetOrderLookupUrlTemplate: row.jetOrderLookupUrlTemplate,
    jetIntegrationKey: row.jetIntegrationKey,
    jetStoreId: row.jetStoreId,
    jetUsername: row.jetUsername,
    jetPassword: row.jetPassword,
    jetBearerToken: row.jetBearerToken,
    sswRequireCnpjs: Array.isArray(row.sswRequireCnpjs) ? row.sswRequireCnpjs : [],
    integrationCarrierExceptions: Array.isArray(row.integrationCarrierExceptions)
        ? row.integrationCarrierExceptions
        : [],
    integrationManualStatuses: Array.isArray(row.integrationManualStatuses)
        ? row.integrationManualStatuses
        : [],
    integrationAutoSyncStatuses: Array.isArray(row.integrationAutoSyncStatuses)
        ? row.integrationAutoSyncStatuses
        : [],
    shippingCutoffTime: row.shippingCutoffTime,
    createdAt: row.createdAt,
    _count: {
        users: Number(row.usersCount || 0),
        orders: Number(row.ordersCount || 0),
    },
    magazordApiPassword: row.magazordApiPassword,
    anymarketToken: row.anymarketToken,
});
// Listar todas as empresas
const getCompanies = async (req, res) => {
    try {
        const companiesResult = await (0, db_1.dbQuery)(`
        SELECT
          c."id",
          c."name",
          c."cnpj",
          c."tenantGlobalId",
          c."documentType",
          c."documentNumber",
          c."trayIntegrationEnabled",
          c."anymarketIntegrationEnabled",
          c."blingIntegrationEnabled",
          c."magazordIntegrationEnabled",
          c."sysempIntegrationEnabled",
          c."jetIntegrationEnabled",
          c."intelipostIntegrationEnabled",
          c."sswRequireEnabled",
          c."correiosIntegrationEnabled",
          c."intelipostClientId",
          c."intelipostApiKey",
          c."magazordApiBaseUrl",
          c."magazordApiUser",
          c."magazordApiPassword",
          c."anymarketToken",
          c."jetOrderLookupUrlTemplate",
          c."jetIntegrationKey",
          c."jetStoreId",
          c."jetUsername",
          c."jetPassword",
          c."jetBearerToken",
          c."sswRequireCnpjs",
          c."integrationCarrierExceptions",
          c."integrationManualStatuses",
          c."integrationAutoSyncStatuses",
          c."shippingCutoffTime",
          c."createdAt",
          (
            SELECT COUNT(*)::int
            FROM "User" u
            WHERE u."companyId" = c."id"
          ) AS "usersCount",
          (
            SELECT COUNT(*)::int
            FROM "Order" o
            WHERE o."companyId" = c."id"
          ) AS "ordersCount"
        FROM "Company" c
        ORDER BY c."name" ASC
      `);
        return res.json(companiesResult.rows.map(mapCompanyRowToResponse));
    }
    catch (error) {
        console.error('Error fetching companies:', error);
        res.status(500).json({ error: 'Failed to fetch companies' });
    }
};
exports.getCompanies = getCompanies;
// Criar empresa
const createCompany = async (req, res) => {
    const { name, cnpj, tenantGlobalId, documentType, documentNumber, intelipostClientId, intelipostApiKey, sswRequireCnpjs, } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Name is required' });
    }
    try {
        const normalizedDocumentNumber = normalizeIdentityDocumentNumber(documentNumber ?? cnpj);
        const normalizedDocumentType = normalizeIdentityDocumentType(documentType, normalizedDocumentNumber);
        const normalizedTenantGlobalId = normalizeOptionalString(tenantGlobalId) || crypto_1.default.randomUUID();
        const normalizedCnpj = normalizeOptionalString(cnpj) ??
            (normalizedDocumentType === "CNPJ" ? normalizedDocumentNumber : null);
        const trayIntegrationEnabled = normalizeBooleanSetting(req.body?.trayIntegrationEnabled);
        const blingIntegrationEnabled = normalizeBooleanSetting(req.body?.blingIntegrationEnabled);
        const anymarketIntegrationEnabled = normalizeBooleanSetting(req.body?.anymarketIntegrationEnabled);
        const magazordIntegrationEnabled = normalizeBooleanSetting(req.body?.magazordIntegrationEnabled);
        const sysempIntegrationEnabled = normalizeBooleanSetting(req.body?.sysempIntegrationEnabled);
        const jetIntegrationEnabled = normalizeBooleanSetting(req.body?.jetIntegrationEnabled);
        const jetOrderLookupUrlTemplate = normalizeOptionalString(req.body?.jetOrderLookupUrlTemplate);
        const jetIntegrationKeyRaw = req.body?.jetIntegrationKey;
        const jetIntegrationKey = jetIntegrationKeyRaw === undefined
            ? undefined
            : normalizeOptionalString(jetIntegrationKeyRaw);
        const jetStoreId = normalizeOptionalString(req.body?.jetStoreId);
        const jetUsernameRaw = req.body?.jetUsername;
        const jetUsername = jetUsernameRaw === undefined ? undefined : normalizeOptionalString(jetUsernameRaw);
        const jetPasswordRaw = req.body?.jetPassword;
        const jetPassword = jetPasswordRaw === undefined ? undefined : normalizeOptionalString(jetPasswordRaw);
        const jetBearerTokenRaw = req.body?.jetBearerToken;
        const jetBearerToken = jetBearerTokenRaw === undefined
            ? undefined
            : normalizeOptionalString(jetBearerTokenRaw);
        const erpIntegrationData = buildErpIntegrationUpdate({
            trayIntegrationEnabled: trayIntegrationEnabled === undefined ? true : trayIntegrationEnabled,
            anymarketIntegrationEnabled,
            blingIntegrationEnabled,
            magazordIntegrationEnabled,
            sysempIntegrationEnabled,
            jetIntegrationEnabled,
        });
        const activeErpsOnCreate = resolveActiveErpFields({
            trayIntegrationEnabled: trayIntegrationEnabled === undefined ? true : trayIntegrationEnabled,
            anymarketIntegrationEnabled,
            blingIntegrationEnabled,
            magazordIntegrationEnabled,
            sysempIntegrationEnabled,
            jetIntegrationEnabled,
        });
        const anymarketToken = normalizeOptionalString(req.body?.anymarketToken);
        const effectiveJetApiKey = normalizeOptionalString(req.body?.jetIntegrationKey);
        if (activeErpsOnCreate.length > 1) {
            return res.status(400).json({
                error: 'Nao e permitido manter mais de um ERP ativo ao mesmo tempo.',
            });
        }
        if (anymarketIntegrationEnabled === true &&
            !anymarketToken) {
            return res.status(400).json({
                error: 'O gumgaToken do ANYMARKET precisa ser informado para ativar a integracao.',
            });
        }
        if (jetIntegrationEnabled === true && !effectiveJetApiKey) {
            return res.status(400).json({
                error: 'A Credencial de Integracao JET (apiKey) precisa ser informada para ativar a integracao.',
            });
        }
        const now = new Date();
        const companyId = crypto_1.default.randomUUID();
        const shippingCutoffTime = normalizeShippingCutoffTime(req.body?.shippingCutoffTime);
        if (shippingCutoffTime === '__INVALID__') {
            return res.status(400).json({
                error: 'Horario de corte invalido. Use o formato HH:mm entre 00:00 e 23:59.',
            });
        }
        const created = await (0, db_1.dbQuery)(`
        INSERT INTO "Company" (
          "id",
          "name",
          "cnpj",
          "tenantGlobalId",
          "documentType",
          "documentNumber",
          "trayIntegrationEnabled",
          "anymarketIntegrationEnabled",
          "blingIntegrationEnabled",
          "magazordIntegrationEnabled",
          "sysempIntegrationEnabled",
          "jetIntegrationEnabled",
          "intelipostIntegrationEnabled",
          "sswRequireEnabled",
          "correiosIntegrationEnabled",
          "intelipostClientId",
          "intelipostApiKey",
          "anymarketToken",
          "magazordApiBaseUrl",
          "magazordApiUser",
          "magazordApiPassword",
          "jetOrderLookupUrlTemplate",
          "jetIntegrationKey",
          "jetStoreId",
          "jetUsername",
          "jetPassword",
          "jetBearerToken",
          "sswRequireCnpjs",
          "integrationCarrierExceptions",
          "integrationManualStatuses",
          "integrationAutoSyncStatuses",
          "shippingCutoffTime",
          "createdAt"
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33
        )
        RETURNING
          "id",
          "name",
          "cnpj",
          "tenantGlobalId",
          "documentType",
          "documentNumber",
          "trayIntegrationEnabled",
          "anymarketIntegrationEnabled",
          "blingIntegrationEnabled",
          "magazordIntegrationEnabled",
          "sysempIntegrationEnabled",
          "jetIntegrationEnabled",
          "intelipostIntegrationEnabled",
          "sswRequireEnabled",
          "correiosIntegrationEnabled",
          "intelipostClientId",
          "intelipostApiKey",
          "magazordApiBaseUrl",
          "magazordApiUser",
          "magazordApiPassword",
          "anymarketToken",
          "jetOrderLookupUrlTemplate",
          "jetIntegrationKey",
          "jetStoreId",
          "jetUsername",
          "jetPassword",
          "jetBearerToken",
          "sswRequireCnpjs",
          "integrationCarrierExceptions",
          "integrationManualStatuses",
          "integrationAutoSyncStatuses",
          "shippingCutoffTime",
          "createdAt"
      `, [
            companyId,
            String(name),
            normalizedCnpj,
            normalizedTenantGlobalId,
            normalizedDocumentType,
            normalizedDocumentNumber,
            erpIntegrationData.trayIntegrationEnabled ?? true,
            erpIntegrationData.anymarketIntegrationEnabled ?? false,
            erpIntegrationData.blingIntegrationEnabled ?? false,
            erpIntegrationData.magazordIntegrationEnabled ?? false,
            erpIntegrationData.sysempIntegrationEnabled ?? false,
            jetIntegrationEnabled ?? false,
            normalizeBooleanSetting(req.body?.intelipostIntegrationEnabled) ?? true,
            normalizeBooleanSetting(req.body?.sswRequireEnabled) ?? true,
            normalizeBooleanSetting(req.body?.correiosIntegrationEnabled) ?? true,
            intelipostClientId ? String(intelipostClientId).trim() : null,
            intelipostApiKey ? String(intelipostApiKey).trim() : null,
            anymarketToken,
            normalizeOptionalString(req.body?.magazordApiBaseUrl),
            normalizeOptionalString(req.body?.magazordApiUser),
            normalizeOptionalString(req.body?.magazordApiPassword),
            jetOrderLookupUrlTemplate,
            jetIntegrationKey,
            jetStoreId,
            jetUsername,
            jetPassword,
            jetBearerToken,
            normalizeSswRequireCnpjs(sswRequireCnpjs),
            normalizeIntegrationCarrierExceptions(req.body?.integrationCarrierExceptions),
            normalizeIntegrationManualStatuses(req.body?.integrationManualStatuses),
            normalizeIntegrationAutoSyncStatuses(req.body?.integrationAutoSyncStatuses),
            shippingCutoffTime ?? '23:59',
            now,
        ]);
        const companyRow = created.rows[0];
        res.status(201).json(mapCompanyRowToResponse({
            ...companyRow,
            usersCount: 0,
            ordersCount: 0,
        }));
    }
    catch (error) {
        console.error('Error creating company:', error);
        res.status(500).json({ error: 'Failed to create company' });
    }
};
exports.createCompany = createCompany;
// Deletar empresa
const deleteCompany = async (req, res) => {
    const { id } = req.params;
    if (typeof id !== 'string') {
        return res.status(400).json({ error: 'Invalid ID' });
    }
    try {
        const deleted = await (0, db_1.dbQuery)(`
        DELETE FROM "Company"
        WHERE "id" = $1
        RETURNING "id"
      `, [id]);
        if (deleted.rows.length === 0) {
            return res.status(404).json({ error: 'Company not found' });
        }
        res.json({ message: 'Company deleted successfully' });
    }
    catch (error) {
        console.error('Error deleting company:', error);
        res.status(500).json({ error: 'Failed to delete company' });
    }
};
exports.deleteCompany = deleteCompany;
const getCurrentCompany = async (req, res) => {
    try {
        if (!req.user?.companyId) {
            return res.status(403).json({ error: 'Usuario sem empresa vinculada' });
        }
        const companyResult = await (0, db_1.dbQuery)(`
        SELECT
          c."id",
          c."name",
          c."cnpj",
          c."tenantGlobalId",
          c."documentType",
          c."documentNumber",
          c."trayIntegrationEnabled",
          c."anymarketIntegrationEnabled",
          c."blingIntegrationEnabled",
          c."magazordIntegrationEnabled",
          c."sysempIntegrationEnabled",
          c."jetIntegrationEnabled",
          c."intelipostIntegrationEnabled",
          c."sswRequireEnabled",
          c."correiosIntegrationEnabled",
          c."intelipostClientId",
          c."intelipostApiKey",
          c."magazordApiBaseUrl",
          c."magazordApiUser",
          c."magazordApiPassword",
          c."anymarketToken",
          c."jetOrderLookupUrlTemplate",
          c."jetIntegrationKey",
          c."jetStoreId",
          c."jetUsername",
          c."jetPassword",
          c."jetBearerToken",
          c."sswRequireCnpjs",
          c."integrationCarrierExceptions",
          c."integrationManualStatuses",
          c."integrationAutoSyncStatuses",
          c."shippingCutoffTime",
          c."createdAt",
          (
            SELECT COUNT(*)::int
            FROM "User" u
            WHERE u."companyId" = c."id"
          ) AS "usersCount",
          (
            SELECT COUNT(*)::int
            FROM "Order" o
            WHERE o."companyId" = c."id"
          ) AS "ordersCount"
        FROM "Company" c
        WHERE c."id" = $1
        LIMIT 1
      `, [String(req.user.companyId)]);
        const company = companyResult.rows[0] || null;
        if (!company) {
            return res.status(404).json({ error: 'Empresa nao encontrada' });
        }
        return res.json(mapCompanyRowToResponse(company));
    }
    catch (error) {
        console.error('Error fetching current company:', error);
        return res.status(500).json({ error: 'Failed to fetch current company' });
    }
};
exports.getCurrentCompany = getCurrentCompany;
const updateCurrentCompanyIntegration = async (req, res) => {
    try {
        if (!req.user?.companyId) {
            return res.status(403).json({ error: 'Usuario sem empresa vinculada' });
        }
        const intelipostClientIdRaw = req.body?.intelipostClientId;
        const intelipostClientId = intelipostClientIdRaw === undefined || intelipostClientIdRaw === null
            ? undefined
            : String(intelipostClientIdRaw).trim();
        const intelipostApiKeyRaw = req.body?.intelipostApiKey;
        const intelipostApiKey = intelipostApiKeyRaw === undefined || intelipostApiKeyRaw === null
            ? undefined
            : String(intelipostApiKeyRaw).trim();
        const sswRequireCnpjsRaw = req.body?.sswRequireCnpjs;
        const sswRequireCnpjs = sswRequireCnpjsRaw === undefined
            ? undefined
            : normalizeSswRequireCnpjs(sswRequireCnpjsRaw);
        const integrationCarrierExceptionsRaw = req.body?.integrationCarrierExceptions;
        const integrationCarrierExceptions = integrationCarrierExceptionsRaw === undefined
            ? undefined
            : normalizeIntegrationCarrierExceptions(integrationCarrierExceptionsRaw);
        const integrationManualStatusesRaw = req.body?.integrationManualStatuses;
        const integrationManualStatuses = integrationManualStatusesRaw === undefined
            ? undefined
            : normalizeIntegrationManualStatuses(integrationManualStatusesRaw);
        const integrationAutoSyncStatusesRaw = req.body?.integrationAutoSyncStatuses;
        const integrationAutoSyncStatuses = integrationAutoSyncStatusesRaw === undefined
            ? undefined
            : normalizeIntegrationAutoSyncStatuses(integrationAutoSyncStatusesRaw);
        const trayIntegrationEnabled = normalizeBooleanSetting(req.body?.trayIntegrationEnabled);
        const blingIntegrationEnabled = normalizeBooleanSetting(req.body?.blingIntegrationEnabled);
        const anymarketIntegrationEnabled = normalizeBooleanSetting(req.body?.anymarketIntegrationEnabled);
        const magazordIntegrationEnabled = normalizeBooleanSetting(req.body?.magazordIntegrationEnabled);
        const sysempIntegrationEnabled = normalizeBooleanSetting(req.body?.sysempIntegrationEnabled);
        const jetIntegrationEnabled = normalizeBooleanSetting(req.body?.jetIntegrationEnabled);
        const intelipostIntegrationEnabled = normalizeBooleanSetting(req.body?.intelipostIntegrationEnabled);
        const sswRequireEnabled = normalizeBooleanSetting(req.body?.sswRequireEnabled);
        const correiosIntegrationEnabled = normalizeBooleanSetting(req.body?.correiosIntegrationEnabled);
        const anymarketTokenRaw = req.body?.anymarketToken;
        const anymarketToken = anymarketTokenRaw === undefined
            ? undefined
            : normalizeOptionalString(anymarketTokenRaw);
        const magazordApiBaseUrl = normalizeOptionalString(req.body?.magazordApiBaseUrl);
        const magazordApiUser = normalizeOptionalString(req.body?.magazordApiUser);
        const magazordApiPasswordRaw = req.body?.magazordApiPassword;
        const magazordApiPassword = magazordApiPasswordRaw === undefined
            ? undefined
            : normalizeOptionalString(magazordApiPasswordRaw);
        const jetOrderLookupUrlTemplate = normalizeOptionalString(req.body?.jetOrderLookupUrlTemplate);
        const jetIntegrationKeyRaw = req.body?.jetIntegrationKey;
        const jetIntegrationKey = jetIntegrationKeyRaw === undefined
            ? undefined
            : normalizeOptionalString(jetIntegrationKeyRaw);
        const jetStoreId = normalizeOptionalString(req.body?.jetStoreId);
        const jetUsernameRaw = req.body?.jetUsername;
        const jetUsername = jetUsernameRaw === undefined ? undefined : normalizeOptionalString(jetUsernameRaw);
        const jetPasswordRaw = req.body?.jetPassword;
        const jetPassword = jetPasswordRaw === undefined ? undefined : normalizeOptionalString(jetPasswordRaw);
        const jetBearerTokenRaw = req.body?.jetBearerToken;
        const jetBearerToken = jetBearerTokenRaw === undefined
            ? undefined
            : normalizeOptionalString(jetBearerTokenRaw);
        const shippingCutoffTime = normalizeShippingCutoffTime(req.body?.shippingCutoffTime);
        if (shippingCutoffTime === '__INVALID__') {
            return res.status(400).json({
                error: 'Horario de corte invalido. Use o formato HH:mm entre 00:00 e 23:59.',
            });
        }
        const erpIntegrationData = buildErpIntegrationUpdate({
            trayIntegrationEnabled,
            anymarketIntegrationEnabled,
            blingIntegrationEnabled,
            magazordIntegrationEnabled,
            sysempIntegrationEnabled,
            jetIntegrationEnabled,
        });
        if (intelipostClientId !== undefined && !intelipostClientId) {
            return res.status(400).json({ error: 'ID da Intelipost obrigatorio' });
        }
        if ((magazordApiBaseUrl !== undefined || magazordApiUser !== undefined) &&
            (!magazordApiBaseUrl || !magazordApiUser)) {
            return res.status(400).json({
                error: 'URL base e usuario da Magazord precisam ser informados juntos.',
            });
        }
        const currentCompanyResult = await (0, db_1.dbQuery)(`
        SELECT
          "trayIntegrationEnabled",
          "anymarketIntegrationEnabled",
          "blingIntegrationEnabled",
          "magazordIntegrationEnabled",
          "sysempIntegrationEnabled",
          "jetIntegrationEnabled",
          "anymarketToken",
          "magazordApiBaseUrl",
          "magazordApiUser",
          "jetIntegrationKey"
        FROM "Company"
        WHERE "id" = $1
        LIMIT 1
      `, [String(req.user.companyId)]);
        const currentCompany = currentCompanyResult.rows[0] || null;
        if (!currentCompany) {
            return res.status(404).json({ error: 'Empresa nao encontrada' });
        }
        const shouldAutoEnableAnymarket = anymarketIntegrationEnabled === undefined &&
            anymarketToken !== undefined &&
            Boolean(anymarketToken);
        const effectiveMagazordApiBaseUrl = magazordApiBaseUrl !== undefined
            ? magazordApiBaseUrl
            : currentCompany.magazordApiBaseUrl;
        const effectiveMagazordApiUser = magazordApiUser !== undefined
            ? magazordApiUser
            : currentCompany.magazordApiUser;
        const shouldAutoEnableMagazord = magazordIntegrationEnabled === undefined &&
            (magazordApiBaseUrl !== undefined ||
                magazordApiUser !== undefined ||
                magazordApiPassword !== undefined) &&
            Boolean(effectiveMagazordApiBaseUrl && effectiveMagazordApiUser);
        if (shouldAutoEnableAnymarket) {
            erpIntegrationData.trayIntegrationEnabled = false;
            erpIntegrationData.anymarketIntegrationEnabled = true;
            erpIntegrationData.blingIntegrationEnabled = false;
            erpIntegrationData.magazordIntegrationEnabled = false;
            erpIntegrationData.sysempIntegrationEnabled = false;
            erpIntegrationData.jetIntegrationEnabled = false;
        }
        if (shouldAutoEnableMagazord) {
            erpIntegrationData.trayIntegrationEnabled = false;
            erpIntegrationData.anymarketIntegrationEnabled = false;
            erpIntegrationData.blingIntegrationEnabled = false;
            erpIntegrationData.magazordIntegrationEnabled = true;
            erpIntegrationData.sysempIntegrationEnabled = false;
            erpIntegrationData.jetIntegrationEnabled = false;
        }
        const effectiveErpState = ERP_INTEGRATION_FIELDS.reduce((accumulator, field) => {
            const nextValue = erpIntegrationData[field];
            accumulator[field] =
                typeof nextValue === 'boolean'
                    ? nextValue
                    : Boolean(currentCompany[field]);
            return accumulator;
        }, {});
        const activeErpFields = resolveActiveErpFields(effectiveErpState);
        if (activeErpFields.length > 1) {
            return res.status(400).json({
                error: 'Nao e permitido ativar um segundo ERP. Desative o ERP atual antes de ativar outro.',
            });
        }
        const effectiveAnymarketToken = anymarketToken !== undefined
            ? anymarketToken
            : currentCompany.anymarketToken;
        const effectiveJetApiKey = jetIntegrationKey !== undefined
            ? jetIntegrationKey
            : currentCompany.jetIntegrationKey;
        const willEnableAnymarket = effectiveErpState.anymarketIntegrationEnabled === true;
        const willEnableJet = effectiveErpState.jetIntegrationEnabled === true;
        if ((willEnableAnymarket ||
            anymarketToken !== undefined) &&
            !effectiveAnymarketToken) {
            return res.status(400).json({
                error: 'O gumgaToken do ANYMARKET precisa ser informado para ativar ou configurar a integracao.',
            });
        }
        if ((willEnableJet || jetIntegrationKey !== undefined) && !effectiveJetApiKey) {
            return res.status(400).json({
                error: 'A Credencial de Integracao JET (apiKey) precisa ser informada para ativar ou configurar a integracao.',
            });
        }
        const updateColumns = [];
        const updateValues = [];
        let idx = 1;
        const pushUpdate = (column, value) => {
            updateColumns.push(`"${column}" = $${idx}`);
            updateValues.push(value);
            idx += 1;
        };
        if (intelipostClientId !== undefined)
            pushUpdate('intelipostClientId', intelipostClientId);
        if (intelipostApiKey !== undefined)
            pushUpdate('intelipostApiKey', intelipostApiKey || null);
        if (erpIntegrationData.trayIntegrationEnabled !== undefined)
            pushUpdate('trayIntegrationEnabled', erpIntegrationData.trayIntegrationEnabled);
        if (erpIntegrationData.anymarketIntegrationEnabled !== undefined)
            pushUpdate('anymarketIntegrationEnabled', erpIntegrationData.anymarketIntegrationEnabled);
        if (erpIntegrationData.blingIntegrationEnabled !== undefined)
            pushUpdate('blingIntegrationEnabled', erpIntegrationData.blingIntegrationEnabled);
        if (erpIntegrationData.magazordIntegrationEnabled !== undefined)
            pushUpdate('magazordIntegrationEnabled', erpIntegrationData.magazordIntegrationEnabled);
        if (erpIntegrationData.sysempIntegrationEnabled !== undefined)
            pushUpdate('sysempIntegrationEnabled', erpIntegrationData.sysempIntegrationEnabled);
        if (jetIntegrationEnabled !== undefined)
            pushUpdate('jetIntegrationEnabled', jetIntegrationEnabled);
        if (intelipostIntegrationEnabled !== undefined)
            pushUpdate('intelipostIntegrationEnabled', intelipostIntegrationEnabled);
        if (sswRequireEnabled !== undefined)
            pushUpdate('sswRequireEnabled', sswRequireEnabled);
        if (correiosIntegrationEnabled !== undefined)
            pushUpdate('correiosIntegrationEnabled', correiosIntegrationEnabled);
        if (anymarketToken !== undefined)
            pushUpdate('anymarketToken', anymarketToken);
        if (magazordApiBaseUrl !== undefined)
            pushUpdate('magazordApiBaseUrl', magazordApiBaseUrl);
        if (magazordApiUser !== undefined)
            pushUpdate('magazordApiUser', magazordApiUser);
        if (magazordApiPassword !== undefined)
            pushUpdate('magazordApiPassword', magazordApiPassword);
        if (jetOrderLookupUrlTemplate !== undefined)
            pushUpdate('jetOrderLookupUrlTemplate', jetOrderLookupUrlTemplate);
        if (jetIntegrationKey !== undefined)
            pushUpdate('jetIntegrationKey', jetIntegrationKey);
        if (jetStoreId !== undefined)
            pushUpdate('jetStoreId', jetStoreId);
        if (jetUsername !== undefined)
            pushUpdate('jetUsername', jetUsername);
        if (jetPassword !== undefined)
            pushUpdate('jetPassword', jetPassword);
        if (jetBearerToken !== undefined)
            pushUpdate('jetBearerToken', jetBearerToken);
        if (sswRequireCnpjs !== undefined)
            pushUpdate('sswRequireCnpjs', sswRequireCnpjs);
        if (integrationCarrierExceptions !== undefined)
            pushUpdate('integrationCarrierExceptions', integrationCarrierExceptions);
        if (integrationManualStatuses !== undefined)
            pushUpdate('integrationManualStatuses', integrationManualStatuses);
        if (integrationAutoSyncStatuses !== undefined)
            pushUpdate('integrationAutoSyncStatuses', integrationAutoSyncStatuses);
        if (shippingCutoffTime !== undefined)
            pushUpdate('shippingCutoffTime', shippingCutoffTime);
        if (updateColumns.length === 0) {
            return res.json({
                success: true,
                message: 'Nenhuma alteracao de integracao foi enviada.',
                company: null,
            });
        }
        updateValues.push(String(req.user.companyId));
        const companyResult = await (0, db_1.dbQuery)(`
        UPDATE "Company"
        SET ${updateColumns.join(', ')}
        WHERE "id" = $${idx}
        RETURNING
          "id",
          "name",
          "cnpj",
          "tenantGlobalId",
          "documentType",
          "documentNumber",
          "trayIntegrationEnabled",
          "anymarketIntegrationEnabled",
          "blingIntegrationEnabled",
          "magazordIntegrationEnabled",
          "sysempIntegrationEnabled",
          "jetIntegrationEnabled",
          "intelipostIntegrationEnabled",
          "sswRequireEnabled",
          "correiosIntegrationEnabled",
          "intelipostClientId",
          "intelipostApiKey",
          "magazordApiBaseUrl",
          "magazordApiUser",
          "magazordApiPassword",
          "anymarketToken",
          "jetOrderLookupUrlTemplate",
          "jetIntegrationKey",
          "jetStoreId",
          "jetUsername",
          "jetPassword",
          "jetBearerToken",
          "sswRequireCnpjs",
          "integrationCarrierExceptions",
          "integrationManualStatuses",
          "integrationAutoSyncStatuses",
          "shippingCutoffTime",
          "createdAt"
      `, updateValues);
        const companyRow = companyResult.rows[0] || null;
        if (!companyRow) {
            return res.status(404).json({ error: 'Empresa nao encontrada' });
        }
        return res.json({
            success: true,
            message: 'Configuracoes de integracao atualizadas com sucesso.',
            company: mapCompanyRowToResponse({
                ...companyRow,
                usersCount: 0,
                ordersCount: 0,
            }),
        });
    }
    catch (error) {
        console.error('Error updating current company integration:', error);
        return res.status(500).json({ error: 'Failed to update company integration' });
    }
};
exports.updateCurrentCompanyIntegration = updateCurrentCompanyIntegration;
const getCompanyUsageSummary = async (req, res) => {
    if (!requireAdminUser(req, res))
        return;
    try {
        const companyId = String(req.params?.id || '').trim();
        if (!companyId) {
            return res.status(400).json({ error: 'Informe o ID da empresa.' });
        }
        const companyResult = await (0, db_1.dbQuery)(`
        SELECT
          c."id",
          c."name",
          c."databaseUrl",
          (
            SELECT COUNT(*)::int
            FROM "User" u
            WHERE u."companyId" = c."id"
          ) AS "usersCount",
          (
            SELECT COUNT(*)::int
            FROM "Order" o
            WHERE o."companyId" = c."id"
          ) AS "ordersCount"
        FROM "Company" c
        WHERE c."id" = $1
        LIMIT 1
      `, [companyId]);
        const company = companyResult.rows[0] || null;
        if (!company) {
            return res.status(404).json({ error: 'Empresa nao encontrada.' });
        }
        const trackingSyncRowsResult = await (0, db_1.dbQuery)(`
        SELECT "createdAt", "payload"
        FROM "SyncNotification"
        WHERE "companyId" = $1
          AND "type" = 'TRACKING_SYNC_SUMMARY'
        ORDER BY "createdAt" DESC
        LIMIT 400
      `, [companyId]);
        const trackingSyncRows = trackingSyncRowsResult.rows;
        const now = Date.now();
        const thirtyDaysAgoMs = now - 30 * 24 * 60 * 60 * 1000;
        let totalTrackingSyncHours = 0;
        let trackingSyncRunsLast30Days = 0;
        let trackingSyncHoursLast30Days = 0;
        let totalSuccessfulSyncs = 0;
        let totalFailedSyncs = 0;
        let lastTrackingSyncAt = null;
        for (const row of trackingSyncRows) {
            const payload = row?.payload && typeof row.payload === 'object'
                ? row.payload
                : {};
            const startedAt = parseDateOrNull(payload.startedAt);
            const finishedAt = parseDateOrNull(payload.finishedAt) || row.createdAt;
            const durationHours = startedAt && finishedAt && finishedAt.getTime() >= startedAt.getTime()
                ? (finishedAt.getTime() - startedAt.getTime()) / (1000 * 60 * 60)
                : 0;
            totalTrackingSyncHours += durationHours;
            totalSuccessfulSyncs += Number(payload.success || 0);
            totalFailedSyncs += Number(payload.failed || 0);
            const finishedAtMs = finishedAt.getTime();
            if (finishedAtMs >= thirtyDaysAgoMs) {
                trackingSyncRunsLast30Days += 1;
                trackingSyncHoursLast30Days += durationHours;
            }
            if (!lastTrackingSyncAt) {
                lastTrackingSyncAt = finishedAt.toISOString();
            }
        }
        return res.json({
            success: true,
            companyId: company.id,
            companyName: company.name,
            database: {
                configured: Boolean(String(company.databaseUrl || '').trim()),
                host: parseDatabaseHost(company.databaseUrl),
            },
            totals: {
                users: Number(company.usersCount || 0),
                orders: Number(company.ordersCount || 0),
                trackingSyncRuns: Number(trackingSyncRows.length),
                trackingSyncRunsLast30Days,
                trackingSyncSuccessEvents: totalSuccessfulSyncs,
                trackingSyncFailedEvents: totalFailedSyncs,
            },
            usage: {
                totalTrackingSyncHours: Number(totalTrackingSyncHours.toFixed(2)),
                trackingSyncHoursLast30Days: Number(trackingSyncHoursLast30Days.toFixed(2)),
                cpuCuHoursEstimatedLast30Days: Number(trackingSyncHoursLast30Days.toFixed(2)),
                usageScore: Number(company.ordersCount || 0) + trackingSyncRunsLast30Days,
            },
            lastTrackingSyncAt,
        });
    }
    catch (error) {
        console.error('Error fetching company usage summary:', error);
        return res.status(500).json({ error: 'Failed to fetch company usage summary' });
    }
};
exports.getCompanyUsageSummary = getCompanyUsageSummary;
