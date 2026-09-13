"use strict";

const ml = require("./mercadoLivreApi");
const sourceService = require("./anuncioSourceService");
const groupService = require("./anuncioDraftGroupService");
const { httpError, normalizeText, normalizeItemId } = require("./helpers");

function ensureScope(ctx = {}) {
  if (!ctx.meliContaId || !ctx.empresaId || !ctx.sellerId) {
    throw httpError("Conta Mercado Livre ou empresa não identificada.", 409);
  }
}

function firstValue(attr = {}) {
  if (attr.value_id || attr.value_name != null) {
    return { value_id: attr.value_id || null, value_name: attr.value_name ?? null };
  }
  const first = Array.isArray(attr.values) ? attr.values[0] : null;
  return { value_id: first?.id || null, value_name: first?.name ?? null };
}

function compactAttribute(attr = {}, hierarchyMap = new Map()) {
  const id = normalizeText(attr.id, 120);
  if (!id) return null;
  const value = firstValue(attr);
  return {
    id,
    name: attr.name || null,
    value_id: value.value_id,
    value_name: value.value_name,
    hierarchy: attr.hierarchy || hierarchyMap.get(id) || null,
  };
}

function compactPicture(pic = {}) {
  const url = pic.secure_url || pic.url || pic.source || null;
  if (!url && !pic.id) return null;
  return { id: pic.id || null, source: url || null, url: url || null, secure_url: pic.secure_url || url || null };
}

function compactSaleTerm(term = {}) {
  if (!term?.id) return null;
  return { id: term.id, name: term.name || null, value_id: term.value_id || null, value_name: term.value_name ?? null };
}

function itemBody(entry) {
  if (!entry) return null;
  if (entry.body) return entry.body;
  return entry;
}

async function fetchItems(ids, ctx) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (!unique.length) return [];
  const output = [];
  for (let i = 0; i < unique.length; i += 20) {
    const chunk = unique.slice(i, i + 20);
    const response = await ml.get(`/items?ids=${encodeURIComponent(chunk.join(","))}`, { accessToken: ctx.accessToken });
    output.push(...(Array.isArray(response) ? response.map(itemBody).filter(Boolean) : []));
  }
  return output;
}

async function getSaleConditions(userProductId, ctx) {
  const search = await ml.get(`/users/${encodeURIComponent(ctx.sellerId)}/items/search`, {
    accessToken: ctx.accessToken,
    query: { user_product_id: userProductId, limit: 50 },
  });
  const ids = Array.isArray(search?.results) ? search.results : [];
  const items = await fetchItems(ids, ctx);
  return items.map((item) => ({
    item_id: item.id,
    status: item.status || null,
    title: item.title || null,
    price: item.price ?? null,
    currency_id: item.currency_id || "BRL",
    listing_type_id: item.listing_type_id || null,
    available_quantity: item.available_quantity ?? null,
    thumbnail: item.thumbnail || item.pictures?.[0]?.secure_url || item.pictures?.[0]?.url || null,
    permalink: item.permalink || null,
    sku: (item.attributes || []).find((attr) => String(attr?.id || "").toUpperCase() === "SELLER_SKU")?.value_name || null,
    _raw: item,
  }));
}

async function getDescription(itemId, ctx) {
  try {
    const data = await ml.get(`/items/${encodeURIComponent(itemId)}/description`, { accessToken: ctx.accessToken });
    return String(data?.plain_text || data?.text || "").trim();
  } catch (error) {
    if ([403, 404].includes(Number(error?.status))) return "";
    throw error;
  }
}

function attributeHierarchyMap(categoryAttributes = []) {
  return new Map((categoryAttributes || []).map((attr) => [String(attr.id || ""), attr.hierarchy || null]).filter(([id]) => id));
}

function mergeAttributes(itemAttributes = [], upAttributes = [], hierarchyMap = new Map()) {
  const map = new Map();
  for (const raw of [...upAttributes, ...itemAttributes]) {
    const attr = compactAttribute(raw, hierarchyMap);
    if (!attr?.id) continue;
    map.set(attr.id, attr);
  }
  return [...map.values()];
}

function findIdentifier(attributes, id) {
  return attributes.find((attr) => String(attr?.id || "").toUpperCase() === id)?.value_name || "";
}

function variationDisplay(childAttributes = []) {
  const color = childAttributes.find((attr) => /(^|_)(COLOR|COR)(_|$)/i.test(attr.id || "") || /\b(cor|color)\b/i.test(attr.name || ""));
  const measure = childAttributes.find((attr) => /(SIZE|WIDTH|HEIGHT|LENGTH|MEASURE|TAMANHO|LARGURA|ALTURA|COMPRIMENTO|MEDIDA)/i.test(`${attr.id || ""} ${attr.name || ""}`));
  return {
    color: color?.value_name || null,
    measure: measure?.value_name || null,
    dimensions: childAttributes.map((attr) => ({ id: attr.id, name: attr.name, value_id: attr.value_id, value_name: attr.value_name })),
  };
}

function buildFamilyBlueprint({ family, userProducts, hierarchyMap }) {
  const first = userProducts[0] || {};
  const allAttrs = userProducts.map((up) => (up.attributes || []).map((attr) => compactAttribute(attr, hierarchyMap)).filter(Boolean));
  const firstAttrs = allAttrs[0] || [];
  const parentPk = firstAttrs
    .filter((attr) => String(attr.hierarchy || "").toUpperCase() === "PARENT_PK")
    .map((attr) => ({ id: attr.id, name: attr.name, value_id: attr.value_id, value_name: attr.value_name }));
  const childMap = new Map();
  for (const attrs of allAttrs) {
    for (const attr of attrs) {
      if (String(attr.hierarchy || "").toUpperCase() === "CHILD_PK") childMap.set(attr.id, { id: attr.id, name: attr.name || null });
    }
  }
  return {
    source_family_id: family.family_id,
    family_name: family.family_name || first.family_name || first.name || null,
    domain_id: family.raw_summary?.domain_id || first.domain_id || null,
    category_id: family.raw_summary?.category_id || first.category_id || null,
    parent_pk: parentPk,
    child_pk: [...childMap.values()],
  };
}

async function discoverFamilyFromItem(input, ctx, { includeRaw = false } = {}) {
  ensureScope(ctx);
  const itemId = normalizeItemId(input);
  if (!itemId) throw httpError("Informe um MLB válido da sua conta.", 400);

  const root = await sourceService.resolveItem(itemId, ctx);
  if (root.source_type !== "own_item") {
    throw httpError("O anúncio informado pertence a outro vendedor.", 403, null, "FAMILY_CLONE_SOURCE_NOT_OWNED");
  }
  const rootUpId = root.source_snapshot?.user_product_id;
  if (!rootUpId) throw httpError("Este anúncio não pertence ao modelo User Products.", 409, null, "ITEM_WITHOUT_USER_PRODUCT");

  const rootUp = await ml.get(`/user-products/${encodeURIComponent(rootUpId)}`, { accessToken: ctx.accessToken });
  if (Number(rootUp?.user_id) !== Number(ctx.sellerId)) {
    throw httpError("O User Product do anúncio não pertence à conta selecionada.", 403, null, "USER_PRODUCT_NOT_OWNED");
  }
  const familyId = normalizeText(rootUp?.family_id || root.source_snapshot?.family_id, 120);
  if (!familyId) throw httpError("Não foi possível identificar a família deste User Product.", 422, null, "USER_PRODUCT_WITHOUT_FAMILY");

  const family = await sourceService.resolveFamily(familyId, ctx);
  const productIds = family.products.map((product) => product.user_product_id).filter(Boolean);
  if (!productIds.length) throw httpError("A família não retornou User Products para clonagem.", 422);

  const userProducts = await Promise.all(productIds.map((id) => ml.get(`/user-products/${encodeURIComponent(id)}`, { accessToken: ctx.accessToken })));
  for (const up of userProducts) {
    if (Number(up?.user_id) !== Number(ctx.sellerId)) {
      throw httpError("A família contém um User Product que não pertence à conta selecionada.", 403, { user_product_id: up?.id }, "FAMILY_USER_PRODUCT_NOT_OWNED");
    }
  }

  const categoryId = family.raw_summary?.category_id || root.source_snapshot?.category_id || userProducts[0]?.category_id || null;
  let categoryAttributes = [];
  if (categoryId) {
    categoryAttributes = await ml.get(`/categories/${encodeURIComponent(categoryId)}/attributes`, { accessToken: ctx.accessToken }).catch(() => []);
  }
  const hierarchyMap = attributeHierarchyMap(categoryAttributes);
  const blueprint = buildFamilyBlueprint({ family, userProducts, hierarchyMap });

  const variations = [];
  for (const up of userProducts) {
    const attrs = (up.attributes || []).map((attr) => compactAttribute(attr, hierarchyMap)).filter(Boolean);
    const child = attrs.filter((attr) => String(attr.hierarchy || "").toUpperCase() === "CHILD_PK");
    const conditions = await getSaleConditions(up.id, ctx);
    // Uma condição pausada/encerrada não é uma origem publicável confiável. A
    // prévia e a criação trabalham exclusivamente com condições ativas.
    const active = conditions.filter((condition) => condition.status === "active");
    const autoSelected = active.length === 1 ? active[0] : (active.length === 0 && conditions.length === 1 ? conditions[0] : null);
    const display = variationDisplay(child);
    const pictures = (up.pictures || []).map(compactPicture).filter(Boolean);
    const summaryCondition = autoSelected || active[0] || conditions[0] || null;
    const variation = {
      user_product_id: up.id,
      name: up.name || up.family_name || family.family_name || `User Product ${up.id}`,
      family_name: up.family_name || family.family_name || null,
      category_id: up.category_id || categoryId || null,
      domain_id: up.domain_id || blueprint.domain_id || null,
      attributes: attrs.map(({ hierarchy, ...attr }) => attr),
      child_attributes: child.map(({ hierarchy, ...attr }) => attr),
      color: display.color,
      measure: display.measure,
      dimensions: display.dimensions,
      sku: summaryCondition?.sku || findIdentifier(attrs, "SELLER_SKU") || null,
      image: pictures[0]?.secure_url || pictures[0]?.url || summaryCondition?.thumbnail || null,
      price: summaryCondition?.price ?? null,
      currency_id: summaryCondition?.currency_id || "BRL",
      selected_condition_item_id: autoSelected?.item_id || null,
      requires_condition_choice: active.length > 1,
      active_condition_count: active.length,
      conditions: active.map(({ _raw, ...condition }) => condition),
    };
    if (includeRaw) {
      variation._raw_user_product = up;
      variation._raw_conditions = new Map(active.map((condition) => [condition.item_id, condition._raw]));
      variation._hierarchy_map = hierarchyMap;
    }
    variations.push(variation);
  }

  return {
    source_item_id: itemId,
    source_user_product_id: rootUpId,
    source_family_id: family.family_id,
    family_name: family.family_name || rootUp.family_name || rootUp.name || null,
    family_blueprint: blueprint,
    variations,
    total_variations: variations.length,
  };
}

function buildDraftData(variation, item, description, blueprint) {
  const up = variation._raw_user_product || {};
  const hierarchyMap = variation._hierarchy_map || new Map();
  const attributes = mergeAttributes(item?.attributes || [], up.attributes || [], hierarchyMap);
  const sku = findIdentifier(attributes, "SELLER_SKU");
  const gtin = findIdentifier(attributes, "GTIN");
  const cleanAttributes = attributes
    .filter((attr) => !["SELLER_SKU", "GTIN"].includes(String(attr.id || "").toUpperCase()))
    .map(({ hierarchy, ...attr }) => attr);
  const pictures = (Array.isArray(item?.pictures) && item.pictures.length ? item.pictures : up.pictures || [])
    .map(compactPicture).filter(Boolean).map((picture) => ({ source: picture.secure_url || picture.url || picture.source }));
  return {
    title: "",
    family_name: variation.family_name || blueprint.family_name || "",
    category_id: item?.category_id || variation.category_id || blueprint.category_id || "",
    price: Number(item?.price || 0) || "",
    currency_id: item?.currency_id || "BRL",
    available_quantity: Math.max(0, Number(item?.available_quantity || 0)),
    buying_mode: item?.buying_mode || "buy_it_now",
    listing_type_id: item?.listing_type_id || "gold_special",
    condition: item?.condition || "new",
    sku,
    gtin,
    attributes: cleanAttributes,
    sale_terms: (item?.sale_terms || []).map(compactSaleTerm).filter(Boolean),
    pictures,
    description,
    shipping: {
      free_shipping: Boolean(item?.shipping?.free_shipping),
      local_pick_up: Boolean(item?.shipping?.local_pick_up),
      ...(item?.shipping?.mode ? { mode: item.shipping.mode } : {}),
    },
    channels: Array.isArray(item?.channels) && item.channels.length ? item.channels : ["marketplace"],
  };
}

async function createFamilyClone(input = {}, ctx) {
  ensureScope(ctx);
  const selected = Array.isArray(input.selected) ? input.selected : [];
  if (!selected.length) throw httpError("Selecione ao menos uma variação para clonar.", 400);
  if (selected.length > 10) throw httpError("Selecione no máximo 10 variações por clonagem.", 400, null, "FAMILY_CLONE_LIMIT");

  const discovery = await discoverFamilyFromItem(input.source_item_id || input.input, ctx, { includeRaw: true });
  const byUp = new Map(discovery.variations.map((variation) => [variation.user_product_id, variation]));
  const seen = new Set();
  const drafts = [];

  for (const choice of selected) {
    const upId = normalizeText(typeof choice === "string" ? choice : choice?.user_product_id, 120);
    if (!upId || seen.has(upId)) throw httpError("A seleção de variações é inválida ou contém duplicidades.", 400);
    seen.add(upId);
    const variation = byUp.get(upId);
    if (!variation) throw httpError(`O User Product ${upId} não pertence à família descoberta.`, 400);

    const explicitItemId = normalizeItemId(typeof choice === "object" ? choice?.source_item_id : null);
    if (variation.requires_condition_choice && !explicitItemId) {
      throw httpError(
        `O User Product ${upId} possui mais de uma condição de venda ativa. Escolha explicitamente qual será usada como origem.`,
        409,
        { user_product_id: upId, conditions: variation.conditions },
        "CONDITION_SELECTION_REQUIRED",
      );
    }
    const sourceItemId = explicitItemId || variation.selected_condition_item_id;
    if (!sourceItemId) {
      throw httpError(`Não foi possível determinar uma condição de venda de origem para ${upId}.`, 409, { user_product_id: upId }, "SOURCE_CONDITION_REQUIRED");
    }
    const condition = variation.conditions.find((row) => row.item_id === sourceItemId);
    const item = variation._raw_conditions.get(sourceItemId);
    if (!condition || !item) throw httpError(`A condição ${sourceItemId} não pertence ao User Product ${upId}.`, 400);
    if (Number(item.seller_id) !== Number(ctx.sellerId)) {
      throw httpError("Uma condição de venda selecionada não pertence à conta atual.", 403, { item_id: sourceItemId }, "SOURCE_CONDITION_NOT_OWNED");
    }

    const description = await getDescription(sourceItemId, ctx);
    const draftData = buildDraftData(variation, item, description, discovery.family_blueprint);
    drafts.push({
      source_type: "own_family",
      source_item_id: sourceItemId,
      source_user_product_id: upId,
      source_family_id: discovery.source_family_id,
      source_seller_id: ctx.sellerId,
      source_snapshot: {
        id: sourceItemId,
        user_product_id: upId,
        family_id: discovery.source_family_id,
        seller_id: ctx.sellerId,
        title: item.title || null,
        family_name: variation.family_name || discovery.family_name,
        category_id: item.category_id || variation.category_id || null,
        permalink: item.permalink || null,
        thumbnail: item.thumbnail || variation.image || null,
        price: item.price ?? null,
        cloned_as_new_family_item: true,
      },
      reference_data: {},
      publication_model: "user_products",
      publication_target: "new_item",
      category_id: draftData.category_id || null,
      family_name: draftData.family_name || null,
      title: null,
      draft_data: draftData,
    });
  }

  const defaultName = groupService.suggestedGroupName(discovery.family_name || discovery.source_family_id, new Date(), "Clonagem de");
  const name = normalizeText(input.name, 240) || defaultName;
  const created = await groupService.createGroupWithDrafts({
    group: {
      type: groupService.GROUP_FAMILY_CLONE,
      source_item_id: discovery.source_item_id,
      source_user_product_id: discovery.source_user_product_id,
      source_family_id: discovery.source_family_id,
      source_label: discovery.family_name || discovery.source_family_id,
      name,
      family_blueprint: discovery.family_blueprint,
    },
    drafts,
  }, ctx);

  return { ...created, family: {
    source_item_id: discovery.source_item_id,
    source_family_id: discovery.source_family_id,
    family_name: discovery.family_name,
    family_blueprint: discovery.family_blueprint,
  } };
}

module.exports = {
  discoverFamilyFromItem,
  createFamilyClone,
  getSaleConditions,
  buildFamilyBlueprint,
};
