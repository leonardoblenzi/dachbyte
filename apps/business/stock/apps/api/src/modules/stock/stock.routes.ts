import type { FastifyInstance } from 'fastify';
import { paginationSchema, stockMoveSchema } from '@voltstock/shared';
import { auditLog } from '../../db/audit';
import { withTenant } from '../../db/tenant';
import { requireAnyPermission } from '../../http/permissions';

async function incrementBalance(
  client: import('../../db/tenant').TenantClient,
  params: {
    tenantId: string;
    companyId: string;
    productId: string;
    locationId: string | null;
    lotCode: string | null;
    quantity: number;
  }
) {
  await client.query(
    `
      INSERT INTO stock_balances (tenant_id, company_id, product_id, location_id, lot_code, quantity)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (tenant_id, product_id, location_scope, container_scope, lot_scope)
      DO UPDATE SET quantity = stock_balances.quantity + EXCLUDED.quantity, updated_at = now()
    `,
    [params.tenantId, params.companyId, params.productId, params.locationId, params.lotCode, params.quantity]
  );
}

async function decrementBalance(
  client: import('../../db/tenant').TenantClient,
  params: {
    tenantId: string;
    productId: string;
    locationId: string;
    lotCode: string | null;
    quantity: number;
  }
) {
  const result = await client.query(
    `
      UPDATE stock_balances
      SET quantity = quantity - $5, updated_at = now()
      WHERE tenant_id = $1
        AND product_id = $2
        AND location_scope = $3
        AND lot_scope = COALESCE($4, '')
        AND quantity >= $5
      RETURNING id
    `,
    [params.tenantId, params.productId, params.locationId, params.lotCode, params.quantity]
  );

  if (!result.rowCount) {
    throw new Error('Saldo insuficiente ou localizacao de origem sem estoque.');
  }
}

export async function stockRoutes(app: FastifyInstance) {
  app.get('/stock/balances', async (request) => {
    const query = paginationSchema.parse(request.query);
    const auth = request.auth;
    const offset = (query.page - 1) * query.pageSize;
    const search = query.q ? `%${query.q}%` : null;

    return withTenant(auth.tenantId, auth.userId, async (client) => {
      const [items, total] = await Promise.all([
        client.query(
          `
            SELECT
              sb.id,
              p.product_code AS "productCode",
              p.name AS "productName",
              l.code AS "locationCode",
              l.name AS "locationName",
              sb.lot_code AS "lotCode",
              sb.quantity,
              sb.reserved_quantity AS "reservedQuantity",
              sb.updated_at AS "updatedAt"
            FROM stock_balances sb
            JOIN products p ON p.id = sb.product_id
            LEFT JOIN locations l ON l.id = sb.location_id
            WHERE sb.tenant_id = $1
              AND sb.company_id = $2
              AND ($3::text IS NULL OR p.product_code ILIKE $3 OR p.name ILIKE $3 OR l.code ILIKE $3)
            ORDER BY sb.updated_at DESC
            LIMIT $4 OFFSET $5
          `,
          [auth.tenantId, auth.companyId, search, query.pageSize, offset]
        ),
        client.query(
          `
            SELECT count(*)::int AS total
            FROM stock_balances sb
            JOIN products p ON p.id = sb.product_id
            LEFT JOIN locations l ON l.id = sb.location_id
            WHERE sb.tenant_id = $1
              AND sb.company_id = $2
              AND ($3::text IS NULL OR p.product_code ILIKE $3 OR p.name ILIKE $3 OR l.code ILIKE $3)
          `,
          [auth.tenantId, auth.companyId, search]
        )
      ]);

      return { items: items.rows, page: query.page, pageSize: query.pageSize, total: total.rows[0].total };
    });
  });

  app.post('/stock/move', { preHandler: [requireAnyPermission(['stock.move', 'stock.adjust'])] }, async (request, reply) => {
    const input = stockMoveSchema.parse(request.body);
    const auth = request.auth;
    const targetCompanyId = input.companyId ?? auth.companyId;

    const result = await withTenant(auth.tenantId, auth.userId, async (client) => {
      if (['saida', 'transferencia'].includes(input.movementType)) {
        if (!input.fromLocationId) {
          throw new Error('fromLocationId e obrigatorio para saida ou transferencia.');
        }
        await decrementBalance(client, {
          tenantId: auth.tenantId,
          productId: input.productId,
          locationId: input.fromLocationId,
          lotCode: input.lotCode ?? null,
          quantity: input.quantity
        });
      }

      if (['entrada', 'alocacao', 'transferencia'].includes(input.movementType)) {
        if (!input.toLocationId) {
          throw new Error('toLocationId e obrigatorio para entrada, alocacao ou transferencia.');
        }
        await incrementBalance(client, {
          tenantId: auth.tenantId,
          companyId: targetCompanyId,
          productId: input.productId,
          locationId: input.toLocationId,
          lotCode: input.lotCode ?? null,
          quantity: input.quantity
        });
      }

      const movement = await client.query(
        `
          INSERT INTO stock_movements (
            tenant_id, company_id, product_id, from_location_id, to_location_id,
            quantity, movement_type, reason, source, user_id, metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING id, created_at
        `,
        [
          auth.tenantId,
          targetCompanyId,
          input.productId,
          input.fromLocationId ?? null,
          input.toLocationId ?? null,
          input.quantity,
          input.movementType,
          input.reason ?? null,
          input.source,
          auth.userId,
          { lotCode: input.lotCode ?? null }
        ]
      );

      await auditLog(client, { ...auth, companyId: targetCompanyId }, `stock.${input.movementType}`, 'stock_movement', movement.rows[0].id, {
        productId: input.productId,
        quantity: input.quantity
      });

      return movement.rows[0];
    });

    return reply.code(201).send(result);
  });
}
