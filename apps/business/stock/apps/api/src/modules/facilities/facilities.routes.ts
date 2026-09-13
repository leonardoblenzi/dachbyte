import type { FastifyInstance } from 'fastify';
import { bulkGenerateLocationsSchema, createFacilitySchema } from '@voltstock/shared';
import { auditLog } from '../../db/audit';
import { withTenant } from '../../db/tenant';
import { requireAnyPermission } from '../../http/permissions';
import { createQrToken } from '../../security/qr';

type LocationRow = {
  id: string;
  parent_id: string | null;
  code: string;
  name: string;
  location_type: string;
  status: string;
  path: string;
  depth: number;
};

function buildTree(rows: LocationRow[]) {
  const byId = new Map<string, LocationRow & { children: LocationRow[] }>();
  const roots: Array<LocationRow & { children: LocationRow[] }> = [];

  for (const row of rows) {
    byId.set(row.id, { ...row, children: [] });
  }

  for (const row of byId.values()) {
    if (row.parent_id && byId.has(row.parent_id)) {
      byId.get(row.parent_id)!.children.push(row);
    } else {
      roots.push(row);
    }
  }

  return roots;
}

export async function facilityRoutes(app: FastifyInstance) {
  app.get('/facilities', async (request) => {
    const { tenantId, userId, companyId } = request.auth;

    return withTenant(tenantId, userId, async (client) => {
      const result = await client.query(
        `
          SELECT id, code, name, facility_type AS "facilityType", status, dimensions
          FROM facilities
          WHERE tenant_id = $1 AND company_id = $2
          ORDER BY code
        `,
        [tenantId, companyId]
      );
      return { items: result.rows };
    });
  });

  app.post('/facilities', { preHandler: [requireAnyPermission(['map.manage'])] }, async (request, reply) => {
    const input = createFacilitySchema.parse(request.body);
    const auth = request.auth;
    const targetCompanyId = input.companyId ?? auth.companyId;

    const facility = await withTenant(auth.tenantId, auth.userId, async (client) => {
      const result = await client.query(
        `
          INSERT INTO facilities (tenant_id, company_id, branch_id, code, name, facility_type, dimensions)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id, code, name, facility_type AS "facilityType", status, dimensions
        `,
        [auth.tenantId, targetCompanyId, input.branchId ?? auth.branchId ?? null, input.code, input.name, input.facilityType, input.dimensions]
      );

      const location = await client.query(
        `
          INSERT INTO locations (tenant_id, company_id, branch_id, facility_id, code, name, location_type, path, depth, status)
          VALUES ($1, $2, $3, $4, $5, $6, 'hangar', $5, 0, 'available')
          ON CONFLICT (tenant_id, facility_id, code) DO UPDATE SET name = EXCLUDED.name
          RETURNING id, code
        `,
        [auth.tenantId, targetCompanyId, input.branchId ?? auth.branchId ?? null, result.rows[0].id, input.code, input.name]
      );

      await client.query(
        `
          INSERT INTO qr_codes (tenant_id, company_id, entity_type, entity_id, qr_token, human_code, payload)
          VALUES ($1, $2, 'location', $3, $4, $5, $6)
          ON CONFLICT (tenant_id, entity_type, entity_id) DO NOTHING
        `,
        [auth.tenantId, targetCompanyId, location.rows[0].id, createQrToken('location'), `VS-LOC-${location.rows[0].code}`, { source: 'facility_create' }]
      );

      await auditLog(client, { ...auth, companyId: targetCompanyId }, 'facility.created', 'facility', result.rows[0].id, {
        code: input.code
      });

      return result.rows[0];
    });

    return reply.code(201).send(facility);
  });

  app.get('/locations/tree', async (request) => {
    const { facilityId } = request.query as { facilityId?: string };
    const { tenantId, userId, companyId } = request.auth;

    return withTenant(tenantId, userId, async (client) => {
      const result = await client.query(
        `
          SELECT id, parent_id, code, name, location_type, status, path, depth
          FROM locations
          WHERE tenant_id = $1
            AND company_id = $2
            AND ($3::uuid IS NULL OR facility_id = $3)
          ORDER BY depth, code
        `,
        [tenantId, companyId, facilityId ?? null]
      );

      return { items: buildTree(result.rows) };
    });
  });

  app.post('/locations/bulk-generate', { preHandler: [requireAnyPermission(['map.manage'])] }, async (request, reply) => {
    const input = bulkGenerateLocationsSchema.parse(request.body);
    const auth = request.auth;
    const targetCompanyId = input.companyId ?? auth.companyId;

    const result = await withTenant(auth.tenantId, auth.userId, async (client) => {
      const parent = input.parentLocationId
        ? await client.query('SELECT id, code, path, depth FROM locations WHERE tenant_id = $1 AND id = $2', [auth.tenantId, input.parentLocationId])
        : await client.query('SELECT id, code, path, depth FROM locations WHERE tenant_id = $1 AND facility_id = $2 AND depth = 0 LIMIT 1', [
            auth.tenantId,
            input.facilityId
          ]);

      if (!parent.rowCount) {
        throw new Error('Localizacao pai nao encontrada para gerar a estrutura.');
      }

      const parentRow = parent.rows[0];
      const rackCode = `${parentRow.code}-${input.aisleCode}-${input.rackCode}`.replace(/--+/g, '-');
      const rack = await client.query(
        `
          INSERT INTO locations (tenant_id, company_id, branch_id, facility_id, parent_id, code, name, location_type, path, depth, capacity_quantity, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'rack', $8, $9, $10, 'available')
          ON CONFLICT (tenant_id, facility_id, code)
          DO UPDATE SET name = EXCLUDED.name
          RETURNING id, code, path
        `,
        [
          auth.tenantId,
          targetCompanyId,
          input.branchId ?? auth.branchId ?? null,
          input.facilityId,
          parentRow.id,
          rackCode,
          input.rackName,
          `${parentRow.path}/${rackCode}`,
          parentRow.depth + 1,
          input.columns * input.levels * input.binsPerLevel * (input.capacityPerBin ?? 1)
        ]
      );

      const generated = [];
      for (let column = 1; column <= input.columns; column += 1) {
        for (let level = 1; level <= input.levels; level += 1) {
          for (let bin = 1; bin <= input.binsPerLevel; bin += 1) {
            const code = `${rackCode}-C${String(column).padStart(2, '0')}-N${String(level).padStart(2, '0')}-BIN${String(bin).padStart(2, '0')}`;
            const inserted = await client.query(
              `
                INSERT INTO locations (
                  tenant_id, company_id, branch_id, facility_id, parent_id, code, name,
                  location_type, path, depth, capacity_quantity, coordinates, status
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, 'bin', $8, $9, $10, $11, 'available')
                ON CONFLICT (tenant_id, facility_id, code)
                DO UPDATE SET name = EXCLUDED.name, capacity_quantity = EXCLUDED.capacity_quantity
                RETURNING id, code
              `,
              [
                auth.tenantId,
                targetCompanyId,
                input.branchId ?? auth.branchId ?? null,
                input.facilityId,
                rack.rows[0].id,
                code,
                `Coluna ${column} Nivel ${level} Bin ${bin}`,
                `${rack.rows[0].path}/${code}`,
                parentRow.depth + 2,
                input.capacityPerBin ?? null,
                { column, level, bin }
              ]
            );

            const location = inserted.rows[0];
            generated.push(location);
            await client.query(
              `
                INSERT INTO qr_codes (tenant_id, company_id, entity_type, entity_id, qr_token, human_code, payload)
                VALUES ($1, $2, 'location', $3, $4, $5, $6)
                ON CONFLICT (tenant_id, entity_type, entity_id) DO NOTHING
              `,
              [auth.tenantId, targetCompanyId, location.id, createQrToken('location'), `VS-LOC-${location.code}`, { generated: true }]
            );
          }
        }
      }

      await auditLog(client, { ...auth, companyId: targetCompanyId }, 'location.bulk_generated', 'facility', input.facilityId, {
        rackCode,
        generated: generated.length
      });

      return { rack: rack.rows[0], generatedCount: generated.length, locations: generated };
    });

    return reply.code(201).send(result);
  });
}
