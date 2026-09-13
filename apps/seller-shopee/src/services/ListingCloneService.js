const axios = require("axios");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const ShopeeProductService = require("./ShopeeProductService");
const ShopeeProductWriteService = require("./ShopeeProductWriteService");
const ShopeeMediaService = require("./ShopeeMediaService");
const {
  listProductsForManagement,
} = require("../repositories/productSqlRepository");
const {
  upsertProductForSync,
  replaceProductImages,
  replaceProductModels,
} = require("../repositories/productSyncSqlRepository");
const {
  listListingCloneDrafts,
  findListingCloneDraftById,
  saveListingCloneDraft,
  deleteListingCloneDraft,
  markListingCloneDraftPublished,
  buildDraftSummary,
} = require("../repositories/listingCloneDraftSqlRepository");
const {
  analyzeLogistics,
  analyzeSpxPhysicalEligibility,
  extractLogistics,
  buildSpxSnapshot,
} = require("../utils/productLogistics");
const {
  applyAnvisaRequirement,
  getAnvisaValidationError,
} = require("../domain/anvisaAttributePolicy");
const {
  applyInmetroRequirement,
  getInmetroValidationError,
  isInmetroRegistrationAttribute,
} = require("../domain/inmetroAttributePolicy");
const {
  buildShopeeBrand,
  resolveBrandDisplayName,
} = require("../domain/listingBrandPolicy");

const execFileAsync = promisify(execFile);
const DEFAULT_HTTP_TIMEOUT_MS = 30000;
const DEFAULT_IMAGE_UPLOAD_BUSINESS = 1;
const DEFAULT_IMAGE_UPLOAD_SCENE = 1;
const MAX_CLIP_FILE_SIZE_BYTES = 30 * 1024 * 1024;
const SHOPEE_IMAGE_CDN = "https://down-br.img.susercontent.com/file/";
const ENTITY_MAP = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "-",
  ndash: "-",
  hellip: "...",
};

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeHtmlEntities(value) {
  let output = String(value || "");

  for (let i = 0; i < 3; i += 1) {
    const next = output
      .replace(/&#(\d+);/g, (_match, code) => {
        const parsed = Number(code);
        return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : _match;
      })
      .replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
        const parsed = Number.parseInt(code, 16);
        return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : _match;
      })
      .replace(/&([a-z]+);/gi, (match, entity) => ENTITY_MAP[entity.toLowerCase()] || match);

    if (next === output) break;
    output = next;
  }

  return output;
}

function stripTags(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "));
}

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function inferTitleFromSourceUrl(sourceUrl) {
  try {
    const url = new URL(String(sourceUrl || ""));
    const segments = String(url.pathname || "")
      .split("/")
      .map((segment) => decodeURIComponent(String(segment || "").trim()))
      .filter(Boolean);
    if (!segments.length) return "";

    const candidates = segments
      .map((segment) =>
        segment
          .replace(/-i\.\d+\.\d+.*$/i, "")
          .replace(/\?.*$/g, "")
          .replace(/[_-]+/g, " ")
          .trim(),
      )
      .filter((segment) => /[a-zA-ZÀ-ÿ]/.test(segment))
      .filter((segment) => !/^up$/i.test(segment));

    if (!candidates.length) return "";
    return normalizeWhitespace(candidates.sort((a, b) => b.length - a.length)[0]);
  } catch (_error) {
    return "";
  }
}

function normalizeCompareToken(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function uniqueBy(list = [], keyFn) {
  const out = [];
  const seen = new Set();

  for (const item of Array.isArray(list) ? list : []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function toFiniteNumber(value) {
  if (value == null || value === "") return null;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const raw = String(value).trim();
  if (!raw) return null;

  let normalized = raw.replace(/[^\d,.-]/g, "");
  const hasComma = normalized.includes(",");
  const hasDot = normalized.includes(".");

  if (hasComma && hasDot) {
    if (normalized.lastIndexOf(",") > normalized.lastIndexOf(".")) {
      normalized = normalized.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = normalized.replace(/,/g, "");
    }
  } else if (hasComma) {
    normalized = normalized.replace(",", ".");
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function toInteger(value) {
  const parsed = toFiniteNumber(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function parsePriceFromText(value) {
  const match = String(value || "").match(/R\$\s*([\d.,]+)/i);
  return match ? toFiniteNumber(match[1]) : null;
}

function parseMetaContent(html, selector) {
  const patterns = [
    new RegExp(
      `<meta[^>]*${selector}[^>]*content="([^"]*)"[^>]*>`,
      "i",
    ),
    new RegExp(
      `<meta[^>]*content="([^"]*)"[^>]*${selector}[^>]*>`,
      "i",
    ),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtmlEntities(match[1]);
  }

  return "";
}

function parseAllJsonLd(html) {
  return Array.from(
    html.matchAll(
      /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi,
    ),
  )
    .map((match) => safeJsonParse(match[1], null))
    .filter(Boolean);
}

function flattenJsonLd(entries) {
  const flattened = [];
  const visit = (entry) => {
    if (!entry || typeof entry !== "object") return;
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    flattened.push(entry);
    if (Array.isArray(entry?.["@graph"])) visit(entry["@graph"]);
  };

  visit(entries);
  return flattened;
}

function jsonLdHasType(entry, type) {
  const types = Array.isArray(entry?.["@type"]) ? entry["@type"] : [entry?.["@type"]];
  return types.some((entryType) => String(entryType || "").toLowerCase() === String(type).toLowerCase());
}

function isPublicHostname(hostname) {
  const normalized = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) {
    return false;
  }
  if (!net.isIP(normalized)) return true;
  if (normalized === "::1" || normalized === "::") return false;

  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  const [first, second] = octets;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function assertPublicSourceUrl(url) {
  const parsed = url instanceof URL ? url : new URL(String(url));
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || !isPublicHostname(parsed.hostname)) {
    const error = new Error("Informe um link publico de produto com HTTP ou HTTPS.");
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function findShopeeItemInMfeState(value) {
  if (!value || typeof value !== "object") return null;

  const scoreShopeeItemCandidate = (candidate) => {
    if (!candidate || typeof candidate !== "object") return 0;
    let score = 0;
    if (Array.isArray(candidate?.images) && candidate.images.length) score += 24;
    if (Array.isArray(candidate?.image?.image_url_list) && candidate.image.image_url_list.length) score += 20;
    if (Array.isArray(candidate?.attributes) && candidate.attributes.length) score += 20;
    if (Array.isArray(candidate?.attribute_list) && candidate.attribute_list.length) score += 20;
    if (Array.isArray(candidate?.tier_variations) && candidate.tier_variations.length) score += 18;
    if (Array.isArray(candidate?.models) && candidate.models.length) score += 18;
    if (Array.isArray(candidate?.model_list) && candidate.model_list.length) score += 18;
    if (candidate?.cat_id != null || candidate?.category_id != null) score += 12;
    if (candidate?.itemid != null || candidate?.item_id != null) score += 10;
    if (String(candidate?.description || "").trim()) score += 8;
    if (String(candidate?.name || candidate?.item_name || candidate?.title || "").trim()) score += 6;
    return score;
  };

  let best = null;
  let bestScore = 0;
  const visited = new Set();

  const walk = (node, depth = 0) => {
    if (!node || typeof node !== "object") return;
    if (depth > 12) return;
    if (visited.has(node)) return;
    visited.add(node);

    const candidates = [node, node?.item].filter(Boolean);
    for (const candidate of candidates) {
      const score = scoreShopeeItemCandidate(candidate);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    const children = Array.isArray(node) ? node : Object.values(node);
    for (const child of children) {
      walk(child, depth + 1);
    }
  };

  walk(value, 0);
  return bestScore > 0 ? best : null;
}

function extractShopeeListingIds(sourceUrl) {
  const value = String(sourceUrl || "");
  const patterns = [
    /-i\.(\d+)\.(\d+)/i,
    /\/product\/(\d+)\/(\d+)/i,
    /[?&]shopid=(\d+).*?[?&]itemid=(\d+)/i,
    /[?&]shop_id=(\d+).*?[?&]item_id=(\d+)/i,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return { shopId: match[1], itemId: match[2] };
  }

  return { shopId: "", itemId: "" };
}

function extractBalancedJsonObject(source, openBraceIndex) {
  if (openBraceIndex < 0 || openBraceIndex >= source.length) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openBraceIndex; i < source.length; i += 1) {
    const char = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;

    if (depth === 0) {
      return source.slice(openBraceIndex, i + 1);
    }
  }

  return null;
}

function parseShopeeItemFromHtml(html) {
  const jsonScriptPatterns = [
    /<script[^>]*type="text\/mfe-initial-data"[^>]*>([\s\S]*?)<\/script>/gi,
    /<script[^>]*id="__NEXT_DATA__"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi,
    /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi,
  ];

  for (const pattern of jsonScriptPatterns) {
    const scripts = Array.from(html.matchAll(pattern));
    for (const match of scripts) {
      const parsed = safeJsonParse(match[1], null);
      const found = findShopeeItemInMfeState(parsed);
      if (found) return found;
    }
  }

  const windowStateMarkers = [
    "window.__INITIAL_STATE__",
    "window.__PRELOADED_STATE__",
    "window.__NUXT__",
  ];

  for (const marker of windowStateMarkers) {
    const start = html.indexOf(marker);
    if (start < 0) continue;
    const openBrace = html.indexOf("{", start);
    if (openBrace < 0) continue;
    const payload = extractBalancedJsonObject(html, openBrace);
    const parsed = payload ? safeJsonParse(payload, null) : null;
    const found = findShopeeItemInMfeState(parsed);
    if (found) return found;
  }

  return null;
}

function normalizeShopeeImageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${SHOPEE_IMAGE_CDN}${raw}`;
}

function normalizeMlImageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return "";
}

function buildShopeeSourceAttributes(item) {
  const attrsRaw = [
    ...(Array.isArray(item?.attributes) ? item.attributes : []),
    ...(Array.isArray(item?.attribute_list) ? item.attribute_list : []),
  ];
  const attrs = uniqueBy(attrsRaw, (entry) => {
    const id = toInteger(entry?.id ?? entry?.attribute_id ?? entry?.attributeId);
    const name = normalizeCompareToken(
      entry?.name ||
        entry?.attribute_name ||
        entry?.original_attribute_name ||
        "",
    );
    return id ? `id:${id}` : name ? `name:${name}` : "";
  });

  return attrs
    .map((attr) => {
      const name = normalizeWhitespace(
        attr?.name ||
          attr?.attribute_name ||
          attr?.original_attribute_name ||
          "",
      );
      const attributeId = toInteger(
        attr?.id ?? attr?.attribute_id ?? attr?.attributeId,
      );
      const rawValues = Array.isArray(attr?.attribute_value_list)
        ? attr.attribute_value_list
        : Array.isArray(attr?.values)
          ? attr.values
          : Array.isArray(attr?.value_list)
            ? attr.value_list
            : Array.isArray(attr?.options)
              ? attr.options
          : [];

      const normalizedValueList = rawValues
        .map((entry) => {
          if (entry == null) return null;
          if (typeof entry === "string" || typeof entry === "number") {
            const valueText = normalizeWhitespace(entry);
            if (!valueText) return null;
            return {
              value_id: 0,
              original_value_name: valueText,
              value_name: valueText,
            };
          }

          const valueText = normalizeWhitespace(
            entry?.original_value_name ||
              entry?.value_name ||
              entry?.value ||
              "",
          );
          if (!valueText) return null;
          return {
            value_id: toInteger(entry?.value_id ?? entry?.id) || 0,
            original_value_name: valueText,
            value_name: valueText,
          };
        })
        .filter(Boolean);

      if (!normalizedValueList.length) {
        const fallbackValue = normalizeWhitespace(
          Array.isArray(attr?.value)
            ? attr.value.join(", ")
            : attr?.value ?? attr?.value_name ?? "",
        );
        if (fallbackValue) {
          normalizedValueList.push({
            value_id: toInteger(attr?.val_id ?? attr?.value_id) || 0,
            original_value_name: fallbackValue,
            value_name: fallbackValue,
          });
        }
      }

      if (!name || !normalizedValueList.length) return null;

      return {
        attributeId: attributeId != null ? String(attributeId) : null,
        name,
        values: normalizedValueList
          .map((entry) => normalizeWhitespace(entry?.original_value_name || ""))
          .filter(Boolean),
        sourceAttribute: {
          attribute_id: attributeId,
          original_attribute_name: name,
          attribute_name: name,
          attribute_value_list: normalizedValueList,
        },
      };
    })
    .filter(Boolean);
}

function buildShopeeSourceSpecs(item) {
  return buildShopeeSourceAttributes(item).map((entry) => ({
    name: entry.name,
    value: entry.values.join(", "),
  }));
}

function buildShopeeVariationDraft(item) {
  const tiers = Array.isArray(item?.tier_variations)
    ? item.tier_variations
    : Array.isArray(item?.tier_variation)
      ? item.tier_variation
      : Array.isArray(item?.variation_tier_list)
        ? item.variation_tier_list
        : [];
  const models = Array.isArray(item?.models)
    ? item.models
    : Array.isArray(item?.model_list)
      ? item.model_list
      : Array.isArray(item?.item_models)
        ? item.item_models
        : [];

  if (!tiers.length) {
    return {
      enabled: false,
      tiers: [],
      models: [],
    };
  }

  const normalizedTiers = tiers.map((tier, tierIndex) => ({
    name: normalizeWhitespace(
      tier?.name || tier?.tier_name || `Variacao ${tierIndex + 1}`,
    ),
    options: (
      Array.isArray(tier?.options)
        ? tier.options
        : Array.isArray(tier?.option_list)
          ? tier.option_list
          : []
    ).map((option, optionIndex) => ({
      optionName: normalizeWhitespace(
        typeof option === "object"
          ? option?.option || option?.name || option?.option_name || ""
          : option || `Opcao ${optionIndex + 1}`,
      ),
      imageUrl: normalizeShopeeImageUrl(
        Array.isArray(tier?.images)
          ? tier.images[optionIndex]
          : Array.isArray(tier?.image_list)
            ? tier.image_list[optionIndex]
            : "",
      ),
      imageId: null,
    })),
  }));

  const normalizedModels = models.map((model, index) => ({
    key: String(model?.model_id || `${index}`),
    displayName: normalizeWhitespace(
      model?.name || model?.model_name || `Modelo ${index + 1}`,
    ),
    tierIndex: Array.isArray(model?.extinfo?.tier_index)
      ? model.extinfo.tier_index.map((value) => Number(value) || 0)
      : Array.isArray(model?.tier_index)
        ? model.tier_index.map((value) => Number(value) || 0)
      : [],
    modelSku: normalizeWhitespace(model?.sku || model?.model_sku || ""),
    originalPrice: toFiniteNumber(
      model?.price ??
        model?.price_info?.[0]?.original_price ??
        model?.price_info?.current_price ??
        model?.price_info?.price ??
        model?.price_before_discount,
    ),
    stock: toInteger(
      model?.stock ??
        model?.current_stock ??
        model?.seller_stock?.[0]?.stock,
    ) ?? 0,
    weight: null,
    dimension: {
      package_width: null,
      package_length: null,
      package_height: null,
    },
    gtinCode: "",
  }));

  const buildModelFallbackFromTiers = () => {
    const tierOptions = normalizedTiers.map((tier) =>
      (Array.isArray(tier?.options) ? tier.options : [])
        .map((option, optionIndex) => ({
          optionName: normalizeWhitespace(option?.optionName || ""),
          optionIndex,
        }))
        .filter((entry) => entry.optionName),
    );
    if (tierOptions.some((options) => !options.length)) return [];

    const combinations = [];
    const walk = (depth, selected = []) => {
      if (combinations.length >= 120) return;
      if (depth >= tierOptions.length) {
        combinations.push(selected.slice());
        return;
      }
      tierOptions[depth].forEach((entry) => {
        selected.push(entry);
        walk(depth + 1, selected);
        selected.pop();
      });
    };
    walk(0, []);

    return combinations.map((combo, index) => ({
      key: `fallback-${index + 1}`,
      displayName: combo.map((entry) => entry.optionName).join(" / "),
      tierIndex: combo.map((entry) => entry.optionIndex),
      modelSku: "",
      originalPrice: null,
      stock: 0,
      weight: null,
      dimension: {
        package_width: null,
        package_length: null,
        package_height: null,
      },
      gtinCode: "",
    }));
  };

  const finalModels = normalizedModels.length
    ? normalizedModels
    : buildModelFallbackFromTiers();

  return {
    enabled: Boolean(normalizedTiers.length && finalModels.length),
    tiers: normalizedTiers,
    models: finalModels,
  };
}

function pickShopeeVideo(item) {
  const list = Array.isArray(item?.video_info_list) ? item.video_info_list : [];
  const first = list[0];
  if (!first) {
    return {
      sourceUrl: "",
      thumbnailUrl: "",
      videoUploadId: "",
    };
  }

  const preferredUrl =
    first?.default_format?.url ||
    (Array.isArray(first?.formats) ? first.formats[0]?.url : "") ||
    first?.url ||
    "";

  const thumbnail =
    first?.item_cover ||
    (first?.mms_data ? safeJsonParse(first.mms_data, null)?.cover : null) ||
    normalizeShopeeImageUrl(first?.thumb_url || "");

  return {
    sourceUrl: String(preferredUrl || ""),
    thumbnailUrl: String(thumbnail || ""),
    videoUploadId: "",
  };
}

function parseShopeePublicListing(
  html,
  sourceUrl,
  itemOverride = null,
  extractionMethod = "public-mobile",
) {
  const item = itemOverride || parseShopeeItemFromHtml(html);
  const productJsonLd = pickMlProductJsonLd(html);
  const ogTitle = parseMetaContent(html, 'property="og:title"');
  const ogDescription = parseMetaContent(html, 'property="og:description"');
  const ogImage = parseMetaContent(html, 'property="og:image"');
  const sourceIds = extractShopeeListingIds(sourceUrl);

  const fallbackDescription = Array.from(
    html.matchAll(/<p[^>]*class="QN2lPu"[^>]*>([\s\S]*?)<\/p>/gi),
  )
    .map((match) => normalizeWhitespace(stripTags(match[1])))
    .filter(Boolean)
    .join("\n");

  const itemName = normalizeWhitespace(
    item?.name || item?.item_name || item?.title || productJsonLd?.name || ogTitle,
  );
  const description = normalizeWhitespace(
    item?.description ||
      productJsonLd?.description ||
      fallbackDescription ||
      ogDescription,
  );

  const jsonLdImages = Array.isArray(productJsonLd?.image)
    ? productJsonLd.image
    : productJsonLd?.image
      ? [productJsonLd.image]
      : [];
  const shopeeImageCandidates = [
    ...(Array.isArray(item?.images) ? item.images : []),
    ...(Array.isArray(item?.image?.image_url_list) ? item.image.image_url_list : []),
    ...(Array.isArray(item?.image?.image_id_list) ? item.image.image_id_list : []),
    ...(Array.isArray(item?.image_url_list) ? item.image_url_list : []),
  ];
  const images = uniqueBy(
    [
      ...shopeeImageCandidates.map((image, index) => ({
        key: `source-${index}`,
        url: normalizeShopeeImageUrl(
          typeof image === "string"
            ? image
            : image?.url || image?.image_url || image?.image_id || "",
        ),
        imageId: null,
      })),
      ...jsonLdImages.map((image, index) => ({
        key: `jsonld-${index}`,
        url: normalizeShopeeImageUrl(image),
        imageId: null,
      })),
      ...(ogImage
        ? [
            {
              key: "og-image",
              url: normalizeShopeeImageUrl(ogImage),
              imageId: null,
            },
          ]
        : []),
    ],
    (entry) => entry.url,
  );

  const sourceSpecs = [
    ...buildShopeeSourceSpecs(item),
    ...buildMercadoLivreSpecs(html),
  ];
  const sourceAttributesRaw = buildShopeeSourceAttributes(item);
  const sourceAttributes = sourceAttributesRaw.length
    ? sourceAttributesRaw
    : buildMlSourceAttributes(sourceSpecs);
  const stockCandidates = Array.isArray(item?.models)
    ? item.models
    : Array.isArray(item?.model_list)
      ? item.model_list
      : [];
  const categoryTrail = Array.isArray(item?.categories) ? item.categories : [];
  const firstModel = stockCandidates[0] || null;
  const summedStock = stockCandidates.reduce((total, model) => {
    const stockValue = toInteger(
      model?.stock ?? model?.current_stock ?? model?.seller_stock?.[0]?.stock,
    );
    return total + (stockValue != null ? stockValue : 0);
  }, 0);

  return {
    platform: "shopee",
    sourceUrl,
    externalItemId:
      sourceIds.itemId || String(item?.itemid || item?.item_id || "").trim(),
    externalShopId:
      sourceIds.shopId || String(item?.shopid || item?.shop_id || "").trim(),
    itemName,
    description,
    price: toFiniteNumber(item?.original_price ?? item?.price),
    stock: firstModel ? null : summedStock,
    brandName: normalizeWhitespace(
      typeof item?.brand === "object"
        ? item.brand?.original_brand_name || item.brand?.brand_name || ""
        : item?.brand || "",
    ),
    categoryId: toInteger(item?.cat_id ?? item?.category_id),
    categoryName: normalizeWhitespace(
      categoryTrail.length ? categoryTrail[categoryTrail.length - 1]?.display_name : "",
    ),
    categoryPath: categoryTrail
      .map((entry) => normalizeWhitespace(entry?.display_name || entry?.name || ""))
      .filter(Boolean)
      .join(" > "),
    weight: toFiniteNumber(item?.weight),
    dimension: {
      package_width: toInteger(item?.dimension?.package_width ?? item?.width),
      package_length: toInteger(item?.dimension?.package_length ?? item?.length),
      package_height: toInteger(item?.dimension?.package_height ?? item?.height),
    },
    daysToShip:
      toInteger(item?.days_to_ship) ??
      toInteger(firstModel?.extinfo?.estimated_days) ??
      null,
    condition: "NEW",
    images,
    sourceAttributes,
    sourceSpecifications: sourceSpecs,
    video: pickShopeeVideo(item),
    variations: buildShopeeVariationDraft(item),
    extractionMethod,
    notes: [
      ...(toFiniteNumber(item?.price) == null
        ? ["Preço da Shopee não ficou disponível publicamente no HTML carregado e pode precisar de ajuste manual."]
        : []),
      ...(toFiniteNumber(item?.weight) == null
        ? ["Peso do anúncio de origem não apareceu no HTML público e deve ser revisado antes da publicação."]
        : []),
    ],
  };
}

function extractMlJsonFromMelidata(html) {
  const marker = 'melidata("add","event_data",';
  const start = html.indexOf(marker);
  if (start < 0) return null;

  const openBrace = html.indexOf("{", start);
  if (openBrace < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openBrace; i < html.length; i += 1) {
    const char = html[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;

    if (depth === 0) {
      return safeJsonParse(html.slice(openBrace, i + 1), null);
    }
  }

  return null;
}

function buildMercadoLivreSpecs(html) {
  return Array.from(
    html.matchAll(
      /<tr[^>]*class="andes-table__row[^"]*"[^>]*>[\s\S]*?<th[^>]*>([\s\S]*?)<\/th>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/gi,
    ),
  )
    .map((match) => ({
      name: normalizeWhitespace(stripTags(match[1])),
      value: normalizeWhitespace(stripTags(match[2])),
    }))
    .filter((entry) => entry.name && entry.value);
}

function buildMercadoLivreImages(html) {
  return uniqueBy(
    Array.from(
      html.matchAll(
        /ui-pdp-gallery__figure__image[\s\S]{0,500}?src="([^"]+)"/gi,
      ),
    )
      .map((match, index) => ({
        key: `source-${index}`,
        url: normalizeMlImageUrl(match[1]),
        imageId: null,
      }))
      .filter((entry) => entry.url),
    (entry) => entry.url,
  );
}

function pickMlProductJsonLd(html) {
  const jsonLd = parseAllJsonLd(html);
  return jsonLd.find((entry) => entry?.["@type"] === "Product") || null;
}

function parseMlDescription(html) {
  const match = html.match(
    /<div id="description"[^>]*>[\s\S]*?<p[^>]*class="ui-pdp-description__content"[^>]*>([\s\S]*?)<\/p>/i,
  );
  return normalizeWhitespace(stripTags(match?.[1] || ""));
}

function parseMlDimensions(specs, description) {
  const dimensionsEntry = specs.find((entry) =>
    normalizeCompareToken(entry.name).includes("largura profundidade altura"),
  );

  const dimensionSource = dimensionsEntry?.value || description;
  const match = String(dimensionSource || "").match(
    /(\d+(?:[.,]\d+)?)\s*cm\s*x\s*(\d+(?:[.,]\d+)?)\s*cm\s*x\s*(\d+(?:[.,]\d+)?)\s*cm/i,
  );

  if (match) {
    return {
      package_width: toInteger(match[1]),
      package_length: toInteger(match[2]),
      package_height: toInteger(match[3]),
    };
  }

  return {
    package_width: null,
    package_length: null,
    package_height: null,
  };
}

function parseMlPrice(html, productJsonLd) {
  return (
    toFiniteNumber(productJsonLd?.offers?.price) ||
    parsePriceFromText(parseMetaContent(html, 'property="og:title"')) ||
    null
  );
}

function buildMlSourceAttributes(specs) {
  return specs.map((entry) => ({
    attributeId: null,
    name: entry.name,
    values: [entry.value],
    sourceAttribute: null,
  }));
}

function buildMlVariationDraft(eventData) {
  const pickers = eventData?.pickers;
  const pickerAttributes = eventData?.pickers_attributes;
  if (!pickers || !pickerAttributes) {
    return {
      enabled: false,
      tiers: [],
      models: [],
    };
  }

  const keys = Object.keys(pickerAttributes).filter((key) => Array.isArray(pickers[key]));
  if (!keys.length) {
    return {
      enabled: false,
      tiers: [],
      models: [],
    };
  }

  const tiers = keys.map((key) => ({
    name: normalizeWhitespace(pickerAttributes[key]?.picker_label || key),
    options: uniqueBy(
      (Array.isArray(pickers[key]) ? pickers[key] : []).map((entry) => ({
        optionName: normalizeWhitespace(entry?.value || ""),
        imageUrl: "",
        imageId: null,
      })),
      (entry) => normalizeCompareToken(entry.optionName),
    ).filter((entry) => entry.optionName),
  }));

  const valuesByCatalogId = new Map();
  keys.forEach((key, tierIndex) => {
    (Array.isArray(pickers[key]) ? pickers[key] : []).forEach((entry) => {
      const catalogId = String(entry?.catalog_product_id || "").trim();
      const optionName = normalizeWhitespace(entry?.value || "");
      if (!catalogId || !optionName) return;
      if (!valuesByCatalogId.has(catalogId)) {
        valuesByCatalogId.set(catalogId, {
          catalogId,
          values: Array.from({ length: keys.length }, () => ""),
        });
      }
      valuesByCatalogId.get(catalogId).values[tierIndex] = optionName;
    });
  });

  const models = Array.from(valuesByCatalogId.values())
    .map((entry) => {
      const tierIndex = entry.values.map((value, tierPosition) =>
        tiers[tierPosition].options.findIndex(
          (option) => normalizeCompareToken(option.optionName) === normalizeCompareToken(value),
        ),
      );

      if (tierIndex.some((value) => value < 0)) return null;

      return {
        key: entry.catalogId,
        displayName: entry.values.join(" / "),
        tierIndex,
        modelSku: "",
        originalPrice: null,
        stock: 0,
        weight: null,
        dimension: {
          package_width: null,
          package_length: null,
          package_height: null,
        },
        gtinCode: "",
      };
    })
    .filter(Boolean);

  return {
    enabled: false,
    tiers,
    models,
  };
}

function parseMercadoLivreListing(html, sourceUrl) {
  const productJsonLd = pickMlProductJsonLd(html);
  const specs = buildMercadoLivreSpecs(html);
  const description = parseMlDescription(html);
  const eventData = extractMlJsonFromMelidata(html);
  const productTitle = normalizeWhitespace(
    productJsonLd?.name ||
      parseMetaContent(html, 'property="og:title"').replace(/\s*-\s*R\$\s*[\d.,]+\s*$/i, ""),
  );
  const weight =
    toFiniteNumber(productJsonLd?.weight) ||
    toFiniteNumber(specs.find((entry) => normalizeCompareToken(entry.name) === "peso")?.value) ||
    null;

  return {
    platform: "mercadolivre",
    sourceUrl,
    externalItemId: normalizeWhitespace(
      (html.match(/name="item_id"[^>]*value="([^"]+)"/i) || [])[1] || "",
    ),
    externalShopId: "",
    itemName: productTitle,
    description,
    price: parseMlPrice(html, productJsonLd),
    stock: null,
    brandName: normalizeWhitespace(
      productJsonLd?.brand ||
        specs.find((entry) => normalizeCompareToken(entry.name) === "marca")?.value ||
        "",
    ),
    categoryId: null,
    categoryName: normalizeWhitespace(productJsonLd?.category || ""),
    categoryPath: "",
    weight,
    dimension: parseMlDimensions(specs, description),
    daysToShip: null,
    condition: "NEW",
    images: buildMercadoLivreImages(html),
    sourceAttributes: buildMlSourceAttributes(specs),
    sourceSpecifications: specs,
    video: {
      sourceUrl: "",
      thumbnailUrl: "",
      videoUploadId: "",
    },
    variations: buildMlVariationDraft(eventData),
    notes: [
      "Categoria Shopee precisa ser revisada manualmente quando a origem for Mercado Livre.",
      ...(weight == null
        ? ["Peso não foi identificado com segurança no anúncio do Mercado Livre."]
        : []),
    ],
  };
}

function extractMercadoLivreItemId(sourceUrl) {
  const raw = String(sourceUrl || "");
  let values = [raw];
  try {
    const parsed = new URL(raw);
    values = [...values, parsed.pathname, ...Array.from(parsed.searchParams.values())];
  } catch (_error) {}

  const match = values
    .map((value) => String(value || "").match(/\bMLB[-_]?\d+\b/i)?.[0] || "")
    .find(Boolean);
  return match ? match.replace(/[-_]/g, "").toUpperCase() : "";
}

async function fetchMercadoLivrePublicListing(itemId, sourceUrl) {
  if (!itemId) return null;
  const requestConfig = {
    timeout: 15000,
    headers: {
      Accept: "application/json",
      "Accept-Language": "pt-BR,pt;q=0.9",
      "User-Agent": "DavanttiSuite-ListingClone/1.0",
    },
  };
  let item;
  let directRequestError = null;

  try {
    const itemResponse = await axios.get(
      `https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}`,
      requestConfig,
    );
    item = itemResponse?.data || null;
  } catch (error) {
    directRequestError = error;
  }

  // The batch endpoint is also public and gives Mercado Livre a second official
  // path for shared product-group URLs whose item endpoint is temporarily unavailable.
  if (!item?.title) {
    try {
      const bulkResponse = await axios.get(
        `https://api.mercadolibre.com/items?ids=${encodeURIComponent(itemId)}`,
        requestConfig,
      );
      const bulkItem = Array.isArray(bulkResponse?.data) ? bulkResponse.data[0] : null;
      item = bulkItem?.code === 200 ? bulkItem.body : null;
    } catch (bulkRequestError) {
      if (directRequestError) {
        directRequestError.bulkRequestError = bulkRequestError;
        throw directRequestError;
      }
      throw bulkRequestError;
    }
  }

  if (!item?.title) return null;

  const description = await axios
    .get(`https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}/description`, {
      ...requestConfig,
    })
    .then((response) => normalizeWhitespace(response?.data?.plain_text || response?.data?.text || ""))
    .catch(() => "");
  const specs = (Array.isArray(item.attributes) ? item.attributes : [])
    .map((attribute) => ({
      name: normalizeWhitespace(attribute?.name || attribute?.id || ""),
      value: normalizeWhitespace(attribute?.value_name || attribute?.value_struct?.number || ""),
    }))
    .filter((entry) => entry.name && entry.value);
  const brand = specs.find((entry) => normalizeCompareToken(entry.name) === "marca")?.value || "";
  const weight = toFiniteNumber(
    specs.find((entry) => ["peso", "peso do pacote"].includes(normalizeCompareToken(entry.name)))?.value,
  ) || null;

  return {
    platform: "mercadolivre",
    sourceUrl,
    externalItemId: itemId,
    externalShopId: String(item.seller_id || ""),
    itemName: normalizeWhitespace(item.title),
    description,
    price: toFiniteNumber(item.price),
    stock: Number.isFinite(Number(item.available_quantity)) ? Number(item.available_quantity) : null,
    brandName: normalizeWhitespace(brand),
    categoryId: item.category_id == null ? null : String(item.category_id),
    categoryName: "",
    categoryPath: "",
    weight,
    dimension: parseMlDimensions(specs, description),
    daysToShip: null,
    condition: String(item.condition || "new").toUpperCase(),
    images: uniqueBy(
      (Array.isArray(item.pictures) ? item.pictures : [])
        .map((picture, index) => ({ key: `source-${index}`, url: normalizeMlImageUrl(picture?.secure_url || picture?.url), imageId: null }))
        .filter((entry) => entry.url),
      (entry) => entry.url,
    ),
    sourceAttributes: buildMlSourceAttributes(specs),
    sourceSpecifications: specs,
    video: { sourceUrl: "", thumbnailUrl: "", videoUploadId: "" },
    variations: { enabled: false, tiers: [], models: [] },
    extractionMethod: "mercadolivre-public-api",
    notes: [
      "Categoria Shopee precisa ser revisada manualmente quando a origem for Mercado Livre.",
      ...(weight == null ? ["Peso não foi identificado com segurança no anúncio do Mercado Livre."] : []),
    ],
  };
}
function parseMadeiraMadeiraDescription(value) {
  return normalizeWhitespace(
    decodeHtmlEntities(String(value || ""))
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/p\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

function buildMadeiraMadeiraSpecs(description, color) {
  const specs = String(description || "")
    .split("\n")
    .map((line) => normalizeWhitespace(line))
    .map((line) => {
      const match = line.match(/^([^:]{2,80}):\s*(.+)$/);
      return match
        ? { name: normalizeWhitespace(match[1]), value: normalizeWhitespace(match[2]) }
        : null;
    })
    .filter((entry) => entry?.name && entry?.value);

  if (color && !specs.some((entry) => normalizeCompareToken(entry.name) === "cor")) {
    specs.push({ name: "Cor", value: color });
  }
  return uniqueBy(specs, (entry) => normalizeCompareToken(entry.name));
}

function parseMadeiraMadeiraDimensions(specs, description) {
  const findDimension = (labels) => {
    const entry = specs.find((spec) =>
      labels.some((label) => normalizeCompareToken(spec.name).includes(label)),
    );
    const match = String(entry?.value || description || "").match(/(\d+(?:[.,]\d+)?)\s*cm/i);
    return toInteger(match?.[1]);
  };

  return {
    package_width: findDimension(["largura"]),
    package_length: findDimension(["profundidade", "comprimento"]),
    package_height: findDimension(["altura"]),
  };
}

function parseMadeiraMadeiraListing(html, sourceUrl) {
  const jsonLd = flattenJsonLd(parseAllJsonLd(html));
  const product = jsonLd.find((entry) => jsonLdHasType(entry, "Product")) || null;
  const breadcrumb = jsonLd.find((entry) => jsonLdHasType(entry, "BreadcrumbList"));
  const description = parseMadeiraMadeiraDescription(product?.description || "");
  const color = normalizeWhitespace(decodeHtmlEntities(product?.color || ""));
  const specs = buildMadeiraMadeiraSpecs(description, color);
  const offers = Array.isArray(product?.offers) ? product.offers : [product?.offers];
  const breadcrumbNames = (Array.isArray(breadcrumb?.itemListElement) ? breadcrumb.itemListElement : [])
    .map((entry) => normalizeWhitespace(entry?.name || ""))
    .filter(Boolean);
  const images = uniqueBy(
    (Array.isArray(product?.image) ? product.image : [product?.image])
      .map((url, index) => ({ key: `source-${index}`, url: normalizeMlImageUrl(url), imageId: null }))
      .filter((entry) => entry.url),
    (entry) => entry.url,
  );
  const productIdMatch = new URL(sourceUrl).pathname.match(/-(\d+)\.html$/i);
  const weightSpec = specs.find((entry) => normalizeCompareToken(entry.name) === "peso");

  return {
    platform: "madeiramadeira",
    sourceUrl,
    externalItemId: normalizeWhitespace(decodeHtmlEntities(product?.sku || productIdMatch?.[1] || "")),
    externalShopId: "",
    itemName: normalizeWhitespace(
      decodeHtmlEntities(product?.name || "") || parseMetaContent(html, 'property="og:title"').replace(/\s*\|\s*MadeiraMadeira\s*$/i, ""),
    ),
    description,
    price: toFiniteNumber(offers.find((offer) => offer?.price != null)?.price),
    stock: null,
    brandName: normalizeWhitespace(
      decodeHtmlEntities(typeof product?.brand === "object" ? product.brand?.name : product?.brand || ""),
    ),
    categoryId: null,
    categoryName: breadcrumbNames.length > 1 ? breadcrumbNames[breadcrumbNames.length - 2] : "",
    categoryPath: breadcrumbNames.slice(0, -1).join(" > "),
    weight: toFiniteNumber(weightSpec?.value),
    dimension: parseMadeiraMadeiraDimensions(specs, description),
    daysToShip: null,
    condition: "NEW",
    images,
    sourceAttributes: buildMlSourceAttributes(specs),
    sourceSpecifications: specs,
    video: { sourceUrl: "", thumbnailUrl: "", videoUploadId: "" },
    variations: { enabled: false, tiers: [], models: [] },
    extractionMethod: "madeiramadeira-jsonld",
    notes: [
      "Categoria Shopee precisa ser revisada manualmente quando a origem for MadeiraMadeira.",
      ...(images.length ? [] : ["As imagens nao foram encontradas na pagina publica e devem ser adicionadas manualmente."]),
    ],
  };
}

function normalizeExternalImageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : "";
  } catch (_error) {
    return "";
  }
}

function normalizeGenericProductTitle(value) {
  const title = normalizeWhitespace(decodeHtmlEntities(value || ""))
    .replace(/\s*\|\s*[^|]+$/i, "")
    .replace(/\s+-\s*R\$\s*[\d.,]+\s*$/i, "")
    .trim();
  return /produto\s+.{0,12}\s+encontrado|p[aá]gina\s+.{0,12}\s+encontrada|access denied/i.test(title)
    ? ""
    : title;
}

function findJsonLdProduct(html) {
  return flattenJsonLd(parseAllJsonLd(html)).find((entry) => jsonLdHasType(entry, "Product")) || null;
}

function toGenericSpecification(name, value) {
  const normalizedName = normalizeWhitespace(decodeHtmlEntities(name || ""));
  const normalizedValue = normalizeWhitespace(decodeHtmlEntities(
    typeof value === "object" && value ? value.value || value.name || "" : value || "",
  ));
  return normalizedName && normalizedValue ? { name: normalizedName, value: normalizedValue } : null;
}

function buildGenericProductSpecs(product) {
  const specs = [
    toGenericSpecification("SKU", product?.sku),
    toGenericSpecification("SKU", product?.mpn),
    toGenericSpecification("GTIN", product?.gtin || product?.gtin13),
    toGenericSpecification("Marca", typeof product?.brand === "object" ? product.brand?.name : product?.brand),
    toGenericSpecification("Cor", product?.color),
    toGenericSpecification("Material", product?.material),
  ].filter(Boolean);
  const extraProperties = Array.isArray(product?.additionalProperty)
    ? product.additionalProperty
    : [product?.additionalProperty];
  extraProperties.forEach((property) => {
    const spec = toGenericSpecification(property?.name || property?.propertyID, property?.value);
    if (spec) specs.push(spec);
  });
  return uniqueBy(specs, (entry) => `${normalizeCompareToken(entry.name)}:${normalizeCompareToken(entry.value)}`);
}

function parseGenericProductDimensions(product, specs, description) {
  const valueFor = (keys) => {
    const direct = keys.map((key) => product?.[key]).find((value) => value != null);
    const spec = specs.find((entry) => keys.some((key) => normalizeCompareToken(entry.name).includes(normalizeCompareToken(key))));
    return toInteger(typeof direct === "object" ? direct?.value : direct || spec?.value || "");
  };
  const direct = {
    package_width: valueFor(["width", "largura"]),
    package_length: valueFor(["depth", "length", "profundidade", "comprimento"]),
    package_height: valueFor(["height", "altura"]),
  };
  if (Object.values(direct).some((value) => value != null)) return direct;
  return parseMlDimensions(specs, description);
}

function extractGenericExternalId(sourceUrl, product) {
  try {
    const parsed = new URL(sourceUrl);
    const idFromQuery = ["item_id", "itemid", "idprod", "product_id", "productid", "sku"]
      .map((key) => parsed.searchParams.get(key))
      .find(Boolean);
    return normalizeWhitespace(product?.sku || product?.mpn || product?.productID || idFromQuery || "");
  } catch (_error) {
    return normalizeWhitespace(product?.sku || product?.mpn || product?.productID || "");
  }
}

function parseGenericProductListing(html, sourceUrl) {
  const product = findJsonLdProduct(html);
  const specs = buildGenericProductSpecs(product);
  const offers = Array.isArray(product?.offers) ? product.offers : [product?.offers];
  const offer = offers.find((entry) => entry && (entry.price != null || entry.lowPrice != null)) || {};
  const description = normalizeWhitespace(stripTags(
    product?.description || parseMetaContent(html, 'name="description"') || parseMetaContent(html, 'property="og:description"'),
  ));
  const title = normalizeGenericProductTitle(
    product?.name || parseMetaContent(html, 'property="og:title"') || parseMetaContent(html, 'name="title"'),
  );
  const imageCandidates = [
    ...(Array.isArray(product?.image) ? product.image : [product?.image]),
    parseMetaContent(html, 'property="og:image"'),
  ];
  const images = uniqueBy(
    imageCandidates
      .map((entry, index) => ({ key: `source-${index}`, url: normalizeExternalImageUrl(typeof entry === "object" ? entry?.url || entry?.contentUrl : entry), imageId: null }))
      .filter((entry) => entry.url),
    (entry) => entry.url,
  );
  const availability = String(offer?.availability || "").toLowerCase();
  const category = normalizeWhitespace(decodeHtmlEntities(product?.category || ""));

  return {
    platform: "generic",
    sourceUrl,
    externalItemId: extractGenericExternalId(sourceUrl, product),
    externalShopId: "",
    itemName: title,
    description,
    price: toFiniteNumber(
      offer?.price ||
      offer?.lowPrice ||
      parseMetaContent(html, 'property="product:price:amount"') ||
      parseMetaContent(html, 'name="price"'),
    ),
    stock: availability.includes("instock") ? 1 : availability.includes("outofstock") ? 0 : null,
    brandName: normalizeWhitespace(decodeHtmlEntities(typeof product?.brand === "object" ? product.brand?.name : product?.brand || "")),
    categoryId: null,
    categoryName: category,
    categoryPath: category,
    weight: toFiniteNumber(typeof product?.weight === "object" ? product.weight?.value : product?.weight),
    dimension: parseGenericProductDimensions(product, specs, description),
    daysToShip: null,
    condition: "NEW",
    images,
    sourceAttributes: buildMlSourceAttributes(specs),
    sourceSpecifications: specs,
    video: { sourceUrl: "", thumbnailUrl: "", videoUploadId: "" },
    variations: { enabled: false, tiers: [], models: [] },
    extractionMethod: "generic-jsonld-meta",
    notes: [
      "Dados extraídos de uma página pública; revise categoria, atributos e variações antes de publicar.",
      ...(images.length ? [] : ["As imagens não foram encontradas na página pública e devem ser adicionadas manualmente."]),
    ],
  };
}

function buildHeaders(url, userAgent = "") {
  const hostname = new URL(url).hostname;
  const isShopee = hostname.toLowerCase().includes("shopee.");
  return {
    "User-Agent": userAgent || (isShopee
      ? "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36"
      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"),
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    Referer: `https://${hostname}/`,
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
}

async function fetchHtml(url, { userAgent = "", allowClientError = false } = {}) {
  assertPublicSourceUrl(url);
  const response = await axios.get(url, {
    timeout: DEFAULT_HTTP_TIMEOUT_MS,
    responseType: "text",
    headers: buildHeaders(url, userAgent),
    maxRedirects: 5,
    beforeRedirect: (options) => {
      assertPublicSourceUrl(`${options.protocol}//${options.hostname}${options.path || "/"}`);
    },
    validateStatus: (status) => status >= 200 && status < (allowClientError ? 500 : 400),
  });

  return String(response.data || "");
}

async function fetchShopeePublicHtmlCandidates(url) {
  const userAgents = [
    "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  ];
  const results = await Promise.all(
    userAgents.map((userAgent) => fetchHtml(url, { userAgent, allowClientError: true }).catch(() => "")),
  );
  return Array.from(new Set(results.filter(Boolean)));
}

async function tryFetchShopeeRenderedHtml(url) {
  if (process.platform !== "win32") return "";

  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];

  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) return "";

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "davantti-listing-clone-"));

  try {
    const { stdout } = await execFileAsync(
      executable,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        `--user-data-dir=${tmpDir}`,
        "--dump-dom",
        url,
      ],
      {
        windowsHide: true,
        maxBuffer: 15 * 1024 * 1024,
        timeout: DEFAULT_HTTP_TIMEOUT_MS,
      },
    );

    return String(stdout || "");
  } catch (_error) {
    return "";
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_cleanupError) {}
  }
}

function normalizeSourceUrl(sourceUrl) {
  const raw = String(sourceUrl || "").trim();
  if (!raw) {
    const error = new Error("Cole um link público de produto.");
    error.statusCode = 400;
    throw error;
  }

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  try {
    const parsed = new URL(withProtocol);
    parsed.hash = "";
    return assertPublicSourceUrl(parsed).toString();
  } catch (_error) {
    const error = new Error("Link inválido. Verifique a URL do anúncio e tente novamente.");
    error.statusCode = 400;
    throw error;
  }
}

function detectMarketplace(sourceUrl) {
  const hostname = new URL(sourceUrl).hostname.toLowerCase();
  if (hostname.includes("shopee.")) return "shopee";
  if (hostname.includes("mercadolivre.com.br") || hostname.includes("mercadolibre.com")) {
    return "mercadolivre";
  }
  if (hostname.includes("madeiramadeira.com.br")) return "madeiramadeira";
  return "generic";
}

function normalizeEditableAttribute(attr) {
  return {
    attributeId:
      attr?.attribute_id != null ? String(attr.attribute_id) : attr?.attributeId || null,
    name:
      attr?.original_attribute_name ||
      attr?.attribute_name ||
      attr?.name ||
      "Atributo",
    isMandatory: Boolean(attr?.is_mandatory ?? attr?.isMandatory),
    values: Array.isArray(attr?.values)
      ? attr.values.map((value) => normalizeWhitespace(value)).filter(Boolean)
      : [],
    sourceAttribute:
      attr?.sourceAttribute ||
      (attr && typeof attr === "object" ? JSON.parse(JSON.stringify(attr)) : null),
  };
}

function buildSourceValueLookup(sourceAttributes = [], sourceSpecifications = []) {
  const map = new Map();

  sourceAttributes.forEach((entry) => {
    const idKey = entry?.attributeId ? `id:${entry.attributeId}` : "";
    const nameKey = entry?.name ? `name:${normalizeCompareToken(entry.name)}` : "";
    const normalized = {
      attributeId: entry?.attributeId || null,
      name: entry?.name || "",
      values: Array.isArray(entry?.values)
        ? entry.values.map((value) => normalizeWhitespace(value)).filter(Boolean)
        : [],
      sourceAttribute:
        entry?.sourceAttribute && typeof entry.sourceAttribute === "object"
          ? JSON.parse(JSON.stringify(entry.sourceAttribute))
          : null,
    };

    if (idKey) map.set(idKey, normalized);
    if (nameKey) map.set(nameKey, normalized);
  });

  sourceSpecifications.forEach((entry) => {
    const name = normalizeWhitespace(entry?.name || "");
    const value = normalizeWhitespace(entry?.value || "");
    const nameKey = name ? `name:${normalizeCompareToken(name)}` : "";
    if (!nameKey || !value || map.has(nameKey)) return;
    map.set(nameKey, {
      attributeId: null,
      name,
      values: [value],
      sourceAttribute: null,
    });
  });

  return map;
}

function buildAttributeValueList(values, sourceAttribute = null) {
  const normalizedValues = Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => normalizeWhitespace(value))
        .filter(Boolean),
    ),
  );

  if (!normalizedValues.length) return [];

  const sourceValues = Array.isArray(sourceAttribute?.attribute_value_list)
    ? sourceAttribute.attribute_value_list
    : [];
  const sourceMap = new Map();

  sourceValues.forEach((entry) => {
    const label = normalizeCompareToken(
      entry?.original_value_name || entry?.value_name || entry?.value || "",
    );
    if (label && !sourceMap.has(label)) {
      sourceMap.set(label, entry);
    }
  });

  return normalizedValues.map((value) => {
    const existing = sourceMap.get(normalizeCompareToken(value));
    if (existing && typeof existing === "object") {
      const cloned = JSON.parse(JSON.stringify(existing));
      if (!cloned.original_value_name) cloned.original_value_name = value;
      if (!cloned.value_name) cloned.value_name = value;
      return cloned;
    }
    return {
      value_id: 0,
      original_value_name: value,
      value_name: value,
    };
  });
}

function extractCategoryAttributes(response) {
  const attrs =
    response?.response?.attribute_tree ||
    response?.response?.list?.[0]?.attribute_tree ||
    response?.response?.attribute_list ||
    response?.response?.attributes ||
    response?.response ||
    [];

  return Array.isArray(attrs) ? attrs : [];
}

async function loadCategoryAttributes(shop, categoryId) {
  if (!categoryId) return [];

  let attributes = [];
  try {
    const response = await ShopeeProductService.getAttributeTree({
      shopId: String(shop.shopId),
      categoryId: String(categoryId),
    });
    attributes = extractCategoryAttributes(response);
  } catch (_treeError) {
    attributes = [];
  }

  if (attributes.length) return attributes;

  // Transitional fallback while Shopee finishes deprecating get_attributes.
  const legacyResponse = await ShopeeProductService.getAttributes({
    shopId: String(shop.shopId),
    categoryId: String(categoryId),
  });
  return extractCategoryAttributes(legacyResponse);
}

function readCategoryChildren(node) {
  const candidates = ["children", "child", "children_list", "category_list"];
  for (const key of candidates) {
    if (Array.isArray(node?.[key])) return node[key];
  }
  return [];
}

function normalizeCategoryNode(node) {
  const categoryId = toInteger(
    node?.catid ?? node?.category_id ?? node?.categoryId ?? node?.id,
  );
  if (!categoryId) return null;

  const parentCategoryId = toInteger(
    node?.parent_catid ??
      node?.parent_category_id ??
      node?.parentCategoryId ??
      node?.parent_id,
  );
  const displayName = sanitizeText(
    node?.display_name ??
      node?.display_category_name ??
      node?.category_name ??
      node?.name ??
      node?.original_category_name ??
      "",
  );

  return {
    categoryId: String(categoryId),
    parentCategoryId: parentCategoryId ? String(parentCategoryId) : "",
    displayName: displayName || `Categoria ${categoryId}`,
    hasChildren:
      Boolean(node?.has_children) ||
      Boolean(node?.has_children_category) ||
      readCategoryChildren(node).length > 0,
    children: readCategoryChildren(node),
  };
}

function flattenCategoryTree(nodes = []) {
  const out = [];
  const walk = (node, level = 0, parentPath = "") => {
    const normalized = normalizeCategoryNode(node);
    if (!normalized) return;

    const path = parentPath
      ? `${parentPath} > ${normalized.displayName}`
      : normalized.displayName;

    out.push({
      categoryId: normalized.categoryId,
      parentCategoryId: normalized.parentCategoryId,
      displayName: normalized.displayName,
      path,
      level,
      hasChildren: normalized.hasChildren,
    });

    normalized.children.forEach((child) => walk(child, level + 1, path));
  };

  (Array.isArray(nodes) ? nodes : []).forEach((node) => walk(node, 0, ""));
  return out;
}

function flattenCategoryRows(nodes = []) {
  const normalized = (Array.isArray(nodes) ? nodes : [])
    .map((node) => normalizeCategoryNode(node))
    .filter(Boolean);
  if (!normalized.length) return [];

  const hasNested = normalized.some((node) => node.children.length > 0);
  if (hasNested) {
    return flattenCategoryTree(nodes);
  }

  const byId = new Map(normalized.map((node) => [node.categoryId, node]));
  const childrenByParent = new Map();
  normalized.forEach((node) => {
    const parentKey = node.parentCategoryId || "";
    if (!childrenByParent.has(parentKey)) childrenByParent.set(parentKey, []);
    childrenByParent.get(parentKey).push(node);
  });

  const out = [];
  const visited = new Set();
  const sortByName = (a, b) =>
    String(a?.displayName || "").localeCompare(String(b?.displayName || ""), "pt-BR");

  const walk = (node, level = 0, parentPath = "") => {
    if (!node || visited.has(node.categoryId)) return;
    visited.add(node.categoryId);
    const path = parentPath ? `${parentPath} > ${node.displayName}` : node.displayName;
    const children = (childrenByParent.get(node.categoryId) || []).sort(sortByName);
    out.push({
      categoryId: node.categoryId,
      parentCategoryId: node.parentCategoryId,
      displayName: node.displayName,
      path,
      level,
      hasChildren: Boolean(children.length || node.hasChildren),
    });
    children.forEach((child) => walk(child, level + 1, path));
  };

  const roots = normalized
    .filter((node) => !node.parentCategoryId || !byId.has(node.parentCategoryId))
    .sort(sortByName);
  roots.forEach((node) => walk(node, 0, ""));
  normalized.forEach((node) => walk(node, 0, ""));

  return out;
}

async function loadCategoryTree(shop) {
  const languages = ["pt-br", "en", "pt_BR"];
  let lastError = null;

  for (const language of languages) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await ShopeeProductService.getCategoryTree({
        shopId: String(shop.shopId),
        language,
      });
      const categoryList =
        response?.response?.category_list ||
        response?.response?.categories ||
        response?.response ||
        [];
      const rows = flattenCategoryRows(Array.isArray(categoryList) ? categoryList : []);
      if (rows.length) return rows;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  return [];
}

function tokenizeCategorySuggestionText(value) {
  const normalized = normalizeCompareToken(value || "");
  if (!normalized) return [];
  return normalized
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function tokenizeLeadingItemName(value, maxTokens = 3) {
  return tokenizeCategorySuggestionText(value).slice(0, Math.max(1, Number(maxTokens) || 3));
}

function scoreCategorySuggestion(row, tokens, sourceCategoryId, primaryTokens = []) {
  const display = normalizeCompareToken(row?.displayName || "");
  const path = normalizeCompareToken(row?.path || "");
  let score = 0;

  if (sourceCategoryId && String(row?.categoryId || "") === String(sourceCategoryId)) {
    score += 1000;
  }

  tokens.forEach((token) => {
    if (!token) return;
    if (display === token) score += 60;
    if (display.startsWith(token)) score += 22;
    if (display.includes(token)) score += 16;
    if (path.includes(token)) score += 8;
  });

  primaryTokens.forEach((token) => {
    if (!token) return;
    if (display.startsWith(token)) score += 34;
    if (display.includes(token)) score += 20;
    if (path.includes(token)) score += 12;
  });

  if (row?.hasChildren === false) score += 10;
  score += Math.max(0, 4 - Number(row?.level || 0));
  return score;
}

async function suggestShopeeCategories(shop, source) {
  let categories = [];
  try {
    categories = await loadCategoryTree(shop);
  } catch (_error) {
    return { detectedCategory: null, recommendedCategories: [] };
  }

  if (!Array.isArray(categories) || !categories.length) {
    return { detectedCategory: null, recommendedCategories: [] };
  }

  const sourceCategoryId = source?.categoryId ? String(source.categoryId) : "";
  const sourceCategoryName = source?.categoryName || "";
  const sourceCategoryPath = source?.categoryPath || "";
  const itemName = source?.itemName || "";
  const primaryTokens = tokenizeLeadingItemName(itemName, 3);
  const tokens = Array.from(
    new Set([
      ...primaryTokens,
      ...tokenizeCategorySuggestionText(sourceCategoryName),
      ...tokenizeCategorySuggestionText(sourceCategoryPath),
      ...tokenizeCategorySuggestionText(itemName),
    ]),
  );

  const detected =
    categories.find((entry) => String(entry?.categoryId || "") === sourceCategoryId) || null;

  const rankedAll = categories
    .map((entry) => ({
      ...entry,
      _score: scoreCategorySuggestion(entry, tokens, sourceCategoryId, primaryTokens),
    }))
    .filter((entry) => entry._score > 0)
    .sort((a, b) => b._score - a._score);

  const ranked = rankedAll
    .filter((entry) => {
      if (sourceCategoryId) return true;
      if (!primaryTokens.length) return true;
      const display = normalizeCompareToken(entry?.displayName || "");
      const path = normalizeCompareToken(entry?.path || "");
      return primaryTokens.some(
        (token) => display.includes(token) || path.includes(token),
      );
    })
    .sort((a, b) => b._score - a._score);

  const rankedFinal = ranked.length ? ranked : rankedAll;

  const recommendedCategories = rankedFinal
    .filter((entry) => String(entry?.categoryId || "") !== String(detected?.categoryId || ""))
    .slice(0, 3)
    .map((entry) => ({
      categoryId: String(entry.categoryId || ""),
      displayName: entry.displayName || "",
      path: entry.path || "",
      score: entry._score,
    }));

  return {
    detectedCategory: detected
      ? {
          categoryId: String(detected.categoryId || ""),
          displayName: detected.displayName || "",
          path: detected.path || "",
        }
      : null,
    recommendedCategories,
  };
}

function getOfficialAttributeOptions(attribute = {}) {
  const candidates = [
    attribute?.attribute_value_list,
    attribute?.values,
    attribute?.attribute_values,
    attribute?.value_list,
  ];
  const values = candidates.find(Array.isArray) || [];
  return values
    .map((value) => ({
      label: normalizeWhitespace(
        value?.original_value_name ?? value?.value_name ?? value?.name ?? value?.value ?? value,
      ),
      source: value && typeof value === "object" ? value : null,
    }))
    .filter((value) => value.label);
}

function mapAssemblyValueToOfficialOption(attribute, values = []) {
  const normalizedValues = Array.isArray(values)
    ? values.map((value) => normalizeWhitespace(value)).filter(Boolean)
    : [];
  if (!normalizedValues.length) return [];

  const optionByToken = new Map(
    getOfficialAttributeOptions(attribute).map((option) => [normalizeCompareToken(option.label), option.label]),
  );
  const first = normalizeCompareToken(normalizedValues[0]);
  const requiresAssembly = /^(sim|yes|y|assembly required|requer montagem)$/.test(first);
  const fullyAssembled = /^(nao|no|n|fully assembled|sem montagem)$/.test(first);

  if (requiresAssembly) {
    return [optionByToken.get("assembly required") || "Assembly Required"];
  }
  if (fullyAssembled) {
    return [optionByToken.get("fully assembled") || "Fully Assembled"];
  }
  return normalizedValues;
}

function normalizeCategoryAttributeValues(attribute, name, values = []) {
  const normalizedValues = Array.isArray(values)
    ? values.map((value) => normalizeWhitespace(value)).filter(Boolean)
    : [];
  const attributeToken = normalizeCompareToken(name);

  if (attributeToken === "assembly") {
    return mapAssemblyValueToOfficialOption(attribute, normalizedValues);
  }
  if (normalizedValues.length || !isInmetroRegistrationAttribute({ name })) {
    return normalizedValues;
  }

  // Select only the explicit Shopee option for products to which the NBR certification does not apply.
  const notApplicable = getOfficialAttributeOptions(attribute).find((option) => {
    const token = normalizeCompareToken(option.label);
    return token.includes("not applicable") || token.includes("nbr not applicable");
  });
  return notApplicable ? [notApplicable.label] : [];
}

function findSourceForCategoryAttribute(sourceLookup, attributeId, name) {
  const direct =
    (attributeId ? sourceLookup.get(`id:${attributeId}`) : null) ||
    sourceLookup.get(`name:${normalizeCompareToken(name)}`) ||
    null;
  if (direct) return direct;

  const attributeToken = normalizeCompareToken(name);
  const aliases = attributeToken === "assembly"
    ? ["requer montagem", "necessita montagem", "montagem"]
    : isInmetroRegistrationAttribute({ name })
      ? ["inmetro", "certificacao inmetro", "registro inmetro"]
      : [];
  return aliases
    .map((alias) => sourceLookup.get(`name:${alias}`))
    .find(Boolean) || null;
}

function mergeWithCategoryAttributes(
  categoryAttributes,
  sourceAttributes,
  sourceSpecifications,
  categoryId = null,
) {
  const sourceLookup = buildSourceValueLookup(sourceAttributes, sourceSpecifications);
  if (!Array.isArray(categoryAttributes) || !categoryAttributes.length) {
    const fallback = (Array.isArray(sourceAttributes) ? sourceAttributes : []).map(
      normalizeEditableAttribute,
    );
    return applyInmetroRequirement(applyAnvisaRequirement(categoryId, fallback));
  }

  const merged = categoryAttributes.map((attribute) => {
    const attributeId = attribute?.attribute_id != null ? String(attribute.attribute_id) : null;
    const name =
      attribute?.original_attribute_name ||
      attribute?.attribute_name ||
      attribute?.name ||
      "Atributo";
    const source = findSourceForCategoryAttribute(sourceLookup, attributeId, name);

    return {
      attributeId,
      name,
      isMandatory: Boolean(attribute?.is_mandatory ?? attribute?.mandatory),
      values: normalizeCategoryAttributeValues(attribute, name, source?.values),
      sourceAttribute:
        attribute && typeof attribute === "object"
          ? JSON.parse(JSON.stringify(attribute))
          : source?.sourceAttribute || null,
    };
  });

  return applyInmetroRequirement(applyAnvisaRequirement(categoryId, merged));
}

function normalizePublishAttributes(attributes = []) {
  return (Array.isArray(attributes) ? attributes : [])
    .map((entry) => {
      const attributeId = toInteger(entry?.attributeId);
      if (!attributeId) return null;

      const sourceAttribute =
        entry?.sourceAttribute && typeof entry.sourceAttribute === "object"
          ? entry.sourceAttribute
          : null;
      const values = Array.isArray(entry?.values)
        ? entry.values.map((value) => normalizeWhitespace(value)).filter(Boolean)
        : [];

      if (!values.length) return null;

      return {
        attribute_id: attributeId,
        attribute_value_list: buildAttributeValueList(values, sourceAttribute),
      };
    })
    .filter(Boolean);
}

function normalizeDraftLogisticsForAnalysis(logisticInfo = []) {
  return (Array.isArray(logisticInfo) ? logisticInfo : [])
    .map((entry) => {
      const logisticId = toInteger(entry?.logisticId ?? entry?.logistic_id);
      if (!logisticId) return null;

      return {
        logistic_id: logisticId,
        logistic_name: sanitizeText(entry?.name || entry?.logistic_name || ""),
        enabled: Boolean(entry?.enabled),
        size_id: toInteger(entry?.sizeId ?? entry?.size_id),
        shipping_fee: toFiniteNumber(entry?.shippingFee ?? entry?.shipping_fee),
        is_free: Boolean(entry?.isFree ?? entry?.is_free),
      };
    })
    .filter(Boolean);
}

function normalizeDraftImages(images = []) {
  return uniqueBy(
    (Array.isArray(images) ? images : [])
      .map((entry, index) => ({
        key: String(entry?.key || `image-${index}`),
        url: String(entry?.url || entry?.sourceUrl || "").trim(),
        imageId: String(entry?.imageId || "").trim() || null,
      }))
      .filter((entry) => entry.url || entry.imageId),
    (entry) => entry.imageId || entry.url,
  );
}

function sanitizeText(value) {
  return normalizeWhitespace(value);
}

function sanitizeDimension(dimension) {
  const packageWidth = toInteger(dimension?.package_width ?? dimension?.packageWidth);
  const packageLength = toInteger(dimension?.package_length ?? dimension?.packageLength);
  const packageHeight = toInteger(dimension?.package_height ?? dimension?.packageHeight);

  if ([packageWidth, packageLength, packageHeight].every((value) => value == null)) {
    return null;
  }

  return {
    ...(packageWidth != null ? { package_width: packageWidth } : {}),
    ...(packageLength != null ? { package_length: packageLength } : {}),
    ...(packageHeight != null ? { package_height: packageHeight } : {}),
  };
}

function sanitizeBrand(draft) {
  return buildShopeeBrand({
    brandId: draft?.brandId,
    brandName: draft?.brandName || draft?.brand || "",
  });
}

function sanitizeLogistics(logisticInfo = []) {
  return (Array.isArray(logisticInfo) ? logisticInfo : [])
    .map((entry) => {
      const logisticId = toInteger(entry?.logisticId ?? entry?.logistic_id);
      if (!logisticId) return null;

      const normalized = {
        logistic_id: logisticId,
        enabled: Boolean(entry?.enabled),
      };

      const sizeId = toInteger(entry?.sizeId ?? entry?.size_id);

      if (sizeId != null) normalized.size_id = sizeId;
      if (entry?.isFree != null || entry?.is_free != null) {
        normalized.is_free = Boolean(entry?.isFree ?? entry?.is_free);
      }

      return normalized;
    })
    .filter(Boolean);
}

function sanitizeTaxInfo(taxInfo) {
  if (!taxInfo || typeof taxInfo !== "object") return null;

  const normalized = {};
  const keys = [
    "ncm",
    "same_state_cfop",
    "diff_state_cfop",
    "csosn",
    "origin",
    "cest",
    "measure_unit",
    "invoice_option",
    "vat_rate",
  ];

  keys.forEach((key) => {
    const value = sanitizeText(taxInfo[key]);
    if (value) normalized[key] = value;
  });

  return Object.keys(normalized).length ? normalized : null;
}

function sanitizeComplaintPolicy(complaintPolicy) {
  if (!complaintPolicy || typeof complaintPolicy !== "object") return null;

  const normalized = {};
  const warrantyTime = sanitizeText(complaintPolicy.warranty_time || complaintPolicy.warrantyTime);
  const additionalInformation = sanitizeText(
    complaintPolicy.additional_information || complaintPolicy.additionalInformation,
  );
  const complaintAddressId = toInteger(
    complaintPolicy.complaint_address_id || complaintPolicy.complaintAddressId,
  );

  if (warrantyTime) normalized.warranty_time = warrantyTime;
  if (additionalInformation) {
    normalized.additional_information = additionalInformation;
  }
  if (complaintAddressId) normalized.complaint_address_id = complaintAddressId;
  if (
    complaintPolicy.exclude_entrepreneur_warranty != null ||
    complaintPolicy.excludeEntrepreneurWarranty != null
  ) {
    normalized.exclude_entrepreneur_warranty = Boolean(
      complaintPolicy.exclude_entrepreneur_warranty ??
        complaintPolicy.excludeEntrepreneurWarranty,
    );
  }

  return Object.keys(normalized).length ? normalized : null;
}

function sanitizeSellerStock(stock) {
  const parsed = toInteger(stock);
  if (parsed == null) return [{ stock: 0 }];
  return [{ stock: Math.max(0, parsed) }];
}

function sanitizePreOrder(preOrder, daysToShipFallback = null) {
  const isPreOrder = Boolean(preOrder?.isPreOrder ?? preOrder?.is_pre_order);
  const daysToShip = toInteger(preOrder?.daysToShip ?? preOrder?.days_to_ship ?? daysToShipFallback);
  if (daysToShip == null && !isPreOrder) return null;

  return {
    is_pre_order: isPreOrder,
    ...(daysToShip != null ? { days_to_ship: daysToShip } : {}),
  };
}

function fillModelPricesWithFallback(models, fallbackPrice) {
  const normalizedFallback = toFiniteNumber(fallbackPrice);
  return models.map((model) => ({
    ...model,
    originalPrice: toFiniteNumber(model?.originalPrice) ?? normalizedFallback,
  }));
}

function getMissingMandatoryAttributeNames(attributes = []) {
  return (Array.isArray(attributes) ? attributes : [])
    .filter((attribute) => Boolean(attribute?.isMandatory))
    .filter((attribute) => {
      const values = Array.isArray(attribute?.values)
        ? attribute.values.map((value) => normalizeWhitespace(value)).filter(Boolean)
        : [];
      return !values.length;
    })
    .map((attribute) => normalizeWhitespace(attribute?.name || "Atributo obrigatorio"))
    .filter(Boolean);
}

function buildDraftLogisticsValidation(draft) {
  const dimension = sanitizeDimension(draft?.dimension);
  const weight = toFiniteNumber(draft?.weight);
  const logisticsForAnalysis = normalizeDraftLogisticsForAnalysis(draft?.logisticInfo);
  const logisticsAnalysis = analyzeLogistics(logisticsForAnalysis);
  const physicalAnalysis = analyzeSpxPhysicalEligibility({ dimension, weight });
  const enabledChannels = Array.isArray(logisticsAnalysis?.enabledChannels)
    ? logisticsAnalysis.enabledChannels
    : [];
  const invalidEnabledChannels = enabledChannels.filter(
    (channel) =>
      (channel?.kind === "spx" || channel?.kind === "pickup") &&
      !physicalAnalysis.eligible,
  );

  return {
    shippingMode: logisticsAnalysis?.shippingMode || null,
    spxEnabled: Boolean(logisticsAnalysis?.spxEnabled),
    spxLogisticsEligible: Boolean(logisticsAnalysis?.spxEligible),
    spxPhysicalEligible: Boolean(physicalAnalysis?.eligible),
    spxEligibilityReasons: Array.isArray(physicalAnalysis?.reasons)
      ? physicalAnalysis.reasons
      : [],
    spxEligibilityMetrics: physicalAnalysis?.metrics || {},
    logistics: Array.isArray(logisticsAnalysis?.logistics) ? logisticsAnalysis.logistics : [],
    invalidEnabledChannels: invalidEnabledChannels.map((channel) => channel?.label || channel?.name),
    requiresSpxAdjustment: invalidEnabledChannels.length > 0,
  };
}

function resolveBaseOriginalPrice(draft) {
  const explicitBasePrice = toFiniteNumber(draft?.originalPrice);
  if (explicitBasePrice != null && explicitBasePrice > 0) return explicitBasePrice;

  const modelPrices = (Array.isArray(draft?.variations?.models) ? draft.variations.models : [])
    .map((model) => toFiniteNumber(model?.originalPrice))
    .filter((value) => value != null && value > 0);

  if (!modelPrices.length) return null;
  return Math.min(...modelPrices);
}

function validateDraftForPublish(draft) {
  const errors = [];
  const title = sanitizeText(draft?.itemName);
  const description = sanitizeText(draft?.description);
  const categoryId = toInteger(draft?.categoryId);
  const weight = toFiniteNumber(draft?.weight);
  const dimension = sanitizeDimension(draft?.dimension);
  const images = normalizeDraftImages(draft?.images);
  const logistics = sanitizeLogistics(draft?.logisticInfo);
  const basePrice = resolveBaseOriginalPrice(draft);
  const brand = sanitizeBrand(draft);
  const logisticsValidation = buildDraftLogisticsValidation(draft);
  const variationsEnabled = Boolean(draft?.variations?.enabled);
  const modelList = fillModelPricesWithFallback(
    Array.isArray(draft?.variations?.models) ? draft.variations.models : [],
    basePrice,
  );
  const missingMandatoryAttributeNames = getMissingMandatoryAttributeNames(
    draft?.attributes,
  );
  const anvisaValidationError = getAnvisaValidationError(categoryId, draft?.attributes);
  const inmetroValidationError = getInmetroValidationError(draft?.attributes);

  if (!title) errors.push("Preencha o título do anúncio.");
  if (!description) errors.push("Preencha a descrição.");
  if (!categoryId) errors.push("Informe a categoria Shopee.");
  if (!brand || !sanitizeText(brand?.original_brand_name)) {
    errors.push("Preencha a marca do produto.");
  }
  if (weight == null || weight <= 0) errors.push("Informe um peso válido em KG.");
  if (!dimension || Object.values(dimension).some((value) => value == null || value <= 0)) {
    errors.push("Preencha largura, comprimento e altura do pacote.");
  }
  if (images.length < 3) errors.push("Adicione ao menos 3 imagens.");
  if (!logistics.length || !logistics.some((entry) => entry.enabled)) {
    errors.push("Selecione ao menos um canal logístico habilitado.");
  }

  if (missingMandatoryAttributeNames.length) {
    errors.push(
      `Preencha os atributos obrigatÃ³rios: ${missingMandatoryAttributeNames.join(", ")}.`,
    );
  }
  if (
    anvisaValidationError &&
    !missingMandatoryAttributeNames.some((name) => /anvisa/i.test(name))
  ) {
    errors.push(anvisaValidationError);
  }
  if (
    inmetroValidationError &&
    !missingMandatoryAttributeNames.some((name) => /inmetro/i.test(name))
  ) {
    errors.push(inmetroValidationError);
  }
  if (logisticsValidation.requiresSpxAdjustment) {
    errors.push(
      `Revise a logÃ­stica SPX/Retire Perto de VocÃª para as dimensÃµes atuais. ${logisticsValidation.spxEligibilityReasons.join(" ")}`.trim(),
    );
  }

  if (variationsEnabled) {
    const tiers = Array.isArray(draft?.variations?.tiers) ? draft.variations.tiers : [];
    if (!tiers.length) errors.push("As variações estão habilitadas, mas não há grupos de variação.");
    if (!modelList.length) errors.push("As variações estão habilitadas, mas não há modelos.");
    if (modelList.some((model) => toFiniteNumber(model?.originalPrice) == null)) {
      errors.push("Preencha o preço de todos os modelos.");
    }
  } else if (basePrice == null || basePrice <= 0) {
    errors.push("Informe o preço do anúncio.");
  }

  return errors;
}

function buildOfficialDraftAttributeFallback(draft, categoryId) {
  const attributes = (Array.isArray(draft?.attributes) ? draft.attributes : [])
    .map((attribute) => normalizeEditableAttribute(attribute))
    .filter((attribute) => Boolean(toInteger(attribute?.attributeId)));

  if (!attributes.length) return null;
  return applyInmetroRequirement(applyAnvisaRequirement(categoryId, attributes));
}

async function enrichDraftAttributesForCategory(shop, draft) {
  const categoryId = toInteger(draft?.categoryId);
  if (!categoryId) return draft;

  try {
    const categoryAttributes = await loadCategoryAttributes(shop, categoryId);
    if (!categoryAttributes.length) {
      const error = new Error(
        "A Shopee não retornou os atributos da categoria selecionada. Recarregue os atributos antes de publicar.",
      );
      error.statusCode = 424;
      error.code = "category_attributes_unavailable";
      throw error;
    }
    const currentAttributes = (Array.isArray(draft?.attributes) ? draft.attributes : []).map(
      (attribute) => normalizeEditableAttribute(attribute),
    );

    return {
      ...draft,
      attributes: mergeWithCategoryAttributes(categoryAttributes, currentAttributes, [], categoryId),
    };
  } catch (cause) {
    const fallbackAttributes = buildOfficialDraftAttributeFallback(draft, categoryId);
    if (fallbackAttributes) {
      return {
        ...draft,
        attributes: fallbackAttributes,
      };
    }

    const error = new Error(
      "Não foi possível carregar os atributos obrigatórios da Shopee para esta categoria. Atualize os atributos e tente novamente.",
    );
    error.statusCode = Number(cause?.statusCode) || 424;
    error.code = "category_attributes_unavailable";
    error.cause = cause;
    throw error;
  }
}

function buildDefaultLogisticRows(logistics = []) {
  return (Array.isArray(logistics) ? logistics : [])
    .map((entry) => ({
      logisticId: String(
        entry?.logistic_id ??
          entry?.logistics_channel_id ??
          entry?.channel_id ??
          entry?.id ??
          "",
      ).trim(),
      name: sanitizeText(
        entry?.logistic_name ??
          entry?.logistics_name ??
          entry?.channel_name ??
          entry?.name ??
          "",
      ),
      enabled:
        entry?.enabled != null
          ? Boolean(entry.enabled)
          : entry?.is_enabled != null
            ? Boolean(entry.is_enabled)
            : true,
      sizeId: toInteger(entry?.size_id),
      shippingFee: toFiniteNumber(entry?.shipping_fee),
      isFree:
        entry?.is_free != null ? Boolean(entry.is_free) : entry?.isFree != null ? Boolean(entry.isFree) : false,
    }))
    .filter((entry) => entry.logisticId);
}

async function loadDefaultLogistics(shop) {
  try {
    const dbProducts = await listProductsForManagement(shop.id, {
      take: 20,
      includeInactive: true,
    });

    for (const product of dbProducts) {
      const logistics = extractLogistics(product?.logistics);
      if (logistics.length) {
        return buildDefaultLogisticRows(logistics);
      }
    }
  } catch (_error) {}

  try {
    const candidateStatuses = ["NORMAL", "UNLIST"];
    for (const itemStatus of candidateStatuses) {
      const list = await ShopeeProductService.getItemList({
        shopId: String(shop.shopId),
        offset: 0,
        pageSize: 10,
        itemStatus,
      });

      const itemIds = (Array.isArray(list?.response?.item) ? list.response.item : [])
        .map((entry) => entry?.item_id)
        .filter(Boolean);

      if (!itemIds.length) continue;

      const details = await ShopeeProductService.getItemBaseInfo({
        shopId: String(shop.shopId),
        itemIdList: itemIds.slice(0, 10),
      });

      const itemList =
        details?.response?.item_list ||
        details?.response?.items ||
        details?.response ||
        [];

      for (const item of Array.isArray(itemList) ? itemList : []) {
        const logistics = extractLogistics(item?.logistic_info);
        if (logistics.length) {
          return buildDefaultLogisticRows(logistics);
        }
      }
    }
  } catch (_error) {}

  return [];
}

function buildFallbackAttributesFromSource(sourceAttributes = []) {
  return (Array.isArray(sourceAttributes) ? sourceAttributes : [])
    .map((entry) => normalizeEditableAttribute(entry))
    .filter((entry) => entry.name && Array.isArray(entry.values) && entry.values.length)
    .filter(
      (entry, index, list) =>
        list.findIndex(
          (candidate) =>
            normalizeCompareToken(candidate?.name || "") ===
            normalizeCompareToken(entry?.name || ""),
        ) === index,
    )
    .filter(Boolean);
}

function buildDraftFromSource(source, logistics, mergedAttributes, categorySuggestions = {}) {
  const variationModels = fillModelPricesWithFallback(
    Array.isArray(source?.variations?.models) ? source.variations.models : [],
    source?.price,
  );

  return {
    sourcePlatform: source.platform,
    sourceUrl: source.sourceUrl,
    sourceItemId: source.externalItemId || "",
    sourceShopId: source.externalShopId || "",
    sourceCategoryName: source.categoryName || "",
    sourceCategoryPath: source.categoryPath || "",
    detectedCategory:
      categorySuggestions?.detectedCategory && typeof categorySuggestions.detectedCategory === "object"
        ? categorySuggestions.detectedCategory
        : null,
    recommendedCategories: Array.isArray(categorySuggestions?.recommendedCategories)
      ? categorySuggestions.recommendedCategories
      : [],
    notes: Array.isArray(source.notes) ? source.notes : [],
    sourceSpecifications: Array.isArray(source.sourceSpecifications)
      ? source.sourceSpecifications
      : [],
    sourceAttributes: Array.isArray(source.sourceAttributes)
      ? source.sourceAttributes
      : [],
    extraction: source.extraction || null,
    itemName: source.itemName || "",
    description: source.description || "",
    originalPrice: source.price ?? null,
    stock: source.stock ?? 0,
    categoryId: source.categoryId != null ? String(source.categoryId) : "",
    categoryName: source.categoryName || "",
    brandName: resolveBrandDisplayName(source.brandName),
    brandId: "",
    itemSku: "",
    condition: source.condition || "NEW",
    itemStatus: "NORMAL",
    imageRatio: "1:1",
    weight: source.weight ?? null,
    dimension: sanitizeDimension(source.dimension) || {
      package_width: null,
      package_length: null,
      package_height: null,
    },
    preOrder: {
      isPreOrder: false,
      daysToShip: source.daysToShip ?? null,
    },
    clip: {
      sourceUrl: source.video?.sourceUrl || "",
      thumbnailUrl: source.video?.thumbnailUrl || "",
      videoUploadId: source.video?.videoUploadId || "",
    },
    images: normalizeDraftImages(source.images),
    attributes: Array.isArray(mergedAttributes) ? mergedAttributes : [],
    logisticInfo: Array.isArray(logistics) ? logistics : [],
    taxInfo: {
      ncm: "",
      same_state_cfop: "",
      diff_state_cfop: "",
      csosn: "",
      origin: "",
      cest: "",
      measure_unit: "",
      invoice_option: "",
      vat_rate: "",
    },
    complaintPolicy: {
      warranty_time: "",
      exclude_entrepreneur_warranty: false,
      complaint_address_id: "",
      additional_information: "",
    },
    itemDangerous: 0,
    variations: {
      enabled: Boolean(source?.variations?.enabled),
      tiers: Array.isArray(source?.variations?.tiers) ? source.variations.tiers : [],
      models: variationModels,
    },
  };
}

function stripClipFromDraft(draft) {
  const sanitized =
    draft && typeof draft === "object" ? JSON.parse(JSON.stringify(draft)) : {};
  if (sanitized?.clip && typeof sanitized.clip === "object") {
    const previewUrl = String(sanitized.clip.previewUrl || "");
    if (previewUrl.startsWith("blob:")) delete sanitized.clip.previewUrl;
  }
  return sanitized;
}

function detectMarketplaceSafe(sourceUrl) {
  try {
    return detectMarketplace(sourceUrl);
  } catch (error) {
    if (error && Number.isInteger(error.statusCode)) throw error;
    const wrapped = new Error("Informe um link público de produto válido.");
    wrapped.statusCode = 400;
    throw wrapped;
  }
}

function unwrapShopeeItemList(response) {
  const items = response?.response?.item_list || response?.response?.items || response?.response || [];
  return Array.isArray(items) ? items : [];
}

async function loadOwnedShopeeListingSource(shop, sourceUrl) {
  const ids = extractShopeeListingIds(sourceUrl);
  if (!ids.itemId || String(ids.shopId) !== String(shop?.shopId || "")) return null;

  try {
    const [baseResponse, modelResponse] = await Promise.all([
      ShopeeProductService.getItemBaseInfo({
        shopId: String(shop.shopId),
        itemIdList: [ids.itemId],
      }),
      ShopeeProductService.getModelList({
        shopId: String(shop.shopId),
        itemId: ids.itemId,
      }).catch(() => null),
    ]);
    const baseItem = unwrapShopeeItemList(baseResponse).find(
      (entry) => String(entry?.item_id || "") === ids.itemId,
    );
    if (!baseItem) return null;

    const modelPayload = modelResponse?.response || {};
    const enrichedItem = {
      ...baseItem,
      models: Array.isArray(modelPayload?.model) ? modelPayload.model : baseItem.models,
      tier_variations:
        modelPayload?.tier_variation ||
        modelPayload?.tier_variations ||
        modelPayload?.standardise_tier_variation ||
        baseItem.tier_variations,
    };
    return parseShopeePublicListing("", sourceUrl, enrichedItem, "official-api");
  } catch (_error) {
    return null;
  }
}

function mergeShopeeListingSources(primary, fallback) {
  if (!primary) return fallback;
  if (!fallback) return primary;
  const preferArray = (first, second) => {
    const a = Array.isArray(first) ? first : [];
    const b = Array.isArray(second) ? second : [];
    return a.length >= b.length ? a : b;
  };

  return {
    ...fallback,
    ...primary,
    itemName: primary.itemName || fallback.itemName,
    description: primary.description || fallback.description,
    categoryName: primary.categoryName || fallback.categoryName,
    categoryPath: primary.categoryPath || fallback.categoryPath,
    images: preferArray(primary.images, fallback.images),
    sourceAttributes: preferArray(primary.sourceAttributes, fallback.sourceAttributes),
    sourceSpecifications: preferArray(primary.sourceSpecifications, fallback.sourceSpecifications),
    video: primary?.video?.sourceUrl ? primary.video : fallback.video,
    variations:
      primary?.variations?.models?.length >= (fallback?.variations?.models?.length || 0)
        ? primary.variations
        : fallback.variations,
    extractionMethod: primary.extractionMethod || fallback.extractionMethod,
    notes: Array.from(new Set([...(fallback.notes || []), ...(primary.notes || [])])),
  };
}

function scoreShopeeListingSource(source) {
  return (
    (source?.itemName ? 20 : 0) +
    (source?.description ? 24 : 0) +
    (source?.categoryId ? 6 : 0) +
    (Array.isArray(source?.images) ? source.images.length * 4 : 0) +
    (Array.isArray(source?.sourceAttributes) ? source.sourceAttributes.length * 3 : 0) +
    (Array.isArray(source?.variations?.models) ? source.variations.models.length * 2 : 0) +
    (source?.video?.sourceUrl ? 3 : 0)
  );
}

function buildExtractionSummary(source) {
  const images = Array.isArray(source?.images) ? source.images.length : 0;
  const attributes = Array.isArray(source?.sourceAttributes) ? source.sourceAttributes.length : 0;
  const variations = Array.isArray(source?.variations?.models) ? source.variations.models.length : 0;
  const copied = [
    source?.itemName ? "title" : null,
    source?.description ? "description" : null,
    images ? "images" : null,
    attributes ? "attributes" : null,
    source?.categoryId ? "category" : null,
    source?.video?.sourceUrl ? "video" : null,
    variations ? "variations" : null,
  ].filter(Boolean);
  const missing = [
    !source?.description ? "description" : null,
    !images ? "images" : null,
    !attributes ? "attributes" : null,
    !source?.categoryId ? "category" : null,
  ].filter(Boolean);

  return {
    method: source?.extractionMethod || "public-page",
    copied,
    missing,
    counts: { images, attributes, variations, videos: source?.video?.sourceUrl ? 1 : 0 },
  };
}

async function buildCloneDraft({ shop, sourceUrl }) {
  const normalizedUrl = normalizeSourceUrl(sourceUrl);
  const marketplace = detectMarketplaceSafe(normalizedUrl);
  const mercadoLivreItemId = marketplace === "mercadolivre" ? extractMercadoLivreItemId(normalizedUrl) : "";

  const [defaultLogistics, rawHtml, renderedShopeeHtml, shopeeFallbackHtmls, ownedSource, mercadoLivreResult] = await Promise.all([
    loadDefaultLogistics(shop),
    marketplace === "mercadolivre" || marketplace === "madeiramadeira" || marketplace === "generic"
      ? fetchHtml(normalizedUrl).catch(() => "")
      : Promise.resolve(""),
    marketplace === "shopee" ? tryFetchShopeeRenderedHtml(normalizedUrl) : Promise.resolve(""),
    marketplace === "shopee" ? fetchShopeePublicHtmlCandidates(normalizedUrl) : Promise.resolve([]),
    marketplace === "shopee"
      ? loadOwnedShopeeListingSource(shop, normalizedUrl)
      : Promise.resolve(null),
    mercadoLivreItemId
      ? fetchMercadoLivrePublicListing(mercadoLivreItemId, normalizedUrl)
        .then((source) => ({ source, error: null }))
        .catch((error) => ({ source: null, error }))
      : Promise.resolve({ source: null, error: null }),
  ]);
  const mercadoLivreSource = mercadoLivreResult?.source || null;
  const mercadoLivreFetchError = mercadoLivreResult?.error || null;

  let source;
  if (marketplace === "shopee") {
    const publicSource = [...shopeeFallbackHtmls, renderedShopeeHtml]
      .filter(Boolean)
      .map((html) => parseShopeePublicListing(html, normalizedUrl))
      .sort((left, right) => scoreShopeeListingSource(right) - scoreShopeeListingSource(left))[0]
      || parseShopeePublicListing("", normalizedUrl);
    source = mergeShopeeListingSources(ownedSource, publicSource);
  } else if (marketplace === "madeiramadeira") {
    source = parseMadeiraMadeiraListing(rawHtml || "", normalizedUrl);
  } else if (marketplace === "generic") {
    source = parseGenericProductListing(rawHtml || "", normalizedUrl);
  } else {
    source = mercadoLivreSource || parseMercadoLivreListing(rawHtml || "", normalizedUrl);
  }

  const inferredTitle = inferTitleFromSourceUrl(normalizedUrl);
  if (!source || typeof source !== "object") {
    source = {
      platform: marketplace,
      sourceUrl: normalizedUrl,
      externalItemId: "",
      externalShopId: "",
      itemName: inferredTitle || "",
      description: "",
      price: null,
      stock: null,
      brandName: "",
      categoryId: null,
      categoryName: "",
      categoryPath: "",
      weight: null,
      dimension: {
        package_width: null,
        package_length: null,
        package_height: null,
      },
      daysToShip: null,
      condition: "NEW",
      images: [],
      sourceAttributes: [],
      sourceSpecifications: [],
      video: {
        sourceUrl: "",
        thumbnailUrl: "",
        videoUploadId: "",
      },
      variations: {
        enabled: false,
        tiers: [],
        models: [],
      },
      notes: [],
    };
  }

  if (!source.itemName && inferredTitle) {
    source.itemName = inferredTitle;
  }


  if (!Array.isArray(source.images)) source.images = [];
  if (!Array.isArray(source.sourceAttributes)) source.sourceAttributes = [];
  if (!Array.isArray(source.sourceSpecifications)) source.sourceSpecifications = [];
  if (!Array.isArray(source.notes)) source.notes = [];

  const extractedCoreContent = Boolean(
    source?.itemName &&
      (source?.description || source?.images?.length || source?.sourceAttributes?.length),
  );
  if (!extractedCoreContent) {
    if (marketplace === "mercadolivre" && mercadoLivreItemId && mercadoLivreFetchError) {
      const upstreamStatus = Number(mercadoLivreFetchError?.response?.status) || 502;
      const error = new Error(
        `O Mercado Livre bloqueou ou não disponibilizou os dados públicos do anúncio ${mercadoLivreItemId}. Tente novamente em alguns minutos.`,
      );
      error.statusCode = upstreamStatus === 429 ? 429 : 424;
      throw error;
    }
    const error = new Error(
      "Não foi possível extrair os dados principais do anúncio informado. Tente outro link público ou copie a URL final do anúncio.",
    );
    error.statusCode = 422;
    throw error;
  }

  let attributes = applyInmetroRequirement(
    applyAnvisaRequirement(
      source.categoryId,
      buildFallbackAttributesFromSource(source.sourceAttributes),
    ),
  );
  if (source.categoryId) {
    try {
      const categoryAttributes = await loadCategoryAttributes(shop, source.categoryId);
      attributes = mergeWithCategoryAttributes(
        categoryAttributes,
        source.sourceAttributes,
        source.sourceSpecifications,
        source.categoryId,
      );
    } catch (_error) {
      attributes = applyInmetroRequirement(
        applyAnvisaRequirement(
          source.categoryId,
          buildFallbackAttributesFromSource(source.sourceAttributes),
        ),
      );
    }
  }

  const categorySuggestions = await suggestShopeeCategories(shop, source);
  source.extraction = buildExtractionSummary(source);
  const draft = buildDraftFromSource(
    source,
    defaultLogistics,
    attributes,
    categorySuggestions,
  );
  draft.notes = [
    ...(Array.isArray(draft.notes) ? draft.notes : []),
    "O frete e calculado automaticamente pela Shopee durante o lancamento do anuncio.",
  ];

  if (!draft.logisticInfo.length) {
    draft.notes = [
      ...draft.notes,
      "Nenhum canal logístico padrão foi identificado na loja ativa; revise a logística antes de publicar.",
    ];
  }

  return draft;
}

async function previewCategoryAttributes({
  shop,
  categoryId,
  sourceAttributes = [],
  sourceSpecifications = [],
}) {
  const buildFallbackResponse = (error = null) => {
    const statusCode = Number(error?.statusCode || 0);
    const shopeeError = String(error?.shopee?.error || "").toLowerCase();
    const shopeeMessage = String(error?.shopee?.message || "").toLowerCase();

    let warning =
      "Nao foi possivel carregar os atributos da categoria na Shopee agora. Mantivemos os atributos clonados para voce continuar a edicao.";

    if (
      statusCode === 401 ||
      statusCode === 403 ||
      shopeeError.includes("auth") ||
      shopeeError.includes("forbidden") ||
      shopeeMessage.includes("invalid access token") ||
      shopeeMessage.includes("forbidden")
    ) {
      warning =
        "Shopee recusou o carregamento dos atributos desta categoria (permissao/autenticacao). Mantivemos os atributos clonados para nao interromper a edicao.";
    } else if (statusCode === 429 || shopeeError.includes("system_busy")) {
      warning =
        "Shopee limitou temporariamente a consulta de atributos. Mantivemos os atributos clonados; tente recarregar em alguns instantes.";
    } else if (
      shopeeError.includes("invalid") ||
      shopeeError.includes("param") ||
      shopeeMessage.includes("category")
    ) {
      warning =
        "A categoria selecionada nao retornou atributos validos na Shopee. Mantivemos os atributos clonados para revisao manual.";
    }

    return {
      attributes: mergeWithCategoryAttributes(
        [],
        sourceAttributes,
        sourceSpecifications,
        categoryId,
      ),
      warning,
      fallback: true,
    };
  };

  try {
    const categoryAttributes = await loadCategoryAttributes(shop, categoryId);
    return {
      attributes: mergeWithCategoryAttributes(
        categoryAttributes,
        sourceAttributes,
        sourceSpecifications,
        categoryId,
      ),
      fallback: false,
    };
  } catch (error) {
    return buildFallbackResponse(error);
  }
}

async function listCategoryTree({ shop }) {
  const categories = await loadCategoryTree(shop);
  return { categories };
}

async function listDrafts({ shop }) {
  return {
    drafts: await listListingCloneDrafts(shop.id),
  };
}

async function getDraft({ shop, draftId }) {
  const savedDraft = await findListingCloneDraftById(shop.id, draftId);
  if (!savedDraft || savedDraft.status !== "DRAFT") {
    const error = new Error("Rascunho nÃ£o encontrado.");
    error.statusCode = 404;
    throw error;
  }

  return {
    draft: {
      ...stripClipFromDraft(savedDraft.draftData || {}),
      draftId: savedDraft.id,
    },
    summary: buildDraftSummary(savedDraft),
  };
}

async function saveDraft({ shop, userId, draft }) {
  const payload = draft && typeof draft === "object" ? { ...draft } : {};
  delete payload.lastPublishResult;
  const storageDraft = stripClipFromDraft(payload);

  const savedDraft = await saveListingCloneDraft({
    draftId: toInteger(payload?.draftId),
    shopId: shop.id,
    userId,
    draft: storageDraft,
  });
  if (!savedDraft) {
    const error = new Error("NÃ£o foi possÃ­vel salvar o rascunho.");
    error.statusCode = 404;
    throw error;
  }

  return {
    draft: {
      ...payload,
      draftId: savedDraft.id,
    },
    summary: buildDraftSummary(savedDraft),
  };
}

async function removeDraft({ shop, draftId }) {
  const deleted = await deleteListingCloneDraft(shop.id, draftId);
  if (!deleted) {
    const error = new Error("Rascunho nÃ£o encontrado.");
    error.statusCode = 404;
    throw error;
  }

  return { ok: true };
}

async function validateDraftLogistics({ draft }) {
  return {
    validation: buildDraftLogisticsValidation(draft),
  };
}

function bufferToUploadFile(buffer, url, index) {
  const pathname = new URL(url).pathname || "";
  const baseName = path.basename(pathname) || `image-${index + 1}.jpg`;
  const extension = path.extname(baseName).toLowerCase();
  const mime =
    extension === ".png"
      ? "image/png"
      : extension === ".webp"
        ? "image/webp"
        : "image/jpeg";

  return {
    buffer,
    originalname: baseName,
    mimetype: mime === "image/webp" ? "image/jpeg" : mime,
  };
}

async function downloadBuffer(url) {
  const response = await axios.get(url, {
    timeout: DEFAULT_HTTP_TIMEOUT_MS,
    responseType: "arraybuffer",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      Referer: url,
    },
    validateStatus: (status) => status >= 200 && status < 400,
  });

  return Buffer.from(response.data);
}

async function uploadExternalImages(entries = []) {
  const missing = (Array.isArray(entries) ? entries : []).filter(
    (entry) => !entry.imageId && entry.url,
  );
  if (!missing.length) return normalizeDraftImages(entries);

  const uploadedByUrl = new Map();
  for (let i = 0; i < missing.length; i += 3) {
    const batch = missing.slice(i, i + 3);
    const files = [];

    for (let index = 0; index < batch.length; index += 1) {
      const entry = batch[index];
      // ML may return WEBP previews; upload as JPEG content type still works better with Shopee.
      // We keep the original buffer and let Shopee normalize the asset.
      // eslint-disable-next-line no-await-in-loop
      const buffer = await downloadBuffer(entry.url);
      files.push(bufferToUploadFile(buffer, entry.url, index));
    }

    // eslint-disable-next-line no-await-in-loop
    const uploaded = await ShopeeMediaService.uploadImage({
      files,
      business: DEFAULT_IMAGE_UPLOAD_BUSINESS,
      scene: DEFAULT_IMAGE_UPLOAD_SCENE,
    });

    uploaded.forEach((image, index) => {
      const source = batch[index];
      if (!source) return;
      uploadedByUrl.set(source.url, {
        key: source.key,
        url: String(image?.image_url || source.url),
        imageId: String(image?.image_id || ""),
      });
    });
  }

  return normalizeDraftImages(entries).map((entry) => {
    if (entry.imageId) return entry;
    return uploadedByUrl.get(entry.url) || entry;
  });
}

async function uploadCloneImages({ files, business, scene }) {
  const uploaded = await ShopeeMediaService.uploadImage({
    files,
    business,
    scene,
  });

  return {
    images: (Array.isArray(uploaded) ? uploaded : []).map((entry, index) => ({
      key: `uploaded-${Date.now()}-${index}`,
      imageId: String(entry?.image_id || ""),
      url: String(entry?.image_url || ""),
    })),
  };
}

function isMp4File(file = {}) {
  const mime = String(file?.mimetype || "").toLowerCase();
  const name = String(file?.originalname || "").toLowerCase();
  return mime === "video/mp4" || mime === "application/mp4" || name.endsWith(".mp4");
}

async function uploadCloneVideo({ shop, file, business, scene }) {
  if (!file || !file.buffer) {
    const error = new Error("Arquivo de clip ausente.");
    error.statusCode = 400;
    throw error;
  }

  if (!isMp4File(file)) {
    const error = new Error("Apenas arquivo MP4 e permitido para clip.");
    error.statusCode = 400;
    throw error;
  }

  if (Number(file.size || 0) > MAX_CLIP_FILE_SIZE_BYTES) {
    const error = new Error("Clip acima de 30MB. Reduza o arquivo e tente novamente.");
    error.statusCode = 400;
    throw error;
  }

  const uploaded = await ShopeeMediaService.uploadVideo({
    file,
    shopId: String(shop.shopId),
    business: Number.isFinite(Number(business)) ? Number(business) : 1,
    scene: Number.isFinite(Number(scene)) ? Number(scene) : 1,
  });

  return {
    clip: {
      videoUploadId: String(uploaded?.videoUploadId || ""),
      sourceUrl: String(uploaded?.videoUrl || ""),
      thumbnailUrl: String(uploaded?.thumbnailUrl || ""),
      durationSeconds:
        Number.isFinite(Number(uploaded?.durationSeconds)) && Number(uploaded.durationSeconds) > 0
          ? Number(uploaded.durationSeconds)
          : null,
    },
  };
}

function buildAddItemPayload(draft, imageIds) {
  const categoryId = toInteger(draft.categoryId);
  const basePrice = resolveBaseOriginalPrice(draft);
  const weight = toFiniteNumber(draft.weight);
  const dimension = sanitizeDimension(draft.dimension);
  const logistics = sanitizeLogistics(draft.logisticInfo);
  const attributes = normalizePublishAttributes(draft.attributes);
  const brand = sanitizeBrand(draft);
  const preOrder = sanitizePreOrder(draft.preOrder, null);
  const taxInfo = sanitizeTaxInfo(draft.taxInfo);
  const complaintPolicy = sanitizeComplaintPolicy(draft.complaintPolicy);
  const variationsEnabled = Boolean(draft?.variations?.enabled);

  const payload = {
    original_price: basePrice,
    description: sanitizeText(draft.description),
    weight,
    item_name: sanitizeText(draft.itemName),
    item_status: sanitizeText(draft.itemStatus || "NORMAL") || "NORMAL",
    category_id: categoryId,
    image: {
      image_id_list: imageIds,
      image_ratio: sanitizeText(draft.imageRatio || "1:1") || "1:1",
    },
    logistic_info: logistics,
    seller_stock: variationsEnabled ? [{ stock: 0 }] : sanitizeSellerStock(draft.stock),
  };

  if (dimension) payload.dimension = dimension;
  if (attributes.length) payload.attribute_list = attributes;
  if (preOrder) payload.pre_order = preOrder;
  if (sanitizeText(draft.itemSku)) payload.item_sku = sanitizeText(draft.itemSku);
  if (sanitizeText(draft.condition)) payload.condition = sanitizeText(draft.condition);
  if (brand) payload.brand = brand;
  if (toInteger(draft.itemDangerous) != null) {
    payload.item_dangerous = toInteger(draft.itemDangerous);
  }
  if (taxInfo) payload.tax_info = taxInfo;
  if (complaintPolicy) payload.complaint_policy = complaintPolicy;

  const videoUploadId = sanitizeText(draft?.clip?.videoUploadId || "");
  if (videoUploadId) {
    payload.video_upload_id = [videoUploadId];
  }

  return payload;
}

function buildInitTierPayload(itemId, draft) {
  const basePrice = resolveBaseOriginalPrice(draft);
  const filledModels = fillModelPricesWithFallback(
    Array.isArray(draft?.variations?.models) ? draft.variations.models : [],
    basePrice,
  );

  const tiers = (Array.isArray(draft?.variations?.tiers) ? draft.variations.tiers : [])
    .map((tier) => ({
      variation_name: sanitizeText(tier?.name),
      variation_id: 0,
      variation_group_id: 0,
      variation_option_list: (Array.isArray(tier?.options) ? tier.options : [])
        .map((option) => ({
          variation_option_id: 0,
          variation_option_name: sanitizeText(option?.optionName),
          ...(sanitizeText(option?.imageId) ? { image_id: sanitizeText(option.imageId) } : {}),
        }))
        .filter((option) => option.variation_option_name),
    }))
    .filter((tier) => tier.variation_name && tier.variation_option_list.length);

  return {
    item_id: Number(itemId),
    standardise_tier_variation: tiers,
    model: filledModels.map((model, index) => ({
      tier_index: Array.isArray(model?.tierIndex)
        ? model.tierIndex.map((value) => Number(value) || 0)
        : [],
      model_sku: sanitizeText(model?.modelSku || ""),
      original_price: toFiniteNumber(model?.originalPrice),
      seller_stock: sanitizeSellerStock(model?.stock),
      ...(sanitizeText(model?.gtinCode) ? { gtin_code: sanitizeText(model.gtinCode) } : {}),
      ...(toFiniteNumber(model?.weight) != null ? { weight: toFiniteNumber(model.weight) } : {}),
      ...(sanitizeDimension(model?.dimension) ? { dimension: sanitizeDimension(model.dimension) } : {}),
      ...(sanitizePreOrder(model?.preOrder, draft?.preOrder?.daysToShip)
        ? { pre_order: sanitizePreOrder(model.preOrder, draft?.preOrder?.daysToShip) }
        : {}),
      ...(sanitizeText(model?.modelSku || "") || toFiniteNumber(model?.originalPrice) != null
        ? {}
        : { model_sku: `MODEL-${index + 1}` }),
    })),
  };
}

async function persistCreatedItem(shop, addResult, initTierResult = null) {
  const itemId =
    toInteger(addResult?.response?.item_id) ||
    toInteger(addResult?.response?.itemId) ||
    null;

  if (!itemId) return null;

  let baseInfo = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await ShopeeProductService.getItemBaseInfo({
        shopId: String(shop.shopId),
        itemIdList: [itemId],
      });
      const items =
        response?.response?.item_list ||
        response?.response?.items ||
        response?.response ||
        [];
      baseInfo = Array.isArray(items) ? items.find((item) => Number(item?.item_id) === itemId) : null;
      if (baseInfo) break;
    } catch (_error) {}
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  if (!baseInfo) return itemId;

  let models = [];
  if (
    Array.isArray(initTierResult?.response?.model) &&
    initTierResult.response.model.length
  ) {
    models = initTierResult.response.model;
  } else if (baseInfo?.has_model) {
    try {
      const response = await ShopeeProductService.getModelList({
        shopId: String(shop.shopId),
        itemId,
      });
      models = Array.isArray(response?.response?.model) ? response.response.model : [];
    } catch (_error) {
      models = [];
    }
  }

  const productLogistics = extractLogistics(baseInfo?.logistic_info);
  const spxSnapshot = buildSpxSnapshot({
    logistics: productLogistics,
    dimension: baseInfo?.dimension ?? null,
    weight: baseInfo?.weight != null ? Number(baseInfo.weight) : null,
  });

  const savedProduct = await upsertProductForSync(shop.id, {
    itemId,
    status: baseInfo?.item_status || null,
    title: baseInfo?.item_name || null,
    description: baseInfo?.description || addResult?.response?.description || null,
    attributes: baseInfo?.attribute_list ?? baseInfo?.attributes ?? null,
    logistics: productLogistics.length ? productLogistics : null,
    dimension: baseInfo?.dimension ?? null,
    weight: baseInfo?.weight != null ? Number(baseInfo.weight) : null,
    shippingModeCache: spxSnapshot.cache.shippingModeCache,
    spxEnabledCache: spxSnapshot.cache.spxEnabledCache,
    spxLogisticsEligibleCache: spxSnapshot.cache.spxLogisticsEligibleCache,
    spxPhysicalEligibleCache: spxSnapshot.cache.spxPhysicalEligibleCache,
    spxEligibleCache: spxSnapshot.cache.spxEligibleCache,
    spxEligibilityReasonsCache: spxSnapshot.cache.spxEligibilityReasonsCache,
    spxSnapshotAt: spxSnapshot.cache.spxSnapshotAt,
    daysToShip: baseInfo?.pre_order?.days_to_ship ?? null,
    itemSku: baseInfo?.item_sku || null,
    brand: baseInfo?.brand?.original_brand_name || null,
    currency: baseInfo?.currency || "BRL",
    priceMin: baseInfo?.price_info?.[0]?.current_price ?? addResult?.response?.price_info?.current_price ?? null,
    priceMax: baseInfo?.price_info?.[0]?.current_price ?? addResult?.response?.price_info?.current_price ?? null,
    stock: baseInfo?.stock_info_v2?.summary_info?.total_available_stock ?? null,
    sold: baseInfo?.sold ?? null,
    ratingStar: null,
    ratingCount: null,
    ratingOver500: false,
    ratingSyncedAt: null,
    shouldUpdateRatingSyncedAt: false,
    hasModel: baseInfo?.has_model ?? Boolean(models.length),
    categoryId: baseInfo?.category_id || null,
    shopeeCreateTime: baseInfo?.create_time
      ? new Date(Number(baseInfo.create_time) * 1000)
      : new Date(),
    shopeeUpdateTime: baseInfo?.update_time
      ? new Date(Number(baseInfo.update_time) * 1000)
      : new Date(),
  });

  if (savedProduct?.id) {
    const imageUrls = Array.isArray(baseInfo?.image?.image_url_list)
      ? baseInfo.image.image_url_list
      : Array.isArray(addResult?.response?.images?.image_url_list)
        ? addResult.response.images.image_url_list
        : [];
    await replaceProductImages(savedProduct.id, imageUrls);

    if (models.length) {
      await replaceProductModels(
        savedProduct.id,
        models
          .filter((model) => model?.model_id != null)
          .map((model) => ({
            modelId: model.model_id,
            name: model.model_name || model.model_sku || null,
            sku: model.model_sku || null,
            price: model.price_info?.[0]?.original_price ?? null,
            stock:
              model.seller_stock?.[0]?.stock ??
              model.stock_info_v2?.summary_info?.total_available_stock ??
              null,
            sold: model.sold ?? null,
          })),
      );
    } else {
      await replaceProductModels(savedProduct.id, []);
    }
  }

  return itemId;
}

async function prepareSourceClipForPublish(shop, draft) {
  const sourceUrl = sanitizeText(draft?.clip?.sourceUrl || "");
  if (!sourceUrl || sanitizeText(draft?.clip?.videoUploadId || "")) return draft;

  try {
    const buffer = await downloadBuffer(sourceUrl);
    if (!buffer.length || buffer.length > MAX_CLIP_FILE_SIZE_BYTES) {
      throw new Error("O clip de origem esta vazio ou ultrapassa 30MB.");
    }
    const uploaded = await uploadCloneVideo({
      shop,
      file: {
        buffer,
        size: buffer.length,
        originalname: "clip-origem.mp4",
        mimetype: "video/mp4",
      },
      business: DEFAULT_IMAGE_UPLOAD_BUSINESS,
      scene: DEFAULT_IMAGE_UPLOAD_SCENE,
    });
    return { ...draft, clip: { ...(draft.clip || {}), ...(uploaded.clip || {}) } };
  } catch (error) {
    const wrapped = new Error(
      `Nao foi possivel copiar o clip de origem: ${error?.message || "arquivo indisponivel"}. Remova o clip ou envie o MP4 manualmente.`,
    );
    wrapped.statusCode = 422;
    throw wrapped;
  }
}

async function publishDraft({ shop, draft }) {
  let normalizedDraft = await enrichDraftAttributesForCategory(shop, {
    ...(draft && typeof draft === "object" ? draft : {}),
  });

  const validationErrors = validateDraftForPublish(normalizedDraft);
  if (validationErrors.length) {
    const error = new Error(validationErrors.join(" "));
    error.statusCode = 400;
    throw error;
  }

  normalizedDraft = await prepareSourceClipForPublish(shop, normalizedDraft);

  const uploadedImages = await uploadExternalImages(normalizedDraft.images);
  const mainImageIds = uploadedImages.map((entry) => entry.imageId).filter(Boolean);

  if (!mainImageIds.length) {
    throw new Error("Falha ao preparar as imagens para publicação.");
  }

  normalizedDraft = {
    ...normalizedDraft,
    images: uploadedImages,
  };

  if (normalizedDraft?.variations?.tiers?.length) {
    const updatedTiers = [];
    for (const tier of normalizedDraft.variations.tiers) {
      const optionsWithUploads = await uploadExternalImages(
        (Array.isArray(tier?.options) ? tier.options : []).map((option, index) => ({
          key: option?.key || `${tier.name || "tier"}-${index}`,
          url: String(option?.imageUrl || "").trim(),
          imageId: String(option?.imageId || "").trim() || null,
        })),
      );

      updatedTiers.push({
        ...tier,
        options: optionsWithUploads.map((option, index) => ({
          ...tier.options[index],
          imageUrl: option.url,
          imageId: option.imageId,
        })),
      });
    }

    normalizedDraft = {
      ...normalizedDraft,
      variations: {
        ...normalizedDraft.variations,
        tiers: updatedTiers,
        models: fillModelPricesWithFallback(
          normalizedDraft.variations.models || [],
          normalizedDraft.originalPrice,
        ),
      },
    };
  }

  const addPayload = buildAddItemPayload(normalizedDraft, mainImageIds);
  const addResult = await ShopeeProductWriteService.addItem({
    shopId: String(shop.shopId),
    body: addPayload,
  });

  const itemId =
    toInteger(addResult?.response?.item_id) || toInteger(addResult?.response?.itemId);
  let initTierResult = null;

  if (
    itemId &&
    Boolean(normalizedDraft?.variations?.enabled) &&
    Array.isArray(normalizedDraft?.variations?.models) &&
    normalizedDraft.variations.models.length
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5500));
    const tierPayload = buildInitTierPayload(itemId, normalizedDraft);
    initTierResult = await ShopeeProductWriteService.initTierVariation({
      shopId: String(shop.shopId),
      body: tierPayload,
    });
  }

  const persistedItemId = await persistCreatedItem(shop, addResult, initTierResult);
  const sourceDraftId = toInteger(normalizedDraft?.draftId);
  if (sourceDraftId) {
    await markListingCloneDraftPublished({
      shopId: shop.id,
      draftId: sourceDraftId,
      publishedItemId: persistedItemId || itemId || null,
    });
  }

  return {
    itemId: persistedItemId || itemId || null,
    addResult,
    initTierResult,
  };
}

module.exports = {
  buildCloneDraft,
  getDraft,
  listDrafts,
  listCategoryTree,
  previewCategoryAttributes,
  removeDraft,
  saveDraft,
  uploadCloneImages,
  uploadCloneVideo,
  validateDraftLogistics,
  publishDraft,
  _test: {
    buildExtractionSummary,
    extractShopeeListingIds,
    findShopeeItemInMfeState,
    parseShopeeItemFromHtml,
    parseShopeePublicListing,
    parseMadeiraMadeiraListing,
    parseGenericProductListing,
    mergeWithCategoryAttributes,
    normalizePublishAttributes,
    enrichDraftAttributesForCategory,
    extractMercadoLivreItemId,
    stripClipFromDraft,
  },
};
