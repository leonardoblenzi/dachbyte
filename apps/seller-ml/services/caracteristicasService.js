"use strict";

const fetch = require("node-fetch");
const XLSX = require("xlsx");
const ExcelJS = require("exceljs");
const TokenService = require("./tokenService");

const API_BASE = "https://api.mercadolibre.com";
const CATEGORY_CACHE = new Map();
const ATTR_CACHE = new Map();
const FIXED_EXCEL_COLUMNS = [
  "MLB",
  "SKU",
  "Titulo",
  "Status",
  "Categoria",
  "Link",
];

function parseJsonSafe(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function normalizeItemId(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function normalizeAttributeId(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizePlain(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function uniqueList(values) {
  return Array.from(new Set((values || []).map(normalizeItemId).filter(Boolean)));
}

function excelHeaderForAttribute(attribute) {
  const mark = isRequired(attribute) ? " *" : "";
  return `${normalizeText(attribute?.name || attribute?.id)} [${normalizeAttributeId(attribute?.id)}]${mark}`;
}

function parseAttributeIdFromHeader(header) {
  const match = String(header || "").match(/\[([A-Z0-9_:-]+)\]/i);
  return match ? normalizeAttributeId(match[1]) : "";
}

function sheetSafe(value) {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function findAttributeValue(attributes, id) {
  const wanted = normalizeAttributeId(id);
  return (Array.isArray(attributes) ? attributes : []).find(
    (attribute) => normalizeAttributeId(attribute?.id) === wanted,
  );
}

function displayExistingAttributeValue(attribute) {
  const picked = pickAttributeValue(attribute);
  if (!picked) return "";
  if (String(picked.value_id || "") === "-1") return "NAO_SE_APLICA";
  if (picked.value_struct?.number != null) {
    const unit = picked.value_struct?.unit || "";
    return unit ? `${picked.value_struct.number} ${unit}` : String(picked.value_struct.number);
  }
  return picked.value_name || picked.value_id || "";
}

function sanitizeFilenamePart(value) {
  return normalizePlain(value)
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "categoria";
}

function parseNumberUnitCell(raw, attribute) {
  const text = normalizeText(raw).replace(",", ".");
  if (!text) return null;
  if (isNotApplicableDisplay(text) || /^NAO_SE_APLICA$/i.test(text)) {
    return { id: normalizeAttributeId(attribute.id), value_type: attribute.value_type, not_applicable: true };
  }
  const match = text.match(/^(-?\d+(?:\.\d+)?)\s*([^\d\s]+.*)?$/);
  if (!match) return null;
  const unit = normalizeText(match[2] || attribute.default_unit || attribute.allowed_units?.[0]?.id || "");
  return {
    id: normalizeAttributeId(attribute.id),
    value_type: attribute.value_type,
    value_name: match[1],
    unit,
  };
}

function parseCellValueForAttribute(raw, attribute) {
  const text = normalizeText(raw);
  const id = normalizeAttributeId(attribute?.id);
  const type = String(attribute?.value_type || "").toLowerCase();
  if (!id || !text) return null;
  if (isNotApplicableDisplay(text) || /^NAO_SE_APLICA$/i.test(text)) {
    return { id, value_type: type, not_applicable: true };
  }

  if (type === "number_unit") {
    return parseNumberUnitCell(text, attribute) || {
      id,
      value_type: type,
      value_name: text,
      invalid_reason: `Valor numerico invalido em ${attribute.name}: "${text}".`,
    };
  }

  if (type === "number") {
    const normalizedNumber = text.replace(",", ".");
    if (!/^-?\d+(?:\.\d+)?$/.test(normalizedNumber)) {
      return {
        id,
        value_type: type,
        value_name: text,
        invalid_reason: `Valor numerico invalido em ${attribute.name}: "${text}".`,
      };
    }
    return { id, value_type: type, value_name: normalizedNumber };
  }

  if (type === "list" || type === "boolean") {
    const normalized = normalizePlain(text);
    const found = (attribute.values || []).find((value) => (
      normalizePlain(value.id) === normalized ||
      normalizePlain(value.name) === normalized
    ));
    if (!found) {
      return {
        id,
        value_type: type,
        value_name: text,
        invalid_reason: `Valor "${text}" nao existe na lista permitida de ${attribute.name}.`,
      };
    }
    return {
      id,
      value_type: type,
      value_id: found.id || "",
      value_name: found.name || text,
    };
  }

  return {
    id,
    value_type: type,
    value_name: text,
  };
}

function pickAttributeValue(attribute) {
  if (!attribute || typeof attribute !== "object") return null;
  if (attribute.value_id != null || attribute.value_name != null) {
    return {
      id: attribute.id || "",
      value_id: attribute.value_id != null ? String(attribute.value_id) : null,
      value_name: attribute.value_name != null ? String(attribute.value_name) : null,
      value_struct: attribute.value_struct || null,
      values: Array.isArray(attribute.values) ? attribute.values : null,
    };
  }
  return null;
}

function isNotApplicableDisplay(value) {
  const text = normalizePlain(value);
  return ["nao aplica", "n/a", "not applicable", "no aplica"].includes(text);
}

function normalizeTags(tags) {
  if (!tags) return {};
  if (Array.isArray(tags)) {
    return tags.reduce((acc, tag) => {
      acc[String(tag)] = true;
      return acc;
    }, {});
  }
  return tags;
}

function isRequired(attribute) {
  const tags = normalizeTags(attribute?.tags);
  return Boolean(tags.required || tags.catalog_required);
}

function isEditable(attribute) {
  const tags = normalizeTags(attribute?.tags);
  return !tags.read_only && !tags.inferred;
}

function isPrimaryAttribute(attribute) {
  const groupId = normalizeAttributeId(attribute?.attribute_group_id);
  const tags = normalizeTags(attribute?.tags);
  return (
    groupId === "MAIN" ||
    tags.required ||
    tags.catalog_required ||
    tags.product_pk ||
    Number(attribute?.relevance || 0) >= 1
  );
}

function allowsNotApplicable(attribute) {
  if (!isEditable(attribute)) return false;
  if (isRequired(attribute)) return false;
  const type = String(attribute?.value_type || "").toLowerCase();
  if (type === "boolean") return false;
  return true;
}

function simplifyCategoryAttribute(attribute, currentValue = null) {
  const tags = normalizeTags(attribute?.tags);
  const allowedUnits = Array.isArray(attribute?.allowed_units)
    ? attribute.allowed_units.map((unit) => ({
        id: String(unit?.id || unit?.name || "").trim(),
        name: String(unit?.name || unit?.id || "").trim(),
      })).filter((unit) => unit.id)
    : [];

  return {
    id: normalizeAttributeId(attribute?.id),
    name: normalizeText(attribute?.name || attribute?.id),
    value_type: String(attribute?.value_type || "string").toLowerCase(),
    value_max_length: attribute?.value_max_length != null && Number.isFinite(Number(attribute.value_max_length))
      ? Number(attribute.value_max_length)
      : null,
    tags,
    required: isRequired(attribute),
    editable: isEditable(attribute),
    allows_not_applicable: allowsNotApplicable(attribute),
    hierarchy: String(attribute?.hierarchy || "").trim(),
    relevance: Number(attribute?.relevance || 0),
    attribute_group_id: String(attribute?.attribute_group_id || "DFLT").trim(),
    attribute_group_name: String(attribute?.attribute_group_name || "Caracteristicas").trim(),
    section: isPrimaryAttribute(attribute) ? "primary" : "secondary",
    values: Array.isArray(attribute?.values)
      ? attribute.values.map((value) => ({
          id: value?.id != null ? String(value.id) : null,
          name: String(value?.name || "").trim(),
          metadata: value?.metadata || null,
        })).filter((value) => value.id || value.name)
      : [],
    allowed_units: allowedUnits,
    default_unit: String(attribute?.default_unit || allowedUnits[0]?.id || "").trim(),
    current_value: currentValue,
  };
}

function serializeValue(attribute, formValue) {
  const id = normalizeAttributeId(attribute?.id || formValue?.id);
  if (!id) return null;

  if (formValue?.not_applicable) {
    return { id, value_id: "-1", value_name: null };
  }

  const valueType = String(attribute?.value_type || formValue?.value_type || "").toLowerCase();
  const rawName = normalizeText(formValue?.value_name);
  const rawId = formValue?.value_id != null ? normalizeText(formValue.value_id) : "";

  if (!rawName && !rawId && valueType !== "boolean") return null;
  if (rawName && isNotApplicableDisplay(rawName)) {
    return { id, value_id: "-1", value_name: null };
  }

  if (valueType === "number_unit") {
    const numberValue = rawName.replace(",", ".");
    if (!numberValue) return null;
    const parsedNumber = Number(numberValue);
    if (!Number.isFinite(parsedNumber)) return null;
    const unit = normalizeText(formValue?.unit || attribute?.default_unit);
    return {
      id,
      value_name: unit ? `${numberValue} ${unit}` : numberValue,
      value_struct: unit
        ? { number: parsedNumber, unit }
        : null,
    };
  }

  if (valueType === "boolean" || valueType === "list") {
    if (rawId) {
      const known = Array.isArray(attribute?.values)
        ? attribute.values.find((value) => String(value.id) === rawId)
        : null;
      return {
        id,
        value_id: rawId,
        value_name: rawName || known?.name || null,
      };
    }
  }

  if (rawId && !rawName) {
    return { id, value_id: rawId, value_name: null };
  }

  return {
    id,
    value_name: rawName,
    value_id: rawId || null,
  };
}

function simplifyExistingAttribute(attribute, attributeMeta) {
  const picked = pickAttributeValue(attribute);
  if (!picked?.id) return null;
  if (picked.value_name && isNotApplicableDisplay(picked.value_name)) {
    return {
      id: normalizeAttributeId(picked.id),
      value_id: "-1",
      value_name: null,
    };
  }

  const valueType = String(attributeMeta?.value_type || "").toLowerCase();
  if (valueType === "number_unit" && picked.value_struct) {
    return {
      id: normalizeAttributeId(picked.id),
      value_name: picked.value_name,
      value_struct: picked.value_struct,
    };
  }

  if (picked.value_id != null || picked.value_name != null) {
    return {
      id: normalizeAttributeId(picked.id),
      value_id: picked.value_id,
      value_name: picked.value_name,
    };
  }

  return null;
}

function buildAttributesPayload(currentAttributes, categoryAttributes, submittedValues) {
  const metaById = new Map(
    (categoryAttributes || []).map((attribute) => [normalizeAttributeId(attribute.id), attribute]),
  );
  const submittedById = new Map();

  for (const value of Array.isArray(submittedValues) ? submittedValues : []) {
    const id = normalizeAttributeId(value?.id);
    if (!id || !metaById.has(id)) continue;
    const meta = metaById.get(id);
    if (!isEditable(meta)) continue;
    const serialized = serializeValue(meta, value);
    if (serialized) submittedById.set(id, serialized);
  }

  const output = [];
  const used = new Set();
  for (const attribute of Array.isArray(currentAttributes) ? currentAttributes : []) {
    const id = normalizeAttributeId(attribute?.id);
    if (!id || used.has(id) || !metaById.has(id)) continue;

    if (submittedById.has(id)) {
      output.push(submittedById.get(id));
      used.add(id);
      continue;
    }

    const meta = metaById.get(id);
    if (!isEditable(meta)) continue;
    const simplified = simplifyExistingAttribute(attribute, meta);
    if (simplified) {
      output.push(simplified);
      used.add(id);
    }
  }

  for (const [id, value] of submittedById.entries()) {
    if (used.has(id)) continue;
    output.push(value);
    used.add(id);
  }

  return output;
}

class CaracteristicasService {
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

  static async searchCategories(mlCreds, query) {
    const q = normalizeText(query);
    if (q.length < 2) return [];

    const state = await this.prepareState(mlCreds);
    const url = `${API_BASE}/sites/MLB/domain_discovery/search?limit=12&q=${encodeURIComponent(q)}`;
    const response = await this.authFetch(state, url);
    const bodyText = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(`Falha ao buscar categorias: HTTP ${response.status} ${bodyText}`);
    }

    const payload = parseJsonSafe(bodyText);
    const rows = Array.isArray(payload) ? payload : [];
    const seen = new Set();
    return rows
      .map((row) => ({
        category_id: normalizeText(row?.category_id),
        category_name: normalizeText(row?.category_name),
        domain_id: normalizeText(row?.domain_id),
        domain_name: normalizeText(row?.domain_name),
      }))
      .filter((row) => {
        if (!row.category_id || seen.has(row.category_id)) return false;
        seen.add(row.category_id);
        return true;
      });
  }

  static async getSellerId(state) {
    const response = await this.authFetch(state, `${API_BASE}/users/me`);
    const bodyText = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(`Falha ao consultar vendedor atual: HTTP ${response.status} ${bodyText}`);
    }
    const payload = parseJsonSafe(bodyText);
    return payload?.id;
  }

  static async listActiveItemIds(state, { limit = 5000 } = {}) {
    const sellerId = await this.getSellerId(state);
    const maxItems = Math.min(Math.max(Number(limit || 5000), 1), 20000);
    const ids = [];
    let cursor = "";
    let total = null;

    for (;;) {
      const url = new URL(`${API_BASE}/users/${sellerId}/items/search`);
      url.searchParams.set("status", "active");
      url.searchParams.set("search_type", "scan");
      url.searchParams.set("limit", "50");
      if (cursor) url.searchParams.set("scroll_id", cursor);

      const response = await this.authFetch(state, url.toString());
      const bodyText = await response.text().catch(() => "");
      if (!response.ok) {
        throw new Error(`Falha ao listar anuncios ativos: HTTP ${response.status} ${bodyText}`);
      }
      const payload = parseJsonSafe(bodyText);
      const results = Array.isArray(payload?.results)
        ? payload.results.map(normalizeItemId).filter(Boolean)
        : [];
      if (total == null) total = Number(payload?.paging?.total || 0) || null;
      ids.push(...results);
      cursor = normalizeText(payload?.scroll_id);
      if (!cursor || !results.length || ids.length >= maxItems) break;
    }

    return {
      ids: ids.slice(0, maxItems),
      total,
      truncated: total != null ? ids.length < total : false,
    };
  }

  static async fetchItemsDetails(state, itemIds = []) {
    const ids = uniqueList(itemIds);
    if (!ids.length) return [];

    const all = [];
    for (let index = 0; index < ids.length; index += 20) {
      const slice = ids.slice(index, index + 20);
      const url =
        `${API_BASE}/items?ids=${slice.join(",")}` +
        "&attributes=id,title,status,permalink,category_id,catalog_listing,catalog_product_id,attributes,seller_custom_field" +
        "&include_internal_attributes=true";

      const response = await this.authFetch(state, url);
      const bodyText = await response.text().catch(() => "");
      if (!response.ok) {
        throw new Error(`Falha ao consultar anuncios: HTTP ${response.status} ${bodyText}`);
      }

      const payload = parseJsonSafe(bodyText);
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

    return ids.map((id) => (
      all.find((row) => row.id === id) || {
        id,
        code: 404,
        body: null,
        error: "Item nao encontrado.",
      }
    ));
  }

  static async listAccountCategories(mlCreds, options = {}) {
    const state = await this.prepareState(mlCreds);
    const active = await this.listActiveItemIds(state, {
      limit: options.limit || 10000,
    });
    const details = await this.fetchItemsDetails(state, active.ids);
    const groups = new Map();

    for (const entry of details) {
      if (entry.code !== 200 || !entry.body) continue;
      const categoryId = normalizeText(entry.body.category_id).toUpperCase();
      if (!categoryId) continue;
      if (!groups.has(categoryId)) {
        groups.set(categoryId, {
          category_id: categoryId,
          category_name: categoryId,
          total: 0,
          active: 0,
          catalog: 0,
          sample_title: "",
        });
      }
      const row = groups.get(categoryId);
      row.total += 1;
      if (normalizePlain(entry.body.status) === "active") row.active += 1;
      if (entry.body.catalog_listing === true) row.catalog += 1;
      if (!row.sample_title) row.sample_title = normalizeText(entry.body.title);
    }

    const categories = [];
    for (const row of groups.values()) {
      try {
        const info = await this.fetchCategoryInfo(state, row.category_id);
        categories.push({
          ...row,
          category_name: info.name || row.category_name,
          path: info.path || [],
        });
      } catch {
        categories.push(row);
      }
    }

    categories.sort((a, b) => b.total - a.total || a.category_name.localeCompare(b.category_name, "pt-BR"));
    return {
      categories,
      scanned_items: details.length,
      total_active_items: active.total,
      truncated: active.truncated,
    };
  }

  static async fetchCategoryInfo(state, categoryId) {
    const id = normalizeText(categoryId).toUpperCase();
    if (!/^MLB\d+$/i.test(id)) throw new Error("Informe uma categoria valida.");
    if (CATEGORY_CACHE.has(id)) return CATEGORY_CACHE.get(id);

    const response = await this.authFetch(state, `${API_BASE}/categories/${encodeURIComponent(id)}`);
    const bodyText = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(`Falha ao consultar categoria ${id}: HTTP ${response.status} ${bodyText}`);
    }

    const payload = parseJsonSafe(bodyText);
    const info = {
      id,
      name: normalizeText(payload?.name || id),
      path: Array.isArray(payload?.path_from_root)
        ? payload.path_from_root.map((node) => normalizeText(node?.name)).filter(Boolean)
        : [],
    };
    CATEGORY_CACHE.set(id, info);
    return info;
  }

  static async fetchCategoryAttributes(state, categoryId) {
    const id = normalizeText(categoryId).toUpperCase();
    if (ATTR_CACHE.has(id)) return ATTR_CACHE.get(id);

    const response = await this.authFetch(
      state,
      `${API_BASE}/categories/${encodeURIComponent(id)}/attributes`,
    );
    const bodyText = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(`Falha ao consultar atributos da categoria ${id}: HTTP ${response.status} ${bodyText}`);
    }

    const payload = parseJsonSafe(bodyText);
    const attributes = (Array.isArray(payload) ? payload : [])
      .map((attribute) => ({ ...attribute, tags: normalizeTags(attribute?.tags) }))
      .filter((attribute) => normalizeAttributeId(attribute?.id));

    ATTR_CACHE.set(id, attributes);
    return attributes;
  }

  static async preview(mlCreds, options = {}) {
    const state = await this.prepareState(mlCreds);
    const ids = uniqueList(options.item_ids);
    let categoryId = normalizeText(options.category_id).toUpperCase();
    let items = [];

    if (ids.length) {
      items = await this.fetchItemsDetails(state, ids);
      const foundItems = items.filter((entry) => entry.code === 200 && entry.body).map((entry) => entry.body);
      const categories = Array.from(new Set(foundItems.map((item) => normalizeText(item.category_id)).filter(Boolean)));
      if (!categoryId && categories.length === 1) categoryId = categories[0];
      if (!categoryId && categories.length > 1) {
        return {
          success: true,
          can_apply: false,
          reason: "O lote possui mais de uma categoria. Separe os MLBs por categoria antes de aplicar.",
          category_conflict: true,
          categories,
          items: this.formatItemRows(items, categoryId),
          attributes: [],
        };
      }
    }

    if (!categoryId) throw new Error("Selecione uma categoria ou informe MLBs para identificar a categoria.");

    const category = await this.fetchCategoryInfo(state, categoryId);
    const categoryAttributes = await this.fetchCategoryAttributes(state, categoryId);
    const itemRows = this.formatItemRows(items, categoryId);
    const mismatches = itemRows.filter((row) => row.found && row.category_id !== categoryId);
    const canApply = ids.length ? mismatches.length === 0 && itemRows.some((row) => row.found) : false;
    const sampleItem = items.find((entry) => entry.code === 200 && entry.body?.category_id === categoryId)?.body || null;
    const currentById = new Map(
      (sampleItem?.attributes || []).map((attribute) => [
        normalizeAttributeId(attribute?.id),
        pickAttributeValue(attribute),
      ]),
    );

    const attrs = categoryAttributes
      .filter((attribute) => isEditable(attribute))
      .map((attribute) => simplifyCategoryAttribute(attribute, currentById.get(normalizeAttributeId(attribute.id)) || null))
      .sort((a, b) => {
        if (a.section !== b.section) return a.section === "primary" ? -1 : 1;
        if (a.required !== b.required) return a.required ? -1 : 1;
        return a.name.localeCompare(b.name, "pt-BR");
      });

    return {
      success: true,
      can_apply: canApply,
      reason: mismatches.length
        ? "Existem anuncios fora da categoria selecionada. Eles ficarao bloqueados para aplicacao."
        : "Categoria validada. Preencha as caracteristicas e aplique apenas nos anuncios elegiveis.",
      category,
      categories: Array.from(new Set(itemRows.map((row) => row.category_id).filter(Boolean))),
      item_count: itemRows.length,
      eligible_count: itemRows.filter((row) => row.can_apply).length,
      mismatch_count: mismatches.length,
      items: itemRows,
      attributes: attrs,
    };
  }

  static async itemsByCategory(state, categoryId) {
    const active = await this.listActiveItemIds(state, { limit: 20000 });
    const details = await this.fetchItemsDetails(state, active.ids);
    const wanted = normalizeText(categoryId).toUpperCase();
    return details
      .filter((entry) => entry.code === 200 && entry.body)
      .filter((entry) => normalizeText(entry.body.category_id).toUpperCase() === wanted);
  }

  static workbookAttributeColumns(categoryAttributes) {
    return (categoryAttributes || [])
      .filter((attribute) => isEditable(attribute))
      .sort((a, b) => {
        const aPrimary = isPrimaryAttribute(a) ? 0 : 1;
        const bPrimary = isPrimaryAttribute(b) ? 0 : 1;
        if (aPrimary !== bPrimary) return aPrimary - bPrimary;
        if (isRequired(a) !== isRequired(b)) return isRequired(a) ? -1 : 1;
        return normalizeText(a.name).localeCompare(normalizeText(b.name), "pt-BR");
      });
  }

  static async buildCategoryWorkbook(mlCreds, options = {}) {
    const state = await this.prepareState(mlCreds);
    const categoryId = normalizeText(options.category_id).toUpperCase();
    if (!categoryId) throw new Error("Categoria obrigatoria para exportar Excel.");

    const mode = normalizePlain(options.mode) === "model" ? "model" : "filled";
    const category = await this.fetchCategoryInfo(state, categoryId);
    const categoryAttributes = await this.fetchCategoryAttributes(state, categoryId);
    const attributes = this.workbookAttributeColumns(categoryAttributes);
    const items = await this.itemsByCategory(state, categoryId);
    const headers = [...FIXED_EXCEL_COLUMNS, ...attributes.map(excelHeaderForAttribute)];
    const rows = [headers];

    for (const entry of items) {
      const item = entry.body;
      const line = [
        normalizeItemId(item.id),
        normalizeText(item.seller_custom_field),
        normalizeText(item.title),
        normalizeText(item.status),
        categoryId,
        normalizeText(item.permalink),
      ];

      for (const attribute of attributes) {
        const current = mode === "filled"
          ? findAttributeValue(item.attributes, attribute.id)
          : null;
        line.push(current ? displayExistingAttributeValue(current) : "");
      }
      rows.push(line);
    }

    const allowedRows = [["attribute_id", "attribute_name", "required", "value_type", "allowed_value_id", "allowed_value_name", "allowed_units"]];
    for (const attribute of attributes) {
      const values = Array.isArray(attribute.values) && attribute.values.length
        ? attribute.values
        : [null];
      for (const value of values) {
        allowedRows.push([
          normalizeAttributeId(attribute.id),
          normalizeText(attribute.name),
          isRequired(attribute) ? "SIM" : "NAO",
          normalizeText(attribute.value_type),
          value?.id || "",
          value?.name || "",
          (attribute.allowed_units || []).map((unit) => unit.id || unit.name).filter(Boolean).join(" | "),
        ]);
      }
    }

    const instructionRows = [
      ["COMO PREENCHER O MODELO DE CARACTERISTICAS", ""],
      ["Siga estas orientacoes antes de importar o arquivo na Davantti.", ""],
      ["Campo", "Orientacao"],
      ["MLB", "Nao altere. Cada linha representa um anuncio da categoria."],
      ["Colunas vermelhas com *", "Sao obrigatorias. Se estiverem vazias no anuncio e na planilha, a linha sera marcada como erro."],
      ["Campos com lista", "Selecione uma opcao no menu da celula. A aba Valores permitidos mostra todas as alternativas."],
      ["Campos numericos", "Informe apenas numeros. Campos com unidade aceitam formatos como 10 cm, 2 kg ou 1,5 m."],
      ["NAO_SE_APLICA", "Use somente em atributos opcionais que disponibilizam essa opcao."],
      ["Processamento", "Ao aplicar, cada MLB sera processado individualmente pelo job. Sucessos e erros ficarao no CSV final."],
      ["Importante", "Nao renomeie colunas, nao exclua a coluna MLB e nao misture anuncios de categorias diferentes."],
    ];

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Davantti";
    workbook.created = new Date();

    const instructionsSheet = workbook.addWorksheet("Instrucoes", {
      views: [{ state: "frozen", ySplit: 3 }],
      properties: { tabColor: { argb: "FF2563EB" } },
    });
    const sheet = workbook.addWorksheet("Caracteristicas", {
      views: [{ state: "frozen", ySplit: 1, xSplit: FIXED_EXCEL_COLUMNS.length }],
      properties: { defaultRowHeight: 18 },
    });
    const allowedSheet = workbook.addWorksheet("Valores permitidos", {
      views: [{ state: "frozen", ySplit: 1 }],
    });

    sheet.addRows(rows);
    allowedSheet.addRows(allowedRows);
    instructionsSheet.addRows(instructionRows);

    headers.forEach((header, index) => {
      sheet.getColumn(index + 1).width = Math.min(
        Math.max(String(header).length + 2, 14),
        44,
      );
    });
    [16, 32, 12, 18, 20, 34, 28].forEach((width, index) => {
      allowedSheet.getColumn(index + 1).width = width;
    });
    instructionsSheet.getColumn(1).width = 24;
    instructionsSheet.getColumn(2).width = 96;

    const headerStyle = {
      font: { bold: true, color: { argb: "FFFFFFFF" } },
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } },
      alignment: { vertical: "middle", wrapText: true },
    };
    [sheet, allowedSheet].forEach((worksheet) => {
      worksheet.getRow(1).eachCell((cell) => {
        cell.font = headerStyle.font;
        cell.fill = headerStyle.fill;
        cell.alignment = headerStyle.alignment;
      });
      worksheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: worksheet.columnCount },
      };
    });

    instructionsSheet.mergeCells("A1:B1");
    instructionsSheet.mergeCells("A2:B2");
    instructionsSheet.getCell("A1").font = { bold: true, size: 18, color: { argb: "FFFFFFFF" } };
    instructionsSheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D4ED8" } };
    instructionsSheet.getCell("A1").alignment = { vertical: "middle" };
    instructionsSheet.getCell("A2").font = { italic: true, color: { argb: "FF334155" } };
    instructionsSheet.getCell("A2").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDBEAFE" } };
    instructionsSheet.getRow(1).height = 34;
    instructionsSheet.getRow(2).height = 25;
    instructionsSheet.getRow(3).eachCell((cell) => {
      cell.font = headerStyle.font;
      cell.fill = headerStyle.fill;
      cell.alignment = headerStyle.alignment;
    });
    for (let rowNumber = 4; rowNumber <= instructionRows.length; rowNumber += 1) {
      const row = instructionsSheet.getRow(rowNumber);
      row.height = 32;
      row.getCell(1).font = { bold: true, color: { argb: "FF0F172A" } };
      row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF6FF" } };
      row.getCell(2).alignment = { vertical: "middle", wrapText: true };
      row.eachCell((cell) => {
        cell.border = {
          bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
        };
      });
    }

    const validationStartColumn = headers.length + 2;
    const validationLastRow = Math.max(items.length + 1, 2);
    let validationColumn = validationStartColumn;

    attributes.forEach((attribute, attributeIndex) => {
      if (!isRequired(attribute)) return;
      const targetColumn = FIXED_EXCEL_COLUMNS.length + attributeIndex + 1;
      const targetLetter = sheet.getColumn(targetColumn).letter;
      const targetRange = `${targetLetter}2:${targetLetter}${validationLastRow}`;
      sheet.getCell(1, targetColumn).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFB91C1C" },
      };
      sheet.getColumn(targetColumn).eachCell({ includeEmpty: true }, (cell, rowNumber) => {
        if (rowNumber < 2 || rowNumber > validationLastRow) return;
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFFEE2E2" },
        };
      });
      sheet.addConditionalFormatting({
        ref: targetRange,
        rules: [{
          type: "expression",
          formulae: [`LEN(TRIM(${targetLetter}2))=0`],
          style: {
            fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFCA5A5" } },
            font: { color: { argb: "FF991B1B" }, bold: true },
          },
        }],
      });
    });

    attributes.forEach((attribute, attributeIndex) => {
      const type = String(attribute?.value_type || "").toLowerCase();
      const values = Array.isArray(attribute?.values)
        ? attribute.values
            .map((value) => normalizeText(value?.name || value?.id))
            .filter(Boolean)
        : [];
      if (!values.length || !["list", "boolean"].includes(type)) return;

      const uniqueValues = Array.from(
        new Set([
          ...values,
          ...(allowsNotApplicable(attribute) ? ["NAO_SE_APLICA"] : []),
        ]),
      );
      const helperColumn = sheet.getColumn(validationColumn);
      helperColumn.hidden = true;
      helperColumn.width = 2;
      sheet.getCell(1, validationColumn).value = normalizeAttributeId(attribute.id);
      uniqueValues.forEach((value, valueIndex) => {
        sheet.getCell(valueIndex + 2, validationColumn).value = value;
      });

      const helperLetter = helperColumn.letter;
      const targetColumn = FIXED_EXCEL_COLUMNS.length + attributeIndex + 1;
      const targetLetter = sheet.getColumn(targetColumn).letter;
      const targetRange = `${targetLetter}2:${targetLetter}${validationLastRow}`;

      sheet.dataValidations.add(`${targetLetter}2:${targetLetter}${validationLastRow}`, {
        type: "list",
        allowBlank: !isRequired(attribute),
        formulae: [`$${helperLetter}$2:$${helperLetter}$${uniqueValues.length + 1}`],
        showErrorMessage: true,
        errorStyle: "stop",
        errorTitle: "Valor nao permitido",
        error: `Selecione um valor da lista de ${normalizeText(attribute.name)}.`,
        showInputMessage: true,
        promptTitle: normalizeText(attribute.name),
        prompt: "Selecione uma opcao da lista.",
      });
      validationColumn += 1;
    });

    attributes.forEach((attribute, attributeIndex) => {
      const type = String(attribute?.value_type || "").toLowerCase();
      if (!["number", "number_unit"].includes(type)) return;
      const targetColumn = FIXED_EXCEL_COLUMNS.length + attributeIndex + 1;
      const targetLetter = sheet.getColumn(targetColumn).letter;
      const targetRange = `${targetLetter}2:${targetLetter}${validationLastRow}`;
      const numericCore = type === "number"
        ? `IFERROR(ISNUMBER(VALUE(${targetLetter}2)),FALSE)`
        : `IFERROR(ISNUMBER(VALUE(LEFT(${targetLetter}2,FIND(" ",${targetLetter}2&" ")-1))),FALSE)`;
      const numericFormula = isRequired(attribute)
        ? numericCore
        : `OR(${targetLetter}2="",${numericCore})`;
      sheet.dataValidations.add(targetRange, {
        type: "custom",
        allowBlank: !isRequired(attribute),
        formulae: [numericFormula],
        showErrorMessage: true,
        errorStyle: "stop",
        errorTitle: "Valor numerico invalido",
        error: type === "number_unit"
          ? "Informe um numero, opcionalmente seguido da unidade. Exemplo: 10 cm."
          : "Informe somente um valor numerico.",
      });
      sheet.addConditionalFormatting({
        ref: targetRange,
        rules: [{
          type: "expression",
          formulae: [`NOT(${numericFormula})`],
          style: {
            fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFECACA" } },
            font: { color: { argb: "FF991B1B" }, bold: true },
          },
        }],
      });
    });

    sheet.getRow(1).height = 34;
    sheet.autoFilter = `A1:${sheet.getColumn(headers.length).letter}1`;

    const output = await workbook.xlsx.writeBuffer();
    const buffer = Buffer.from(output);
    const filename = `caracteristicas-${sanitizeFilenamePart(category.name)}-${categoryId}-${mode}.xlsx`;
    return { filename, buffer };
  }

  static parseWorkbookRows(buffer) {
    const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
    const sheetName =
      workbook.SheetNames.find((name) => normalizePlain(name) === "caracteristicas") ||
      workbook.SheetNames[0];
    if (!sheetName) throw new Error("Arquivo Excel sem planilhas.");
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
    return rows;
  }

  static async validateWorkbookImport(mlCreds, options = {}) {
    const state = await this.prepareState(mlCreds);
    const categoryId = normalizeText(options.category_id).toUpperCase();
    if (!categoryId) throw new Error("Categoria obrigatoria para validar importacao.");
    if (!options.buffer) throw new Error("Arquivo Excel obrigatorio.");

    await this.fetchCategoryInfo(state, categoryId);
    const categoryAttributes = await this.fetchCategoryAttributes(state, categoryId);
    const editable = this.workbookAttributeColumns(categoryAttributes);
    const metaById = new Map(editable.map((attribute) => [normalizeAttributeId(attribute.id), attribute]));
    const rawRows = this.parseWorkbookRows(options.buffer);
    const itemIds = uniqueList(rawRows.map((row) => row.MLB || row.mlb));
    const details = await this.fetchItemsDetails(state, itemIds);
    const detailsById = new Map(details.map((entry) => [entry.id, entry]));

    const parsedRows = [];
    const errors = [];
    const warnings = [];

    rawRows.forEach((row, index) => {
      const lineNumber = index + 2;
      const itemId = normalizeItemId(row.MLB || row.mlb);
      const rowErrors = [];
      const rowWarnings = [];
      const submitted = [];

      if (!itemId) rowErrors.push("Linha sem MLB.");
      const entry = detailsById.get(itemId);
      const item = entry?.body || null;
      if (!entry || entry.code !== 200 || !item) {
        rowErrors.push("MLB nao encontrado na conta atual.");
      } else if (normalizeText(item.category_id).toUpperCase() !== categoryId) {
        rowErrors.push(`MLB pertence a categoria ${item.category_id}, nao ${categoryId}.`);
      } else if (item.catalog_listing === true) {
        rowErrors.push("Anuncio de catalogo bloqueado para edicao em massa.");
      }

      for (const [header, value] of Object.entries(row)) {
        const attributeId = parseAttributeIdFromHeader(header);
        if (!attributeId) continue;
        const attribute = metaById.get(attributeId);
        if (!attribute) {
          rowWarnings.push(`Coluna ${header} ignorada: atributo inexistente ou nao editavel.`);
          continue;
        }
        const parsed = parseCellValueForAttribute(value, attribute);
        if (!parsed) continue;
        if (parsed.invalid_reason) rowErrors.push(parsed.invalid_reason);
        else submitted.push(parsed);
      }

      for (const attribute of editable) {
        if (!isRequired(attribute)) continue;
        const hasValue = submitted.some((value) => normalizeAttributeId(value.id) === normalizeAttributeId(attribute.id));
        const current = item ? findAttributeValue(item.attributes, attribute.id) : null;
        if (!hasValue && !current) {
          rowErrors.push(`Obrigatorio sem valor: ${attribute.name}.`);
        }
      }

      const shaped = {
        line: lineNumber,
        id: itemId,
        title: normalizeText(item?.title || row.Titulo || row.titulo),
        sku: normalizeText(item?.seller_custom_field || row.SKU || row.sku),
        item_status: normalizeText(item?.status || row.Status || row.status),
        category_id: normalizeText(item?.category_id || row.Categoria || row.categoria).toUpperCase(),
        permalink: normalizeText(item?.permalink || row.Link || row.link),
        status: rowErrors.length ? "error" : "ready",
        errors: rowErrors,
        warnings: rowWarnings,
        attributes: submitted,
      };
      parsedRows.push(shaped);
      rowErrors.forEach((message) => errors.push({ line: lineNumber, id: itemId, message }));
      rowWarnings.forEach((message) => warnings.push({ line: lineNumber, id: itemId, message }));
    });

    return {
      category_id: categoryId,
      total_rows: parsedRows.length,
      ready_count: parsedRows.filter((row) => row.status === "ready").length,
      error_count: errors.length,
      warning_count: warnings.length,
      rows: parsedRows,
      apply_rows: parsedRows.map((row) => ({
          id: row.id,
          sku: row.sku,
          title: row.title,
          item_status: row.item_status,
          category_id: row.category_id,
          permalink: row.permalink,
          attributes: row.attributes,
          validation_errors: row.errors,
          validation_warnings: row.warnings,
        })),
      errors,
      warnings,
    };
  }

  static formatItemRows(items, expectedCategoryId) {
    return (items || []).map((entry) => {
      const item = entry.body || {};
      const found = entry.code === 200 && Boolean(entry.body);
      const categoryId = normalizeText(item.category_id).toUpperCase();
      const categoryMatches = !expectedCategoryId || categoryId === expectedCategoryId;
      const catalogListing = item.catalog_listing === true;
      return {
        id: entry.id,
        found,
        title: found ? normalizeText(item.title) : "",
        status: found ? normalizeText(item.status) : "nao_encontrado",
        permalink: found ? normalizeText(item.permalink) : "",
        category_id: categoryId || null,
        catalog_listing: catalogListing,
        seller_custom_field: normalizeText(item.seller_custom_field),
        can_apply: found && categoryMatches && !catalogListing,
        reason: !found
          ? entry.error || "Item nao encontrado."
          : !categoryMatches
            ? `Categoria diferente (${categoryId || "sem categoria"}).`
            : catalogListing
              ? "Anuncio de catalogo exige revisao manual."
              : "Elegivel para aplicar caracteristicas.",
      };
    });
  }

  static async apply(mlCreds, options = {}) {
    const state = await this.prepareState(mlCreds);
    const ids = uniqueList(options.item_ids);
    const categoryId = normalizeText(options.category_id).toUpperCase();
    if (!ids.length) throw new Error("Informe ao menos um MLB para aplicar.");
    if (!categoryId) throw new Error("Categoria obrigatoria para aplicar caracteristicas.");

    const items = await this.fetchItemsDetails(state, ids);
    const categoryAttributes = await this.fetchCategoryAttributes(state, categoryId);
    const rows = this.formatItemRows(items, categoryId);
    const invalidCategory = rows.filter((row) => row.found && row.category_id !== categoryId);
    if (invalidCategory.length) {
      return {
        success: false,
        error: "O lote possui anuncios de categorias diferentes. Separe os MLBs antes de aplicar.",
        items: rows,
        results: [],
      };
    }

    const results = [];
    for (const entry of items) {
      const row = rows.find((item) => item.id === entry.id);
      if (!row?.can_apply || !entry.body) {
        results.push({
          id: entry.id,
          status: "skipped",
          reason: row?.reason || "Anuncio nao elegivel.",
        });
        continue;
      }

      const attributes = buildAttributesPayload(
        entry.body.attributes,
        categoryAttributes,
        options.attributes,
      );

      if (options.dry_run) {
        results.push({
          id: entry.id,
          status: "dry_run",
          reason: "Simulacao concluida.",
          payload_preview: { attributes },
        });
        continue;
      }

      const response = await this.authFetch(
        state,
        `${API_BASE}/items/${encodeURIComponent(entry.id)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ attributes }),
        },
      );
      const bodyText = await response.text().catch(() => "");
      const payload = parseJsonSafe(bodyText);

      if (!response.ok) {
        results.push({
          id: entry.id,
          status: "error",
          reason: payload?.message || payload?.error || `HTTP ${response.status}`,
          details: payload,
        });
        continue;
      }

      results.push({
        id: entry.id,
        status: "applied",
        reason: "Caracteristicas atualizadas com sucesso.",
        response: payload,
      });
    }

    return {
      success: true,
      total: results.length,
      applied: results.filter((result) => result.status === "applied").length,
      errors: results.filter((result) => result.status === "error").length,
      skipped: results.filter((result) => result.status === "skipped").length,
      dry_run: Boolean(options.dry_run),
      results,
    };
  }

  static async applyRowValues(state, itemId, categoryId, categoryAttributes, submittedValues, { dryRun = false } = {}) {
    const entry = (await this.fetchItemsDetails(state, [itemId]))[0];
    const row = this.formatItemRows([entry], categoryId)[0];

    if (!row?.can_apply || !entry?.body) {
      return {
        id: itemId,
        status: "skipped",
        reason: row?.reason || "Anuncio nao elegivel.",
      };
    }

    const attributes = buildAttributesPayload(
      entry.body.attributes,
      categoryAttributes,
      submittedValues,
    );
    const metaById = new Map(
      (categoryAttributes || []).map((attribute) => [
        normalizeAttributeId(attribute.id),
        attribute,
      ]),
    );
    const currentById = new Map(
      (entry.body.attributes || []).map((attribute) => [
        normalizeAttributeId(attribute.id),
        attribute,
      ]),
    );
    const submittedSummary = attributes.map((attribute) => {
      const id = normalizeAttributeId(attribute?.id);
      const current = currentById.get(id);
      return {
        id,
        name: normalizeText(metaById.get(id)?.name || id),
        previous_value: current ? displayExistingAttributeValue(current) : "",
        requested_value: displayExistingAttributeValue(attribute),
        value_id: attribute?.value_id ?? null,
        value_name: attribute?.value_name ?? null,
        value_struct: attribute?.value_struct || null,
      };
    });

    if (dryRun) {
      return {
        id: itemId,
        status: "dry_run",
        reason: "Simulacao concluida.",
        payload_preview: { attributes },
        submitted_attributes: submittedSummary,
      };
    }

    const response = await this.authFetch(
      state,
      `${API_BASE}/items/${encodeURIComponent(itemId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attributes }),
      },
    );
    const bodyText = await response.text().catch(() => "");
    const payload = parseJsonSafe(bodyText);

    if (!response.ok) {
      return {
        id: itemId,
        status: "error",
        reason: payload?.message || payload?.error || `HTTP ${response.status}`,
        details: payload,
        submitted_attributes: submittedSummary,
      };
    }

    return {
      id: itemId,
      status: "applied",
      reason: "Caracteristicas atualizadas com sucesso.",
      response: payload,
      submitted_attributes: submittedSummary,
      applied_attributes: submittedSummary,
    };
  }
}

module.exports = CaracteristicasService;
