"use strict";

const db = require("../../db/db");
const sourceService = require("./anuncioSourceService");
const capabilitiesService = require("./anuncioCapabilitiesService");
const { httpError, normalizeText } = require("./helpers");

function ensureScope(ctx) {
  if (!ctx.meliContaId) throw httpError("Selecione uma conta Mercado Livre para usar o Cadastro de anúncios.", 409);
  if (!ctx.empresaId) throw httpError("Empresa não identificada para o Cadastro de anúncios.", 409);
}

function rowToDraft(row) {
  if (!row) return null;
  const draft = {
    ...row,
    id: Number(row.id),
    meli_conta_id: Number(row.meli_conta_id),
    empresa_id: row.empresa_id != null ? Number(row.empresa_id) : null,
    source_seller_id: row.source_seller_id != null ? Number(row.source_seller_id) : null,
    draft_group_id: row.draft_group_id != null ? Number(row.draft_group_id) : null,
  };
  if (draft.draft_group_id) {
    draft.group = {
      id: draft.draft_group_id,
      name: row.draft_group_name || null,
      type: row.draft_group_type || null,
      family_blueprint: row.draft_group_family_blueprint || null,
      expected_published_family_id: row.draft_group_expected_family_id || null,
      family_divergent: Boolean(row.family_divergent),
    };
  } else {
    draft.group = null;
  }
  return draft;
}

async function getDraft(id, ctx, { includeDeleted = false } = {}) {
  ensureScope(ctx);
  const draftId = Number(id);
  if (!Number.isFinite(draftId) || draftId <= 0) throw httpError("Rascunho inválido.", 400);
  const result = await db.query(
    `select d.*,
            g.name as draft_group_name, g.type as draft_group_type,
            g.family_blueprint as draft_group_family_blueprint,
            g.expected_published_family_id as draft_group_expected_family_id,
            (d.published_family_id is not null and g.expected_published_family_id is not null
              and d.published_family_id <> g.expected_published_family_id) as family_divergent
       from ml.anuncio_drafts d
       left join ml.anuncio_draft_groups g
         on g.id=d.draft_group_id and g.empresa_id=d.empresa_id and g.meli_conta_id=d.meli_conta_id
      where d.id = $1 and d.empresa_id=$2 and d.meli_conta_id = $3
        and ($4::boolean = true or d.deleted_at is null)
      limit 1`,
    [draftId, ctx.empresaId, ctx.meliContaId, Boolean(includeDeleted)],
  );
  if (!result.rowCount) throw httpError("Rascunho não encontrado.", 404);
  return rowToDraft(result.rows[0]);
}

async function createBlank(input = {}, ctx) {
  ensureScope(ctx);
  const capabilities = await capabilitiesService.getCapabilities(ctx);
  const draftData = {
    title: "",
    family_name: "",
    category_id: "",
    price: "",
    currency_id: "BRL",
    available_quantity: 1,
    buying_mode: "buy_it_now",
    listing_type_id: "gold_special",
    condition: "new",
    sku: "",
    gtin: "",
    attributes: [],
    sale_terms: [],
    pictures: [],
    description: "",
    shipping: { free_shipping: false, local_pick_up: false },
    channels: ["marketplace"],
    ...((input && typeof input === "object") ? input : {}),
  };
  const result = await db.query(
    `insert into ml.anuncio_drafts
      (empresa_id, meli_conta_id, created_by, updated_by, source_type, publication_model, publication_target,
       category_id, family_name, title, status, draft_data)
     values ($1,$2,$3,$3,'blank',$4,'new_item',$5,$6,$7,'incomplete',$8::jsonb)
     returning *`,
    [ctx.empresaId, ctx.meliContaId, ctx.userId, capabilities.publication_model,
      normalizeText(draftData.category_id, 80) || null,
      normalizeText(draftData.family_name, 180) || null,
      normalizeText(draftData.title, 180) || null,
      JSON.stringify(draftData)],
  );
  return rowToDraft(result.rows[0]);
}

async function createFromItem(input, ctx, options = {}) {
  ensureScope(ctx);
  const resolved = await sourceService.resolveItem(input, ctx);
  if (options.expected === "own" && resolved.source_type !== "own_item") {
    throw httpError("Esse anúncio pertence a outro vendedor. Use a opção 'Usar uma referência'.", 409);
  }
  if (options.expected === "external" && resolved.source_type !== "external_item") {
    throw httpError("Esse anúncio pertence à conta selecionada. Use a opção 'Usar meu anúncio'.", 409);
  }
  const requestedTarget = options.publicationTarget === "sale_condition" ? "sale_condition" : "new_item";
  if (requestedTarget === "sale_condition" && (resolved.source_type !== "own_item" || !resolved.source_snapshot?.user_product_id)) {
    throw httpError("Só é possível criar uma nova condição de venda a partir de um User Product da própria conta.", 409);
  }
  const snap = resolved.source_snapshot || {};
  const data = resolved.draft_data || {};
  const result = await db.query(
    `insert into ml.anuncio_drafts
      (empresa_id, meli_conta_id, created_by, updated_by, source_type, source_item_id,
       source_user_product_id, source_family_id, source_seller_id, source_snapshot, reference_data,
       publication_model, publication_target, category_id, family_name, title, status, draft_data)
     values ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,'review',$16::jsonb)
     returning *`,
    [ctx.empresaId, ctx.meliContaId, ctx.userId, resolved.source_type, snap.id,
      snap.user_product_id, snap.family_id, snap.seller_id, JSON.stringify(resolved.source_snapshot || {}),
      JSON.stringify(resolved.reference_data || {}), resolved.publication_model,
      requestedTarget,
      normalizeText(data.category_id, 80) || null, normalizeText(data.family_name, 180) || null,
      normalizeText(data.title, 180) || null, JSON.stringify(data)],
  );
  return rowToDraft(result.rows[0]);
}

async function createFromFamily(familyId, ctx) {
  ensureScope(ctx);
  const family = await sourceService.resolveFamily(familyId, ctx);
  const products = family.products || [];
  if (!products.length) throw httpError("A família foi encontrada, mas nenhum User Product foi retornado pelo Mercado Livre.", 422);

  const created = [];
  const failures = [];
  for (const product of products) {
    const upId = product.user_product_id;
    try {
      let itemId = null;
      try {
        const search = await require("./mercadoLivreApi").get(
          `/users/${encodeURIComponent(ctx.sellerId)}/items/search`,
          { accessToken: ctx.accessToken, query: { user_product_id: upId, limit: 1 } },
        );
        itemId = Array.isArray(search?.results) ? search.results[0] : null;
      } catch (_) {}

      if (itemId) {
        const draft = await createFromItem(itemId, ctx, { expected: "own" });
        const patched = await updateDraft(draft.id, {
          source_type: "own_family",
          source_family_id: family.family_id,
          publication_target: "sale_condition",
          family_name: family.family_name || draft.draft_data?.family_name,
        }, ctx);
        created.push(patched);
        continue;
      }

      let userProduct = null;
      try {
        userProduct = await require("./mercadoLivreApi").get(
          `/user-products/${encodeURIComponent(upId)}`,
          { accessToken: ctx.accessToken },
        );
      } catch (_) {}

      const upAttributes = Array.isArray(userProduct?.attributes)
        ? userProduct.attributes.map((attr) => {
            const first = Array.isArray(attr?.values) ? attr.values[0] : null;
            return {
              id: attr?.id || null,
              name: attr?.name || null,
              value_id: first?.id || null,
              value_name: first?.name || null,
            };
          }).filter((attr) => attr.id && (attr.value_id || attr.value_name))
        : (product.attributes || []);
      const upPictures = Array.isArray(userProduct?.pictures) ? userProduct.pictures : (product.pictures || []);
      const base = await createBlank({
        family_name: family.family_name || userProduct?.family_name || userProduct?.name || product.name || "",
        category_id: family.raw_summary?.category_id || userProduct?.category_id || "",
        attributes: upAttributes,
        pictures: upPictures.map((pic) => ({ source: pic.secure_url || pic.url || pic.source })).filter((pic) => pic.source),
      }, ctx);
      const result = await db.query(
        `update ml.anuncio_drafts
            set source_type='own_family', source_user_product_id=$4, source_family_id=$5,
                source_seller_id=$6, publication_target='sale_condition', source_snapshot=$7::jsonb,
                status='review', updated_at=now(), revision=revision+1
          where id=$1 and empresa_id=$2 and meli_conta_id=$3 returning *`,
        [base.id, ctx.empresaId, ctx.meliContaId, upId, family.family_id, ctx.sellerId, JSON.stringify({ family: family.raw_summary, product, user_product: userProduct })],
      );
      created.push(rowToDraft(result.rows[0]));
    } catch (error) {
      failures.push({
        user_product_id: upId,
        error: error?.message || "Falha ao gerar rascunho.",
        status: Number(error?.status) || null,
      });
    }
  }

  if (!created.length) {
    throw httpError("Não foi possível gerar rascunhos para os User Products desta família.", 422, { failures });
  }
  return { family, drafts: created, failures };
}

function normalizeDraftDataPatch(current, patch) {
  const next = { ...(current || {}) };
  const allowed = [
    "title", "family_name", "category_id", "price", "currency_id", "available_quantity", "buying_mode",
    "listing_type_id", "condition", "sku", "gtin", "attributes", "sale_terms", "pictures", "description",
    "shipping", "channels", "notes",
  ];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch || {}, key)) next[key] = patch[key];
  }
  return next;
}

async function updateDraft(id, patch = {}, ctx) {
  const current = await getDraft(id, ctx);
  if (current.status === "published") throw httpError("Um rascunho já publicado não pode ser alterado.", 409);
  if (current.status === "publishing") throw httpError("O rascunho está sendo publicado.", 409);

  const payloadPatch = patch.draft_data && typeof patch.draft_data === "object" ? patch.draft_data : patch;
  const nextData = normalizeDraftDataPatch(current.draft_data || {}, payloadPatch);
  const nextSourceType = ["blank", "own_item", "own_family", "external_item", "draft_copy"].includes(patch.source_type)
    ? patch.source_type : current.source_type;
  const nextSourceFamilyId = Object.prototype.hasOwnProperty.call(patch, "source_family_id")
    ? normalizeText(patch.source_family_id, 120) || null : current.source_family_id;
  let nextPublicationTarget = current.publication_target || "new_item";
  if (Object.prototype.hasOwnProperty.call(patch, "publication_target")) {
    const requestedTarget = normalizeText(patch.publication_target, 40).toLowerCase();
    if (!["new_item", "sale_condition"].includes(requestedTarget)) {
      throw httpError("Destino de publicação inválido.", 400);
    }
    if (requestedTarget === "sale_condition") {
      if (!current.source_user_product_id || Number(current.source_seller_id) !== Number(ctx.sellerId)) {
        throw httpError("Só é possível criar condição de venda para um User Product da conta selecionada.", 403);
      }
    }
    nextPublicationTarget = requestedTarget;
  }

  const result = await db.query(
    `update ml.anuncio_drafts
        set updated_by=$4,
            source_type=$5,
            source_family_id=$6,
            publication_target=$7,
            category_id=$8,
            family_name=$9,
            title=$10,
            draft_data=$11::jsonb,
            status='review',
            validation_status='pending', validation_hash=null, validation_data=null, validated_at=null,
            updated_at=now(), revision=revision+1
      where id=$1 and empresa_id=$2 and meli_conta_id=$3
      returning *`,
    [current.id, ctx.empresaId, ctx.meliContaId, ctx.userId, nextSourceType, nextSourceFamilyId, nextPublicationTarget,
      normalizeText(nextData.category_id, 80) || null, normalizeText(nextData.family_name, 180) || null,
      normalizeText(nextData.title, 180) || null, JSON.stringify(nextData)],
  );
  if (!result.rowCount) throw httpError("Rascunho não encontrado.", 404);
  return getDraft(current.id, ctx);
}

async function duplicateDraft(id, ctx) {
  const current = await getDraft(id, ctx);
  const result = await db.query(
    `insert into ml.anuncio_drafts
      (empresa_id, meli_conta_id, created_by, updated_by, source_type, source_item_id,
       source_user_product_id, source_family_id, source_seller_id, source_snapshot, reference_data,
       publication_model, publication_target, category_id, family_name, title, status, draft_data)
     values ($1,$2,$3,$3,'draft_copy',$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,'review',$15::jsonb)
     returning *`,
    [current.empresa_id, ctx.meliContaId, ctx.userId, current.source_item_id, current.source_user_product_id,
      current.source_family_id, current.source_seller_id, JSON.stringify({ ...current.source_snapshot, copied_from_draft_id: current.id }),
      JSON.stringify(current.reference_data || {}), current.publication_model, current.publication_target || "new_item",
      current.category_id, current.family_name, current.title, JSON.stringify(current.draft_data || {})],
  );
  return rowToDraft(result.rows[0]);
}

async function listDrafts(query = {}, ctx) {
  ensureScope(ctx);
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(10, Number(query.pageSize) || 25));
  const offset = (page - 1) * pageSize;
  const status = normalizeText(query.status, 40);
  const sourceType = normalizeText(query.source_type, 40);
  const q = normalizeText(query.q, 120);
  const view = ["editing", "published", "trash"].includes(String(query.view || ""))
    ? String(query.view)
    : (String(query.deleted || "0") === "1" ? "trash" : "editing");
  const groupId = query.group_id == null || query.group_id === "" ? null : Number(query.group_id);
  if (groupId != null && (!Number.isFinite(groupId) || groupId <= 0)) throw httpError("Grupo inválido.", 400);

  const params = [ctx.empresaId, ctx.meliContaId];
  const where = ["d.empresa_id=$1", "d.meli_conta_id=$2"];
  if (view === "published") {
    where.push("d.deleted_at is null", "d.published_item_id is not null", "d.status='published'", "d.published_at >= now() - interval '30 days'");
  } else if (view === "trash") {
    where.push("d.deleted_at is not null");
  } else {
    where.push("d.deleted_at is null", "d.published_item_id is null", "d.status <> 'published'");
  }
  if (status && status !== "all" && view === "editing") { params.push(status); where.push(`d.status=$${params.length}`); }
  if (sourceType && sourceType !== "all") { params.push(sourceType); where.push(`d.source_type=$${params.length}`); }
  if (groupId != null) { params.push(groupId); where.push(`d.draft_group_id=$${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(coalesce(d.title,'') ilike $${params.length} or coalesce(d.family_name,'') ilike $${params.length} or coalesce(d.source_item_id,'') ilike $${params.length} or coalesce(d.published_item_id,'') ilike $${params.length} or coalesce(d.draft_data->>'sku','') ilike $${params.length} or coalesce(g.name,'') ilike $${params.length})`);
  }

  const join = `left join ml.anuncio_draft_groups g on g.id=d.draft_group_id and g.empresa_id=d.empresa_id and g.meli_conta_id=d.meli_conta_id`;
  const count = await db.query(`select count(*)::int as total from ml.anuncio_drafts d ${join} where ${where.join(" and ")}`, params);
  const rowsParams = [...params, pageSize, offset];
  const order = view === "published" ? "d.published_at desc nulls last, d.id desc" : (view === "trash" ? "d.deleted_at desc, d.id desc" : "d.updated_at desc, d.id desc");
  const rows = await db.query(
    `select d.id, d.empresa_id, d.meli_conta_id, d.draft_group_id, d.source_type, d.source_item_id, d.source_user_product_id, d.source_family_id,
            d.publication_model, d.publication_target, d.category_id, d.family_name, d.title, d.status, d.validation_status,
            d.published_item_id, d.published_user_product_id, d.published_family_id, d.published_permalink, d.published_at,
            d.revision, d.created_at, d.updated_at, d.deleted_at,
            d.draft_data->>'sku' as sku,
            coalesce(d.draft_data->'pictures'->0->>'source', d.source_snapshot->>'thumbnail') as thumbnail,
            g.name as draft_group_name, g.type as draft_group_type,
            g.family_blueprint as draft_group_family_blueprint,
            g.expected_published_family_id as draft_group_expected_family_id,
            (d.published_family_id is not null and g.expected_published_family_id is not null and d.published_family_id <> g.expected_published_family_id) as family_divergent
       from ml.anuncio_drafts d
       ${join}
      where ${where.join(" and ")}
      order by ${order}
      limit $${params.length + 1} offset $${params.length + 2}`,
    rowsParams,
  );
  return { items: rows.rows.map(rowToDraft), paging: { page, pageSize, total: count.rows[0]?.total || 0 }, view };
}

async function softDelete(id, ctx) {
  const current = await getDraft(id, ctx);
  if (current.status === "publishing") throw httpError("Não é possível excluir enquanto o rascunho está sendo publicado.", 409);
  if (current.status === "published" || current.published_item_id) throw httpError("Itens publicados ficam no histórico e não podem ser enviados para a lixeira.", 409);
  await db.query(`update ml.anuncio_drafts set deleted_at=now(), updated_by=$4, updated_at=now() where id=$1 and empresa_id=$2 and meli_conta_id=$3`, [current.id, ctx.empresaId, ctx.meliContaId, ctx.userId]);
  return { ok: true };
}

async function restore(id, ctx) {
  const current = await getDraft(id, ctx, { includeDeleted: true });
  if (current.published_item_id) throw httpError("Histórico publicado não pode ser restaurado como rascunho.", 409);
  if (!current.deleted_at) throw httpError("Este rascunho não está na lixeira.", 409);
  const deletedAt = new Date(current.deleted_at);
  const restoreDeadline = deletedAt.getTime() + 30 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(deletedAt.getTime()) || Date.now() >= restoreDeadline) {
    throw httpError("O prazo de 30 dias para restaurar este rascunho expirou.", 410, null, "DRAFT_RESTORE_EXPIRED");
  }
  await db.query(`update ml.anuncio_drafts set deleted_at=null, updated_by=$4, updated_at=now() where id=$1 and empresa_id=$2 and meli_conta_id=$3`, [current.id, ctx.empresaId, ctx.meliContaId, ctx.userId]);
  return getDraft(current.id, ctx);
}

module.exports = {
  createBlank, createFromItem, createFromFamily, getDraft, updateDraft, duplicateDraft, listDrafts, softDelete, restore,
};
