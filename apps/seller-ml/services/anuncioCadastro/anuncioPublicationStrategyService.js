"use strict";

const payloadService = require("./anuncioPayloadService");
const { httpError, normalizeText, payloadHash } = require("./helpers");

const TARGET_NEW_ITEM = "new_item";
const TARGET_SALE_CONDITION = "sale_condition";

function publicationTarget(draft = {}) {
  const explicit = normalizeText(draft.publication_target, 40).toLowerCase();
  if ([TARGET_NEW_ITEM, TARGET_SALE_CONDITION].includes(explicit)) return explicit;

  // Compatibilidade com rascunhos criados antes da migration 068.
  if (draft.source_type === "own_family" && draft.source_user_product_id) return TARGET_SALE_CONDITION;
  return TARGET_NEW_ITEM;
}

function userProductId(draft = {}) {
  return normalizeText(draft.source_user_product_id, 100).toUpperCase();
}

function assertSaleConditionSource(draft = {}) {
  const upId = userProductId(draft);
  if (!upId) {
    throw httpError(
      "Este rascunho foi marcado como condição de venda, mas não possui User Product de origem.",
      422,
      null,
      "SALE_CONDITION_WITHOUT_USER_PRODUCT",
    );
  }
  return upId;
}

function buildPublicationPayload(draft = {}) {
  const target = publicationTarget(draft);
  if (target === TARGET_SALE_CONDITION) {
    assertSaleConditionSource(draft);
    return payloadService.buildSaleConditionPayload(draft);
  }
  return payloadService.buildItemPayload(draft);
}

function publicationEndpoint(draft = {}) {
  const target = publicationTarget(draft);
  if (target === TARGET_SALE_CONDITION) {
    const upId = assertSaleConditionSource(draft);
    return `/user-products/${encodeURIComponent(upId)}/items`;
  }
  return "/items";
}

function validationEndpoint(draft = {}) {
  return publicationTarget(draft) === TARGET_NEW_ITEM ? "/items/validate" : null;
}

function publicationHash(draft = {}, payload = buildPublicationPayload(draft)) {
  const target = publicationTarget(draft);
  return payloadHash({
    target,
    source_user_product_id: target === TARGET_SALE_CONDITION ? assertSaleConditionSource(draft) : null,
    payload,
  });
}

module.exports = {
  TARGET_NEW_ITEM,
  TARGET_SALE_CONDITION,
  publicationTarget,
  buildPublicationPayload,
  publicationEndpoint,
  validationEndpoint,
  publicationHash,
  assertSaleConditionSource,
};
