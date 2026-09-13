"use strict";

const fetch = require("node-fetch");
const TokenService = require("./tokenService");

const API_BASE = "https://api.mercadolibre.com";
const CATEGORY_ATTR_CACHE = new Map();

function normalizeItemId(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function normalizeModelValue(value) {
  return String(value || "").trim();
}

function normalizeAttributeId(value) {
  return String(value || "").trim().toUpperCase();
}

function countChars(value) {
  return String(value || "").length;
}

function parseJsonSafe(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function extractInvalidAttributeIds(payload) {
  const ids = new Set();
  const causes = Array.isArray(payload?.cause) ? payload.cause : [];

  for (const cause of causes) {
    const message = String(cause?.message || "");
    const matches = message.matchAll(/Attribute\s+\[([^\]]+)\]/gi);
    for (const match of matches) {
      const id = normalizeAttributeId(match?.[1]);
      if (id) ids.add(id);
    }
  }

  return Array.from(ids);
}

function extractUserProductConflict(payload) {
  const causes = Array.isArray(payload?.cause) ? payload.cause : [];
  const repeatedCause = causes.find((cause) => {
    const code = String(cause?.code || "").trim();
    const message = String(cause?.message || "").trim();
    return (
      code === "item.user_product.repeated.conflict" ||
      /user product was duplicated/i.test(message)
    );
  });

  if (!repeatedCause) return null;

  const message = String(payload?.message || repeatedCause?.message || "").trim();
  const conflictMatch = message.match(/Conflict id:\s*([A-Z0-9]+)/i);
  const conflictId = conflictMatch?.[1] || null;

  return {
    conflict_id: conflictId,
    code: String(repeatedCause?.code || "item.user_product.repeated.conflict"),
    message,
  };
}

function userProductConflictReason(conflict) {
  const suffix = conflict?.conflict_id ? ` Conflito: ${conflict.conflict_id}.` : "";
  return (
    "O Mercado Livre identificou que essa alteracao deixaria o anuncio com a mesma identidade de outro User Product." +
    suffix +
    " Use um modelo mais especifico ou revise o anuncio manualmente no Mercado Livre."
  );
}

function pickAttributeValue(attribute) {
  if (!attribute || typeof attribute !== "object") return "";

  if (attribute.value_name != null && String(attribute.value_name).trim()) {
    return String(attribute.value_name).trim();
  }

  if (attribute.value_id != null && String(attribute.value_id).trim()) {
    return String(attribute.value_id).trim();
  }

  if (attribute.value_struct?.name != null) {
    return String(attribute.value_struct.name).trim();
  }

  if (Array.isArray(attribute.values) && attribute.values.length) {
    const first = attribute.values[0] || {};
    return String(first.name || first.id || "").trim();
  }

  return "";
}

function simplifyAttribute(attribute) {
  const id = String(attribute?.id || "").trim();
  if (!id) return null;

  const valueName =
    attribute?.value_name != null && String(attribute.value_name).trim()
      ? String(attribute.value_name).trim()
      : null;

  const valueId =
    attribute?.value_id != null && String(attribute.value_id).trim()
      ? String(attribute.value_id).trim()
      : null;

  if (valueName) {
    if (isNotApplicableDisplay(valueName)) {
      return {
        id,
        value_id: "-1",
        value_name: null,
      };
    }

    return {
      id,
      value_name: valueName,
      value_id: valueId,
    };
  }

  if (valueId) {
    return {
      id,
      value_id: valueId,
      value_name: null,
    };
  }

  return null;
}

function isNotApplicableDisplay(value) {
  const text = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
  return ["nao aplica", "n/a", "not applicable", "no aplica"].includes(text);
}

function shouldKeepAttribute(attribute, categoryInfo, targetId) {
  const id = normalizeAttributeId(attribute?.id);
  if (!id) return false;
  if (id === targetId) return true;

  if (
    categoryInfo?.validAttributeIds instanceof Set &&
    !categoryInfo.validAttributeIds.has(id)
  ) {
    return false;
  }

  const meta = categoryInfo?.attributeById?.get(id) || null;
  const tags = meta?.tags || {};
  if (tags.read_only || tags.inferred) return false;

  return true;
}

function buildModelAttribute(attributeId, modelValue) {
  return {
    id: String(attributeId || "MODEL").trim().toUpperCase(),
    value_name: normalizeModelValue(modelValue),
    value_id: null,
  };
}

function buildUpdatedAttributes(currentAttributes, categoryInfo, modelValue) {
  const attributeId = categoryInfo?.attributeId || "MODEL";
  const targetId = String(attributeId || "MODEL").trim().toUpperCase();
  const next = [];
  let replaced = false;

  for (const attribute of Array.isArray(currentAttributes) ? currentAttributes : []) {
    if (!shouldKeepAttribute(attribute, categoryInfo, targetId)) continue;

    const simplified = simplifyAttribute(attribute);
    if (!simplified) continue;

    if (String(simplified.id).trim().toUpperCase() === targetId) {
      if (!replaced) {
        next.push(buildModelAttribute(targetId, modelValue));
        replaced = true;
      }
      continue;
    }

    next.push(simplified);
  }

  if (!replaced) next.push(buildModelAttribute(targetId, modelValue));
  return next;
}

function extractCurrentModel(item) {
  const attrs = Array.isArray(item?.attributes) ? item.attributes : [];
  const modelAttr = attrs.find((attribute) => {
    const id = String(attribute?.id || "").trim().toUpperCase();
    return id === "MODEL" || id === "MODELO";
  });

  return pickAttributeValue(modelAttr);
}

function asStatusLabel(item) {
  return String(item?.status || "")
    .trim()
    .toLowerCase();
}

function inferListingType(item) {
  if (item?.catalog_listing === true) return "catalogo";
  return "normal";
}

class ModeloMassaService {
  static async prepareState(mlCreds = {}) {
    const token = await TokenService.renovarTokenSeNecessario(mlCreds);
    return { token, creds: mlCreds };
  }

  static async authFetch(state, url, init = {}) {
    const call = async (token) => {
      const headers = {
        Accept: "application/json",
        ...(init.headers || {}),
        Authorization: `Bearer ${token}`,
      };
      return fetch(url, { ...init, headers });
    };

    let response = await call(state.token);
    if (response.status !== 401) return response;

    const renewed = await TokenService.renovarToken(state.creds);
    state.token = renewed?.access_token || state.token;
    return call(state.token);
  }

  static async fetchItemsDetails(state, itemIds = []) {
    const ids = Array.from(new Set((itemIds || []).map(normalizeItemId).filter(Boolean)));
    if (!ids.length) return [];

    const all = [];
    for (let index = 0; index < ids.length; index += 20) {
      const slice = ids.slice(index, index + 20);
      const url =
        `${API_BASE}/items?ids=${slice.join(",")}` +
        "&attributes=id,title,status,permalink,category_id,catalog_listing,catalog_product_id,attributes,variations,seller_custom_field" +
        "&include_internal_attributes=true";

      const response = await this.authFetch(state, url);
      const body = await response.text().catch(() => "");

      if (!response.ok) {
        throw new Error(
          `Falha ao consultar itens na API do Mercado Livre: HTTP ${response.status} ${body}`,
        );
      }

      const payload = parseJsonSafe(body);
      const rows = Array.isArray(payload) ? payload : [];
      for (const row of rows) {
        all.push({
          id: normalizeItemId(row?.body?.id || row?.id),
          code: Number(row?.code || 0),
          body: row?.body || null,
          error: row?.body?.message || row?.error || null,
        });
      }
    }

    return ids.map((id) => {
      return all.find((row) => row.id === id) || {
        id,
        code: 404,
        body: null,
        error: "Item não encontrado.",
      };
    });
  }

  static async fetchCategoryModelInfo(state, categoryId) {
    const normalizedCategory = String(categoryId || "").trim();
    if (!normalizedCategory) {
      return {
        found: false,
        attributeId: "MODEL",
        tags: [],
        valueMaxLength: null,
        validAttributeIds: new Set(),
        attributeById: new Map(),
      };
    }

    if (CATEGORY_ATTR_CACHE.has(normalizedCategory)) {
      return CATEGORY_ATTR_CACHE.get(normalizedCategory);
    }

    const response = await this.authFetch(
      state,
      `${API_BASE}/categories/${encodeURIComponent(normalizedCategory)}/attributes`,
    );

    const bodyText = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(
        `Falha ao consultar atributos da categoria ${normalizedCategory}: HTTP ${response.status} ${bodyText}`,
      );
    }

    const payload = parseJsonSafe(bodyText);
    const list = Array.isArray(payload) ? payload : [];
    const attributeById = new Map();
    const validAttributeIds = new Set();
    for (const attribute of list) {
      const id = normalizeAttributeId(attribute?.id);
      if (!id) continue;
      validAttributeIds.add(id);
      attributeById.set(id, attribute);
    }

    const modelAttribute = list.find((attribute) => {
      const id = String(attribute?.id || "").trim().toUpperCase();
      return id === "MODEL" || id === "MODELO";
    });

    const info = {
      found: !!modelAttribute,
      attributeId: String(modelAttribute?.id || "MODEL").trim().toUpperCase(),
      name: String(modelAttribute?.name || "Modelo"),
      tags: Array.isArray(modelAttribute?.tags) ? modelAttribute.tags : [],
      valueMaxLength: Number.isInteger(modelAttribute?.value_max_length)
        ? Number(modelAttribute.value_max_length)
        : null,
      validAttributeIds,
      attributeById,
    };

    CATEGORY_ATTR_CACHE.set(normalizedCategory, info);
    return info;
  }

  static async buildPreviewRows(mlCreds, itemIds, targetModel) {
    const normalizedTargetModel = normalizeModelValue(targetModel);
    const targetModelLength = countChars(normalizedTargetModel);
    if (!normalizedTargetModel) {
      throw new Error("Informe o valor do campo modelo antes de analisar.");
    }

    const ids = Array.from(new Set((itemIds || []).map(normalizeItemId).filter(Boolean)));
    if (!ids.length) {
      throw new Error("Informe pelo menos um MLB para analisar.");
    }

    const state = await this.prepareState(mlCreds);
    const items = await this.fetchItemsDetails(state, ids);
    const rows = [];

    for (const entry of items) {
      if (entry.code !== 200 || !entry.body) {
        rows.push({
          id: entry.id,
          title: "",
          permalink: "",
          status: "nao_encontrado",
          listing_type: "desconhecido",
          current_model: "",
          target_model: normalizedTargetModel,
          can_apply: false,
          action_label: "Revisar",
          reason:
            entry.error || `Não foi possível consultar o item ${entry.id}.`,
          category_id: null,
          catalog_listing: false,
          catalog_product_id: null,
          has_variations: false,
          model_attribute_id: null,
          selected: false,
        });
        continue;
      }

      const item = entry.body;
      const listingType = inferListingType(item);
      const currentModel = extractCurrentModel(item);
      const categoryInfo = await this.fetchCategoryModelInfo(state, item.category_id);
      const status = asStatusLabel(item);
      const isCatalog = listingType === "catalogo";
      const hasVariations =
        Array.isArray(item?.variations) && item.variations.length > 0;

      let canApply = true;
      let reason = "Pronto para atualizar o atributo MODEL via API.";
      let actionLabel = "Aplicar";
      const valueMaxLength = categoryInfo.valueMaxLength;

      if (isCatalog) {
        canApply = false;
        actionLabel = "Manual";
        reason =
          "Anúncio de catálogo: a correção do modelo precisa ser feita pelo fluxo manual do Mercado Livre.";
      } else if (status !== "active") {
        canApply = false;
        actionLabel = "Bloqueado";
        reason = `Anúncio com status "${status || "desconhecido"}".`;
      } else if (!categoryInfo.found) {
        canApply = false;
        actionLabel = "Revisar";
        reason =
          "A categoria não expõe o atributo MODEL na API. Revise manualmente antes de tentar alterar em massa.";
      }

      if (canApply && valueMaxLength && targetModelLength > valueMaxLength) {
        canApply = false;
        actionLabel = "Revisar";
        reason =
          `O modelo alvo tem ${targetModelLength} caractere(s), mas a categoria permite no maximo ${valueMaxLength}.`;
      }

      rows.push({
        id: normalizeItemId(item.id),
        title: item.title || "",
        permalink: item.permalink || "",
        status: status || "desconhecido",
        listing_type: listingType,
        current_model: currentModel,
        target_model: normalizedTargetModel,
        can_apply: canApply,
        action_label: actionLabel,
        reason,
        category_id: item.category_id || null,
        catalog_listing: !!item.catalog_listing,
        catalog_product_id: item.catalog_product_id || null,
        has_variations: hasVariations,
        model_attribute_id: categoryInfo.attributeId || "MODEL",
        model_value_max_length: valueMaxLength,
        target_model_length: targetModelLength,
        selected: canApply,
        seller_custom_field: item.seller_custom_field || "",
      });
    }

    return rows;
  }

  static async applyModelForItem(state, itemId, options = {}) {
    const normalizedItemId = normalizeItemId(itemId);
    const targetModel = normalizeModelValue(options.target_model);
    const targetModelLength = countChars(targetModel);
    if (!normalizedItemId) throw new Error("MLB inválido para atualização.");
    if (!targetModel) throw new Error("Modelo alvo inválido.");

    const [entry] = await this.fetchItemsDetails(state, [normalizedItemId]);
    if (!entry || entry.code !== 200 || !entry.body) {
      return {
        id: normalizedItemId,
        status: "error",
        reason: entry?.error || "Não foi possível carregar o anúncio.",
      };
    }

    const item = entry.body;
    const listingType = inferListingType(item);
    const currentModel = extractCurrentModel(item);
    const categoryInfo = await this.fetchCategoryModelInfo(state, item.category_id);
    const valueMaxLength = categoryInfo.valueMaxLength;

    if (listingType === "catalogo") {
      return {
        id: normalizedItemId,
        status: "manual",
        reason:
          "Anúncio de catálogo detectado. O ajuste do modelo deve ser sugerido manualmente no Mercado Livre.",
        listing_type: listingType,
        current_model: currentModel,
        target_model: targetModel,
      };
    }

    if (asStatusLabel(item) !== "active") {
      return {
        id: normalizedItemId,
        status: "skipped",
        reason: `Anúncio com status "${item.status || "desconhecido"}".`,
        listing_type: listingType,
        current_model: currentModel,
        target_model: targetModel,
      };
    }

    if (!categoryInfo.found) {
      return {
        id: normalizedItemId,
        status: "skipped",
        reason:
          "A categoria do anúncio não expõe o atributo MODEL via API.",
        listing_type: listingType,
        current_model: currentModel,
        target_model: targetModel,
      };
    }

    if (valueMaxLength && targetModelLength > valueMaxLength) {
      return {
        id: normalizedItemId,
        status: "skipped",
        reason:
          `O modelo alvo tem ${targetModelLength} caractere(s), mas a categoria permite no maximo ${valueMaxLength}.`,
        listing_type: listingType,
        current_model: currentModel,
        target_model: targetModel,
      };
    }

    let attributes = buildUpdatedAttributes(
      item.attributes,
      categoryInfo,
      targetModel,
    );

    if (options.dry_run) {
      return {
        id: normalizedItemId,
        status: "dry_run",
        reason: "Simulação concluída sem enviar alteração ao Mercado Livre.",
        listing_type: listingType,
        current_model: currentModel,
        target_model: targetModel,
        payload_preview: { attributes },
      };
    }

    let response = await this.authFetch(
      state,
      `${API_BASE}/items/${encodeURIComponent(normalizedItemId)}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ attributes }),
      },
    );

    let bodyText = await response.text().catch(() => "");
    let payload = parseJsonSafe(bodyText);
    let retryRemovedAttributes = [];

    if (!response.ok) {
      const targetAttributeId = normalizeAttributeId(categoryInfo.attributeId || "MODEL");
      const invalidAttributeIds = extractInvalidAttributeIds(payload).filter(
        (id) => id && id !== targetAttributeId,
      );

      if (invalidAttributeIds.length) {
        const invalidSet = new Set(invalidAttributeIds);
        const retryAttributes = attributes.filter(
          (attribute) => !invalidSet.has(normalizeAttributeId(attribute?.id)),
        );

        if (retryAttributes.length !== attributes.length) {
          const retryResponse = await this.authFetch(
            state,
            `${API_BASE}/items/${encodeURIComponent(normalizedItemId)}`,
            {
              method: "PUT",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ attributes: retryAttributes }),
            },
          );

          const retryBodyText = await retryResponse.text().catch(() => "");
          const retryPayload = parseJsonSafe(retryBodyText);

          if (retryResponse.ok) {
            return {
              id: normalizedItemId,
              status: "applied",
              reason: "Campo modelo atualizado com sucesso.",
              listing_type: listingType,
              current_model: currentModel,
              target_model: targetModel,
              response: retryPayload,
              retry_removed_attributes: invalidAttributeIds,
            };
          }

          response = retryResponse;
          bodyText = retryBodyText;
          payload = retryPayload;
          attributes = retryAttributes;
          retryRemovedAttributes = invalidAttributeIds;
        }
      }
    }

    if (!response.ok) {
      const userProductConflict = extractUserProductConflict(payload);
      if (userProductConflict) {
        return {
          id: normalizedItemId,
          status: "manual",
          reason: userProductConflictReason(userProductConflict),
          listing_type: listingType,
          current_model: currentModel,
          target_model: targetModel,
          details: payload,
          user_product_conflict_id: userProductConflict.conflict_id,
          recommended_action:
            "Revise manualmente no Mercado Livre ou use um valor de modelo mais especifico para diferenciar o produto.",
          retry_removed_attributes: retryRemovedAttributes,
        };
      }

      const reason =
        payload?.message ||
        payload?.error ||
        `Falha ao atualizar ${normalizedItemId}: HTTP ${response.status}`;

      return {
        id: normalizedItemId,
        status: "error",
        reason,
        listing_type: listingType,
        current_model: currentModel,
        target_model: targetModel,
        details: payload,
        retry_removed_attributes: retryRemovedAttributes,
      };
    }

    return {
      id: normalizedItemId,
      status: "applied",
      reason: "Campo modelo atualizado com sucesso.",
      listing_type: listingType,
      current_model: currentModel,
      target_model: targetModel,
      response: payload,
    };
  }
}

module.exports = ModeloMassaService;
