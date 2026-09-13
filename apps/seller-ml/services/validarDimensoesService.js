const fetch = require('node-fetch');
const TokenService = require('./tokenService');
const config = require('../config/config');

const PACKAGE_ATTR_IDS = {
  height: 'SELLER_PACKAGE_HEIGHT',
  width: 'SELLER_PACKAGE_WIDTH',
  length: 'SELLER_PACKAGE_LENGTH',
  weight: 'SELLER_PACKAGE_WEIGHT',
  type: 'SELLER_PACKAGE_TYPE',
};

function urls() {
  return {
    items_base: config?.urls?.items || 'https://api.mercadolibre.com/items',
  };
}

function chunk(array, size) {
  const out = [];
  for (let index = 0; index < array.length; index += size) {
    out.push(array.slice(index, index + size));
  }
  return out;
}

async function prepararAuthState(options = {}) {
  if (options?.token && options?.creds) return options;
  const tokenResponse = await TokenService.renovarTokenSeNecessario(options?.mlCreds || {});
  const token =
    typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.access_token || null;
  const creds = options?.mlCreds || {};
  if (token) creds.access_token = token;
  return {
    token,
    creds,
    key: options?.accountKey || options?.key || 'conta',
  };
}

function updateStateFromToken(state, tokenData = {}) {
  const token = tokenData?.access_token || state.token;
  state.token = token;
  if (state.creds) {
    state.creds.access_token = token;
    if (tokenData?.refresh_token) state.creds.refresh_token = tokenData.refresh_token;
    if (tokenData?.expires_in) {
      state.creds.access_expires_at = new Date(
        Date.now() + Number(tokenData.expires_in) * 1000
      ).toISOString();
    }
  }
}

async function authFetch(url, init, state) {
  const call = async (tok) => {
    const headers = { ...(init?.headers || {}), Authorization: `Bearer ${tok}` };
    return fetch(url, { ...init, headers });
  };

  let response = await call(state.token);
  if (response.status !== 401) return response;

  const renewed = await TokenService.renovarToken(state.creds);
  updateStateFromToken(state, renewed);
  return call(state.token);
}

async function authFetchJson(url, init, state) {
  const response = await authFetch(url, init, state);
  const data = await response.json().catch(() => null);

  if (response.ok) return data || {};

  const error = new Error(
    data?.message || data?.error || `Erro na API do Mercado Livre: HTTP ${response.status}`,
  );
  error.statusCode = response.status;
  error.raw = data;
  throw error;
}

function parseShippingDimensions(dimStr) {
  if (!dimStr || typeof dimStr !== 'string') {
    return {
      height_cm: null,
      width_cm: null,
      length_cm: null,
      weight_g: null,
    };
  }

  const [dimsPart, weightPart] = dimStr.split(',');
  const dims = (dimsPart || '')
    .split('x')
    .map((part) => part.trim())
    .map((part) => Number(part.replace(',', '.')) || null);

  const [height, width, length] = dims;
  const weight = weightPart ? Number(weightPart.replace(',', '.')) || null : null;

  return {
    height_cm: height,
    width_cm: width,
    length_cm: length,
    weight_g: weight,
  };
}

function parseNumericValue(value) {
  if (value == null) return null;
  const match = String(value)
    .trim()
    .match(/-?\d+(?:[.,]\d+)?/);
  if (!match) return null;
  const num = Number(match[0].replace(',', '.'));
  return Number.isFinite(num) ? num : null;
}

function getAttributeMap(attributes = []) {
  return new Map(
    (Array.isArray(attributes) ? attributes : [])
      .filter((attr) => attr && attr.id)
      .map((attr) => [String(attr.id).toUpperCase(), attr]),
  );
}

function pickAttributeText(attr) {
  if (!attr) return null;
  if (attr.value_name != null && String(attr.value_name).trim()) return String(attr.value_name).trim();
  if (attr.value_id != null && String(attr.value_id).trim()) return String(attr.value_id).trim();
  if (Array.isArray(attr.values)) {
    for (const value of attr.values) {
      if (value?.name != null && String(value.name).trim()) return String(value.name).trim();
      if (value?.id != null && String(value.id).trim()) return String(value.id).trim();
    }
  }
  return null;
}

function extractSku(item = {}) {
  const attrMap = getAttributeMap(item.attributes);
  return (
    (item?.seller_custom_field != null && String(item.seller_custom_field).trim()) ||
    (item?.seller_sku != null && String(item.seller_sku).trim()) ||
    pickAttributeText(attrMap.get('SELLER_SKU')) ||
    pickAttributeText(attrMap.get('SKU')) ||
    null
  );
}

function readAttributeNumeric(attrMap, ids = []) {
  for (const id of ids) {
    const attr = attrMap.get(String(id).toUpperCase());
    if (!attr) continue;

    const numeric =
      parseNumericValue(attr?.value_name) ??
      parseNumericValue(attr?.value_struct?.number) ??
      parseNumericValue(attr?.values?.[0]?.name) ??
      parseNumericValue(attr?.values?.[0]?.struct?.number);

    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
  }

  return null;
}

function extractPackageDimensionAttributes(attributes = []) {
  const attrMap = getAttributeMap(attributes);
  const height = attrMap.get(PACKAGE_ATTR_IDS.height);
  const width = attrMap.get(PACKAGE_ATTR_IDS.width);
  const length = attrMap.get(PACKAGE_ATTR_IDS.length);
  const weight = attrMap.get(PACKAGE_ATTR_IDS.weight);
  const pkgType = attrMap.get(PACKAGE_ATTR_IDS.type);

  return {
    raw: {
      height: height?.value_name || null,
      width: width?.value_name || null,
      length: length?.value_name || null,
      weight: weight?.value_name || null,
      package_type: pkgType?.value_name || null,
      package_type_id: pkgType?.value_id || null,
    },
    parsed: {
      height_cm: parseNumericValue(height?.value_name),
      width_cm: parseNumericValue(width?.value_name),
      length_cm: parseNumericValue(length?.value_name),
      weight_g: parseNumericValue(weight?.value_name),
      package_type: pkgType?.value_name || null,
      package_type_id: pkgType?.value_id || null,
    },
  };
}

function isCompleteDimensions(dimensions = {}) {
  return ['height_cm', 'width_cm', 'length_cm', 'weight_g'].every((key) => {
    const value = Number(dimensions?.[key]);
    return Number.isFinite(value) && value > 0;
  });
}

function sanitizePositiveInteger(value, fieldLabel) {
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
    throw new Error(`${fieldLabel} deve ser um inteiro positivo.`);
  }
  return num;
}

function normalizeFillDimensions(input = {}) {
  const output = {
    height_cm: sanitizePositiveInteger(input.height_cm, 'Altura'),
    width_cm: sanitizePositiveInteger(input.width_cm, 'Largura'),
    length_cm: sanitizePositiveInteger(input.length_cm, 'Comprimento'),
    weight_g: sanitizePositiveInteger(input.weight_g, 'Peso'),
  };

  if (input.package_type_id) {
    output.package_type_id = String(input.package_type_id).trim();
  }

  if (input.package_type_name) {
    output.package_type_name = String(input.package_type_name).trim();
  }

  return output;
}

function inferFillDimensionsFromItem(item = {}) {
  const attrMap = getAttributeMap(item.attributes);
  const shippingParsed = parseShippingDimensions(item?.shipping?.dimensions || null);

  const heightFromAttr = readAttributeNumeric(attrMap, ['HEIGHT', 'PACKAGE_HEIGHT']);
  const widthFromAttr = readAttributeNumeric(attrMap, ['WIDTH', 'PACKAGE_WIDTH']);
  const lengthFromAttr = readAttributeNumeric(attrMap, ['LENGTH', 'DEPTH', 'PACKAGE_LENGTH']);
  const weightFromAttr = readAttributeNumeric(attrMap, [
    'WEIGHT',
    'ITEM_WEIGHT',
    'PACKAGE_WEIGHT',
    'PRODUCT_WEIGHT',
    'GROSS_WEIGHT',
    'NET_WEIGHT',
    'SHIPMENT_WEIGHT',
  ]);
  const weightFromShipping = parseNumericValue(item?.shipping?.weight);
  const weightFromItem = parseNumericValue(item?.weight);

  const inferred = {
    height_cm: heightFromAttr || shippingParsed.height_cm,
    width_cm: widthFromAttr || shippingParsed.width_cm,
    length_cm: lengthFromAttr || shippingParsed.length_cm,
    weight_g: weightFromAttr || weightFromShipping || weightFromItem || shippingParsed.weight_g,
  };

  const details = {
    source_map: {
      height_cm:
        heightFromAttr != null
          ? 'attributes: HEIGHT/PACKAGE_HEIGHT'
          : shippingParsed.height_cm != null
            ? 'shipping.dimensions'
            : null,
      width_cm:
        widthFromAttr != null
          ? 'attributes: WIDTH/PACKAGE_WIDTH'
          : shippingParsed.width_cm != null
            ? 'shipping.dimensions'
            : null,
      length_cm:
        lengthFromAttr != null
          ? 'attributes: LENGTH/DEPTH/PACKAGE_LENGTH'
          : shippingParsed.length_cm != null
            ? 'shipping.dimensions'
            : null,
      weight_g:
        weightFromAttr != null
          ? 'attributes: WEIGHT/ITEM_WEIGHT/PACKAGE_WEIGHT'
          : weightFromShipping != null
            ? 'shipping.weight'
            : weightFromItem != null
              ? 'item.weight'
              : shippingParsed.weight_g != null
                ? 'shipping.dimensions'
                : null,
    },
    found_values: inferred,
  };

  const missing = Object.entries(inferred)
    .filter(([, value]) => !(Number.isFinite(value) && value > 0))
    .map(([key]) => key);

  details.missing_fields = missing;

  if (missing.length) {
    const labels = {
      height_cm: 'altura',
      width_cm: 'largura',
      length_cm: 'comprimento',
      weight_g: 'peso',
    };
    const error = new Error(
      `Não foi possível montar medidas automáticas a partir do anúncio. Faltando: ${missing
        .map((key) => labels[key] || key)
        .join(', ')}.`,
    );
    error.autoFillDebug = details;
    throw error;
  }

  return {
    fill: normalizeFillDimensions(inferred),
    details,
  };
}

function formatShippingDimensions(fill) {
  return `${fill.height_cm}x${fill.width_cm}x${fill.length_cm},${fill.weight_g}`;
}

function pickUpdateStrategy(item) {
  const shippingMode = String(item?.shipping?.mode || '').trim().toLowerCase();
  return shippingMode === 'me2' ? 'attributes' : 'shipping.dimensions';
}

function parseSoldQuantity(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function buildMarketplaceUpdateAlert(item = {}, strategy = null) {
  const normalizedStatus = String(item?.status || '').trim().toLowerCase();
  const soldQuantity = parseSoldQuantity(item?.sold_quantity);
  const hasBids = item?.has_bids === true;

  if (strategy !== 'shipping.dimensions') {
    return {
      blocked: false,
      level: null,
      code: null,
      message: null,
    };
  }

  if (normalizedStatus === 'active' && soldQuantity != null && soldQuantity > 0) {
    return {
      blocked: true,
      level: 'error',
      code: 'ml_active_item_with_sales',
      message:
        'Mercado Livre bloqueia alteracao de shipping.dimensions em item ativo que ja possui vendas.',
    };
  }

  if (normalizedStatus === 'active' && hasBids) {
    return {
      blocked: false,
      level: 'warning',
      code: 'ml_active_item_has_bids',
      message:
        'Item ativo com has_bids=true. O Mercado Livre pode bloquear a alteracao de shipping.dimensions nesse cenario.',
    };
  }

  return {
    blocked: false,
    level: null,
    code: null,
    message: null,
  };
}

function mergeAttributesWithPackage(existingAttributes = [], fill) {
  const attrs = Array.isArray(existingAttributes)
    ? existingAttributes.filter((attr) => attr && attr.id)
    : [];

  const replacementMap = new Map([
    [PACKAGE_ATTR_IDS.height, { id: PACKAGE_ATTR_IDS.height, value_name: `${fill.height_cm} cm` }],
    [PACKAGE_ATTR_IDS.width, { id: PACKAGE_ATTR_IDS.width, value_name: `${fill.width_cm} cm` }],
    [PACKAGE_ATTR_IDS.length, { id: PACKAGE_ATTR_IDS.length, value_name: `${fill.length_cm} cm` }],
    [PACKAGE_ATTR_IDS.weight, { id: PACKAGE_ATTR_IDS.weight, value_name: `${fill.weight_g} g` }],
  ]);

  if (fill.package_type_id || fill.package_type_name) {
    replacementMap.set(PACKAGE_ATTR_IDS.type, {
      id: PACKAGE_ATTR_IDS.type,
      ...(fill.package_type_id ? { value_id: fill.package_type_id } : {}),
      ...(fill.package_type_name ? { value_name: fill.package_type_name } : {}),
    });
  }

  const merged = [];
  const seen = new Set();

  for (const attr of attrs) {
    const attrId = String(attr.id).toUpperCase();
    if (replacementMap.has(attrId)) {
      merged.push(replacementMap.get(attrId));
      seen.add(attrId);
      continue;
    }

    const nextAttr = { id: attr.id };
    if (attr.value_id != null) nextAttr.value_id = attr.value_id;
    if (attr.value_name != null) nextAttr.value_name = attr.value_name;
    if (!nextAttr.value_id && !nextAttr.value_name && attr.values?.length) {
      const firstValue = attr.values[0];
      if (firstValue?.id != null) nextAttr.value_id = firstValue.id;
      if (firstValue?.name != null) nextAttr.value_name = firstValue.name;
    }
    merged.push(nextAttr);
  }

  for (const [attrId, attrValue] of replacementMap.entries()) {
    if (!seen.has(attrId)) merged.push(attrValue);
  }

  return merged;
}

function buildShippingPatch(existingShipping = {}, fill) {
  const allowed = {};
  if (existingShipping.mode) allowed.mode = existingShipping.mode;
  if (typeof existingShipping.local_pick_up === 'boolean') {
    allowed.local_pick_up = existingShipping.local_pick_up;
  }
  if (typeof existingShipping.free_shipping === 'boolean') {
    allowed.free_shipping = existingShipping.free_shipping;
  }
  if (existingShipping.logistic_type) {
    allowed.logistic_type = existingShipping.logistic_type;
  }
  if (typeof existingShipping.store_pick_up === 'boolean') {
    allowed.store_pick_up = existingShipping.store_pick_up;
  }

  allowed.dimensions = formatShippingDimensions(fill);
  return allowed;
}

function summarizeItemDimensions(item = {}) {
  const shippingRaw = item?.shipping?.dimensions || null;
  const shippingParsed = parseShippingDimensions(shippingRaw);
  const packageAttrs = extractPackageDimensionAttributes(item?.attributes || []);
  const strategy = pickUpdateStrategy(item);
  const soldQuantity = parseSoldQuantity(item?.sold_quantity);
  const marketplaceAlert = buildMarketplaceUpdateAlert(item, strategy);
  const shippingComplete = isCompleteDimensions(shippingParsed);
  const attrComplete = isCompleteDimensions(packageAttrs.parsed);
  const effectiveDimensions = shippingComplete
    ? shippingParsed
    : attrComplete
      ? packageAttrs.parsed
      : shippingParsed;

  return {
    sku: extractSku(item),
    marketplace_origin: String(item?.shipping?.mode || "").trim().toLowerCase() === "me2" ? "ME2" : "ME1",
    shipping_mode: item?.shipping?.mode || null,
    logistic_type: item?.shipping?.logistic_type || null,
    item_status: item?.status || null,
    has_bids: item?.has_bids === true,
    sold_quantity: soldQuantity,
    update_strategy: strategy,
    ml_update_blocked: marketplaceAlert.blocked,
    ml_update_alert_level: marketplaceAlert.level,
    ml_update_alert_code: marketplaceAlert.code,
    ml_update_alert: marketplaceAlert.message,
    dimensions_source: shippingComplete
      ? 'shipping.dimensions'
      : attrComplete
        ? 'seller_package_attributes'
        : 'none',
    raw: shippingRaw,
    raw_attributes: packageAttrs.raw,
    shipping_height_cm: shippingParsed.height_cm,
    shipping_width_cm: shippingParsed.width_cm,
    shipping_length_cm: shippingParsed.length_cm,
    shipping_weight_g: shippingParsed.weight_g,
    package_height_cm: packageAttrs.parsed.height_cm,
    package_width_cm: packageAttrs.parsed.width_cm,
    package_length_cm: packageAttrs.parsed.length_cm,
    package_weight_g: packageAttrs.parsed.weight_g,
    has_dimensions_complete: isCompleteDimensions(effectiveDimensions),
    height_cm: effectiveDimensions.height_cm,
    width_cm: effectiveDimensions.width_cm,
    length_cm: effectiveDimensions.length_cm,
    weight_g: effectiveDimensions.weight_g,
    package_type: packageAttrs.parsed.package_type,
    package_type_id: packageAttrs.parsed.package_type_id,
  };
}

function composeResult({ mlbId, item, updateInfo = null, error = null }) {
  return {
    mlb: mlbId,
    sku: extractSku(item),
    success: !error,
    status: error ? 'ERRO' : 'OK',
    message: error ? error.message || String(error) : null,
    ...summarizeItemDimensions(item),
    updated: !!updateInfo?.updated,
    updated_target: updateInfo?.target || null,
    updated_message: updateInfo?.message || null,
    debug_update: updateInfo?.debug || null,
  };
}

class ValidarDimensoesService {
  static async analisarVarios(mlbIds = [], options = {}) {
    const ids = Array.from(
      new Set(
        (Array.isArray(mlbIds) ? mlbIds : [])
          .map((value) => String(value || "").trim().toUpperCase())
          .filter(Boolean),
      ),
    );
    if (!ids.length) return [];

    const U = urls();
    const state = await prepararAuthState(options);
    const attributes = [
      "id",
      "seller_custom_field",
      "attributes",
      "shipping",
      "status",
      "has_bids",
      "sold_quantity",
      "variations",
    ];
    const results = [];

    for (const batch of chunk(ids, 20)) {
      const url = new URL(U.items_base);
      url.searchParams.set("ids", batch.join(","));
      url.searchParams.set("attributes", attributes.join(","));

      let payload = null;
      try {
        payload = await authFetchJson(url.toString(), { method: "GET" }, state);
      } catch (err) {
        results.push(
          ...batch.map((id) =>
            composeResult({
              mlbId: id,
              item: {},
              error: {
                message: err?.message || "Erro ao consultar lote de anuncios.",
                statusCode: err?.statusCode || null,
                raw: err?.raw || null,
              },
            }),
          ),
        );
        continue;
      }
      const rows = Array.isArray(payload) ? payload : [];
      const byId = new Map(
        rows
          .filter((row) => row && Number(row.code) === 200 && row.body?.id)
          .map((row) => [String(row.body.id).toUpperCase(), row.body]),
      );
      const rowStatusById = new Map(
        rows
          .filter((row) => row?.body?.id)
          .map((row) => [String(row.body.id).toUpperCase(), Number(row.code || 0)]),
      );

      for (const [index, id] of batch.entries()) {
        const item = byId.get(id);
        if (item) {
          results.push(composeResult({ mlbId: id, item }));
          continue;
        }

        const row = rows[index] || null;
        const statusCode = rowStatusById.get(id) || Number(row?.code || 0) || 404;
        results.push(
          composeResult({
            mlbId: id,
            item: {},
            error: {
              message:
                statusCode === 404
                  ? "Anuncio nao encontrado no Mercado Livre no momento da consulta."
                  : `Erro ao consultar anuncio no lote: HTTP ${statusCode}`,
              statusCode,
            },
          }),
        );
      }
    }

    return results;
  }

  static async analisarUm(mlbId, options = {}) {
    const U = urls();
    const state = await prepararAuthState(options);
    const logger =
      options.logger && options.logger.log
        ? options.logger.log.bind(options.logger)
        : console.log.bind(console);

    let item = {};

    try {
      item = await authFetchJson(
        `${U.items_base}/${encodeURIComponent(mlbId)}`,
        { method: 'GET', headers: { 'Content-Type': 'application/json' } },
        state,
      );

      let updateInfo = null;

      if (options.fillDimensions || options.autoFillFromItem) {
        let fill = null;
        let autoDetails = null;
        const beforeUpdate = summarizeItemDimensions(item);
        const forceOverwrite = options.forceOverwrite === true;

        if (options.autoFillFromItem) {
          const inferred = inferFillDimensionsFromItem(item);
          fill = inferred.fill;
          autoDetails = inferred.details;
        } else {
          fill = normalizeFillDimensions(options.fillDimensions);
        }

        const strategy = pickUpdateStrategy(item);
        const marketplaceAlert = buildMarketplaceUpdateAlert(item, strategy);
        const debug = {
          requested_fill: fill,
          fill_source: options.autoFillFromItem ? 'item_attributes' : 'manual_form',
          before_update: beforeUpdate,
          auto_fill_details: autoDetails,
          overwrite_requested: forceOverwrite,
          marketplace_alert: marketplaceAlert.message ? marketplaceAlert : null,
        };

        if (beforeUpdate.has_dimensions_complete && !forceOverwrite) {
          updateInfo = {
            updated: false,
            target: null,
            message: 'Dimensoes ja completas no anuncio. Nenhuma atualizacao foi necessaria.',
            debug: {
              ...debug,
              skipped_reason: 'already_complete',
            },
          };
        } else if (marketplaceAlert.blocked) {
          updateInfo = {
            updated: false,
            target: null,
            message: `${marketplaceAlert.message} O sistema pulou o PUT para evitar um erro previsivel da API.`,
            debug: {
              ...debug,
              skipped_reason: 'marketplace_restriction',
            },
          };
        } else if (strategy === 'attributes') {
          const payload = {
            attributes: mergeAttributesWithPackage(item.attributes, fill),
          };
          const updateResponse = await authFetchJson(
            `${U.items_base}/${encodeURIComponent(mlbId)}`,
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            },
            state,
          );

          debug.update_payload = payload;
          debug.update_response = updateResponse;

          updateInfo = {
            updated: true,
            target: 'attributes',
            message: 'Dimensões preenchidas via atributos SELLER_PACKAGE_*.',
            debug,
          };
          if (forceOverwrite && beforeUpdate.has_dimensions_complete) {
            updateInfo.message = 'Dimensoes sobrescritas via atributos SELLER_PACKAGE_*.';
          }
        } else {
          const payload = {
            shipping: buildShippingPatch(item.shipping, fill),
          };
          const updateResponse = await authFetchJson(
            `${U.items_base}/${encodeURIComponent(mlbId)}`,
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            },
            state,
          );

          debug.update_payload = payload;
          debug.update_response = updateResponse;

          updateInfo = {
            updated: true,
            target: 'shipping.dimensions',
            message: 'Dimensões preenchidas via shipping.dimensions.',
            debug,
          };
          if (forceOverwrite && beforeUpdate.has_dimensions_complete) {
            updateInfo.message = 'Dimensoes sobrescritas via shipping.dimensions.';
          }
        }
      }

      const refreshedItem = updateInfo
        ? await authFetchJson(
            `${U.items_base}/${encodeURIComponent(mlbId)}`,
            { method: 'GET', headers: { 'Content-Type': 'application/json' } },
            state,
          )
        : item;

      if (updateInfo?.debug) {
        updateInfo.debug.immediate_read = summarizeItemDimensions(refreshedItem);
      }

      return composeResult({
        mlbId,
        item: refreshedItem,
        updateInfo,
      });
    } catch (err) {
      const notFound = Number(err?.statusCode || 0) === 404 || String(err?.error || "").toLowerCase() === "not_found";
      const logLevel = notFound ? "warn" : "error";
      if (notFound) {
        logger?.(
          `[${state.key}] validarDimensoes.analisarUm item nao encontrado ${mlbId}`,
          err?.raw || err?.message || err,
        );
      } else {
        logger?.(`[${state.key}] validarDimensoes.analisarUm erro`, err);
      }

      const debug =
        err?.autoFillDebug || options.autoFillFromItem
          ? {
              fill_source: options.autoFillFromItem ? 'item_attributes' : 'manual_form',
              before_update: summarizeItemDimensions(item),
              auto_fill_details: err?.autoFillDebug || null,
              update_error: err?.raw
                ? {
                    status_code: err?.statusCode || null,
                    raw: err.raw,
                  }
                : null,
            }
          : null;

      return composeResult({
        mlbId,
        item,
        error: notFound
          ? {
              message: "Anuncio nao encontrado no Mercado Livre no momento da consulta.",
              statusCode: 404,
              raw: err?.raw || null,
              logLevel,
            }
          : err,
        updateInfo: debug ? { debug } : null,
      });
    }
  }
}

module.exports = ValidarDimensoesService;
