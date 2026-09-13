import type { TenantClient } from './tenant';
import type { AuthContext } from '../types/auth';

export async function auditLog(
  client: TenantClient,
  auth: Pick<AuthContext, 'tenantId' | 'companyId' | 'userId'>,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata: Record<string, unknown> = {}
) {
  await client.query(
    `
      INSERT INTO audit_logs (tenant_id, company_id, user_id, action, entity_type, entity_id, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [auth.tenantId, auth.companyId, auth.userId, action, entityType, entityId, metadata]
  );
}
