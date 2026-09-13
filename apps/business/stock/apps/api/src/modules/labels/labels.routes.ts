import type { FastifyInstance } from 'fastify';
import { labelRequestSchema } from '@voltstock/shared';
import { auditLog } from '../../db/audit';
import { withTenant, type TenantClient } from '../../db/tenant';
import { requireAnyPermission } from '../../http/permissions';
import { createQrToken } from '../../security/qr';
import { createLabelsPdf, type LabelEntity } from './pdf';

type EntityRow = {
  id: string;
  entity_type: 'product' | 'location';
  primary_code: string;
  title: string;
  subtitle: string | null;
  barcode: string | null;
  qr_token: string | null;
  human_code: string | null;
};

async function ensureQr(client: TenantClient, tenantId: string, companyId: string, row: EntityRow) {
  if (row.qr_token && row.human_code) {
    return {
      qrToken: row.qr_token,
      humanCode: row.human_code
    };
  }

  const humanPrefix = row.entity_type === 'product' ? 'VS-PROD' : 'VS-LOC';
  const qr = await client.query(
    `
      INSERT INTO qr_codes (tenant_id, company_id, entity_type, entity_id, qr_token, human_code, payload)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (tenant_id, entity_type, entity_id)
      DO UPDATE SET status = 'active'
      RETURNING qr_token, human_code
    `,
    [
      tenantId,
      companyId,
      row.entity_type,
      row.id,
      createQrToken(row.entity_type),
      `${humanPrefix}-${row.primary_code}`,
      { source: 'label_generation' }
    ]
  );

  return {
    qrToken: qr.rows[0].qr_token as string,
    humanCode: qr.rows[0].human_code as string
  };
}

async function loadEntities(
  client: TenantClient,
  tenantId: string,
  companyId: string,
  targetEntity: 'product' | 'location',
  entityIds: string[]
): Promise<LabelEntity[]> {
  const query =
    targetEntity === 'product'
      ? `
          SELECT
            p.id,
            'product'::text AS entity_type,
            p.product_code AS primary_code,
            p.name AS title,
            NULLIF(CONCAT_WS(' / ', p.sku, p.category), '') AS subtitle,
            p.barcode,
            q.qr_token,
            q.human_code
          FROM products p
          LEFT JOIN qr_codes q ON q.tenant_id = p.tenant_id AND q.entity_type = 'product' AND q.entity_id = p.id
          WHERE p.tenant_id = $1 AND p.company_id = $2 AND p.id = ANY($3::uuid[])
          ORDER BY p.product_code
        `
      : `
          SELECT
            l.id,
            'location'::text AS entity_type,
            l.code AS primary_code,
            l.name AS title,
            l.path AS subtitle,
            NULL::text AS barcode,
            q.qr_token,
            q.human_code
          FROM locations l
          LEFT JOIN qr_codes q ON q.tenant_id = l.tenant_id AND q.entity_type = 'location' AND q.entity_id = l.id
          WHERE l.tenant_id = $1 AND l.company_id = $2 AND l.id = ANY($3::uuid[])
          ORDER BY l.path
        `;

  const result = await client.query<EntityRow>(query, [tenantId, companyId, entityIds]);
  const entities: LabelEntity[] = [];

  for (const row of result.rows) {
    const qr = await ensureQr(client, tenantId, companyId, row);
    entities.push({
      id: row.id,
      entityType: row.entity_type,
      primaryCode: row.primary_code,
      title: row.title,
      subtitle: row.subtitle,
      barcode: row.barcode,
      qrToken: qr.qrToken,
      humanCode: qr.humanCode
    });
  }

  return entities;
}

function pdfPayload(buffer: Buffer, fileName: string, labelCount: number) {
  const base64 = buffer.toString('base64');

  return {
    fileName,
    mimeType: 'application/pdf',
    labelCount,
    sizeBytes: buffer.length,
    base64,
    dataUrl: `data:application/pdf;base64,${base64}`
  };
}

export async function labelRoutes(app: FastifyInstance) {
  app.post('/labels/preview', { preHandler: [requireAnyPermission(['labels.manage', 'labels.print'])] }, async (request, reply) => {
    const input = labelRequestSchema.parse(request.body);
    const auth = request.auth;
    const targetCompanyId = input.companyId ?? auth.companyId;

    const entities = await withTenant(auth.tenantId, auth.userId, async (client) => {
      const rows = await loadEntities(client, auth.tenantId, targetCompanyId, input.targetEntity, input.entityIds);

      if (rows.length) {
        await auditLog(client, { ...auth, companyId: targetCompanyId }, 'label.preview_generated', 'label_template', null, {
          targetEntity: input.targetEntity,
          labels: rows.length,
          copies: input.copies
        });
      }

      return rows;
    });

    if (!entities.length) {
      return reply.code(404).send({ error: 'not_found', message: 'Nenhum item encontrado para gerar etiquetas.' });
    }

    const pdf = await createLabelsPdf(entities, input);
    return pdfPayload(pdf, `voltstock-etiquetas-${input.targetEntity}-preview.pdf`, entities.length * input.copies);
  });

  app.post('/labels/print-job', { preHandler: [requireAnyPermission(['labels.manage', 'labels.print'])] }, async (request, reply) => {
    const input = labelRequestSchema.parse(request.body);
    const auth = request.auth;
    const targetCompanyId = input.companyId ?? auth.companyId;

    const entities = await withTenant(auth.tenantId, auth.userId, async (client) =>
      loadEntities(client, auth.tenantId, targetCompanyId, input.targetEntity, input.entityIds)
    );

    if (!entities.length) {
      return reply.code(404).send({ error: 'not_found', message: 'Nenhum item encontrado para gerar etiquetas.' });
    }

    const pdf = await createLabelsPdf(entities, input);
    const payload = pdfPayload(pdf, `voltstock-etiquetas-${input.targetEntity}.pdf`, entities.length * input.copies);

    const job = await withTenant(auth.tenantId, auth.userId, async (client) => {
      const result = await client.query(
        `
          INSERT INTO label_print_jobs (
            tenant_id, company_id, requested_by, status, printer_profile, payload
          )
          VALUES ($1, $2, $3, 'completed', $4, $5)
          RETURNING id, status, created_at
        `,
        [
          auth.tenantId,
          targetCompanyId,
          auth.userId,
          { pageFormat: input.pageFormat, templateName: input.templateName },
          {
            targetEntity: input.targetEntity,
            entityIds: input.entityIds,
            copies: input.copies,
            labelCount: payload.labelCount,
            fileName: payload.fileName,
            sizeBytes: payload.sizeBytes
          }
        ]
      );

      await auditLog(client, { ...auth, companyId: targetCompanyId }, 'label.print_job_completed', 'label_print_job', result.rows[0].id, {
        targetEntity: input.targetEntity,
        labels: payload.labelCount,
        fileName: payload.fileName
      });

      return result.rows[0];
    });

    return reply.code(201).send({ job, ...payload });
  });
}
