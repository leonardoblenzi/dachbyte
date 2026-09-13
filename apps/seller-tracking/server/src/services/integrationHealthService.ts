import crypto from 'crypto';
import { dbQuery } from '../lib/db';
import { shouldRunAutomaticProcesses } from '../utils/modSituation';
import { notificationService } from './notificationService';
import {
  evaluateIntegrationConfiguration,
  type IntegrationConfiguration,
  type IntegrationHealthIssue,
} from './integrationHealthPolicy';
import {
  isTrayReconnectRequiredError,
  trayAuthService,
} from './trayAuthService';

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

type CompanyIntegrationRow = IntegrationConfiguration & {
  id: string;
  name: string;
};

type ExistingIncident = {
  issueCode: string;
  status: string;
  lastNotifiedAt: Date | null;
};

const trayReconnectIssue = (): IntegrationHealthIssue => ({
  integration: 'TRAY',
  code: 'TRAY_RECONNECT_REQUIRED',
  title: 'Reconexao da Tray necessaria',
  message:
    'A autenticacao da Tray expirou ou foi invalidada. Acesse Integracoes e reconecte a Tray para retomar as sincronizacoes.',
});

export class IntegrationHealthService {
  private interval: NodeJS.Timeout | null = null;
  private activeCheck: Promise<void> | null = null;

  async initialize() {
    if (!shouldRunAutomaticProcesses()) {
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

  async checkCompany(companyId: string) {
    const company = await this.findCompany(companyId);
    if (!company) return;
    await this.checkCompanyHealth(company);
  }

  private async runAllChecks() {
    const companies = await this.findCompanies();
    for (const company of companies) {
      try {
        await this.checkCompanyHealth(company);
      } catch (error) {
        console.error(
          `[INTEGRATIONS] Falha ao verificar a saude das integracoes da empresa ${company.id}:`,
          error,
        );
      }
    }
  }

  private async checkCompanyHealth(company: CompanyIntegrationRow) {
    const issues = evaluateIntegrationConfiguration(company);
    const unresolvedCodes = new Set<string>();

    if (company.trayIntegrationEnabled && company.hasTrayAuth) {
      try {
        const auth = await trayAuthService.getValidAuthData(company.id, {
          refreshBeforeMs: CHECK_INTERVAL_MS,
        });
        if (!auth) {
          issues.push(trayReconnectIssue());
        }
      } catch (error) {
        if (isTrayReconnectRequiredError(error)) {
          issues.push(trayReconnectIssue());
        } else {
          unresolvedCodes.add('TRAY_RECONNECT_REQUIRED');
          console.error(
            `[INTEGRATIONS] Nao foi possivel confirmar a autenticacao Tray da empresa ${company.id}:`,
            error,
          );
        }
      }
    }

    for (const issue of issues) {
      await this.openIssue(company, issue);
    }

    const activeCodes = new Set(issues.map((issue) => issue.code));
    await this.resolveRecoveredIssues(company.id, activeCodes, unresolvedCodes);
  }

  private async openIssue(company: CompanyIntegrationRow, issue: IntegrationHealthIssue) {
    const existing = await dbQuery<ExistingIncident>(
      `
        SELECT "issueCode", "status", "lastNotifiedAt"
        FROM "IntegrationHealthIncident"
        WHERE "companyId" = $1
          AND "integration" = $2
          AND "issueCode" = $3
        LIMIT 1
      `,
      [company.id, issue.integration, issue.code],
    ).then((result) => result.rows[0] || null);

    const lastNotifiedAt = existing?.lastNotifiedAt
      ? new Date(existing.lastNotifiedAt)
      : null;
    const shouldNotify =
      !existing ||
      existing.status !== 'OPEN' ||
      !lastNotifiedAt ||
      Date.now() - lastNotifiedAt.getTime() >= REMINDER_INTERVAL_MS;

    await dbQuery(
      `
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
      `,
      [
        crypto.randomUUID(),
        company.id,
        issue.integration,
        issue.code,
        issue.title,
        issue.message,
        shouldNotify ? new Date() : null,
        shouldNotify,
      ],
    );

    if (shouldNotify) {
      await notificationService.registerIntegrationHealthNotification({
        companyId: company.id,
        companyName: company.name,
        integration: issue.integration,
        issueCode: issue.code,
        title: issue.title,
        message: issue.message,
      });
    }
  }

  private async resolveRecoveredIssues(
    companyId: string,
    activeCodes: Set<string>,
    unresolvedCodes: Set<string>,
  ) {
    const incidents = await dbQuery<ExistingIncident>(
      `
        SELECT "issueCode", "status", "lastNotifiedAt"
        FROM "IntegrationHealthIncident"
        WHERE "companyId" = $1
          AND "status" = 'OPEN'
      `,
      [companyId],
    ).then((result) => result.rows);

    const recoveredCodes = incidents
      .map((incident) => incident.issueCode)
      .filter((code) => !activeCodes.has(code) && !unresolvedCodes.has(code));

    if (recoveredCodes.length === 0) return;

    await dbQuery(
      `
        UPDATE "IntegrationHealthIncident"
        SET "status" = 'RESOLVED', "resolvedAt" = NOW(), "updatedAt" = NOW()
        WHERE "companyId" = $1
          AND "status" = 'OPEN'
          AND "issueCode" = ANY($2::text[])
      `,
      [companyId, recoveredCodes],
    );
  }

  private async findCompany(companyId: string) {
    const companies = await this.findCompanies(companyId);
    return companies[0] || null;
  }

  private async findCompanies(companyId?: string): Promise<CompanyIntegrationRow[]> {
    const result = await dbQuery<CompanyIntegrationRow>(
      `
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
      `,
      [companyId || null],
    );

    return result.rows;
  }
}

export const integrationHealthService = new IntegrationHealthService();
