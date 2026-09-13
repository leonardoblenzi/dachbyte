"use strict";

const db = require("../../db/db");
const ml = require("./mercadoLivreApi");
const draftService = require("./anuncioDraftService");
const strategy = require("./anuncioPublicationStrategyService");
const groupService = require("./anuncioDraftGroupService");
const { httpError, normalizeText } = require("./helpers");

async function claimForPublish(draft, ctx, expectedHash) {
  const result = await db.query(
    `update ml.anuncio_drafts
        set status='publishing', updated_by=$4, updated_at=now(), revision=revision+1
      where id=$1 and empresa_id=$2 and meli_conta_id=$3 and deleted_at is null
        and published_item_id is null
        and status <> 'publishing'
        and validation_status='valid'
        and validation_hash=$5
      returning *`,
    [draft.id, ctx.empresaId, ctx.meliContaId, ctx.userId, expectedHash],
  );
  if (!result.rowCount) {
    const fresh = await draftService.getDraft(draft.id, ctx);
    if (fresh.published_item_id) return { alreadyPublished: true, draft: fresh };
    if (fresh.status === "publishing") throw httpError("Este rascunho já está em processo de publicação.", 409);
    throw httpError("Valide novamente o rascunho antes de publicar.", 409);
  }
  return { alreadyPublished: false, draft: result.rows[0] };
}

async function markFailure(draftId, ctx, error) {
  const raw = error?.mlPayload || error?.details || null;
  await db.query(
    `update ml.anuncio_drafts
        set status='publish_error', last_publish_result=$4::jsonb,
            updated_by=$5, updated_at=now(), revision=revision+1
      where id=$1 and empresa_id=$2 and meli_conta_id=$3 and published_item_id is null`,
    [draftId, ctx.empresaId, ctx.meliContaId, JSON.stringify({ ok: false, error: error?.message || "Falha ao publicar", raw }), ctx.userId],
  );
}

async function assertOwnedUserProduct(draft, ctx) {
  if (strategy.publicationTarget(draft) !== strategy.TARGET_SALE_CONDITION) return null;
  const upId = strategy.assertSaleConditionSource(draft);
  const userProduct = await ml.get(`/user-products/${encodeURIComponent(upId)}`, { accessToken: ctx.accessToken });
  if (Number(userProduct?.user_id) !== Number(ctx.sellerId)) {
    throw httpError("O User Product de origem não pertence à conta selecionada.", 403, { user_product_id: upId }, "USER_PRODUCT_NOT_OWNED");
  }
  return upId;
}

async function resolvePublishedUserProductAndFamily(item, itemId, ctx, draft) {
  let userProductId = normalizeText(item?.user_product_id, 120) || null;
  let familyId = item?.family_id != null ? String(item.family_id) : null;
  if ((!userProductId || !familyId) && itemId) {
    try {
      const freshItem = await ml.get(`/items/${encodeURIComponent(itemId)}`, { accessToken: ctx.accessToken });
      userProductId = userProductId || normalizeText(freshItem?.user_product_id, 120) || null;
      familyId = familyId || (freshItem?.family_id != null ? String(freshItem.family_id) : null);
    } catch (_) {}
  }
  if (!userProductId && strategy.publicationTarget(draft) === strategy.TARGET_SALE_CONDITION) {
    userProductId = draft.source_user_product_id || null;
  }
  if (userProductId && !familyId) {
    try {
      const up = await ml.get(`/user-products/${encodeURIComponent(userProductId)}`, { accessToken: ctx.accessToken });
      familyId = up?.family_id != null ? String(up.family_id) : null;
    } catch (_) {}
  }
  return { userProductId, familyId };
}

async function checkGroupIntegrity(draft, familyId, ctx) {
  if (!draft?.draft_group_id || !familyId) return null;
  try {
    return await groupService.recordPublishedFamily(draft.draft_group_id, familyId, ctx);
  } catch (error) {
    return { ok: false, error: error?.message || "Falha ao verificar agrupamento da família." };
  }
}

function pendingCreatedItem(draft = {}) {
  const result = draft.last_publish_result || {};
  const itemId = normalizeText(result.created_item_id || result.item_id, 80).toUpperCase();
  if (!itemId) return null;
  return {
    item_id: itemId,
    permalink: result.permalink || null,
    user_product_id: result.user_product_id || null,
    family_id: result.family_id || null,
    endpoint: result.endpoint || null,
    target: result.target || strategy.publicationTarget(draft),
    description: result.description || { ok: false, skipped: true },
    response: result.response || null,
  };
}

async function persistPublishedDraft(draft, publishResult, ctx) {
  const result = await db.query(
    `update ml.anuncio_drafts
        set status='published', published_item_id=$4, published_user_product_id=$5,
            published_family_id=$6, published_permalink=$7, published_at=now(),
            last_publish_result=$8::jsonb, updated_by=$9, updated_at=now(), revision=revision+1
      where id=$1 and empresa_id=$2 and meli_conta_id=$3
      returning *`,
    [draft.id, ctx.empresaId, ctx.meliContaId, publishResult.item_id, publishResult.user_product_id || null,
      publishResult.family_id || null, publishResult.permalink || null,
      JSON.stringify(publishResult), ctx.userId],
  );
  if (!result.rowCount) throw httpError("Não foi possível registrar a publicação do rascunho.", 500);
  return result.rows[0];
}

async function savePendingCreatedItem(draft, publishResult, ctx, error) {
  const recovery = {
    ...publishResult,
    created_item_id: publishResult.item_id,
    persistence_error: error?.message || "Falha ao registrar a publicação.",
  };
  try {
    await db.query(
      `update ml.anuncio_drafts
          set status='publish_error', last_publish_result=$4::jsonb,
              updated_by=$5, updated_at=now(), revision=revision+1
        where id=$1 and empresa_id=$2 and meli_conta_id=$3 and published_item_id is null`,
      [draft.id, ctx.empresaId, ctx.meliContaId, JSON.stringify(recovery), ctx.userId],
    );
  } catch (_) {
    // Se o banco estiver totalmente indisponível, a exceção abaixo informa que
    // um item já foi criado e impede que a interface induza nova publicação.
  }
}

async function recoverPublishedDraft(draft, pending, ctx) {
  const publishResult = { ok: true, ...pending, recovered: true };
  const persisted = await persistPublishedDraft(draft, publishResult, ctx);
  const groupIntegrity = await checkGroupIntegrity(draft, publishResult.family_id, ctx);
  return { ...publishResult, group_integrity: groupIntegrity, draft: persisted };
}

async function publishDraft(id, ctx) {
  const draft = await draftService.getDraft(id, ctx);
  if (draft.published_item_id) {
    const groupIntegrity = await checkGroupIntegrity(draft, draft.published_family_id, ctx);
    return { ok: true, already_published: true, item_id: draft.published_item_id, permalink: draft.published_permalink, group_integrity: groupIntegrity, draft };
  }

  const pending = pendingCreatedItem(draft);
  if (pending) return recoverPublishedDraft(draft, pending, ctx);

  const target = strategy.publicationTarget(draft);
  const payload = strategy.buildPublicationPayload(draft);
  const hash = strategy.publicationHash(draft, payload);
  if (draft.validation_status !== "valid" || draft.validation_hash !== hash) {
    throw httpError("O rascunho mudou desde a última validação. Valide novamente antes de publicar.", 409);
  }

  const claim = await claimForPublish(draft, ctx, hash);
  if (claim.alreadyPublished) {
    const groupIntegrity = await checkGroupIntegrity(claim.draft, claim.draft.published_family_id, ctx);
    return { ok: true, already_published: true, item_id: claim.draft.published_item_id, permalink: claim.draft.published_permalink, group_integrity: groupIntegrity, draft: claim.draft };
  }

  let created;
  const endpoint = strategy.publicationEndpoint(draft);
  try {
    await assertOwnedUserProduct(draft, ctx);
    created = await ml.post(endpoint, payload, { accessToken: ctx.accessToken });
  } catch (error) {
    await markFailure(draft.id, ctx, error);
    throw error;
  }

  const item = created.payload || {};
  const itemId = normalizeText(item.id, 80).toUpperCase();
  if (!itemId) {
    const error = httpError("O Mercado Livre respondeu à publicação sem retornar o item_id.", 502, item);
    await markFailure(draft.id, ctx, error);
    throw error;
  }

  let descriptionResult = { ok: true, skipped: true };
  const description = normalizeText(draft.draft_data?.description, 50000);
  if (description) {
    try {
      const response = await ml.post(`/items/${encodeURIComponent(itemId)}/description`, { plain_text: description }, { accessToken: ctx.accessToken });
      descriptionResult = { ok: true, status: response.status };
    } catch (error) {
      // O item já existe: não repetimos a criação para evitar duplicidade.
      descriptionResult = { ok: false, error: error.message, raw: error?.mlPayload || error?.details || null };
    }
  }

  const identity = await resolvePublishedUserProductAndFamily(item, itemId, ctx, draft);
  const publishResult = {
    ok: true,
    target,
    endpoint,
    item_id: itemId,
    permalink: item.permalink || null,
    user_product_id: identity.userProductId,
    family_id: identity.familyId,
    description: descriptionResult,
    response: item,
  };

  let result;
  try {
    result = await persistPublishedDraft(draft, publishResult, ctx);
  } catch (error) {
    await savePendingCreatedItem(draft, publishResult, ctx, error);
    throw httpError(
      "O anúncio foi criado no Mercado Livre, mas seu registro local falhou. Não publique novamente; tente abrir este rascunho para concluir a recuperação.",
      502,
      { item_id: itemId },
      "PUBLISH_PERSISTENCE_PENDING",
    );
  }

  const groupIntegrity = await checkGroupIntegrity(draft, publishResult.family_id, ctx);

  return { ...publishResult, group_integrity: groupIntegrity, draft: result };
}

module.exports = { publishDraft, claimForPublish, assertOwnedUserProduct, resolvePublishedUserProductAndFamily, checkGroupIntegrity, pendingCreatedItem, persistPublishedDraft };
