"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.integrationHealthService = exports.IntegrationHealthService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const db_1 = require("../lib/db");
const modSituation_1 = require("../utils/modSituation");
const notificationService_1 = require("./notificationService");
const integrationHealthPolicy_1 = require("./integrationHealthPolicy");
const trayAuthService_1 = require("./trayAuthService");
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
const trayReconnectIssue = () => ({
    integration: 'TRAY',
    code: 'TRAY_RECONNECT_REQUIRED',
    title: 'Reconexao da Tray necessaria',
    message: 'A autenticacao da Tray expirou ou foi invalidada. Acesse Integracoes e reconecte a Tray para retomar as sincronizacoes.',
});
class IntegrationHealthService {
    interval = null;
    activeCheck = null;
    async initialize() {
        if (!(0, modSituation_1.shouldRunAutomaticProcesses)()) {
            console.log('[INTEGRATIONS] Monitor de saude desabilitado fora de producao.');
            return;
        }
        await this.checkAllCompanies();
        if (this.interval) {
            clearInterval(this.interval);
        }
        this.interval = setInterval(() => {
            void this.checkAllCompanies();
        }, CHECK_INTERVAL_MS);
        this.interval.unref?.();
    }
    async checkAllCompanies() {
        if (this.activeCheck) {
            return this.activeCheck;
        }
        this.activeCheck = this.runAllChecks().finally(() => {
            this.activeCheck = null;
        });
        return this.activeCheck;
    }
    async checkCompany(companyId) {
        const company = await this.findCompany(companyId);
        if (!company)
            return;
        await this.checkCompanyHealth(company);
    }
    async runAllChecks() {
        const companies = await this.findCompanies();
        for (const company of companies) {
            try {
                await this.checkCompanyHealth(company);
            }
            catch (error) {
                console.error(`[INTEGRATIONS] Falha ao verificar a saude das integracoes da empresa ${company.id}:`, error);
            }
        }
    }
    async checkCompanyHealth(company) {
        const issues = (0, integrationHealthPolicy_1.evaluateIntegrationConfiguration)(company);
        const unresolvedCodes = new Set();
        if (company.trayIntegrationEnabled && company.hasTrayAuth) {
            try {
                const auth = await trayAuthService_1.trayAuthService.getValidAuthData(company.id, {
                    refreshBeforeMs: CHECK_INTERVAL_MS,
                });
                if (!auth) {
                    issues.push(trayReconnectIssue());
                }
            }
            catch (error) {
                if ((0, trayAuthService_1.isTrayReconnectRequiredError)(error)) {
                    issues.push(trayReconnectIssue());
                }
                else {
                    unresolvedCodes.add('TRAY_RECONNECT_REQUIRED');
                    console.error(`[INTEGRATIONS] Nao foi possivel confirmar a autenticacao Tray da empresa ${company.id}:`, error);
                }
            }
        }
        for (const issue of issues) {
            await this.openIssue(company, issue);
        }
        const activeCodes = new Set(issues.map((issue) => issue.code));
        await this.resolveRecoveredIssues(company.id, activeCodes, unresolvedCodes);
    }
    async openIssue(company, issue) {
        const existing = await (0, db_1.dbQuery)(`
        SELECT "issueCode", "status", "lastNotifiedAt"
        FROM "IntegrationHealthIncident"
        WHERE "companyId" = $1
          AND "integration" = $2
          AND "issueCode" = $3
        LIMIT 1
      `, [company.id, issue.integration, issue.code]).then((result) => result.rows[0] || null);
        const lastNotifiedAt = existing?.lastNotifiedAt
            ? new Date(existing.lastNotifiedAt)
            : null;
        const shouldNotify = !existing ||
            existing.status !== 'OPEN' ||
            !lastNotifiedAt ||
            Date.now() - lastNotifiedAt.getTime() >= REMINDER_INTERVAL_MS;
        await (0, db_1.dbQuery)(`
        INSERT INTO "IntegrationHealthIncident" (
          "id", "companyId", "integration", "issueCode", "status", "title", "message",
          "lastNotifiedAt", "resolvedAt", "createdAt", "updatedAt"
        )
        VALUES ($1, $2, $3, $4, 'OPEN', $5, $6, $7, NULL, NOW(), NOW())
        ON CONFLICT ("companyId", "integration", "issueCode")
        DO UPDATE SET
          "status" = 'OPEN',
          "title" = EXCLUDED."title",
          "message" = EXCLUDED."message",
          "lastNotifiedAt" = CASE
            WHEN $8 THEN NOW()
            ELSE "IntegrationHealthIncident"."lastNotifiedAt"
          END,
          "resolvedAt" = NULL,
          "updatedAt" = NOW()
      `, [
            crypto_1.default.randomUUID(),
            company.id,
            issue.integration,
            issue.code,
            issue.title,
            issue.message,
            shouldNotify ? new Date() : null,
            shouldNotify,
        ]);
        if (shouldNotify) {
            await notificationService_1.notificationService.registerIntegrationHealthNotification({
                companyId: company.id,
                companyName: company.name,
                integration: issue.integration,
                issueCode: issue.code,
                title: issue.title,
                message: issue.message,
            });
        }
    }
    async resolveRecoveredIssues(companyId, activeCodes, unresolvedCodes) {
        const incidents = await (0, db_1.dbQuery)(`
        SELECT "issueCode", "status", "lastNotifiedAt"
        FROM "IntegrationHealthIncident"
        WHERE "companyId" = $1
          AND "status" = 'OPEN'
      `, [companyId]).then((result) => result.rows);
        const recoveredCodes = incidents
            .map((incident) => incident.issueCode)
            .filter((code) => !activeCodes.has(code) && !unresolvedCodes.has(code));
        if (recoveredCodes.length === 0)
            return;
        await (0, db_1.dbQuery)(`
        UPDATE "IntegrationHealthIncident"
        SET "status" = 'RESOLVED', "resolvedAt" = NOW(), "updatedAt" = NOW()
        WHERE "companyId" = $1
          AND "status" = 'OPEN'
          AND "issueCode" = ANY($2::text[])
      `, [companyId, recoveredCodes]);
    }
    async findCompany(companyId) {
        const companies = await this.findCompanies(companyId);
        return companies[0] || null;
    }
    async findCompanies(companyId) {
        const result = await (0, db_1.dbQuery)(`
        SELECT
          c."id",
          c."name",
          c."trayIntegrationEnabled",
          (ta."id" IS NOT NULL) AS "hasTrayAuth",
          c."anymarketIntegrationEnabled",
          c."anymarketToken",
          c."magazordIntegrationEnabled",
          c."magazordApiBaseUrl",
          c."magazordApiUser",
          c."magazordApiPassword",
          c."jetIntegrationEnabled",
          c."jetIntegrationKey",
          c."intelipostIntegrationEnabled",
          c."intelipostClientId",
          c."intelipostApiKey",
          c."sswRequireEnabled",
          c."sswRequireCnpjs",
          c."correiosIntegrationEnabled"
        FROM "Company" c
        LEFT JOIN "TrayAuth" ta ON ta."companyId" = c."id"
        WHERE ($1::text IS NULL OR c."id" = $1)
        ORDER BY c."createdAt" ASC
      `, [companyId || null]);
        return result.rows;
    }
}
exports.IntegrationHealthService = IntegrationHealthService;
exports.integrationHealthService = new IntegrationHealthService();
