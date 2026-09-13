"use strict";

const db = require("../../db/db");
const sourceService = require("./anuncioSourceService");
const { httpError, normalizeText } = require("./helpers");

const GROUP_BATCH_COPY = "batch_copy";
const GROUP_FAMILY_CLONE = "family_clone";

function ensureScope(ctx = {}) {
  if (!ctx.meliContaId) throw httpError("Selecione uma conta Mercado Livre para usar o Cadastro de anúncios.", 409);
  if (!ctx.empresaId) throw httpError("Empresa não identificada para o Cadastro de anúncios.", 409);
}

function validateQuantity(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10) {
    throw httpError("A quantidade deve ser um número inteiro entre 1 e 10.", 400, null, "INVALID_BATCH_QUANTITY");
  }
  return value;
}

function suggestedGroupName(label, now = new Date(), prefix = "Cópias de") {
  const safe = normalizeText(label, 180) || "anúncio";
  const stamp = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
  return `${prefix} ${safe} · ${stamp}`.slice(0, 240);
}

function sanitizeDraftData(data = {}, { restoreIdentifiers = false } = {}) {
  const next = JSON.parse(JSON.stringify(data || {}));
  if (restoreIdentifiers) {
    if (!next.sku && next.original_sku) next.sku = next.original_sku;
    if (!next.gtin && next.original_gtin) next.gtin = next.original_gtin;
  }
  delete next.original_sku;
  delete next.original_gtin;
  delete next.id;
  delete next.status;
  delete next.validation_status;
  delete next.validation_hash;
  delete next.validation_data;
  delete next.published_item_id;
  delete next.published_user_product_id;
  delete next.published_family_id;
  delete next.published_permalink;
  delete next.published_at;
  delete next.last_publish_result;
  delete next.validated_at;
  delete next.deleted_at;
  delete next.created_at;
  delete next.updated_at;
  delete next.draft_group_id;
  delete next.lock;
  delete next.locks;
  delete next.revision;
  return next;
}

function draftInsertFromSource(source, overrides = {}) {
  const data = sanitizeDraftData(source.draft_data || {}, { restoreIdentifiers: Boolean(overrides.restoreIdentifiers) });
  return {
    source_type: overrides.source_type || "draft_copy",
    source_item_id: overrides.source_item_id ?? source.source_item_id ?? source.source_snapshot?.id ?? null,
    source_user_product_id: overrides.source_user_product_id ?? source.source_user_product_id ?? source.source_snapshot?.user_product_id ?? null,
    source_family_id: overrides.source_family_id ?? source.source_family_id ?? source.source_snapshot?.family_id ?? null,
    source_seller_id: overrides.source_seller_id ?? source.source_seller_id ?? source.source_snapshot?.seller_id ?? null,
    source_snapshot: overrides.source_snapshot || source.source_snapshot || {},
    reference_data: overrides.reference_data || source.reference_data || {},
    publication_model: overrides.publication_model || source.publication_model || "legacy",
    publication_target: overrides.publication_target || source.publication_target || "new_item",
    category_id: normalizeText(overrides.category_id ?? data.category_id ?? source.category_id, 80) || null,
    family_name: normalizeText(overrides.family_name ?? data.family_name ?? source.family_name, 180) || null,
    title: normalizeText(overrides.title ?? data.title ?? source.title, 180) || null,
    draft_data: data,
  };
}

async function createGroupWithDrafts({ group, drafts }, ctx) {
  ensureScope(ctx);
  if (!Array.isArray(drafts) || !drafts.length) throw httpError("Nenhum rascunho foi informado para o grupo.", 400);
  if (drafts.length > 10) throw httpError("Cada ação pode criar no máximo 10 rascunhos.", 400, null, "GROUP_DRAFT_LIMIT");

  return db.withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const groupResult = await client.query(
        `insert into ml.anuncio_draft_groups
          (empresa_id, meli_conta_id, type, source_draft_id, source_item_id, source_user_product_id,
           source_family_id, source_label, name, requested_quantity, family_blueprint, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
         returning *`,
        [ctx.empresaId, ctx.meliContaId, group.type, group.source_draft_id || null, group.source_item_id || null,
          group.source_user_product_id || null, group.source_family_id || null, normalizeText(group.source_label, 240) || null,
          normalizeText(group.name, 240), drafts.length, group.family_blueprint ? JSON.stringify(group.family_blueprint) : null, ctx.userId],
      );
      const createdGroup = groupResult.rows[0];
      const createdDrafts = [];
      for (const draft of drafts) {
        const result = await client.query(
          `insert into ml.anuncio_drafts
            (empresa_id, meli_conta_id, created_by, updated_by, draft_group_id,
             source_type, source_item_id, source_user_product_id, source_family_id, source_seller_id,
             source_snapshot, reference_data, publication_model, publication_target,
             category_id, family_name, title, status, validation_status, draft_data)
           values ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,'review','pending',$17::jsonb)
           returning *`,
          [ctx.empresaId, ctx.meliContaId, ctx.userId, createdGroup.id,
            draft.source_type || "draft_copy", draft.source_item_id || null, draft.source_user_product_id || null,
            draft.source_family_id || null, draft.source_seller_id || null, JSON.stringify(draft.source_snapshot || {}),
            JSON.stringify(draft.reference_data || {}), draft.publication_model || "legacy", draft.publication_target || "new_item",
            draft.category_id || null, draft.family_name || null, draft.title || null, JSON.stringify(sanitizeDraftData(draft.draft_data || {}))],
        );
        createdDrafts.push(result.rows[0]);
      }
      await client.query("COMMIT");
      return { group: createdGroup, drafts: createdDrafts };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => null);
      throw error;
    }
  });
}

async function createBatchCopies(input = {}, ctx) {
  ensureScope(ctx);
  const quantity = validateQuantity(input.quantity);
  const sourceKind = normalizeText(input.source_type, 20).toLowerCase();
  let source;
  let groupSource;

  if (sourceKind === "draft") {
    const id = Number(input.source_id);
    if (!Number.isFinite(id) || id <= 0) throw httpError("Rascunho de origem inválido.", 400);
    const result = await db.query(
      `select * from ml.anuncio_drafts
        where id=$1 and empresa_id=$2 and meli_conta_id=$3 and deleted_at is null
        limit 1`,
      [id, ctx.empresaId, ctx.meliContaId],
    );
    if (!result.rowCount) throw httpError("Rascunho de origem não encontrado.", 404);
    source = result.rows[0];
    if (source.status === "publishing") throw httpError("Aguarde a publicação atual antes de criar cópias deste rascunho.", 409);
    const label = source.family_name || source.title || source.draft_data?.family_name || source.draft_data?.title || `Rascunho #${id}`;
    groupSource = {
      source_draft_id: id,
      source_item_id: source.source_item_id || null,
      source_user_product_id: source.source_user_product_id || null,
      source_family_id: source.source_family_id || null,
      source_label: label,
    };
    source = draftInsertFromSource(source, {
      source_type: "draft_copy",
      source_snapshot: { ...(source.source_snapshot || {}), copied_from_draft_id: id },
    });
  } else if (sourceKind === "item") {
    const resolved = await sourceService.resolveItem(input.source_id, ctx);
    if (resolved.source_type !== "own_item") {
      throw httpError("Criar cópias em lote de anúncio publicado só é permitido para anúncios da conta selecionada.", 403, null, "BATCH_SOURCE_NOT_OWNED");
    }
    const snap = resolved.source_snapshot || {};
    const label = snap.family_name || snap.title || snap.id || "anúncio";
    groupSource = {
      source_item_id: snap.id || null,
      source_user_product_id: snap.user_product_id || null,
      source_family_id: snap.family_id || null,
      source_label: label,
    };
    source = draftInsertFromSource({
      ...resolved,
      source_item_id: snap.id,
      source_user_product_id: snap.user_product_id,
      source_family_id: snap.family_id,
      source_seller_id: snap.seller_id,
      publication_target: "new_item",
    }, {
      source_type: "draft_copy",
      publication_target: "new_item",
      restoreIdentifiers: true,
      source_snapshot: { ...(resolved.source_snapshot || {}), batch_copy_from_published_item: true },
    });
  } else {
    throw httpError("Origem de cópia em lote inválida. Use 'draft' ou 'item'.", 400);
  }

  const defaultName = suggestedGroupName(groupSource.source_label);
  const name = normalizeText(input.name, 240) || defaultName;
  const drafts = Array.from({ length: quantity }, () => JSON.parse(JSON.stringify(source)));
  const created = await createGroupWithDrafts({
    group: { type: GROUP_BATCH_COPY, ...groupSource, name },
    drafts,
  }, ctx);
  return { ...created, warning: source.publication_target === "sale_condition"
    ? "As cópias criarão novas condições de venda para o mesmo User Product da origem."
    : null };
}

async function listGroups(query = {}, ctx) {
  ensureScope(ctx);
  const type = normalizeText(query.type, 30);
  const params = [ctx.empresaId, ctx.meliContaId];
  const where = ["g.empresa_id=$1", "g.meli_conta_id=$2", "exists (select 1 from ml.anuncio_drafts d where d.draft_group_id=g.id and d.empresa_id=g.empresa_id and d.meli_conta_id=g.meli_conta_id)"];
  if ([GROUP_BATCH_COPY, GROUP_FAMILY_CLONE].includes(type)) {
    params.push(type);
    where.push(`g.type=$${params.length}`);
  }
  const result = await db.query(
    `select g.*, count(d.id)::int as draft_count,
            count(d.id) filter (where d.published_item_id is not null)::int as published_count,
            count(d.id) filter (where d.published_family_id is not null and g.expected_published_family_id is not null and d.published_family_id <> g.expected_published_family_id)::int as divergence_count
       from ml.anuncio_draft_groups g
       left join ml.anuncio_drafts d on d.draft_group_id=g.id and d.empresa_id=g.empresa_id and d.meli_conta_id=g.meli_conta_id
      where ${where.join(" and ")}
      group by g.id
      order by g.updated_at desc, g.id desc
      limit 200`,
    params,
  );
  return result.rows;
}

async function getGroup(id, ctx) {
  ensureScope(ctx);
  const groupId = Number(id);
  if (!Number.isFinite(groupId) || groupId <= 0) throw httpError("Grupo inválido.", 400);
  const result = await db.query(
    `select g.*, count(d.id)::int as draft_count,
            count(d.id) filter (where d.published_item_id is not null)::int as published_count,
            count(d.id) filter (where d.published_family_id is not null and g.expected_published_family_id is not null and d.published_family_id <> g.expected_published_family_id)::int as divergence_count
       from ml.anuncio_draft_groups g
       left join ml.anuncio_drafts d on d.draft_group_id=g.id and d.empresa_id=g.empresa_id and d.meli_conta_id=g.meli_conta_id
      where g.id=$1 and g.empresa_id=$2 and g.meli_conta_id=$3
      group by g.id limit 1`,
    [groupId, ctx.empresaId, ctx.meliContaId],
  );
  if (!result.rowCount) throw httpError("Grupo não encontrado.", 404);
  return result.rows[0];
}

async function recordPublishedFamily(groupId, familyId, ctx) {
  if (!groupId || !familyId) return { expected_family_id: null, divergent: false };
  ensureScope(ctx);
  const normalized = normalizeText(familyId, 120);
  return db.withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const found = await client.query(
        `select * from ml.anuncio_draft_groups
          where id=$1 and empresa_id=$2 and meli_conta_id=$3
          for update`,
        [Number(groupId), ctx.empresaId, ctx.meliContaId],
      );
      if (!found.rowCount || found.rows[0].type !== GROUP_FAMILY_CLONE) {
        await client.query("COMMIT");
        return { expected_family_id: null, divergent: false };
      }
      const current = found.rows[0];
      const expected = normalizeText(current.expected_published_family_id, 120) || normalized;
      if (!current.expected_published_family_id) {
        await client.query(
          `update ml.anuncio_draft_groups
              set expected_published_family_id=$4, updated_at=now()
            where id=$1 and empresa_id=$2 and meli_conta_id=$3`,
          [current.id, ctx.empresaId, ctx.meliContaId, normalized],
        );
      } else {
        await client.query(
          `update ml.anuncio_draft_groups set updated_at=now()
            where id=$1 and empresa_id=$2 and meli_conta_id=$3`,
          [current.id, ctx.empresaId, ctx.meliContaId],
        );
      }
      await client.query("COMMIT");
      return { expected_family_id: expected, divergent: Boolean(expected && normalized && expected !== normalized) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => null);
      throw error;
    }
  });
}

module.exports = {
  GROUP_BATCH_COPY,
  GROUP_FAMILY_CLONE,
  validateQuantity,
  suggestedGroupName,
  sanitizeDraftData,
  draftInsertFromSource,
  createGroupWithDrafts,
  createBatchCopies,
  listGroups,
  getGroup,
  recordPublishedFamily,
};
