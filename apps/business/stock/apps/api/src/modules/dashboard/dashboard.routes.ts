import type { FastifyInstance } from 'fastify';
import { withTenant } from '../../db/tenant';

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/dashboard', async (request) => {
    const { tenantId, userId, companyId } = request.auth;

    return withTenant(tenantId, userId, async (client) => {
      const [productStats, locationStats, movementStats, scans] = await Promise.all([
        client.query(
          `
            SELECT
              count(*)::int AS total_skus,
              COALESCE(sum(sb.quantity), 0)::numeric AS total_quantity,
              count(*) FILTER (WHERE sb.id IS NULL)::int AS products_without_location
            FROM products p
            LEFT JOIN stock_balances sb ON sb.tenant_id = p.tenant_id AND sb.product_id = p.id AND sb.quantity > 0
            WHERE p.tenant_id = $1 AND p.company_id = $2
          `,
          [tenantId, companyId]
        ),
        client.query(
          `
            SELECT
              count(*) FILTER (WHERE status = 'available')::int AS available,
              count(*) FILTER (WHERE status = 'partial')::int AS partial,
              count(*) FILTER (WHERE status = 'full')::int AS full,
              count(*) FILTER (WHERE status = 'blocked')::int AS blocked
            FROM locations
            WHERE tenant_id = $1 AND company_id = $2
          `,
          [tenantId, companyId]
        ),
        client.query(
          `
            SELECT sm.id, sm.movement_type, sm.quantity, sm.created_at, p.name AS product_name
            FROM stock_movements sm
            JOIN products p ON p.id = sm.product_id
            WHERE sm.tenant_id = $1 AND sm.company_id = $2
            ORDER BY sm.created_at DESC
            LIMIT 8
          `,
          [tenantId, companyId]
        ),
        client.query(
          `
            SELECT scanned_value, resolved_type, scan_source, created_at
            FROM scan_events
            WHERE tenant_id = $1 AND company_id = $2
            ORDER BY created_at DESC
            LIMIT 8
          `,
          [tenantId, companyId]
        )
      ]);

      return {
        products: productStats.rows[0],
        locations: locationStats.rows[0],
        recentMovements: movementStats.rows,
        recentScans: scans.rows
      };
    });
  });
}
