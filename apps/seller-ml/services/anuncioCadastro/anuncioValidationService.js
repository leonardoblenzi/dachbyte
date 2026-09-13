"use strict";

const db = require("../../db/db");
const ml = require("./mercadoLivreApi");
const draftService = require("./anuncioDraftService");
const strategy = require("./anuncioPublicationStrategyService");
const { httpError } = require("./helpers");

function normalizeMlCauses(payload) {
  const causes = Array.isArray(payload?.cause) ? payload.cause : [];
  if (causes.length) {
    return causes.map((cause) => ({
      code: cause?.code || cause?.cause_id || null,
      field: Array.isArray(cause?.references) ? cause.references[0] || null : (cause?.reference || null),
      type: cause?.type || "error",
      message: cause?.message || cause?.detail || "Validação do Mercado Livre não atendida.",
    }));
  }
  return [{
    code: payload?.error || null,
    field: null,
    type: "error",
    message: payload?.message || payload?.error_description || "O Mercado Livre recusou a validação do anúncio.",
  }];
}

function normalizeError(error) {
  if (Array.isArray(error?.details?.errors)) return error.details.errors;
  const raw = error?.mlPayload || error?.details || null;
  return normalizeMlCauses(raw || { message: error?.message });
}

async function saveValidation(draft, ctx, { status, hash = null, data = null, draftStatus }) {
  const result = await db.query(
    `update ml.anuncio_drafts
        set validation_status=$3, validation_hash=$4, validation_data=$5::jsonb,
            validated_at=case when $3 in ('valid','invalid') then now() else null end,
            status=$6, updated_by=$7, updated_at=now(), revision=revision+1
      where id=$1 and meli_conta_id=$2 and empresa_id=$3
      returning *`,
    [draft.id, ctx.meliContaId, ctx.empresaId, status, hash, data == null ? null : JSON.stringify(data), draftStatus, ctx.userId],
  );
  return result.rows[0];
}

async function preflightSaleCondition(draft, ctx) {
  const upId = strategy.assertSaleConditionSource(draft);
  const userProduct = await ml.get(`/user-products/${encodeURIComponent(upId)}`, { accessToken: ctx.accessToken });
  const ownerId = Number(userProduct?.user_id);
  if (!Number.isFinite(ownerId) || ownerId !== Number(ctx.sellerId)) {
    throw httpError(
      "O User Product de origem não pertence à conta selecionada.",
      403,
      { errors: [{ code: "USER_PRODUCT_NOT_OWNED", field: "source_user_product_id", message: "O User Product de origem não pertence à conta selecionada." }] },
      "USER_PRODUCT_NOT_OWNED",
    );
  }

  const search = await ml.get(
    `/users/${encodeURIComponent(ctx.sellerId)}/items/search`,
    { accessToken: ctx.accessToken, query: { user_product_id: upId, limit: 50 } },
  );
  const total = Number(search?.paging?.total ?? (Array.isArray(search?.results) ? search.results.length : 0));
  if (Number.isFinite(total) && total >= 30) {
    throw httpError(
      "Este User Product já atingiu o limite de 30 condições de venda.",
      422,
      { errors: [{ code: "USER_PRODUCT_CONDITION_LIMIT", field: "source_user_product_id", message: "Este User Product já atingiu o limite de 30 condições de venda." }] },
      "USER_PRODUCT_CONDITION_LIMIT",
    );
  }

  return {
    user_product_id: upId,
    user_product_user_id: ownerId,
    existing_conditions: Number.isFinite(total) ? total : null,
  };
}

async function validateDraft(id, ctx) {
  const draft = await draftService.getDraft(id, ctx);
  if (draft.status === "published" || draft.published_item_id) throw httpError("Este rascunho já foi publicado.", 409);
  if (draft.status === "publishing") throw httpError("Este rascunho está em processo de publicação.", 409);

  let payload;
  let target;
  let hash;
  try {
    target = strategy.publicationTarget(draft);
    payload = strategy.buildPublicationPayload(draft);
    hash = strategy.publicationHash(draft, payload);
  } catch (error) {
    const errors = normalizeError(error);
    const saved = await saveValidation(draft, ctx, {
      status: "invalid",
      data: { source: "local", target: target || strategy.publicationTarget(draft), errors },
      draftStatus: "error",
    });
    return { ok: false, valid: false, source: "local", target: target || strategy.publicationTarget(draft), errors, draft: saved };
  }

  try {
    if (target === strategy.TARGET_SALE_CONDITION) {
      // A documentação pública não expõe um dry-run equivalente a /items/validate
      // para POST /user-products/{id}/items. Fazemos preflight seguro no próprio UP:
      // ownership + capacidade de novas condições, sem criar o item durante a validação.
      const preflight = await preflightSaleCondition(draft, ctx);
      const saved = await saveValidation(draft, ctx, {
        status: "valid",
        hash,
        data: {
          source: "mercadolivre_preflight",
          target,
          valid: true,
          errors: [],
          dry_run: false,
          endpoint: strategy.publicationEndpoint(draft),
          ...preflight,
        },
        draftStatus: "ready",
      });
      return { ok: true, valid: true, source: "mercadolivre_preflight", target, hash, errors: [], draft: saved };
    }

    await ml.post(strategy.validationEndpoint(draft), payload, { accessToken: ctx.accessToken });
    const saved = await saveValidation(draft, ctx, {
      status: "valid",
      hash,
      data: { source: "mercadolivre", target, valid: true, errors: [], endpoint: strategy.validationEndpoint(draft) },
      draftStatus: "ready",
    });
    return { ok: true, valid: true, source: "mercadolivre", target, hash, errors: [], draft: saved };
  } catch (error) {
    const raw = error?.mlPayload || error?.details || null;
    const errors = normalizeError(error);
    const saved = await saveValidation(draft, ctx, {
      status: "invalid",
      hash,
      data: { source: target === strategy.TARGET_SALE_CONDITION ? "mercadolivre_preflight" : "mercadolivre", target, valid: false, errors, raw },
      draftStatus: "error",
    });
    return { ok: false, valid: false, target, hash, errors, draft: saved };
  }
}

module.exports = { validateDraft, normalizeMlCauses, preflightSaleCondition, saveValidation };
