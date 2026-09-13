import type { FastifyInstance } from 'fastify';
import { createProductSchema, paginationSchema, updateProductSchema } from '@voltstock/shared';
import { auditLog } from '../../db/audit';
import { withTenant } from '../../db/tenant';
import { requireAnyPermission } from '../../http/permissions';
import { normalizeIdentifier } from '../../security/normalize';
import { createQrToken } from '../../security/qr';

export async function productRoutes(app: FastifyInstance) {
  app.get('/products', async (request) => {
    const query = paginationSchema.parse(request.query);
    const { tenantId, userId, companyId } = request.auth;
    const offset = (query.page - 1) * query.pageSize;
    const search = query.q ? `%${query.q}%` : null;

    return withTenant(tenantId, userId, async (client) => {
      const [items, total] = await Promise.all([
        client.query(
          `
            SELECT
              p.id,
              p.product_code AS "productCode",
              p.sku,
              p.barcode,
              p.name,
              p.category,
              p.brand,
              p.unit,
              p.tracking_mode AS "trackingMode",
              p.status,
              COALESCE(sum(sb.quantity), 0)::numeric AS quantity
            FROM products p
            LEFT JOIN stock_balances sb ON sb.product_id = p.id AND sb.tenant_id = p.tenant_id
            WHERE p.tenant_id = $1
              AND p.company_id = $2
              AND ($3::text IS NULL OR p.product_code ILIKE $3 OR p.sku ILIKE $3 OR p.barcode ILIKE $3 OR p.name ILIKE $3)
            GROUP BY p.id
            ORDER BY p.created_at DESC
            LIMIT $4 OFFSET $5
          `,
          [tenantId, companyId, search, query.pageSize, offset]
        ),
        client.query(
          `
            SELECT count(*)::int AS total
            FROM products p
            WHERE p.tenant_id = $1
              AND p.company_id = $2
              AND ($3::text IS NULL OR p.product_code ILIKE $3 OR p.sku ILIKE $3 OR p.barcode ILIKE $3 OR p.name ILIKE $3)
          `,
          [tenantId, companyId, search]
        )
      ]);

      return {
        items: items.rows,
        page: query.page,
        pageSize: query.pageSize,
        total: total.rows[0].total
      };
    });
  });

  app.post('/products', { preHandler: [requireAnyPermission(['products.manage', 'products.create'])] }, async (request, reply) => {
    const input = createProductSchema.parse(request.body);
    const auth = request.auth;
    const targetCompanyId = input.companyId ?? auth.companyId;

    const product = await withTenant(auth.tenantId, auth.userId, async (client) => {
      const inserted = await client.query(
        `
          INSERT INTO products (
            tenant_id, company_id, product_code, sku, barcode, name, description,
            category, brand, unit, tracking_mode, cost_amount
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          RETURNING id, product_code AS "productCode", sku, barcode, name, category, unit, tracking_mode AS "trackingMode"
        `,
        [
          auth.tenantId,
          targetCompanyId,
          input.productCode,
          input.sku ?? null,
          input.barcode ?? null,
          input.name,
          input.description ?? null,
          input.category ?? null,
          input.brand ?? null,
          input.unit,
          input.trackingMode,
          input.costAmount ?? null
        ]
      );

      const row = inserted.rows[0];
      const token = createQrToken('product');

      await client.query(
        `
          INSERT INTO qr_codes (tenant_id, company_id, entity_type, entity_id, qr_token, human_code, payload)
          VALUES ($1, $2, 'product', $3, $4, $5, $6)
        `,
        [
          auth.tenantId,
          targetCompanyId,
          row.id,
          token,
          `VS-PROD-${input.productCode}`,
          { productCode: input.productCode }
        ]
      );

      if (input.barcode) {
        await client.query(
          `
            INSERT INTO product_identifiers (
              tenant_id, company_id, product_id, identifier_type, raw_value,
              normalized_value, source, is_primary, created_by
            )
            VALUES ($1, $2, $3, 'barcode', $4, $5, 'product_create', true, $6)
            ON CONFLICT (tenant_id, identifier_type, normalized_value, source) DO NOTHING
          `,
          [auth.tenantId, targetCompanyId, row.id, input.barcode, normalizeIdentifier(input.barcode), auth.userId]
        );
      }

      await auditLog(client, { ...auth, companyId: targetCompanyId }, 'product.created', 'product', row.id, {
        productCode: input.productCode
      });

      return { ...row, qrToken: token, humanCode: `VS-PROD-${input.productCode}` };
    });

    return reply.code(201).send(product);
  });

  app.patch('/products/:id', { preHandler: [requireAnyPermission(['products.manage'])] }, async (request) => {
    const { id } = request.params as { id: string };
    const input = updateProductSchema.parse(request.body);
    const auth = request.auth;

    return withTenant(auth.tenantId, auth.userId, async (client) => {
      const result = await client.query(
        `
          UPDATE products
          SET
            sku = COALESCE($3, sku),
            barcode = COALESCE($4, barcode),
            name = COALESCE($5, name),
            description = COALESCE($6, description),
            category = COALESCE($7, category),
            brand = COALESCE($8, brand),
            unit = COALESCE($9, unit),
            tracking_mode = COALESCE($10, tracking_mode),
            cost_amount = COALESCE($11, cost_amount)
          WHERE tenant_id = $1 AND id = $2
          RETURNING id, product_code AS "productCode", sku, barcode, name, category, unit, tracking_mode AS "trackingMode", status
        `,
        [
          auth.tenantId,
          id,
          input.sku ?? null,
          input.barcode ?? null,
          input.name ?? null,
          input.description ?? null,
          input.category ?? null,
          input.brand ?? null,
          input.unit ?? null,
          input.trackingMode ?? null,
          input.costAmount ?? null
        ]
      );

      if (!result.rowCount) {
        return { error: 'not_found' };
      }

      await auditLog(client, auth, 'product.updated', 'product', id, { fields: Object.keys(input) });
      return result.rows[0];
    });
  });
}
