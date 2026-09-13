import type { FastifyInstance } from 'fastify';
import { allocationConfirmSchema, existingCodeIdentifySchema, scanResolveSchema } from '@voltstock/shared';
import { auditLog } from '../../db/audit';
import { withTenant } from '../../db/tenant';
import { requireAnyPermission } from '../../http/permissions';
import { normalizeIdentifier } from '../../security/normalize';
import { createQrToken } from '../../security/qr';

export async function scanRoutes(app: FastifyInstance) {
  app.post('/scan/resolve', async (request) => {
    const input = scanResolveSchema.parse(request.body);
    const auth = request.auth;
    const normalized = normalizeIdentifier(input.scannedValue);

    return withTenant(auth.tenantId, auth.userId, async (client) => {
      let resolved:
        | {
            resolved: boolean;
            type?: string;
            entityId?: string;
            displayName?: string;
            actions?: string[];
          }
        | undefined;

      const qr = await client.query(
        `
          SELECT q.entity_type, q.entity_id, q.human_code, p.name AS product_name, l.name AS location_name, l.path AS location_path
          FROM qr_codes q
          LEFT JOIN products p ON p.id = q.entity_id AND q.entity_type = 'product'
          LEFT JOIN locations l ON l.id = q.entity_id AND q.entity_type = 'location'
          WHERE q.tenant_id = $1
            AND q.status = 'active'
            AND (q.qr_token = $2 OR upper(q.human_code) = $3)
          LIMIT 1
        `,
        [auth.tenantId, input.scannedValue, normalized]
      );

      if (qr.rowCount) {
        const row = qr.rows[0];
        resolved = {
          resolved: true,
          type: row.entity_type,
          entityId: row.entity_id,
          displayName: row.product_name ?? row.location_path ?? row.location_name ?? row.human_code,
          actions:
            row.entity_type === 'location'
              ? ['open_location', 'allocate_product', 'count', 'print_label']
              : ['open_product', 'scan_location', 'generate_label']
        };
      }

      if (!resolved) {
        const identifier = await client.query(
          `
            SELECT p.id, p.name, p.product_code
            FROM product_identifiers pi
            JOIN products p ON p.id = pi.product_id
            WHERE pi.tenant_id = $1
              AND pi.status = 'active'
              AND pi.normalized_value = $2
            LIMIT 1
          `,
          [auth.tenantId, normalized]
        );

        if (identifier.rowCount) {
          const row = identifier.rows[0];
          resolved = {
            resolved: true,
            type: 'product',
            entityId: row.id,
            displayName: `${row.product_code} - ${row.name}`,
            actions: ['open_product', 'scan_location', 'generate_label']
          };
        }
      }

      if (!resolved) {
        const product = await client.query(
          `
            SELECT id, product_code, name
            FROM products
            WHERE tenant_id = $1
              AND (upper(product_code) = $2 OR upper(sku) = $2 OR upper(barcode) = $2)
            LIMIT 1
          `,
          [auth.tenantId, normalized]
        );

        if (product.rowCount) {
          const row = product.rows[0];
          resolved = {
            resolved: true,
            type: 'product',
            entityId: row.id,
            displayName: `${row.product_code} - ${row.name}`,
            actions: ['open_product', 'scan_location', 'link_identifier', 'generate_label']
          };
        }
      }

      const finalResult = resolved ?? {
        resolved: false,
        type: 'unknown',
        displayName: input.scannedValue,
        actions: ['create_product', 'link_identifier']
      };

      await client.query(
        `
          INSERT INTO scan_events (
            tenant_id, company_id, user_id, session_id, scanned_value,
            resolved_type, resolved_entity_id, scan_source
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          auth.tenantId,
          auth.companyId,
          auth.userId,
          input.sessionId ?? null,
          input.scannedValue,
          finalResult.type ?? null,
          finalResult.entityId ?? null,
          input.source
        ]
      );

      return finalResult;
    });
  });

  app.post('/scan/existing-code/identify', async (request) => {
    const input = existingCodeIdentifySchema.parse(request.body);
    const auth = request.auth;
    const normalized = normalizeIdentifier(input.scannedValue);

    return withTenant(auth.tenantId, auth.userId, async (client) => {
      const existing = await client.query(
        `
          SELECT pi.id AS identifier_id, p.id AS product_id, p.product_code, p.name, q.qr_token
          FROM product_identifiers pi
          JOIN products p ON p.id = pi.product_id
          LEFT JOIN qr_codes q ON q.entity_type = 'product' AND q.entity_id = p.id
          WHERE pi.tenant_id = $1 AND pi.normalized_value = $2 AND pi.status = 'active'
          LIMIT 1
        `,
        [auth.tenantId, normalized]
      );

      if (existing.rowCount) {
        const row = existing.rows[0];
        return {
          resolved: true,
          matchType: 'existing_product',
          externalIdentifierId: row.identifier_id,
          productId: row.product_id,
          internalQrToken: row.qr_token,
          displayName: `${row.product_code} - ${row.name}`,
          actions: ['open_product', 'link_identifier', 'generate_label', 'scan_location']
        };
      }

      if (input.linkToProductId && input.createInternalIdentifier) {
        const product = await client.query('SELECT id, company_id, product_code, name FROM products WHERE tenant_id = $1 AND id = $2', [
          auth.tenantId,
          input.linkToProductId
        ]);

        if (!product.rowCount) {
          return { resolved: false, matchType: 'new_product_required', actions: ['create_product'] };
        }

        const row = product.rows[0];
        const identifier = await client.query(
          `
            INSERT INTO product_identifiers (
              tenant_id, company_id, product_id, identifier_type, raw_value,
              normalized_value, source, provider_name, created_by
            )
            VALUES ($1, $2, $3, $4, $5, $6, 'manual_scan', $7, $8)
            ON CONFLICT (tenant_id, identifier_type, normalized_value, source)
            DO UPDATE SET product_id = EXCLUDED.product_id, updated_at = now()
            RETURNING id
          `,
          [auth.tenantId, row.company_id, row.id, input.codeFormat, input.scannedValue, normalized, input.source, auth.userId]
        );

        let qr = await client.query("SELECT qr_token FROM qr_codes WHERE tenant_id = $1 AND entity_type = 'product' AND entity_id = $2", [
          auth.tenantId,
          row.id
        ]);

        if (!qr.rowCount) {
          qr = await client.query(
            `
              INSERT INTO qr_codes (tenant_id, company_id, entity_type, entity_id, qr_token, human_code, payload)
              VALUES ($1, $2, 'product', $3, $4, $5, $6)
              RETURNING qr_token
            `,
            [auth.tenantId, row.company_id, row.id, createQrToken('product'), `VS-PROD-${row.product_code}`, { source: 'existing_code_identify' }]
          );
        }

        await auditLog(client, { ...auth, companyId: row.company_id }, 'product_identifier.linked', 'product', row.id, {
          codeFormat: input.codeFormat
        });

        return {
          resolved: true,
          matchType: 'existing_product',
          externalIdentifierId: identifier.rows[0].id,
          productId: row.id,
          internalQrToken: qr.rows[0].qr_token,
          actions: ['open_product', 'generate_label', 'scan_location']
        };
      }

      return {
        resolved: false,
        matchType: 'new_product_required',
        actions: ['create_product', 'link_identifier', 'scan_location_after_create']
      };
    });
  });

  app.post('/scan/allocation/confirm', { preHandler: [requireAnyPermission(['stock.move'])] }, async (request, reply) => {
    const input = allocationConfirmSchema.parse(request.body);
    const auth = request.auth;
    const targetCompanyId = input.companyId ?? auth.companyId;

    const result = await withTenant(auth.tenantId, auth.userId, async (client) => {
      const movement = await client.query(
        `
          INSERT INTO stock_movements (
            tenant_id, company_id, product_id, to_location_id, quantity,
            movement_type, reason, source, user_id, metadata
          )
          VALUES ($1, $2, $3, $4, $5, 'alocacao', 'Alocacao por bipagem', 'scan', $6, $7)
          RETURNING id, created_at
        `,
        [auth.tenantId, targetCompanyId, input.productId, input.locationId, input.quantity, auth.userId, { flowType: input.flowType, lotCode: input.lotCode ?? null }]
      );

      await client.query(
        `
          INSERT INTO stock_balances (tenant_id, company_id, product_id, location_id, lot_code, quantity)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (tenant_id, product_id, location_scope, container_scope, lot_scope)
          DO UPDATE SET quantity = stock_balances.quantity + EXCLUDED.quantity, updated_at = now()
        `,
        [auth.tenantId, targetCompanyId, input.productId, input.locationId, input.lotCode ?? null, input.quantity]
      );

      await client.query(
        `
          INSERT INTO allocation_sessions (
            tenant_id, company_id, user_id, status, flow_type, product_id, location_id, quantity, confirmed_at
          )
          VALUES ($1, $2, $3, 'confirmed', $4, $5, $6, $7, now())
        `,
        [auth.tenantId, targetCompanyId, auth.userId, input.flowType, input.productId, input.locationId, input.quantity]
      );

      await auditLog(client, { ...auth, companyId: targetCompanyId }, 'stock.allocated', 'stock_movement', movement.rows[0].id, {
        productId: input.productId,
        locationId: input.locationId,
        quantity: input.quantity
      });

      return { movementId: movement.rows[0].id, confirmedAt: movement.rows[0].created_at };
    });

    return reply.code(201).send(result);
  });
}
