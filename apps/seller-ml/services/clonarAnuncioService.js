"use strict";

const fetch = require("node-fetch");
const db = require("../db/db");
const TokenService = require("./tokenService");

const ML_API_BASE = "https://api.mercadolibre.com";
const SHOPEE_IMAGE_CDN = "https://down-br.img.susercontent.com/file/";
const GTIN_EMPTY_TOKEN = "EMPTY_GTIN";
const EMPTY_GTIN_ATTRIBUTE_ID = "EMPTY_GTIN";
const PACKAGE_DIMENSION_ATTRIBUTE_IDS = new Set([
  "seller_package_height",
  "seller_package_width",
  "seller_package_length",
]);
const PACKAGE_WEIGHT_ATTRIBUTE_IDS = new Set(["seller_package_weight"]);
const ALWAYS_VISIBLE_CATEGORY_ATTRIBUTE_IDS = new Set([
  "seller_package_height",
  "seller_package_width",
  "seller_package_length",
  "seller_package_weight",
  "gtin",
  "ean",
]);
const KNOWN_SHIPPING_MODES = new Set(["me1", "me2", "custom", "not_specified"]);

class CloneDraftError extends Error {
  constructor(message, status = 400, code = "clone_draft_error", details = null) {
    super(message);
    this.name = "CloneDraftError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function normalizeAccountKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (raw.toLowerCase() === "default") return null;
  return raw;
}

function normalizeItemId(value) {
  const text = String(value || "")
    .trim()
    .toUpperCase();
  if (!text) return null;

  const direct = text.match(/\b(M[A-Z]{2})[-_ ]?(\d{6,})\b/);
  if (!direct) return null;
  return `${direct[1]}${direct[2]}`;
}

function extractItemIdFromQueryParams(parsedUrl) {
  if (!parsedUrl || !parsedUrl.searchParams) return null;

  const directKeys = ["item_id", "itemId", "item"];
  for (const key of directKeys) {
    const directValue = parsedUrl.searchParams.get(key);
    const normalizedDirect = normalizeItemId(directValue);
    if (normalizedDirect) return normalizedDirect;
  }

  const params = Array.from(parsedUrl.searchParams.entries());
  for (const [, rawValue] of params) {
    const value = String(rawValue || "");
    if (!value) continue;

    const taggedMatch = value.match(
      /\bitem_id\s*[:=]\s*(M[A-Z]{2}[-_ ]?\d{6,})\b/i,
    );
    if (taggedMatch) {
      const normalizedTagged = normalizeItemId(taggedMatch[1]);
      if (normalizedTagged) return normalizedTagged;
    }

    const normalizedGeneric = normalizeItemId(value);
    if (normalizedGeneric) return normalizedGeneric;
  }

  return null;
}

function extractItemIdFromHash(parsedUrl) {
  if (!parsedUrl) return null;
  const rawHash = String(parsedUrl.hash || "")
    .replace(/^#/, "")
    .trim();
  if (!rawHash) return null;

  const normalizedFromHash = normalizeItemId(rawHash);
  if (normalizedFromHash) return normalizedFromHash;

  try {
    const params = new URLSearchParams(rawHash);
    const directKeys = ["item_id", "itemId", "item", "wid"];
    for (const key of directKeys) {
      const value = params.get(key);
      const normalized = normalizeItemId(value);
      if (normalized) return normalized;
    }

    for (const [, value] of params.entries()) {
      const normalized = normalizeItemId(value);
      if (normalized) return normalized;
    }
  } catch {
    // fallback below via regex
  }

  const regexMatch = rawHash.match(/\b(M[A-Z]{2})[-_ ]?(\d{6,})\b/i);
  if (regexMatch) {
    return `${String(regexMatch[1]).toUpperCase()}${regexMatch[2]}`;
  }

  return null;
}

function extractItemIdFromSource(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw new CloneDraftError(
      "Informe a URL ou o codigo do anuncio para continuar.",
      400,
      "source_required",
    );
  }

  let parsedUrl = null;
  try {
    parsedUrl = new URL(raw);
  } catch {
    const taggedMatch = raw.match(
      /\bitem_id\s*[:=]\s*(M[A-Z]{2})[-_ ]?(\d{6,})\b/i,
    );
    if (taggedMatch) return `${String(taggedMatch[1]).toUpperCase()}${taggedMatch[2]}`;

    const textMatch = raw.match(/\b(M[A-Z]{2})[-_ ]?(\d{6,})\b/i);
    if (textMatch) return `${String(textMatch[1]).toUpperCase()}${textMatch[2]}`;
    throw new CloneDraftError(
      "Nao foi possivel identificar o codigo do anuncio nessa URL.",
      400,
      "source_invalid",
    );
  }

  const itemFromQuery = extractItemIdFromQueryParams(parsedUrl);
  if (itemFromQuery) return itemFromQuery;

  const itemFromHash = extractItemIdFromHash(parsedUrl);
  if (itemFromHash) return itemFromHash;

  const candidates = [
    parsedUrl.pathname || "",
    parsedUrl.search || "",
    parsedUrl.hash || "",
    decodeURIComponent(parsedUrl.pathname || ""),
    decodeURIComponent(parsedUrl.search || ""),
    decodeURIComponent(parsedUrl.hash || ""),
  ];

  for (const candidate of candidates) {
    const match = String(candidate || "").match(/\b(M[A-Z]{2})[-_ ]?(\d{6,})\b/i);
    if (match) return `${String(match[1]).toUpperCase()}${match[2]}`;
  }

  throw new CloneDraftError(
    "Nao foi possivel identificar o item a partir da URL informada.",
    400,
    "item_id_not_found",
  );
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function removeHashFromUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return String(value || "").trim();
  }
}

function extractMetaContent(html, key) {
  const escaped = String(key || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return "";
  const source = String(html || "");
  const patterns = [
    new RegExp(
      `<meta[^>]+property=["']${escaped}["'][^>]+content=["']([\\s\\S]*?)["'][^>]*>`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([\\s\\S]*?)["'][^>]+property=["']${escaped}["'][^>]*>`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+name=["']${escaped}["'][^>]+content=["']([\\s\\S]*?)["'][^>]*>`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([\\s\\S]*?)["'][^>]+name=["']${escaped}["'][^>]*>`,
      "i",
    ),
  ];
  for (const pattern of patterns) {
    const value = firstRegexGroup(source, pattern);
    if (value) return decodeBasicHtmlEntities(value);
  }
  return "";
}

function extractCanonicalUrlFromHtml(html) {
  return (
    firstRegexGroup(
      html,
      /<link[^>]+rel=["']canonical["'][^>]+href=["']([\s\S]*?)["'][^>]*>/i,
    ) ||
    firstRegexGroup(
      html,
      /<link[^>]+href=["']([\s\S]*?)["'][^>]+rel=["']canonical["'][^>]*>/i,
    ) ||
    ""
  );
}

function extractShopeeIdsFromUrl(value) {
  const url = String(value || "").trim();
  if (!url) return { itemId: null, shopId: null };
  const directMatch = url.match(/-i\.(\d+)\.(\d+)/i);
  if (directMatch) {
    return {
      shopId: String(directMatch[1] || "").trim() || null,
      itemId: String(directMatch[2] || "").trim() || null,
    };
  }

  const fallbackMatch = url.match(/\bitemid=(\d+)\b/i);
  return {
    shopId: null,
    itemId: fallbackMatch ? String(fallbackMatch[1] || "").trim() || null : null,
  };
}

function parseSourceReference(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw new CloneDraftError(
      "Informe a URL ou o codigo do anuncio para continuar.",
      400,
      "source_required",
    );
  }

  if (isHttpUrl(raw)) {
    const normalizedUrl = removeHashFromUrl(raw);
    const hostname = String(new URL(normalizedUrl).hostname || "").toLowerCase();
    if (hostname.includes("shopee.")) {
      const ids = extractShopeeIdsFromUrl(normalizedUrl);
      return {
        platform: "shopee",
        sourceUrl: normalizedUrl,
        itemId: ids.itemId,
        shopId: ids.shopId,
      };
    }

    return {
      platform: "mercadolivre",
      sourceUrl: normalizedUrl,
      itemId: extractItemIdFromSource(raw),
      shopId: null,
    };
  }

  return {
    platform: "mercadolivre",
    sourceUrl: raw,
    itemId: extractItemIdFromSource(raw),
    shopId: null,
  };
}

function buildPublicItemUrls(itemId, source) {
  const rawSource = String(source || "").trim();
  const normalized = String(itemId || "").trim().toUpperCase();
  const candidates = [];

  if (isHttpUrl(rawSource)) {
    candidates.push(removeHashFromUrl(rawSource));
  }

  if (!normalized) {
    return Array.from(new Set(candidates));
  }

  const site = normalized.slice(0, 3);
  const hostBySite = {
    MLB: "produto.mercadolivre.com.br",
    MLA: "articulo.mercadolibre.com.ar",
    MLM: "articulo.mercadolibre.com.mx",
    MLC: "articulo.mercadolibre.cl",
    MCO: "articulo.mercadolibre.com.co",
    MLU: "articulo.mercadolibre.com.uy",
    MPE: "articulo.mercadolibre.com.pe",
  };
  const host = hostBySite[site] || "produto.mercadolivre.com.br";
  const hosts = site === "MLB" ? [host, "www.mercadolivre.com.br"] : [host];
  const split = normalized.match(/^(M[A-Z]{2})(\d{6,})$/);
  const permalinkId = split ? `${split[1]}-${split[2]}` : normalized;

  for (const currentHost of hosts) {
    candidates.push(`https://${currentHost}/${permalinkId}`);
    if (permalinkId !== normalized) {
      candidates.push(`https://${currentHost}/${normalized}`);
    }
    if (split) {
      candidates.push(`https://${currentHost}/${permalinkId}-_JM`);
    }
    candidates.push(`https://${currentHost}/p/${normalized}`);
  }

  return Array.from(new Set(candidates));
}

function firstRegexGroup(text, regex) {
  const match = String(text || "").match(regex);
  if (!match || match[1] == null) return null;
  const out = String(match[1]).trim();
  return out || null;
}

function stripHtmlTags(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeBasicHtmlEntities(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function decodeNumericHtmlEntities(text) {
  return String(text || "")
    .replace(/&#(\d+);/g, (_, decimal) => {
      const code = Number(decimal);
      if (!Number.isFinite(code) || code <= 0) return "";
      try {
        return String.fromCodePoint(code);
      } catch {
        return "";
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      if (!Number.isFinite(code) || code <= 0) return "";
      try {
        return String.fromCodePoint(code);
      } catch {
        return "";
      }
    });
}

function decodeJsEscapes(text) {
  return String(text || "")
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\x([0-9a-f]{2})/gi, (_, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
}

function fixUtf8Mojibake(text) {
  const raw = String(text || "");
  if (!raw) return raw;
  if (!/[ÃÂÐÑ]/.test(raw)) return raw;
  try {
    return Buffer.from(raw, "latin1").toString("utf8");
  } catch {
    return raw;
  }
}

function normalizeExtractedText(value) {
  let out = String(value == null ? "" : value).trim();
  if (!out) return "";

  out = decodeJsEscapes(out);
  out = decodeNumericHtmlEntities(decodeBasicHtmlEntities(out));

  // Alguns blocos de JSON chegam com entidades em cascata (ex.: &amp;#39;).
  if (/[&]#\d+;|[&]#x[0-9a-f]+;|&amp;/i.test(out)) {
    out = decodeNumericHtmlEntities(decodeBasicHtmlEntities(out));
  }

  out = fixUtf8Mojibake(out);
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

function isSuspiciousAttributeText(value) {
  const text = normalizeExtractedText(value);
  if (!text) return false;
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 4) return false;

  const weirdChars = (compact.match(/[^0-9a-zA-Z\u00C0-\u024F.,'"%\-()/+]/g) || []).length;
  const noisyChars = (compact.match(/[&#?]/g) || []).length;
  const weirdRatio = weirdChars / compact.length;

  return weirdRatio >= 0.18 || noisyChars >= 3;
}

function parseShopeeItemFromHtml(html) {
  const scripts = String(html || "").match(
    /<script[^>]*type="text\/mfe-initial-data"[^>]*>[\s\S]*?<\/script>/gi,
  );
  if (!Array.isArray(scripts) || !scripts.length) return null;

  const walk = (value) => {
    if (!value || typeof value !== "object") return null;
    if (
      value.item &&
      typeof value.item === "object" &&
      (value.item.name ||
        Array.isArray(value.item.images) ||
        Array.isArray(value.item.attributes))
    ) {
      return value.item;
    }

    const entries = Array.isArray(value) ? value : Object.values(value);
    for (const entry of entries) {
      const found = walk(entry);
      if (found) return found;
    }
    return null;
  };

  for (const script of scripts) {
    const jsonText = firstRegexGroup(
      script,
      /<script[^>]*type="text\/mfe-initial-data"[^>]*>([\s\S]*?)<\/script>/i,
    );
    const parsed = parseJsonColumn(jsonText, null);
    const found = walk(parsed);
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
  const raw = String(value || "")
    .trim()
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/");
  if (!raw) return null;
  if (!/^https?:\/\/(?:http2\.)?mlstatic\.com\//i.test(raw)) return null;

  const noQuery = raw.split("?")[0].split("#")[0];
  if (!/\/D_[^/]+\.(?:webp|jpe?g|png|avif)$/i.test(noQuery)) return null;
  return noQuery;
}

function mlImageDedupeKey(url) {
  const normalized = String(url || "").trim();
  if (!normalized) return "";
  const canonical = normalized.split("?")[0].split("#")[0];
  const tokenMatch = canonical.match(
    /-(ML[A-Z]?\d{6,}_[0-9]{6})(?:-[A-Z])?\.(?:webp|jpe?g|png|avif)$/i,
  );
  if (tokenMatch) return String(tokenMatch[1] || "").toUpperCase();
  return canonical.toLowerCase();
}

function dedupeMlImageUrls(urls, limit = 10) {
  const out = [];
  const seen = new Set();
  const list = Array.isArray(urls) ? urls : [];
  for (const value of list) {
    const raw = String(value || "").trim();
    if (!raw || !/^https?:\/\//i.test(raw)) continue;

    const normalizedMl = normalizeMlImageUrl(raw);
    const normalized = normalizedMl || raw.split("?")[0].split("#")[0];
    const key = normalizedMl ? mlImageDedupeKey(normalizedMl) : normalized.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= Math.max(1, Math.floor(Number(limit) || 10))) break;
  }
  return out;
}

function extractMlImageUrlsFromHtml(html) {
  const source = String(html || "");
  if (!source.trim()) return [];

  const urls = [];
  const add = (value) => {
    const normalized = normalizeMlImageUrl(value);
    if (!normalized) return;
    urls.push(normalized);
  };

  const pictureBlocks = source.match(/"pictures"\s*:\s*\[[\s\S]{0,60000}?\]/gi) || [];
  for (const block of pictureBlocks) {
    let pictureField = null;
    const pictureFieldRegex =
      /"(?:secure_url|url|source)"\s*:\s*"([^"]+\.(?:webp|jpe?g|png|avif)[^"]*)"/gi;
    while ((pictureField = pictureFieldRegex.exec(block)) !== null) {
      add(pictureField[1]);
    }
  }

  let globalUrlMatch = null;
  const globalUrlRegex =
    /https?:\\?\/\\?(?:http2\\?\.)?mlstatic\.com\\?\/D_[^"'\\\s<>]+?\.(?:webp|jpe?g|png|avif)(?:\?[^"'\\\s<>]*)?/gi;
  while ((globalUrlMatch = globalUrlRegex.exec(source)) !== null) {
    add(globalUrlMatch[0]);
  }

  return dedupeMlImageUrls(urls, 15);
}

function extractJsonObjectAfterMarker(scriptText, marker) {
  const source = String(scriptText || "");
  const token = String(marker || "").trim();
  if (!source || !token) return null;

  const markerIndex = source.indexOf(token);
  if (markerIndex < 0) return null;
  const objectStart = source.indexOf("{", markerIndex + token.length);
  if (objectStart < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = objectStart; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(objectStart, i + 1);
      }
    }
  }

  return null;
}

function extractJsonValueAt(sourceText, startIndex) {
  const source = String(sourceText || "");
  let start = Number(startIndex);
  if (!Number.isFinite(start) || start < 0) return null;
  while (start < source.length && /\s|=/.test(source[start])) start += 1;
  if (source[start] !== "{" && source[start] !== "[") return null;

  const open = source[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) {
      depth += 1;
      continue;
    }
    if (ch === close) {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }

  return null;
}

function extractScriptContents(html) {
  const out = [];
  const regex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match = null;
  while ((match = regex.exec(String(html || ""))) !== null) {
    const text = decodeBasicHtmlEntities(String(match[1] || "").trim());
    if (text) out.push(text);
  }
  return out;
}

function extractEmbeddedJsonObjects(html) {
  const objects = [];
  const pushParsed = (raw) => {
    const parsed = parseJsonColumn(raw, null);
    if (parsed && typeof parsed === "object") objects.push(parsed);
  };

  for (const script of extractScriptContents(html)) {
    const trimmed = script.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      pushParsed(trimmed);
    }

    const markers = [
      "_n.ctx.r=",
      "window.__PRELOADED_STATE__",
      "__PRELOADED_STATE__",
      "window.__INITIAL_STATE__",
      "__INITIAL_STATE__",
      "window.__APOLLO_STATE__",
      "__APOLLO_STATE__",
      "window.__NUXT__",
      "__NUXT__",
    ];
    for (const marker of markers) {
      const raw = extractJsonObjectAfterMarker(script, marker);
      if (raw) pushParsed(raw);
    }

    const assignmentRegex =
      /(?:window\.)?(?:__)?[A-Z0-9_]*(?:STATE|DATA|PROPS|CONTEXT)[A-Z0-9_]*(?:__)?\s*=/gi;
    let match = null;
    while ((match = assignmentRegex.exec(script)) !== null) {
      const raw = extractJsonValueAt(script, assignmentRegex.lastIndex);
      if (raw) pushParsed(raw);
    }
  }

  return objects;
}

function extractNordicRenderingContext(html) {
  const scriptText = firstRegexGroup(
    html,
    /<script[^>]*id=["']__NORDIC_RENDERING_CTX__["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!scriptText) return null;

  const jsonText = extractJsonObjectAfterMarker(scriptText, "_n.ctx.r=");
  const parsed = parseJsonColumn(jsonText, null);
  if (!parsed || typeof parsed !== "object") return null;

  const initialState = parsed?.appProps?.pageProps?.initialState;
  if (!initialState || typeof initialState !== "object") return null;

  return {
    root: parsed,
    initialState,
  };
}

function renderMlImageTemplate(template, pictureId) {
  const tpl = String(template || "").trim();
  const id = String(pictureId || "").trim();
  if (!tpl || !id) return null;

  const rendered = tpl
    .replace(/\{id\}/g, id)
    .replace(/\{sanitizedTitle\}/g, "")
    .replace(/\{[^}]+\}/g, "");
  return normalizeMlImageUrl(rendered);
}

function buildMlImageUrlsFromNordicGallery(gallery) {
  const pictures = Array.isArray(gallery?.pictures) ? gallery.pictures : [];
  const config = gallery?.picture_config || {};
  const templates = [
    config?.template_zoom,
    config?.template,
    config?.template_2x,
    config?.template_thumbnail,
    ...(Array.isArray(config?.template_variants)
      ? config.template_variants.map((entry) => entry?.template)
      : []),
  ].filter((entry) => !!String(entry || "").trim());

  const urls = [];
  const add = (value) => {
    const normalized = normalizeMlImageUrl(value);
    if (!normalized) return;
    urls.push(normalized);
  };

  for (const picture of pictures) {
    add(picture?.url?.src || picture?.url || picture?.src || "");
    const id = String(picture?.id || "").trim();
    if (!id) continue;

    for (const template of templates) {
      const rendered = renderMlImageTemplate(template, id);
      if (rendered) add(rendered);
    }
    add(`https://http2.mlstatic.com/D_NQ_NP_${id}-O.webp`);
  }

  return dedupeMlImageUrls(urls, 12);
}

function inferSpecsSectionKey(title) {
  const normalized = normalizeTextForMatch(title);
  if (normalized.includes("principal")) return "main";
  return "secondary";
}

function extractSpecsFromNordicState(initialState) {
  const components = initialState?.components || {};
  const grouped = [];
  const seen = new Set();

  const pushSectionRows = (sectionTitle, rowsInput, sectionKey = null) => {
    const rows = [];
    for (const entry of Array.isArray(rowsInput) ? rowsInput : []) {
      const label = normalizeExtractedText(
        entry?.id || entry?.name || entry?.label || "",
      );
      const value = normalizeExtractedText(
        entry?.text || entry?.value || entry?.value_name || "",
      );
      if (!label || !value) continue;

      const key = `${normalizeTextForMatch(label)}::${normalizeTextForMatch(value)}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rows.push({ label, value });
    }

    if (!rows.length) return;
    const title = normalizeExtractedText(sectionTitle || "Caracteristicas");
    grouped.push({
      section_name: title || "Caracteristicas",
      section_key: sectionKey || inferSpecsSectionKey(title),
      rows,
    });
  };

  const highlightedSpecs = components?.highlighted_specs_attrs;
  for (const block of Array.isArray(highlightedSpecs?.components)
    ? highlightedSpecs.components
    : []) {
    for (const section of Array.isArray(block?.specs) ? block.specs : []) {
      pushSectionRows(
        section?.title || block?.title || "Caracteristicas",
        section?.attributes,
        inferSpecsSectionKey(section?.title || ""),
      );
    }
  }

  const technicalSpecs = components?.technical_specifications;
  for (const section of Array.isArray(technicalSpecs?.specs) ? technicalSpecs.specs : []) {
    pushSectionRows(section?.title || "Caracteristicas", section?.attributes);
  }

  return grouped;
}

function extractMlPreviewFromNordicContext(html) {
  const context = extractNordicRenderingContext(html);
  if (!context) return null;

  const root = context.root || {};
  const initialState = context.initialState || {};
  const components = initialState?.components || {};
  const eventData = components?.track?.melidata_event?.event_data || {};

  const rawTitle = normalizeExtractedText(root?.title || "");
  const title = rawTitle.replace(/\s*\|\s*MercadoLivre.*$/i, "").trim();
  const description = normalizeExtractedText(
    components?.description?.content ||
      components?.item_status_short_description_message?.text ||
      "",
  );

  const images = buildMlImageUrlsFromNordicGallery(components?.gallery);
  const specsBlocks = extractSpecsFromNordicState(initialState);
  const priceFromPriceComponent = toNumberOrNull(components?.price?.price?.value);
  const categoryPath = (Array.isArray(components?.breadcrumb?.categories)
    ? components.breadcrumb.categories
        .map((entry) => normalizeExtractedText(entry?.label?.text || ""))
        .filter(Boolean)
    : [])
    .join(" > ");

  return {
    item_id: normalizeItemId(
      eventData?.item_id || components?.share?.item_id || "",
    ),
    title: title || null,
    description: description || null,
    price:
      priceFromPriceComponent != null
        ? priceFromPriceComponent
        : toNumberOrNull(eventData?.price),
    currency_id:
      String(
        components?.price?.price?.currency_id || eventData?.currency_id || "",
      )
        .trim()
        .toUpperCase() || null,
    category_id: String(eventData?.category_id || "").trim().toUpperCase() || null,
    listing_type_id:
      String(eventData?.listing_type_id || "")
        .trim()
        .toLowerCase() || null,
    condition: String(eventData?.item_condition || "").trim().toLowerCase() || null,
    seller_id: toNumberOrNull(eventData?.seller_id),
    seller_nickname: normalizeExtractedText(
      eventData?.seller_name || components?.seller_data?.name || "",
    ) || null,
    source_permalink:
      String(
        components?.share?.permalink ||
          components?.canonical?.url ||
          "",
      ).trim() || null,
    category_path: categoryPath || null,
    specs_blocks: specsBlocks,
    images,
  };
}

function pickTextField(object, keys) {
  if (!object || typeof object !== "object") return "";
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === "string" || typeof value === "number") {
      const text = normalizeExtractedText(value);
      if (text) return text;
    }
    if (value && typeof value === "object") {
      const nested = pickTextField(value, ["text", "label", "name", "value"]);
      if (nested) return nested;
    }
  }
  return "";
}

function pickNumberField(object, keys) {
  if (!object || typeof object !== "object") return null;
  for (const key of keys) {
    const value = object?.[key];
    const direct = toNumberOrNull(value);
    if (Number.isFinite(direct)) return direct;
    if (value && typeof value === "object") {
      const nested = pickNumberField(value, ["value", "amount", "price"]);
      if (Number.isFinite(nested)) return nested;
    }
  }
  return null;
}

function extractImageUrlsFromUnknown(value, out = []) {
  if (!value) return out;
  if (typeof value === "string") {
    const normalized = normalizeMlImageUrl(value);
    if (normalized) out.push(normalized);
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) extractImageUrlsFromUnknown(entry, out);
    return out;
  }
  if (typeof value !== "object") return out;
  for (const key of ["secure_url", "url", "src", "source", "thumbnail", "image"]) {
    extractImageUrlsFromUnknown(value?.[key], out);
  }
  return out;
}

function extractSpecRowsFromUnknown(value, out = [], seen = new Set(), depth = 0) {
  if (!value || depth > 6) return out;
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 250)) {
      extractSpecRowsFromUnknown(entry, out, seen, depth + 1);
    }
    return out;
  }
  if (typeof value !== "object") return out;

  const label = pickTextField(value, ["id", "name", "label", "title"]);
  const val = pickTextField(value, ["value_name", "value", "text", "display_value"]);
  if (label && val && normalizeTextForMatch(label) !== normalizeTextForMatch(val)) {
    const key = `${normalizeTextForMatch(label)}::${normalizeTextForMatch(val)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ label, value: val });
    }
  }

  for (const key of [
    "attributes",
    "specs",
    "specifications",
    "technical_specifications",
    "highlighted_specs",
    "components",
  ]) {
    extractSpecRowsFromUnknown(value?.[key], out, seen, depth + 1);
  }
  return out;
}

function extractMlPreviewFromEmbeddedJson(html, itemId = null) {
  const objects = extractEmbeddedJsonObjects(html);
  const normalizedItemId = normalizeItemId(itemId);
  const candidates = [];
  const visited = new Set();

  const scoreObject = (object) => {
    if (!object || typeof object !== "object") return 0;
    let score = 0;
    const objectId = normalizeItemId(
      object?.id || object?.item_id || object?.itemId || object?.itemIdValue,
    );
    if (normalizedItemId && objectId === normalizedItemId) score += 80;
    if (pickTextField(object, ["title", "name"])) score += 15;
    if (Number.isFinite(pickNumberField(object, ["price", "amount"]))) score += 15;
    if (pickTextField(object, ["category_id", "categoryId", "cat_id"])) score += 10;
    if (extractImageUrlsFromUnknown(object?.pictures || object?.images || object?.gallery).length) score += 10;
    if (pickTextField(object, ["description", "plain_text"])) score += 8;
    return score;
  };

  const walk = (value, depth = 0) => {
    if (!value || depth > 8) return;
    if (Array.isArray(value)) {
      for (const entry of value.slice(0, 350)) walk(entry, depth + 1);
      return;
    }
    if (typeof value !== "object" || visited.has(value)) return;
    visited.add(value);

    const score = scoreObject(value);
    if (score >= 25) candidates.push({ score, value });
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === "object") walk(nested, depth + 1);
    }
  };

  for (const object of objects) walk(object);
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0]?.value || null;
  if (!best) return null;

  const rows = extractSpecRowsFromUnknown(best);
  const images = dedupeMlImageUrls(
    extractImageUrlsFromUnknown(best?.pictures || best?.images || best?.gallery || best),
    12,
  );
  const categoryPath = Array.isArray(best?.breadcrumb?.categories)
    ? best.breadcrumb.categories
        .map((entry) => pickTextField(entry, ["label", "name", "text"]))
        .filter(Boolean)
        .join(" > ")
    : "";

  return {
    item_id: normalizeItemId(
      best?.id || best?.item_id || best?.itemId || normalizedItemId || "",
    ),
    title: pickTextField(best, ["title", "name"]),
    description: pickTextField(best, ["description", "plain_text", "content"]),
    price: pickNumberField(best, ["price", "amount", "value"]),
    currency_id:
      pickTextField(best, ["currency_id", "currencyId", "currency"]) || null,
    category_id:
      pickTextField(best, ["category_id", "categoryId", "cat_id"]).toUpperCase() ||
      String(best?.category?.id || "").trim().toUpperCase() ||
      "",
    listing_type_id: pickTextField(best, ["listing_type_id", "listingTypeId"]).toLowerCase(),
    condition: pickTextField(best, ["condition", "item_condition"]).toLowerCase(),
    seller_id: toNumberOrNull(best?.seller_id || best?.sellerId || best?.seller?.id),
    seller_nickname: pickTextField(best?.seller || best, ["nickname", "name", "seller_name"]),
    source_permalink: pickTextField(best, ["permalink", "url", "canonical_url"]),
    category_path: categoryPath,
    specs_blocks: rows.length
      ? [
          {
            section_name: "Caracteristicas da origem",
            section_key: "secondary",
            rows,
          },
        ]
      : [],
    images,
  };
}

function parseShopeePrice(value) {
  const parsed = toNumberOrNull(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed > 100000) return Number((parsed / 100000).toFixed(2));
  return parsed;
}

function buildShopeeFallbackSpecs(item) {
  return (Array.isArray(item?.attributes) ? item.attributes : [])
    .map((attribute) => {
      const label = String(attribute?.name || "").trim();
      const value = String(attribute?.value || "").trim();
      if (!label || !value) return null;
      return { label, value };
    })
    .filter(Boolean);
}

function extractJsonLdObjects(html) {
  const out = [];
  const regex =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match = null;
  while ((match = regex.exec(String(html || ""))) !== null) {
    const raw = String(match[1] || "").trim();
    if (!raw) continue;
    const parsed = parseJsonColumn(raw, null);
    if (parsed == null) continue;

    const pushObj = (value) => {
      if (!value || typeof value !== "object") return;
      out.push(value);
      if (Array.isArray(value?.["@graph"])) {
        for (const g of value["@graph"]) {
          if (g && typeof g === "object") out.push(g);
        }
      }
    };

    if (Array.isArray(parsed)) {
      for (const entry of parsed) pushObj(entry);
    } else {
      pushObj(parsed);
    }
  }
  return out;
}

function pickProductFromJsonLd(list) {
  const items = Array.isArray(list) ? list : [];
  for (const entry of items) {
    const type = entry?.["@type"];
    if (typeof type === "string" && type.toLowerCase() === "product") {
      return entry;
    }
    if (Array.isArray(type)) {
      const hasProduct = type.some(
        (t) => String(t || "").toLowerCase() === "product",
      );
      if (hasProduct) return entry;
    }
  }
  return null;
}

function normalizeTextForMatch(value) {
  return normalizeExtractedText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeShippingMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (!mode) return null;
  return KNOWN_SHIPPING_MODES.has(mode) ? mode : null;
}

function cleanZip(value) {
  const normalized = String(value || "").replace(/\D+/g, "");
  if (normalized.length !== 8) return null;
  return normalized;
}

function buildMlErrorText(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload.toLowerCase();
  const causes = Array.isArray(payload?.cause) ? payload.cause : [];
  const text = [
    payload?.message,
    payload?.error,
    payload?.code,
    ...causes.map((entry) => entry?.message),
    ...causes.map((entry) => entry?.code),
    ...causes.flatMap((entry) =>
      Array.isArray(entry?.references) ? entry.references : [],
    ),
  ]
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .join(" ");
  return text.toLowerCase();
}

function collectShippingOptionRows(payload) {
  const rows = [];
  const push = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach((item) => push(item));
      return;
    }
    if (typeof value === "object") rows.push(value);
  };

  push(payload);
  push(payload?.options);
  push(payload?.shipping_options);
  push(payload?.available_shipping_options);
  push(payload?.coverage);
  push(payload?.coverage?.all_country);
  push(payload?.coverage?.country);
  push(payload?.coverage?.same_city);

  return rows;
}

function pickPreferredNumeric(values = [], { preferPositive = false } = {}) {
  const nums = (Array.isArray(values) ? values : [])
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry) && entry >= 0);
  if (!nums.length) return null;
  if (!preferPositive) return Math.min(...nums);
  const positive = nums.filter((entry) => entry > 0);
  if (positive.length) return Math.min(...positive);
  return 0;
}

function extractShippingCostSnapshot(payload, fallbackFreeShipping = null) {
  const rows = collectShippingOptionRows(payload);
  const sellerCandidates = [];
  const buyerCandidates = [];
  let freeShipping =
    typeof fallbackFreeShipping === "boolean" ? fallbackFreeShipping : null;

  for (const row of rows) {
    if (row?.free_shipping != null) {
      freeShipping = !!row.free_shipping;
    }

    sellerCandidates.push(
      row?.seller_cost,
      row?.seller_shipping_cost,
      row?.sender_cost,
      row?.list_cost,
      row?.base_cost,
      row?.coverage?.all_country?.list_cost,
      row?.coverage?.all_country?.cost,
      row?.coverage?.country?.list_cost,
      row?.coverage?.country?.cost,
      row?.coverage?.same_city?.list_cost,
      row?.coverage?.same_city?.cost,
    );
    buyerCandidates.push(
      row?.buyer_cost,
      row?.cost,
      row?.receiver_cost,
      row?.final_cost,
      row?.amount,
      row?.coverage?.all_country?.cost,
      row?.coverage?.country?.cost,
      row?.coverage?.same_city?.cost,
    );
  }

  const sellerCost = pickPreferredNumeric(sellerCandidates, {
    preferPositive: true,
  });
  const buyerCost = pickPreferredNumeric(buyerCandidates, {
    preferPositive: false,
  });

  return {
    seller_cost: Number.isFinite(sellerCost) ? sellerCost : null,
    buyer_cost: Number.isFinite(buyerCost) ? buyerCost : null,
    free_shipping:
      typeof freeShipping === "boolean" ? freeShipping : fallbackFreeShipping,
  };
}

function getShippingModeLabel(mode) {
  const normalized = normalizeShippingMode(mode);
  if (normalized === "me2") return "Mercado Envios 2 (ME2)";
  if (normalized === "me1") return "Mercado Envios 1 (ME1)";
  if (normalized === "custom") return "Personalizado";
  if (normalized === "not_specified") return "Nao especificado";
  return normalized || "Automatico";
}

function normalizeAttributeIdForCompare(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function canonicalizeMlAttributeId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const normalized = normalizeAttributeIdForCompare(raw);
  if (normalized === "ean" || normalized === "ean13" || normalized === "ean_13") {
    return "GTIN";
  }
  return raw;
}

function isGtinAttributeId(value) {
  const normalized = normalizeAttributeIdForCompare(value);
  return normalized === "gtin" || normalized === "ean" || normalized === "ean13" || normalized === "ean_13";
}

function normalizeGtinValue(rawValue) {
  const text = normalizeExtractedText(rawValue || "");
  if (!text) return null;

  const normalized = normalizeTextForMatch(text).replace(/\s+/g, "_");
  if (normalized === "empty_gtin" || normalized === "sem_gtin" || normalized === "nao_possui_gtin") {
    return GTIN_EMPTY_TOKEN;
  }

  const digits = String(text).replace(/\D+/g, "");
  if (digits.length >= 8 && digits.length <= 14) {
    return digits;
  }

  return text;
}

function isEmptyGtinAttributeId(value) {
  const normalized = normalizeAttributeIdForCompare(value);
  return normalized === "empty_gtin";
}

function parseFlexibleNumber(rawValue) {
  let text = normalizeExtractedText(rawValue || "");
  if (!text) return null;
  text = text.replace(/\s+/g, "");
  if (!text) return null;

  text = text.replace(/[^0-9,.\-]/g, "");
  if (!text || !/[0-9]/.test(text)) return null;

  const hasComma = text.includes(",");
  const hasDot = text.includes(".");
  if (hasComma && hasDot) {
    if (text.lastIndexOf(",") > text.lastIndexOf(".")) {
      text = text.replace(/\./g, "").replace(",", ".");
    } else {
      text = text.replace(/,/g, "");
    }
  } else if (hasComma) {
    text = text.replace(",", ".");
  } else if (hasDot) {
    const dotCount = (text.match(/\./g) || []).length;
    if (dotCount > 1) {
      const parts = text.split(".");
      const decimal = parts.pop();
      text = `${parts.join("")}.${decimal}`;
    }
  }

  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractNumbersFromText(rawValue) {
  const text = normalizeExtractedText(rawValue || "");
  if (!text) return [];

  const byParts = text
    .split(/\s*[xX]\s*/g)
    .map((part) => parseFlexibleNumber(part))
    .filter((entry) => Number.isFinite(entry));
  if (byParts.length) return byParts;

  return (text.match(/-?\d+(?:[.,]\d+)?/g) || [])
    .map((part) => parseFlexibleNumber(part))
    .filter((entry) => Number.isFinite(entry));
}

function formatNumberWithUnit(value, unit, { integerOnly = false } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  if (integerOnly) {
    return `${Math.max(1, Math.round(numeric))} ${unit}`;
  }

  const rounded = Math.round(numeric * 1000) / 1000;
  const formatted = Number.isInteger(rounded)
    ? String(rounded)
    : String(rounded).replace(/\.?0+$/, "");
  return `${formatted} ${unit}`;
}

function pickDimensionValueByAttributeId(attributeId, values = []) {
  const list = Array.isArray(values) ? values.filter(Number.isFinite) : [];
  if (!list.length) return null;
  if (list.length === 1) return list[0];

  const normalized = normalizeAttributeIdForCompare(attributeId);
  if (normalized.includes("height")) return list[0];
  if (normalized.includes("width")) return list[Math.min(1, list.length - 1)];
  if (normalized.includes("depth") || normalized.includes("length")) {
    return list[Math.min(2, list.length - 1)];
  }
  return list[0];
}

function normalizeDimensionValueForMl(attributeId, rawValue, { integerOnly = false } = {}) {
  const text = normalizeExtractedText(rawValue || "");
  if (!text) return null;

  const numbers = extractNumbersFromText(text);
  if (!numbers.length) return text;

  const selected = pickDimensionValueByAttributeId(attributeId, numbers);
  return formatNumberWithUnit(selected, "cm", { integerOnly }) || text;
}

function normalizePackageWeightValueForMl(rawValue) {
  const text = normalizeExtractedText(rawValue || "");
  if (!text) return null;

  const numbers = extractNumbersFromText(text);
  if (!numbers.length) return text;

  let grams = numbers[0];
  const normalizedText = normalizeTextForMatch(text);
  if (/\bkg\b/i.test(text) || normalizedText.includes("quilo") || normalizedText.includes("kilograma")) {
    grams *= 1000;
  } else if (/\bmg\b/i.test(text)) {
    grams /= 1000;
  }

  return formatNumberWithUnit(grams, "g", { integerOnly: true }) || text;
}

function shouldNormalizeAsCentimeterDimension(attributeId) {
  const normalized = normalizeAttributeIdForCompare(attributeId);
  if (!normalized) return false;
  if (PACKAGE_DIMENSION_ATTRIBUTE_IDS.has(normalized)) return true;
  if (normalized === "height" || normalized === "width" || normalized === "depth" || normalized === "length") {
    return true;
  }
  return /_(height|width|depth|length)$/.test(normalized);
}

function normalizeEmptyGtinValue(rawValue) {
  const normalized = normalizeTextForMatch(rawValue || "").replace(/\s+/g, "_");
  if (!normalized) return "Sim";
  if (
    normalized === "sim" ||
    normalized === "yes" ||
    normalized === "true" ||
    normalized === "1" ||
    normalized === "empty_gtin" ||
    normalized === "sem_gtin" ||
    normalized === "nao_possui_gtin" ||
    normalized === "nao_possui_ean"
  ) {
    return "Sim";
  }
  if (
    normalized === "nao" ||
    normalized === "no" ||
    normalized === "false" ||
    normalized === "0"
  ) {
    return null;
  }
  return "Sim";
}

function normalizeAttributeEntryForMl({ id, valueId = null, valueName = null } = {}) {
  let normalizedId = canonicalizeMlAttributeId(id);
  let nextValueId =
    valueId != null && String(valueId).trim() ? String(valueId).trim() : null;
  let nextValueName =
    valueName != null && String(valueName).trim()
      ? normalizeExtractedText(valueName)
      : null;

  if (isGtinAttributeId(normalizedId)) {
    const normalizedGtin = normalizeGtinValue(nextValueName || nextValueId || "");
    if (!normalizedGtin) return null;
    if (normalizedGtin === GTIN_EMPTY_TOKEN) {
      return null;
    }
    return {
      id: "GTIN",
      valueId: null,
      valueName: normalizedGtin,
    };
  }

  if (isEmptyGtinAttributeId(normalizedId)) {
    const emptyGtinValue = normalizeEmptyGtinValue(nextValueName || nextValueId || "");
    if (!emptyGtinValue) return null;
    return {
      id: EMPTY_GTIN_ATTRIBUTE_ID,
      valueId: null,
      valueName: emptyGtinValue,
    };
  }

  const normalizedCompare = normalizeAttributeIdForCompare(normalizedId);
  if (PACKAGE_WEIGHT_ATTRIBUTE_IDS.has(normalizedCompare)) {
    const formatted = normalizePackageWeightValueForMl(nextValueName || nextValueId || "");
    if (formatted) {
      nextValueName = formatted;
      nextValueId = null;
    }
  } else if (PACKAGE_DIMENSION_ATTRIBUTE_IDS.has(normalizedCompare)) {
    const formatted = normalizeDimensionValueForMl(normalizedId, nextValueName || nextValueId || "", {
      integerOnly: true,
    });
    if (formatted) {
      nextValueName = formatted;
      nextValueId = null;
    }
  } else if (shouldNormalizeAsCentimeterDimension(normalizedId)) {
    const formatted = normalizeDimensionValueForMl(normalizedId, nextValueName || nextValueId || "", {
      integerOnly: false,
    });
    if (formatted) {
      nextValueName = formatted;
      nextValueId = null;
    }
  }

  return {
    id: normalizedId,
    valueId: nextValueId,
    valueName: nextValueName,
  };
}

function tokenizeForMatch(value) {
  const stopWords = new Set([
    "de",
    "do",
    "da",
    "dos",
    "das",
    "e",
    "em",
    "com",
    "sem",
    "para",
    "por",
    "ou",
    "a",
    "o",
    "as",
    "os",
  ]);
  return normalizeTextForMatch(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token && token.length >= 2 && !stopWords.has(token));
}

function attributeNameMatchScore(label, metaName) {
  const a = tokenizeForMatch(label);
  const b = tokenizeForMatch(metaName);
  if (!a.length || !b.length) return 0;

  const bSet = new Set(b);
  let common = 0;
  for (const token of a) {
    if (bSet.has(token)) common += 1;
  }

  if (!common) return 0;
  const coverageA = common / a.length;
  const coverageB = common / b.length;
  const base = Math.max(coverageA, coverageB);
  const full = coverageA === 1 || coverageB === 1 ? 0.08 : 0;
  return Math.min(1, base + full);
}

function conditionLabel(value) {
  const id = String(value || "").trim().toLowerCase();
  if (id === "new") return "Novo";
  if (id === "used") return "Usado";
  if (id === "not_specified") return "Nao especificado";
  return id || "Nao informado";
}

function listingTypeFriendlyLabel(value) {
  const id = String(value || "").trim().toLowerCase();
  if (id === "gold_special") return "Classico";
  if (id === "gold_pro") return "Premium";
  if (id === "free") return "Gratis";
  return id || "Nao informado";
}

function htmlToPlainText(value) {
  const prepared = String(value || "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ");
  const withoutTags = prepared.replace(/<[^>]+>/g, "");
  const decoded = normalizeExtractedText(withoutTags);
  return String(decoded)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractDescriptionFromHtml(html, fallback = "") {
  const direct =
    firstRegexGroup(
      html,
      /<p[^>]*class=["'][^"']*ui-pdp-description__content[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
    ) ||
    firstRegexGroup(
      html,
      /<div[^>]*class=["'][^"']*ui-pdp-description__content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    ) ||
    "";
  const fromDirect = htmlToPlainText(direct);
  if (fromDirect) return fromDirect;

  const fromMeta = normalizeExtractedText(
    htmlToPlainText(
      firstRegexGroup(
        html,
        /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i,
      ) || "",
    ),
  );
  if (fromMeta) return fromMeta;

  return String(fallback || "").trim();
}

function extractSpecsFromHtml(html) {
  const blocks = [];
  const seenPairs = new Set();
  const registerRow = (rows, label, value) => {
    const safeLabel = normalizeExtractedText(label);
    const safeValue = normalizeExtractedText(value);
    if (!safeLabel || !safeValue) return;
    const pairKey = `${normalizeTextForMatch(safeLabel)}::${normalizeTextForMatch(safeValue)}`;
    if (!pairKey || seenPairs.has(pairKey)) return;
    seenPairs.add(pairKey);
    rows.push({ label: safeLabel, value: safeValue });
  };

  const sectionRegex =
    /<h3[^>]*class=["'][^"']*ui-vpp-striped-specs__header[^"']*["'][^>]*>([\s\S]*?)<\/h3>\s*<table[^>]*>[\s\S]*?<tbody[^>]*>([\s\S]*?)<\/tbody>/gi;
  let sectionMatch = null;

  while ((sectionMatch = sectionRegex.exec(String(html || ""))) !== null) {
    const headerText = htmlToPlainText(sectionMatch[1] || "");
    const bodyHtml = String(sectionMatch[2] || "");
    const rows = [];

    const rowRegex =
      /<tr[^>]*ui-vpp-striped-specs__row[^>]*>[\s\S]*?<th[^>]*>([\s\S]*?)<\/th>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/gi;
    let rowMatch = null;
    while ((rowMatch = rowRegex.exec(bodyHtml)) !== null) {
      registerRow(rows, htmlToPlainText(rowMatch[1] || ""), htmlToPlainText(rowMatch[2] || ""));
    }

    if (!rows.length) continue;
    const normalizedHeader = normalizeTextForMatch(headerText);
    const isMain = normalizedHeader.includes("principal");
    blocks.push({
      section_name: headerText || (isMain ? "Caracteristicas principais" : "Outras caracteristicas"),
      section_key: isMain ? "main" : "secondary",
      rows,
    });
  }

  // Fallback complementar: pega linhas de qualquer tabela com th/td em blocos de ficha tecnica.
  const genericRows = [];
  const genericTableRowRegex = /<tr[^>]*>[\s\S]*?<th[^>]*>([\s\S]*?)<\/th>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/gi;
  let genericTableRowMatch = null;
  while ((genericTableRowMatch = genericTableRowRegex.exec(String(html || ""))) !== null) {
    registerRow(
      genericRows,
      htmlToPlainText(genericTableRowMatch[1] || ""),
      htmlToPlainText(genericTableRowMatch[2] || ""),
    );
  }

  // Alguns layouts usam listas <dt>/<dd> para especificacoes.
  const genericListRegex = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
  let genericListMatch = null;
  while ((genericListMatch = genericListRegex.exec(String(html || ""))) !== null) {
    registerRow(
      genericRows,
      htmlToPlainText(genericListMatch[1] || ""),
      htmlToPlainText(genericListMatch[2] || ""),
    );
  }

  if (genericRows.length) {
    blocks.push({
      section_name: "Caracteristicas detectadas",
      section_key: "secondary",
      rows: genericRows,
    });
  }

  return blocks;
}

function toMlAttributePayload(attribute) {
  const rawId = canonicalizeMlAttributeId(attribute?.id);
  if (!rawId) return null;
  const valueId =
    attribute?.value_id != null && String(attribute.value_id).trim()
      ? String(attribute.value_id).trim()
      : null;
  const valueName =
    attribute?.value_name != null && String(attribute.value_name).trim()
      ? normalizeExtractedText(attribute.value_name)
      : null;

  const normalized = normalizeAttributeEntryForMl({
    id: rawId,
    valueId,
    valueName,
  });
  if (!normalized) return null;
  if (!normalized.valueId && !normalized.valueName) return null;

  return {
    id: normalized.id,
    value_id: normalized.valueId || null,
    value_name: normalized.valueName || null,
  };
}

function toMlAttributesPayload(attributes) {
  const out = [];
  const list = Array.isArray(attributes) ? attributes : [];
  for (const attr of list) {
    const normalized = toMlAttributePayload(attr);
    if (!normalized) continue;
    out.push(normalized);
  }
  return out;
}

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseJsonColumn(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function normalizeCloneMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "variacoes") return "variacoes";
  if (mode === "unitario") return "unitario";
  return null;
}

function normalizeSpaces(value) {
  return String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value) {
  return String(value == null ? "" : value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clipTextByWords(value, maxLength) {
  const text = normalizeSpaces(value);
  if (!text) return null;
  const safeMax = Math.max(16, Math.floor(Number(maxLength) || 120));
  if (text.length <= safeMax) return text;
  let clipped = text.slice(0, safeMax).trim();
  const lastSpace = clipped.lastIndexOf(" ");
  if (lastSpace >= 20) clipped = clipped.slice(0, lastSpace).trim();
  return clipped || text.slice(0, safeMax).trim();
}

function extractVariationTokensForFamilyName(draft) {
  const out = new Set();
  const add = (value) => {
    const text = normalizeSpaces(value);
    if (!text || text.length < 2) return;
    if (/^\d+$/.test(text)) return;
    out.add(text);
  };

  const variationList = Array.isArray(draft?.variations) ? draft.variations : [];
  for (const variation of variationList) {
    const attrs = [
      ...(Array.isArray(variation?.attribute_combinations)
        ? variation.attribute_combinations
        : []),
      ...(Array.isArray(variation?.attributes) ? variation.attributes : []),
    ];
    for (const attr of attrs) {
      add(attr?.value_name || attr?.value_id);
    }
  }

  const likelyVariantIds = new Set([
    "COLOR",
    "SECONDARY_COLOR",
    "MAIN_COLOR",
    "SIZE",
    "SIZE_NAME",
    "TALLE",
    "TALLA",
    "VOLTAGE",
  ]);
  const itemAttrs = Array.isArray(draft?.attributes) ? draft.attributes : [];
  for (const attr of itemAttrs) {
    const id = String(attr?.id || "").trim().toUpperCase();
    if (!id || !likelyVariantIds.has(id)) continue;
    add(attr?.value_name || attr?.value_id);
  }

  return Array.from(out).sort((a, b) => b.length - a.length);
}

function cleanTitleForFamilyName(title, variationTokens = []) {
  let text = normalizeSpaces(title);
  if (!text) return text;

  text = text.replace(/\s*[\(\[][^)\]]*[\)\]]\s*/g, " ");
  text = text.replace(
    /\b(cor|color|cores|tamanho|tam|size)\s*[:\-]?\s*[a-z0-9\u00C0-\u024F/\-\s]{1,40}/gi,
    " ",
  );

  for (const token of variationTokens) {
    const escaped = escapeRegex(token);
    text = text.replace(
      new RegExp(`(?:\\s*[-|/:,;]\\s*|\\s+)${escaped}(?=\\s|$)`, "gi"),
      " ",
    );
  }

  text = text.replace(
    /\b(bege|branco|preto|cinza|marrom|azul|vermelho|verde|amarelo|rosa|roxo|lilas|laranja|dourado|prata|white|black|gray|grey|brown|blue|red|green|yellow|pink|purple|orange)\b/gi,
    " ",
  );

  text = text
    .replace(/[-|/:,;]+$/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return text;
}

function resolveFamilyNameFromDraft(draft) {
  const maxTitleRaw = Number(
    draft?.max_title_length ||
      draft?.category_max_title_length ||
      draft?.source_item_snapshot?.max_title_length ||
      120,
  );
  const maxLength = Number.isFinite(maxTitleRaw)
    ? Math.min(120, Math.max(16, Math.floor(maxTitleRaw)))
    : 120;

  const explicit = normalizeSpaces(draft?.family_name);
  if (explicit) return clipTextByWords(explicit, maxLength);

  const title = normalizeSpaces(draft?.title);
  const variationTokens = extractVariationTokensForFamilyName(draft);
  const cleaned = cleanTitleForFamilyName(title, variationTokens);
  const fallback = cleaned || title || variationTokens[0] || null;
  return clipTextByWords(fallback, maxLength);
}

function mergeAttributeLists(primaryList, extraList) {
  const byId = new Map();
  const append = (entry) => {
    const normalized = toMlAttributePayload(entry);
    if (!normalized) return;
    byId.set(normalized.id, normalized);
  };
  for (const entry of Array.isArray(extraList) ? extraList : []) append(entry);
  for (const entry of Array.isArray(primaryList) ? primaryList : []) append(entry);
  if (byId.has("GTIN")) {
    byId.delete(EMPTY_GTIN_ATTRIBUTE_ID);
  }
  return Array.from(byId.values());
}

function extractMlErrorSnapshot(responseData) {
  if (!responseData || typeof responseData !== "object") {
    return {
      message: "",
      error: "",
      causes: [],
    };
  }

  const message = String(responseData.message || "").trim().toLowerCase();
  const error = String(responseData.error || "").trim().toLowerCase();
  const causes = Array.isArray(responseData.cause) ? responseData.cause : [];
  return { message, error, causes };
}

function isTitleInvalidForRequestedCall(responseData) {
  const snapshot = extractMlErrorSnapshot(responseData);
  if (!snapshot.message.includes("body.invalid_fields")) return false;

  if (snapshot.error.includes("[title]") || snapshot.error.includes("title")) {
    return true;
  }

  for (const cause of snapshot.causes) {
    const code = String(cause?.code || "").toLowerCase();
    const msg = String(cause?.message || "").toLowerCase();
    const refs = Array.isArray(cause?.references)
      ? cause.references.map((ref) => String(ref || "").toLowerCase())
      : [];
    if (code.includes("title") || msg.includes("title")) return true;
    if (refs.some((ref) => ref.includes("title"))) return true;
  }

  return false;
}

function responseMentionsField(responseData, candidates = []) {
  const list = (Array.isArray(candidates) ? candidates : [])
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return false;

  const snapshot = extractMlErrorSnapshot(responseData);
  const containsField = (text) => {
    const normalized = String(text || "").trim().toLowerCase();
    if (!normalized) return false;
    return list.some((field) => normalized.includes(field));
  };

  if (containsField(snapshot.error) || containsField(snapshot.message)) {
    return true;
  }

  const bracketFields = String(snapshot.error || "")
    .match(/\[([^\]]+)\]/)?.[1]
    ?.split(",")
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter(Boolean) || [];
  if (bracketFields.some((field) => list.includes(field))) {
    return true;
  }

  for (const cause of snapshot.causes) {
    const code = String(cause?.code || "").toLowerCase();
    const msg = String(cause?.message || "").toLowerCase();
    const refs = Array.isArray(cause?.references)
      ? cause.references.map((ref) => String(ref || "").toLowerCase())
      : [];
    if (containsField(code) || containsField(msg)) return true;
    if (refs.some((ref) => containsField(ref))) return true;
  }

  return false;
}

function isWarningsOnlyMlValidationResponse(responseData) {
  if (!responseData || typeof responseData !== "object") return false;
  const causes = Array.isArray(responseData?.cause) ? responseData.cause : [];
  if (!causes.length) return false;

  let hasWarning = false;
  for (const cause of causes) {
    const type = String(cause?.type || "").trim().toLowerCase();
    if (!type) return false;
    if (type === "warning") {
      hasWarning = true;
      continue;
    }
    return false;
  }
  return hasWarning;
}

function collectUiAttributeIdsFromDraftPayload(draftPayload = {}) {
  const ids = new Set();
  const addId = (value) => {
    const normalized = canonicalizeMlAttributeId(value);
    if (!normalized) return;
    ids.add(normalizeAttributeIdForCompare(normalized));
  };

  const sources = [
    ...(Array.isArray(draftPayload?.attributes_main) ? draftPayload.attributes_main : []),
    ...(Array.isArray(draftPayload?.attributes_secondary)
      ? draftPayload.attributes_secondary
      : []),
  ];

  for (const entry of sources) {
    addId(entry?.id);
  }
  return ids;
}

function filterUnsupportedSyntheticAttributes(attributes = [], draftPayload = {}) {
  const list = Array.isArray(attributes) ? attributes : [];
  if (!list.length) return [];

  const supportedUiIds = collectUiAttributeIdsFromDraftPayload(draftPayload);
  const supportsEmptyGtin = supportedUiIds.has("empty_gtin");
  if (supportsEmptyGtin) return list;

  return list.filter((attr) => {
    const id = normalizeAttributeIdForCompare(attr?.id);
    if (id !== "empty_gtin") return true;
    return false;
  });
}

function sanitizeAttributes(attributes) {
  const out = [];
  const list = Array.isArray(attributes) ? attributes : [];

  for (const attr of list) {
    let id = canonicalizeMlAttributeId(attr?.id);
    if (!id) continue;

    const nameRaw =
      attr?.name != null && String(attr.name).trim()
        ? normalizeExtractedText(attr.name)
        : attr?.attribute_name != null && String(attr.attribute_name).trim()
          ? normalizeExtractedText(attr.attribute_name)
          : null;

    let valueId =
      attr?.value_id != null && String(attr.value_id).trim()
        ? String(attr.value_id).trim()
        : null;
    let valueName =
      attr?.value_name != null && String(attr.value_name).trim()
        ? normalizeExtractedText(attr.value_name)
        : null;

    if (!valueName && attr?.value_struct?.name != null) {
      const structName = normalizeExtractedText(attr.value_struct.name);
      if (structName) valueName = structName;
    }
    if (!valueName && attr?.value_struct?.number != null) {
      const structNumber = Number(attr.value_struct.number);
      const structUnit =
        attr.value_struct.unit != null && String(attr.value_struct.unit).trim()
          ? String(attr.value_struct.unit).trim()
          : "";
      if (Number.isFinite(structNumber)) {
        valueName = structUnit ? `${structNumber} ${structUnit}` : String(structNumber);
      }
    }

    if ((!valueId || !valueName) && Array.isArray(attr?.values) && attr.values.length) {
      const first = attr.values[0] || {};
      if (!valueId && first.id != null && String(first.id).trim()) {
        valueId = String(first.id).trim();
      }
      if (!valueName && first.name != null && String(first.name).trim()) {
        valueName = normalizeExtractedText(first.name);
      }
    }

    const normalized = normalizeAttributeEntryForMl({
      id,
      valueId,
      valueName,
    });
    if (!normalized) continue;
    id = normalized.id;
    valueId = normalized.valueId;
    valueName = normalized.valueName;

    if (!valueId && !valueName) continue;

    const groupId =
      attr?.attribute_group_id != null && String(attr.attribute_group_id).trim()
        ? String(attr.attribute_group_id).trim()
        : attr?.group_id != null && String(attr.group_id).trim()
          ? String(attr.group_id).trim()
          : null;

    const groupName =
      attr?.attribute_group_name != null && String(attr.attribute_group_name).trim()
        ? String(attr.attribute_group_name).trim()
        : attr?.group_name != null && String(attr.group_name).trim()
          ? String(attr.group_name).trim()
          : null;

    const required =
      typeof attr?.required === "boolean"
        ? attr.required
        : attr?.tags?.required === true;

    out.push({
      id,
      name: nameRaw,
      value_id: valueId || null,
      value_name: valueName || null,
      attribute_group_id: groupId,
      attribute_group_name: groupName,
      required,
      source_section:
        attr?.source_section != null && String(attr.source_section).trim()
          ? String(attr.source_section).trim().toLowerCase()
          : null,
    });
  }

  return out;
}

function sanitizeSaleTerms(saleTerms) {
  const out = [];
  const list = Array.isArray(saleTerms) ? saleTerms : [];

  for (const term of list) {
    const id = String(term?.id || "").trim();
    if (!id) continue;

    const valueId =
      term?.value_id != null && String(term.value_id).trim()
        ? String(term.value_id).trim()
        : null;
    let valueName =
      term?.value_name != null && String(term.value_name).trim()
        ? normalizeExtractedText(term.value_name)
        : null;

    if (!valueName && term?.value_struct?.name != null) {
      const structValue = normalizeExtractedText(term.value_struct.name);
      if (structValue) valueName = structValue;
    }

    if (!valueId && !valueName) continue;
    out.push({
      id,
      value_id: valueId,
      value_name: valueName,
    });
  }

  return out;
}

function sanitizePictures(item) {
  const list = Array.isArray(item?.pictures) ? item.pictures : [];
  const raw = list
    .map((pic) => pic?.secure_url || pic?.url || pic?.source || null)
    .filter((value) => !!String(value || "").trim())
    .map((value) => String(value).trim());

  if (!raw.length && item?.thumbnail) {
    raw.push(String(item.thumbnail).trim());
  }

  const unique = Array.from(new Set(raw));
  return unique.slice(0, 10).map((source) => ({ source }));
}

function sanitizeVariations(variations) {
  const list = Array.isArray(variations) ? variations : [];
  const out = [];

  for (const variation of list) {
    const attrs = sanitizeAttributes(variation?.attribute_combinations);
    const extraAttrs = sanitizeAttributes(variation?.attributes);
    const pictureIds = Array.isArray(variation?.picture_ids)
      ? variation.picture_ids
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      : [];

    const entry = {
      id:
        variation?.id != null && String(variation.id).trim()
          ? String(variation.id).trim()
          : null,
      price: toNumberOrNull(variation?.price),
      available_quantity: toNumberOrNull(variation?.available_quantity),
      seller_custom_field:
        variation?.seller_custom_field != null
          ? String(variation.seller_custom_field)
          : null,
      attribute_combinations: attrs,
      attributes: extraAttrs,
      picture_ids: pictureIds,
    };

    out.push(entry);
  }

  return out;
}

function sanitizeShipping(shipping) {
  if (!shipping || typeof shipping !== "object") return null;
  const output = {};

  if (shipping.mode != null) {
    const mode = normalizeShippingMode(shipping.mode);
    if (mode) output.mode = mode;
  }
  if (shipping.local_pick_up != null) output.local_pick_up = !!shipping.local_pick_up;
  if (shipping.free_shipping != null) output.free_shipping = !!shipping.free_shipping;
  if (shipping.logistic_type != null) {
    const logisticType = String(shipping.logistic_type || "").trim().toLowerCase();
    if (logisticType) output.logistic_type = logisticType;
  }
  if (shipping.dimensions != null && String(shipping.dimensions).trim()) {
    output.dimensions = String(shipping.dimensions).trim();
  }

  return Object.keys(output).length ? output : null;
}

function normalizeDraftPayload(item, descriptionText) {
  const rawVariations = sanitizeVariations(item?.variations);
  const cloneMode = rawVariations.length ? "variacoes" : "unitario";
  const sourcePlatform = String(item?.source_platform || "mercadolivre")
    .trim()
    .toLowerCase();
  const payload = {
    title: String(item?.title || "").trim(),
    family_name: null,
    clone_mode: cloneMode,
    source_platform: sourcePlatform || "mercadolivre",
    max_title_length:
      Number.isFinite(Number(item?.max_title_length)) && Number(item.max_title_length) > 0
        ? Math.floor(Number(item.max_title_length))
        : 120,
    category_id: String(item?.category_id || "").trim(),
    category_name:
      item?.category_name != null && String(item.category_name).trim()
        ? String(item.category_name).trim()
        : null,
    category_path: null,
    price: toNumberOrNull(item?.price),
    currency_id: String(item?.currency_id || "BRL").trim() || "BRL",
    available_quantity: Math.max(
      1,
      Math.floor(toNumberOrNull(item?.available_quantity) || 1),
    ),
    buying_mode: String(item?.buying_mode || "buy_it_now").trim() || "buy_it_now",
    listing_type_id:
      String(item?.listing_type_id || "gold_special").trim() || "gold_special",
    condition: String(item?.condition || "new").trim() || "new",
    condition_options: [],
    description_plain_text: String(descriptionText || "").trim(),
    pictures: sanitizePictures(item),
    attributes: sanitizeAttributes(item?.attributes),
    attributes_extra: [],
    attributes_main: [],
    attributes_secondary: [],
    attributes_unmatched: [],
    sale_terms: sanitizeSaleTerms(item?.sale_terms),
    shipping: sanitizeShipping(item?.shipping),
    warranty:
      item?.warranty != null && String(item.warranty).trim()
        ? String(item.warranty).trim()
        : null,
    video_id:
      item?.video_id != null && String(item.video_id).trim()
        ? String(item.video_id).trim()
        : null,
    variations: rawVariations,
    source_item_snapshot: {
      platform: sourcePlatform || "mercadolivre",
      id: String(item?.id || "").trim(),
      title: String(item?.title || "").trim(),
      permalink:
        item?.permalink != null && String(item.permalink).trim()
          ? String(item.permalink).trim()
          : null,
      seller_id: toNumberOrNull(item?.seller_id),
      category_id: String(item?.category_id || "").trim(),
      listing_type_id: String(item?.listing_type_id || "").trim(),
      catalog_listing: item?.catalog_listing === true,
      catalog_product_id:
        item?.catalog_product_id != null && String(item.catalog_product_id).trim()
          ? String(item.catalog_product_id).trim()
          : null,
      family_name:
        item?.family_name != null && String(item.family_name).trim()
          ? String(item.family_name).trim()
          : null,
    },
    listing_type_options: [],
  };
  payload.family_name = resolveFamilyNameFromDraft(payload);
  return payload;
}

function parseJsonInput(value, label, { allowArray = false, allowObject = false } = {}) {
  if (value == null) return undefined;
  if (typeof value === "string") {
    const text = String(value).trim();
    if (!text) return undefined;
    try {
      const parsed = JSON.parse(text);
      if (allowArray && Array.isArray(parsed)) return parsed;
      if (allowObject && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
      throw new CloneDraftError(
        `${label} precisa estar no formato esperado.`,
        400,
        "payload_invalid",
      );
    } catch (error) {
      if (error instanceof CloneDraftError) throw error;
      throw new CloneDraftError(
        `${label} esta com JSON invalido.`,
        400,
        "payload_invalid_json",
      );
    }
  }

  if (allowArray && Array.isArray(value)) return value;
  if (allowObject && value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }

  throw new CloneDraftError(
    `${label} precisa estar no formato esperado.`,
    400,
    "payload_invalid",
  );
}

function buildScopeFilter({ meliContaId, accountKey }, params) {
  if (meliContaId) {
    params.push(Number(meliContaId));
    return `d.meli_conta_id = $${params.length}`;
  }
  if (accountKey) {
    params.push(String(accountKey));
    return `d.account_key = $${params.length}`;
  }
  throw new CloneDraftError(
    "Conta atual nao identificada para operar os rascunhos.",
    400,
    "scope_missing",
  );
}

function mapDraftRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    account_key: row.account_key || null,
    meli_conta_id: toNumberOrNull(row.meli_conta_id),
    created_by: toNumberOrNull(row.created_by),
    updated_by: toNumberOrNull(row.updated_by),
    source_url: row.source_url,
    source_item_id: row.source_item_id,
    source_seller_id: toNumberOrNull(row.source_seller_id),
    source_seller_nickname: row.source_seller_nickname || null,
    source_title: row.source_title || null,
    source_permalink: row.source_permalink || null,
    status: row.status || "em_revisao",
    review_notes: row.review_notes || "",
    draft_payload: parseJsonColumn(row.draft_payload, {}) || {},
    last_validation: parseJsonColumn(row.last_validation, null),
    published_item_id: row.published_item_id || null,
    published_permalink: row.published_permalink || null,
    published_at: row.published_at || null,
    last_publish_result: parseJsonColumn(row.last_publish_result, null),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function stripUndefinedFromObject(input) {
  const output = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (value === undefined) continue;
    output[key] = value;
  }
  return output;
}

class ClonarAnuncioService {
  static async prepareState({ mlCreds = {}, accountKey = null } = {}) {
    const resolved = {
      ...(mlCreds || {}),
      account_key:
        mlCreds?.account_key ||
        mlCreds?.accountKey ||
        normalizeAccountKey(accountKey) ||
        null,
    };
    const token = await TokenService.renovarTokenSeNecessario(resolved);
    return { token, creds: resolved };
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

  static async mlGetJson(state, path) {
    const response = await this.authFetch(state, `${ML_API_BASE}${path}`, {
      method: "GET",
    });
    const text = await response.text().catch(() => "");
    const json = parseJsonColumn(text, null);

    if (!response.ok) {
      const message =
        json?.message ||
        json?.error ||
        text ||
        `Falha ao consultar ${path}: HTTP ${response.status}`;
      throw new CloneDraftError(message, response.status, "ml_api_error", {
        path,
        status: response.status,
        response: json != null ? json : text,
      });
    }

    return json != null ? json : {};
  }

  static async mlGetJsonPublic(path) {
    const response = await fetch(`${ML_API_BASE}${path}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });
    const text = await response.text().catch(() => "");
    const json = parseJsonColumn(text, null);

    if (!response.ok) {
      const message =
        json?.message ||
        json?.error ||
        text ||
        `Falha ao consultar ${path}: HTTP ${response.status}`;
      throw new CloneDraftError(message, response.status, "ml_api_error", {
        path,
        status: response.status,
        response: json != null ? json : text,
      });
    }

    return json != null ? json : {};
  }

  static async mlGetJsonPreferPublic(path, { mlCreds, accountKey } = {}) {
    try {
      return await this.mlGetJsonPublic(path);
    } catch (error) {
      const status = Number(error?.status || 0);
      if (status !== 401 && status !== 403) throw error;

      const state = await this.prepareState({ mlCreds, accountKey });
      return this.mlGetJson(state, path);
    }
  }

  static parseMultigetItemPayload(payload, itemId, sourcePath) {
    const normalized = String(itemId || "").trim().toUpperCase();
    const rows = Array.isArray(payload) ? payload : [];
    const match = rows.find((entry) => {
      const bodyId = String(entry?.body?.id || entry?.id || "").trim().toUpperCase();
      return bodyId === normalized;
    }) || rows[0] || null;

    if (match?.code === 200 && match.body && typeof match.body === "object") {
      return match.body;
    }

    const body = match?.body && typeof match.body === "object" ? match.body : {};
    const message =
      body?.message ||
      body?.error ||
      match?.message ||
      `Falha ao consultar ${normalized} no multiget do Mercado Livre.`;
    throw new CloneDraftError(message, Number(match?.code || 502), "ml_api_error", {
      path: sourcePath,
      status: Number(match?.code || 502),
      response: match || payload,
    });
  }

  static async mlGetItemPreferPublic(itemId, { mlCreds, accountKey } = {}) {
    const normalized = String(itemId || "").trim().toUpperCase();
    if (!normalized) {
      throw new CloneDraftError("Informe um MLB valido.", 400, "item_id_required");
    }

    const directPath = `/items/${encodeURIComponent(normalized)}`;
    let directError = null;
    try {
      return await this.mlGetJsonPreferPublic(directPath, { mlCreds, accountKey });
    } catch (error) {
      directError = error;
    }

    const multigetPath =
      `/items?ids=${encodeURIComponent(normalized)}` +
      "&include_internal_attributes=true";
    try {
      const payload = await this.mlGetJsonPreferPublic(multigetPath, {
        mlCreds,
        accountKey,
      });
      return this.parseMultigetItemPayload(payload, normalized, multigetPath);
    } catch (multigetError) {
      if (this.shouldUseHtmlFallback(multigetError)) throw multigetError;
      if (this.shouldUseHtmlFallback(directError)) throw directError;
      throw multigetError || directError;
    }
  }

  static shouldUseHtmlFallback(error) {
    const status = Number(error?.status || 0);
    const msg = String(error?.message || "").toLowerCase();
    const blockedByPolicy =
      msg.includes("unauthorized_result_from_policies") ||
      msg.includes("policy returned unauthorized") ||
      msg.includes("policyagent") ||
      msg.includes("forbidden") ||
      msg.includes("access to the requested resource is forbidden");
    return status === 403 && blockedByPolicy;
  }

  static buildConditionOptionsFromCategory(category) {
    const ids = Array.isArray(category?.settings?.item_conditions)
      ? category.settings.item_conditions
      : ["new", "used"];
    const seen = new Set();
    const out = [];
    for (const entry of ids) {
      const id = String(entry || "").trim().toLowerCase();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        name: conditionLabel(id),
      });
    }
    return out.length
      ? out
      : [
          { id: "new", name: "Novo" },
          { id: "used", name: "Usado" },
        ];
  }

  static buildCategoryPathText(category) {
    const pathList = Array.isArray(category?.path_from_root)
      ? category.path_from_root
      : [];
    return pathList
      .map((entry) => String(entry?.name || "").trim())
      .filter(Boolean)
      .join(" > ");
  }

  static async resolveCategoryContext({ categoryId, mlCreds, accountKey }) {
    const normalized = String(categoryId || "").trim().toUpperCase();
    if (!normalized) {
      return {
        category_id: null,
        category_name: null,
        category_path: null,
        max_title_length: 120,
        attributes_meta: [],
        shipping_modes: [],
        condition_options: [
          { id: "new", name: "Novo" },
          { id: "used", name: "Usado" },
        ],
      };
    }

    let category = null;
    let attributesMeta = [];
    try {
      category = await this.mlGetJsonPreferPublic(
        `/categories/${encodeURIComponent(normalized)}`,
        { mlCreds, accountKey },
      );
    } catch {
      category = null;
    }

    try {
      const attributesResponse = await this.mlGetJsonPreferPublic(
        `/categories/${encodeURIComponent(normalized)}/attributes`,
        { mlCreds, accountKey },
      );
      attributesMeta = Array.isArray(attributesResponse) ? attributesResponse : [];
    } catch {
      attributesMeta = [];
    }

    return {
      category_id: normalized,
      category_name:
        category?.name != null && String(category.name).trim()
          ? String(category.name).trim()
          : null,
      category_path: this.buildCategoryPathText(category),
      max_title_length:
        Number.isFinite(Number(category?.settings?.max_title_length)) &&
        Number(category.settings.max_title_length) > 0
          ? Math.floor(Number(category.settings.max_title_length))
          : 120,
      attributes_meta: attributesMeta,
      shipping_modes: Array.isArray(category?.settings?.shipping_modes)
        ? category.settings.shipping_modes
            .map((entry) => normalizeShippingMode(entry))
            .filter(Boolean)
        : [],
      condition_options: this.buildConditionOptionsFromCategory(category),
    };
  }

  static async resolveListingTypeOptions({
    mlCreds,
    accountKey,
    categoryId,
    currentListingTypeId = null,
  }) {
    const byId = new Map();
    const addOption = (idValue, nameValue = null) => {
      const id = String(idValue || "").trim().toLowerCase();
      if (!id) return;
      const fallbackName = listingTypeFriendlyLabel(id);
      byId.set(id, {
        id,
        name:
          nameValue != null && String(nameValue).trim()
            ? String(nameValue).trim()
            : fallbackName,
      });
    };

    addOption("gold_special", "Classico");
    addOption("gold_pro", "Premium");

    const userId = toNumberOrNull(mlCreds?.meli_user_id);
    const normalizedCategoryId = String(categoryId || "").trim().toUpperCase();
    if (userId && normalizedCategoryId) {
      try {
        const state = await this.prepareState({ mlCreds, accountKey });
        const response = await this.authFetch(
          state,
          `${ML_API_BASE}/users/${userId}/available_listing_types?category_id=${encodeURIComponent(normalizedCategoryId)}`,
          { method: "GET" },
        );
        const rawText = await response.text().catch(() => "");
        const rawJson = parseJsonColumn(rawText, null);
        if (response.ok) {
          const available = Array.isArray(rawJson?.available)
            ? rawJson.available
            : Array.isArray(rawJson)
              ? rawJson
              : [];
          for (const entry of available) {
            if (typeof entry === "string") {
              addOption(entry);
              continue;
            }
            addOption(entry?.id || entry?.listing_type_id, entry?.name);
          }
        }
      } catch {
        // fallback silencioso para opções padrão
      }
    }

    if (currentListingTypeId) {
      addOption(currentListingTypeId);
    }

    const priority = {
      gold_special: 1,
      gold_pro: 2,
      free: 3,
    };
    return Array.from(byId.values()).sort((a, b) => {
      const pa = priority[a.id] || 99;
      const pb = priority[b.id] || 99;
      if (pa !== pb) return pa - pb;
      return a.name.localeCompare(b.name, "pt-BR");
    });
  }

  static async authGetJson(state, path, query = {}) {
    const url = new URL(`${ML_API_BASE}${path}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value == null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    const response = await this.authFetch(state, url.toString(), { method: "GET" });
    const rawText = await response.text().catch(() => "");
    const rawJson = parseJsonColumn(rawText, null);
    return {
      ok: response.ok,
      status: response.status,
      data: rawJson != null ? rawJson : rawText,
    };
  }

  static async resolveCurrentSellerId({ mlCreds, accountKey, state = null }) {
    const direct = toNumberOrNull(
      mlCreds?.meli_user_id || mlCreds?.seller_id || mlCreds?.user_id,
    );
    if (direct) return direct;

    const activeState = state || (await this.prepareState({ mlCreds, accountKey }));
    try {
      const me = await this.mlGetJson(activeState, "/users/me");
      return toNumberOrNull(me?.id);
    } catch {
      return null;
    }
  }

  static parseShippingProbeResult(result, { mode, freeShipping }) {
    const normalizedMode = normalizeShippingMode(mode);
    const normalizedText = buildMlErrorText(result?.data);
    const hasRequiredDimensions =
      normalizedText.includes("required_fields") &&
      (normalizedText.includes("seller_package") ||
        normalizedText.includes("dimensions") ||
        normalizedText.includes("billable_weight"));
    const modeNotAllowed =
      normalizedText.includes("shipping_mode") &&
      (normalizedText.includes("invalid") ||
        normalizedText.includes("not allowed") ||
        normalizedText.includes("unsupported"));

    if (result?.ok) {
      const costs = extractShippingCostSnapshot(result.data, freeShipping);
      return {
        mode: normalizedMode,
        mode_eligible: true,
        free_shipping_eligible:
          typeof costs.free_shipping === "boolean" ? costs.free_shipping : freeShipping,
        quote_seller_cost: costs.seller_cost,
        quote_buyer_cost: costs.buyer_cost,
        reason: "",
      };
    }

    if (modeNotAllowed) {
      return {
        mode: normalizedMode,
        mode_eligible: false,
        free_shipping_eligible: false,
        quote_seller_cost: null,
        quote_buyer_cost: null,
        reason: "Modo de envio nao habilitado para esta conta/categoria.",
      };
    }

    if (hasRequiredDimensions) {
      return {
        mode: normalizedMode,
        mode_eligible: true,
        free_shipping_eligible: null,
        quote_seller_cost: null,
        quote_buyer_cost: null,
        reason:
          "Nao foi possivel simular frete gratis sem dimensoes completas do pacote.",
      };
    }

    return {
      mode: normalizedMode,
      mode_eligible: null,
      free_shipping_eligible: null,
      quote_seller_cost: null,
      quote_buyer_cost: null,
      reason: "Nao foi possivel confirmar elegibilidade do modo de envio.",
    };
  }

  static async resolveShippingContextForDraft({
    draftPayload = {},
    categoryContext = {},
    mlCreds,
    accountKey,
  }) {
    const categoryModes = Array.isArray(categoryContext?.shipping_modes)
      ? categoryContext.shipping_modes
          .map((entry) => normalizeShippingMode(entry))
          .filter(Boolean)
      : [];
    const hasCategoryModes = categoryModes.length > 0;
    const candidates = hasCategoryModes
      ? categoryModes
      : ["me2", "me1"];
    const modeCandidates = Array.from(
      new Set(candidates.filter((mode) => mode === "me1" || mode === "me2")),
    );

    const output = {
      source: hasCategoryModes ? "category_settings" : "fallback",
      mode_options: modeCandidates.map((mode) => ({
        id: mode,
        label: getShippingModeLabel(mode),
        eligible: true,
        reason: "",
      })),
      free_shipping: {
        eligible: null,
        reason: "",
      },
      recommendation: {
        mode: modeCandidates.includes("me2")
          ? "me2"
          : modeCandidates.includes("me1")
            ? "me1"
            : null,
        free_shipping: null,
      },
      notes: [],
    };

    if (!modeCandidates.length) {
      output.notes.push(
        "Nao foi possivel identificar modos de envio desta categoria no momento.",
      );
      return output;
    }

    if (!modeCandidates.includes("me2")) {
      output.free_shipping.eligible = false;
      output.free_shipping.reason =
        "Frete gratis nao habilitado porque ME2 nao esta disponivel.";
      output.recommendation.free_shipping = false;
      return output;
    }

    const categoryId = String(draftPayload?.category_id || "").trim().toUpperCase();
    const listingTypeId = String(draftPayload?.listing_type_id || "")
      .trim()
      .toLowerCase();
    const itemPrice = toNumberOrNull(draftPayload?.price);
    const shippingDimensions = String(draftPayload?.shipping?.dimensions || "").trim() || null;
    const zipCode = cleanZip(
      mlCreds?.zip_code || mlCreds?.cep || mlCreds?.postal_code || "",
    );

    let state = null;
    let sellerId = null;
    try {
      state = await this.prepareState({ mlCreds, accountKey });
      sellerId = await this.resolveCurrentSellerId({
        mlCreds,
        accountKey,
        state,
      });
    } catch {
      state = null;
      sellerId = null;
    }

    if (!state || !sellerId) {
      output.notes.push(
        "Nao foi possivel validar elegibilidade de envio com a conta autenticada.",
      );
      return output;
    }

    try {
      const preferences = await this.authGetJson(
        state,
        `/users/${encodeURIComponent(sellerId)}/shipping_preferences`,
      );
      if (preferences?.ok && preferences?.data && typeof preferences.data === "object") {
        const prefModes = Array.isArray(preferences.data?.modes)
          ? preferences.data.modes
              .map((entry) => normalizeShippingMode(entry))
              .filter(Boolean)
          : [];
        if (prefModes.length) {
          const allowed = new Set(prefModes);
          output.mode_options = output.mode_options.map((entry) => {
            if (allowed.has(entry.id)) return entry;
            return {
              ...entry,
              eligible: false,
              reason: "Modo nao habilitado nas preferencias de envio da conta.",
            };
          });
          output.source = "user_shipping_preferences";
          if (
            output.recommendation.mode &&
            !output.mode_options.some(
              (entry) => entry.id === output.recommendation.mode && entry.eligible !== false,
            )
          ) {
            const fallbackMode = output.mode_options.find(
              (entry) => entry.eligible !== false,
            );
            output.recommendation.mode = fallbackMode?.id || null;
            if (output.recommendation.mode !== "me2") {
              output.free_shipping.eligible = false;
              output.free_shipping.reason =
                "Frete gratis depende de modo ME2 habilitado na conta.";
              output.recommendation.free_shipping = false;
            }
          }
        }
      }
    } catch {
      // segue com avaliacao baseada em categoria/fallback
    }

    if (!output.mode_options.some((entry) => entry.eligible !== false)) {
      output.notes.push(
        "Nenhum modo ME1/ME2 ficou habilitado para a conta nesta categoria.",
      );
      output.recommendation.mode = null;
      output.recommendation.free_shipping = false;
      output.free_shipping.eligible = false;
      output.free_shipping.reason =
        output.free_shipping.reason || "Modos de envio indisponiveis para esta conta.";
      return output;
    }

    const enabledModes = output.mode_options
      .filter((entry) => entry.eligible !== false)
      .map((entry) => entry.id);
    const probeMode = enabledModes.includes("me2")
      ? "me2"
      : enabledModes.includes("me1")
        ? "me1"
        : null;
    if (!probeMode) return output;

    const freeProbeQuery = {
      mode: probeMode,
      free_shipping: true,
    };
    if (categoryId) freeProbeQuery.category_id = categoryId;
    if (listingTypeId) freeProbeQuery.listing_type_id = listingTypeId;
    if (Number.isFinite(itemPrice) && itemPrice > 0) {
      freeProbeQuery.item_price = Number(itemPrice);
    }
    if (shippingDimensions) freeProbeQuery.dimensions = shippingDimensions;
    if (zipCode) freeProbeQuery.zip_code = zipCode;

    try {
      const probe = await this.authGetJson(
        state,
        `/users/${encodeURIComponent(sellerId)}/shipping_options/free`,
        freeProbeQuery,
      );
      const parsed = this.parseShippingProbeResult(probe, {
        mode: probeMode,
        freeShipping: true,
      });
      if (parsed?.mode === "me2") {
        const me2Option = output.mode_options.find((entry) => entry.id === "me2");
        if (me2Option) {
          if (typeof parsed.mode_eligible === "boolean") {
            me2Option.eligible = parsed.mode_eligible;
          }
          if (parsed.reason) me2Option.reason = parsed.reason;
        }
      }
      output.free_shipping.eligible = parsed?.free_shipping_eligible;
      output.free_shipping.reason = parsed?.reason || "";
      output.source = probe?.ok ? "users_shipping_options_free" : output.source;
    } catch {
      output.notes.push(
        "Nao foi possivel consultar elegibilidade de frete gratis no momento.",
      );
    }

    if (output.recommendation.mode === "me2") {
      if (output.free_shipping.eligible === true) {
        output.recommendation.free_shipping = true;
      } else if (output.free_shipping.eligible === false) {
        output.recommendation.free_shipping = false;
      }
    } else {
      output.recommendation.free_shipping = false;
    }

    if (
      output.recommendation.mode &&
      output.mode_options.some(
        (entry) => entry.id === output.recommendation.mode && entry.eligible === false,
      )
    ) {
      const fallback = output.mode_options.find((entry) => entry.eligible !== false);
      output.recommendation.mode = fallback?.id || null;
      if (output.recommendation.mode !== "me2") {
        output.recommendation.free_shipping = false;
      }
    }

    return output;
  }

  static async applyShippingContextToDraftPayload({
    draftPayload = {},
    categoryContext = {},
    mlCreds,
    accountKey,
  }) {
    const payload = draftPayload && typeof draftPayload === "object"
      ? draftPayload
      : {};
    const context = await this.resolveShippingContextForDraft({
      draftPayload: payload,
      categoryContext,
      mlCreds,
      accountKey,
    });
    payload.shipping_context = context;

    const selectedShipping = sanitizeShipping(payload.shipping);
    const selectedMode = normalizeShippingMode(selectedShipping?.mode);
    const modeIsAllowed = selectedMode
      ? context?.mode_options?.some(
          (entry) => entry.id === selectedMode && entry.eligible !== false,
        )
      : false;
    const nextMode =
      modeIsAllowed
        ? selectedMode
        : normalizeShippingMode(context?.recommendation?.mode) || null;

    const selectedFreeShipping =
      selectedShipping?.free_shipping === true
        ? true
        : selectedShipping?.free_shipping === false
          ? false
          : null;
    const freeEligible = context?.free_shipping?.eligible;
    let nextFreeShipping = selectedFreeShipping;
    if (nextFreeShipping == null) {
      nextFreeShipping =
        context?.recommendation?.free_shipping === true
          ? true
          : context?.recommendation?.free_shipping === false
            ? false
            : null;
    }
    if (nextFreeShipping === true && freeEligible === false) {
      nextFreeShipping = false;
    }
    if (nextFreeShipping === true && nextMode !== "me2") {
      nextFreeShipping = false;
    }

    payload.shipping = sanitizeShipping({
      ...(selectedShipping || {}),
      mode: nextMode || undefined,
      free_shipping: nextFreeShipping,
    });

    return payload;
  }

  static mergeAttributesWithCategoryMeta(itemAttributes, categoryAttributesMeta = []) {
    const source = sanitizeAttributes(itemAttributes);
    const metaList = Array.isArray(categoryAttributesMeta) ? categoryAttributesMeta : [];
    const normalizeMetaTags = (tags) => {
      if (!tags) return {};
      if (Array.isArray(tags)) {
        return tags.reduce((acc, tag) => {
          acc[String(tag)] = true;
          return acc;
        }, {});
      }
      return tags && typeof tags === "object" ? tags : {};
    };
    const isMetaRequired = (meta) => {
      const tags = normalizeMetaTags(meta?.tags);
      return tags.required === true || tags.catalog_required === true;
    };
    const isMetaEditable = (meta) => {
      const tags = normalizeMetaTags(meta?.tags);
      return tags.read_only !== true && tags.inferred !== true;
    };
    const isMetaPrimary = (meta) => {
      const tags = normalizeMetaTags(meta?.tags);
      const groupId = String(meta?.attribute_group_id || "").trim().toUpperCase();
      return (
        groupId === "MAIN" ||
        tags.required === true ||
        tags.catalog_required === true ||
        tags.product_pk === true ||
        Number(meta?.relevance || 0) >= 1
      );
    };
    const allowsNotApplicable = (meta) => {
      if (!isMetaEditable(meta)) return false;
      if (isMetaRequired(meta)) return false;
      const valueType = String(meta?.value_type || "").trim().toLowerCase();
      if (valueType === "boolean") return false;
      return true;
    };
    const metaById = new Map();
    const normalizeMetaValues = (values) =>
      Array.isArray(values)
        ? values
            .map((entry) => ({
              id:
                entry?.id != null && String(entry.id).trim()
                  ? String(entry.id).trim()
                  : null,
              name:
                entry?.name != null && String(entry.name).trim()
                  ? normalizeExtractedText(entry.name)
                  : null,
            }))
            .filter((entry) => entry.id || entry.name)
            .slice(0, 200)
        : [];
    const normalizeMetaUnits = (units) =>
      Array.isArray(units)
        ? units
            .map((entry) => ({
              id:
                entry?.id != null && String(entry.id).trim()
                  ? String(entry.id).trim()
                  : entry?.name != null && String(entry.name).trim()
                    ? String(entry.name).trim()
                    : null,
              name:
                entry?.name != null && String(entry.name).trim()
                  ? String(entry.name).trim()
                  : entry?.id != null && String(entry.id).trim()
                    ? String(entry.id).trim()
                    : null,
            }))
            .filter((entry) => entry.id)
            .slice(0, 120)
        : [];

    for (const meta of metaList) {
      const id = canonicalizeMlAttributeId(meta?.id);
      if (!id) continue;
      const tags = normalizeMetaTags(meta?.tags);
      const allowedUnits = normalizeMetaUnits(meta?.allowed_units);
      metaById.set(id, {
        id,
        name:
          meta?.name != null && String(meta.name).trim()
            ? normalizeExtractedText(meta.name)
            : id,
        attribute_group_id:
          meta?.attribute_group_id != null && String(meta.attribute_group_id).trim()
            ? String(meta.attribute_group_id).trim()
            : null,
        attribute_group_name:
          meta?.attribute_group_name != null && String(meta.attribute_group_name).trim()
            ? String(meta.attribute_group_name).trim()
            : null,
        required: isMetaRequired(meta),
        editable: isMetaEditable(meta),
        allows_not_applicable: allowsNotApplicable(meta),
        source_section: isMetaPrimary(meta) ? "main" : "secondary",
        tags,
        value_type:
          meta?.value_type != null && String(meta.value_type).trim()
            ? String(meta.value_type).trim()
            : "string",
        values: normalizeMetaValues(meta?.values),
        allowed_units: allowedUnits,
        default_unit:
          meta?.default_unit != null && String(meta.default_unit).trim()
            ? String(meta.default_unit).trim()
            : allowedUnits[0]?.id || null,
      });
    }

    const byId = new Map();
    for (const attr of source) {
      const id = canonicalizeMlAttributeId(attr?.id);
      if (!id) continue;
      const meta = metaById.get(id);
      const nextEntry = {
        id,
        name: normalizeExtractedText(attr?.name || meta?.name || id),
        value_id:
          attr?.value_id != null && String(attr.value_id).trim()
            ? String(attr.value_id).trim()
            : null,
        value_name:
          attr?.value_name != null && String(attr.value_name).trim()
            ? normalizeExtractedText(attr.value_name)
            : null,
        attribute_group_id:
          attr?.attribute_group_id || meta?.attribute_group_id || null,
        attribute_group_name:
          attr?.attribute_group_name || meta?.attribute_group_name || null,
        required:
          typeof attr?.required === "boolean"
            ? attr.required
            : meta?.required === true,
        editable: meta?.editable !== false,
        allows_not_applicable: meta?.allows_not_applicable === true,
        source_section:
          attr?.source_section != null && String(attr.source_section).trim()
            ? String(attr.source_section).trim().toLowerCase()
            : meta?.source_section || null,
        value_type: meta?.value_type || "string",
        values: Array.isArray(meta?.values) ? meta.values : [],
        allowed_units: Array.isArray(meta?.allowed_units) ? meta.allowed_units : [],
        default_unit: meta?.default_unit || null,
      };

      const currentEntry = byId.get(id);
      if (!currentEntry) {
        byId.set(id, nextEntry);
        continue;
      }

      const currentRawValue = normalizeExtractedText(
        currentEntry.value_name || currentEntry.value_id || "",
      );
      const nextRawValue = normalizeExtractedText(
        nextEntry.value_name || nextEntry.value_id || "",
      );

      const currentHasValue = !!currentRawValue;
      const nextHasValue = !!nextRawValue;
      if (!currentHasValue && nextHasValue) {
        byId.set(id, nextEntry);
        continue;
      }
      if (currentHasValue && nextHasValue) {
        const currentSuspicious = isSuspiciousAttributeText(currentRawValue);
        const nextSuspicious = isSuspiciousAttributeText(nextRawValue);
        if (currentSuspicious && !nextSuspicious) {
          byId.set(id, nextEntry);
          continue;
        }
      }

      byId.set(id, {
        ...currentEntry,
        name: currentEntry.name || nextEntry.name,
        attribute_group_id: currentEntry.attribute_group_id || nextEntry.attribute_group_id,
        attribute_group_name: currentEntry.attribute_group_name || nextEntry.attribute_group_name,
        required: currentEntry.required || nextEntry.required,
        source_section: currentEntry.source_section || nextEntry.source_section,
        values: Array.isArray(currentEntry.values) && currentEntry.values.length
          ? currentEntry.values
          : nextEntry.values,
        allowed_units: Array.isArray(currentEntry.allowed_units) && currentEntry.allowed_units.length
          ? currentEntry.allowed_units
          : nextEntry.allowed_units,
        default_unit: currentEntry.default_unit || nextEntry.default_unit,
        allows_not_applicable:
          currentEntry.allows_not_applicable || nextEntry.allows_not_applicable,
        editable: currentEntry.editable !== false && nextEntry.editable !== false,
      });
    }

    for (const meta of metaById.values()) {
      if (meta.editable === false) continue;
      const forceVisible = ALWAYS_VISIBLE_CATEGORY_ATTRIBUTE_IDS.has(
        normalizeAttributeIdForCompare(meta.id),
      );
      if (byId.has(meta.id)) {
        const current = byId.get(meta.id);
        byId.set(meta.id, {
          ...current,
          name: current.name || meta.name || meta.id,
          attribute_group_id: current.attribute_group_id || meta.attribute_group_id || null,
          attribute_group_name:
            current.attribute_group_name || meta.attribute_group_name || null,
          required: current.required || meta.required === true,
          editable: meta.editable !== false,
          allows_not_applicable:
            current.allows_not_applicable || meta.allows_not_applicable === true,
          source_section: current.source_section || meta.source_section || null,
          value_type: meta.value_type || current.value_type || "string",
          values: Array.isArray(current.values) && current.values.length
            ? current.values
            : Array.isArray(meta.values)
              ? meta.values
              : [],
          allowed_units: Array.isArray(current.allowed_units) && current.allowed_units.length
            ? current.allowed_units
            : Array.isArray(meta.allowed_units)
              ? meta.allowed_units
              : [],
          default_unit: current.default_unit || meta.default_unit || null,
        });
        continue;
      }
      byId.set(meta.id, {
        id: meta.id,
        name: meta.name || meta.id,
        value_id: null,
        value_name: "",
        attribute_group_id: meta.attribute_group_id || null,
        attribute_group_name: meta.attribute_group_name || null,
        required: meta.required === true,
        editable: meta.editable !== false,
        allows_not_applicable: meta.allows_not_applicable === true,
        source_section: meta.source_section || (forceVisible ? "main" : "secondary"),
        value_type: meta.value_type || "string",
        values: Array.isArray(meta.values) ? meta.values : [],
        allowed_units: Array.isArray(meta.allowed_units) ? meta.allowed_units : [],
        default_unit: meta.default_unit || null,
      });
    }

    return Array.from(byId.values());
  }

  static splitAttributesForUi(attributes) {
    const list = Array.isArray(attributes) ? attributes : [];
    const main = [];
    const secondary = [];
    const payload = [];

    for (const attr of list) {
      const hasValue =
        (attr?.value_id != null && String(attr.value_id).trim()) ||
        (attr?.value_name != null && String(attr.value_name).trim());
      if (hasValue) {
        const mlPayload = toMlAttributePayload(attr);
        if (mlPayload) payload.push(mlPayload);
      }

      const groupId = String(attr?.attribute_group_id || "").trim().toUpperCase();
      const groupName = normalizeTextForMatch(attr?.attribute_group_name || "");
      const sourceSection = String(attr?.source_section || "").trim().toLowerCase();
      const isMain =
        attr?.required === true ||
        groupId === "MAIN" ||
        groupName.includes("principal") ||
        sourceSection === "main";
      if (isMain) {
        main.push(attr);
      } else {
        secondary.push(attr);
      }
    }

    return { payload, main, secondary };
  }

  static mapSpecsRowsToCategoryAttributes(specBlocks, categoryAttributesMeta = []) {
    const blocks = Array.isArray(specBlocks) ? specBlocks : [];
    const metaList = Array.isArray(categoryAttributesMeta) ? categoryAttributesMeta : [];

    const metaByNormalizedName = new Map();
    const metaById = new Map();
    const allMetaEntries = [];
    for (const meta of metaList) {
      const id = String(meta?.id || "").trim();
      const name = normalizeExtractedText(meta?.name || "");
      if (!id || !name) continue;
      const key = normalizeTextForMatch(name);
      if (!key) continue;
      if (!metaByNormalizedName.has(key)) {
        metaByNormalizedName.set(key, meta);
      }
      metaById.set(id.toLowerCase(), meta);
      allMetaEntries.push({
        key,
        name,
        meta,
      });
    }

    const resolveMetaByLabel = (labelValue) => {
      const label = normalizeExtractedText(labelValue);
      if (!label) return null;
      const normalized = normalizeTextForMatch(label);
      if (!normalized) return null;

      const exact = metaByNormalizedName.get(normalized);
      if (exact) return exact;

      let best = null;
      let bestScore = 0;
      for (const entry of allMetaEntries) {
        const score = attributeNameMatchScore(label, entry.name);
        if (score > bestScore) {
          bestScore = score;
          best = entry.meta;
        }
      }
      if (best && bestScore >= 0.74) return best;
      return null;
    }

    const mapMetaValues = (meta) =>
      Array.isArray(meta?.values)
        ? meta.values
            .map((entry) => ({
              id:
                entry?.id != null && String(entry.id).trim()
                  ? String(entry.id).trim()
                  : null,
              name:
                entry?.name != null && String(entry.name).trim()
                  ? String(entry.name).trim()
                  : null,
            }))
            .filter((entry) => entry.id || entry.name)
            .slice(0, 200)
        : [];

    const matchedById = new Map();
    const pushMatched = ({ meta, label, value, sectionKey }) => {
      const resolvedMeta = meta && typeof meta === "object" ? meta : null;
      const id = String(resolvedMeta?.id || "").trim();
      if (!id) return false;

      matchedById.set(id, {
        id,
        name:
          resolvedMeta?.name != null && String(resolvedMeta.name).trim()
            ? normalizeExtractedText(resolvedMeta.name)
            : normalizeExtractedText(label || id),
        value_id: null,
        value_name: normalizeExtractedText(value || ""),
        attribute_group_id:
          resolvedMeta?.attribute_group_id != null && String(resolvedMeta.attribute_group_id).trim()
            ? String(resolvedMeta.attribute_group_id).trim()
            : null,
        attribute_group_name:
          resolvedMeta?.attribute_group_name != null && String(resolvedMeta.attribute_group_name).trim()
            ? String(resolvedMeta.attribute_group_name).trim()
            : null,
        required: resolvedMeta?.tags?.required === true,
        value_type:
          resolvedMeta?.value_type != null && String(resolvedMeta.value_type).trim()
            ? String(resolvedMeta.value_type).trim()
            : "string",
        values: mapMetaValues(resolvedMeta),
        source_section: sectionKey || "secondary",
      });
      return true;
    };

    const extractDimensionParts = (label, value) => {
      const labelParts = String(label || "")
        .split(/x/gi)
        .map((part) => normalizeTextForMatch(part))
        .filter(Boolean);
      const valueParts = String(value || "")
        .split(/\s*x\s*/i)
        .map((part) => normalizeExtractedText(part))
        .filter(Boolean);
      if (labelParts.length < 2 || valueParts.length < 2) return null;

      const roleIndex = {
        height: labelParts.findIndex((part) => part.includes("altura")),
        length: labelParts.findIndex((part) => part.includes("comprimento")),
        width: labelParts.findIndex((part) => part.includes("largura")),
      };

      const out = {};
      const getValue = (idx) =>
        idx >= 0 && idx < valueParts.length ? valueParts[idx] : null;

      out.height = getValue(roleIndex.height);
      out.length = getValue(roleIndex.length);
      out.width = getValue(roleIndex.width);

      if (!out.height && !out.length && !out.width && valueParts.length >= 3) {
        out.height = valueParts[0] || null;
        out.length = valueParts[1] || null;
        out.width = valueParts[2] || null;
      }

      return out.height || out.length || out.width ? out : null;
    };

    const unmatched = [];

    for (const block of blocks) {
      const sectionKey = String(block?.section_key || "").trim().toLowerCase();
      for (const row of Array.isArray(block?.rows) ? block.rows : []) {
        const label = normalizeExtractedText(row?.label || "");
        const value = normalizeExtractedText(row?.value || "");
        if (!label || !value) continue;

        const normalizedLabel = normalizeTextForMatch(label);
        const isMultiDimensionLabel =
          normalizedLabel.includes("altura") &&
          normalizedLabel.includes("comprimento") &&
          normalizedLabel.includes("largura") &&
          /(?:^|\s)x(?:\s|$)/i.test(value);
        if (isMultiDimensionLabel) {
          const parts = extractDimensionParts(label, value);
          let mappedCount = 0;
          if (parts?.height) {
            if (
              pushMatched({
                meta: metaById.get("seller_package_height"),
                label: "seller_package_height",
                value: parts.height,
                sectionKey,
              })
            ) {
              mappedCount += 1;
            }
          }
          if (parts?.length) {
            if (
              pushMatched({
                meta: metaById.get("seller_package_length"),
                label: "seller_package_length",
                value: parts.length,
                sectionKey,
              })
            ) {
              mappedCount += 1;
            }
          }
          if (parts?.width) {
            if (
              pushMatched({
                meta: metaById.get("seller_package_width"),
                label: "seller_package_width",
                value: parts.width,
                sectionKey,
              })
            ) {
              mappedCount += 1;
            }
          }
          if (mappedCount > 0) {
            continue;
          }
        }

        if (normalizedLabel.includes("peso")) {
          const metaWeight = metaById.get("seller_package_weight");
          if (
            pushMatched({
              meta: metaWeight,
              label: "seller_package_weight",
              value,
              sectionKey,
            })
          ) {
            continue;
          }
        }

        const meta = resolveMetaByLabel(label);
        if (!meta) {
          unmatched.push({
            name: label,
            value_name: value,
            section_key: sectionKey || "secondary",
          });
          continue;
        }

        pushMatched({ meta, label, value, sectionKey });
      }
    }

    return {
      matched: Array.from(matchedById.values()),
      unmatched,
    };
  }

  static async inferCategoryIdFromText({ text, mlCreds, accountKey }) {
    const query = clipTextByWords(String(text || "").trim(), 120);
    if (!query) return null;

    try {
      const result = await this.mlGetJsonPreferPublic(
        `/sites/MLB/domain_discovery/search?limit=6&q=${encodeURIComponent(query)}`,
        { mlCreds, accountKey },
      );
      const list = Array.isArray(result) ? result : [];
      for (const entry of list) {
        const categoryId = String(
          entry?.category_id || entry?.category?.id || "",
        )
          .trim()
          .toUpperCase();
        if (categoryId) return categoryId;
      }
    } catch {
      return null;
    }

    return null;
  }

  static async fetchPreviewFromShopeeSource({ source, mlCreds, accountKey }) {
    const sourceUrl = removeHashFromUrl(source);
    const response = await fetch(sourceUrl, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });

    const html = await response.text().catch(() => "");
    if (!response.ok || !html.trim()) {
      throw new CloneDraftError(
        "Nao foi possivel ler o anuncio publico da Shopee.",
        response.status || 502,
        "shopee_preview_failed",
      );
    }

    const item = parseShopeeItemFromHtml(html) || {};
    const ogTitleRaw = decodeBasicHtmlEntities(
      firstRegexGroup(
        html,
        /<meta[^>]+property=["']og:title["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i,
      ) || "",
    );
    const htmlTitleRaw = decodeBasicHtmlEntities(
      firstRegexGroup(html, /<title[^>]*>([\s\S]*?)<\/title>/i) || "",
    );
    const title = String(item?.name || ogTitleRaw || htmlTitleRaw || "")
      .replace(/\s*-\s*Shopee.*$/i, "")
      .trim();

    if (!title) {
      throw new CloneDraftError(
        "Nao foi possivel extrair o titulo do anuncio da Shopee.",
        422,
        "shopee_title_missing",
      );
    }

    const paragraphMatches = Array.from(
      String(html || "").matchAll(/<p[^>]*class="QN2lPu"[^>]*>([\s\S]*?)<\/p>/gi),
    );
    const paragraphDescription = paragraphMatches
      .map((match) => htmlToPlainText(match?.[1] || ""))
      .filter(Boolean)
      .join("\n");
    const ogDescription = decodeBasicHtmlEntities(
      firstRegexGroup(
        html,
        /<meta[^>]+property=["']og:description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i,
      ) || "",
    );
    const description = String(
      item?.description || paragraphDescription || ogDescription || "",
    ).trim();

    const imageList = [];
    const pushImage = (value) => {
      const normalized = normalizeShopeeImageUrl(value);
      if (!normalized) return;
      imageList.push(normalized);
    };

    (Array.isArray(item?.images) ? item.images : []).forEach(pushImage);
    pushImage(
      firstRegexGroup(
        html,
        /<meta[^>]+property=["']og:image["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i,
      ) || "",
    );
    const uniqueImages = Array.from(new Set(imageList)).slice(0, 10);

    const models = Array.isArray(item?.models) ? item.models : [];
    const modelPrices = models
      .map((model) => parseShopeePrice(model?.price))
      .filter((value) => Number.isFinite(value) && value > 0);
    const price = parseShopeePrice(item?.price) || (modelPrices.length ? Math.min(...modelPrices) : null);

    const stockFromModels = models.reduce((sum, model) => {
      const current = Math.floor(toNumberOrNull(model?.stock) || 0);
      return sum + Math.max(0, current);
    }, 0);
    const availableQuantity = stockFromModels > 0 ? stockFromModels : 1;

    const ids = extractShopeeIdsFromUrl(sourceUrl);
    const sourceItemNumeric =
      String(item?.itemid || item?.item_id || ids.itemId || "").trim() || null;
    const sourceShopNumeric =
      String(item?.shopid || item?.shop_id || ids.shopId || "").trim() || null;
    const sourceItemId = sourceItemNumeric
      ? `SHP${sourceItemNumeric}`
      : `SHP${Date.now()}`;

    const categories = Array.isArray(item?.categories) ? item.categories : [];
    const sourceCategoryName =
      String(
        categories.length
          ? categories[categories.length - 1]?.display_name ||
              categories[categories.length - 1]?.name ||
              ""
          : "",
      ).trim() || null;
    const sourceCategoryPath = categories
      .map((entry) => String(entry?.display_name || entry?.name || "").trim())
      .filter(Boolean)
      .join(" > ");

    const sourceSpecs = buildShopeeFallbackSpecs(item);
    const discoveryText = [
      title,
      sourceCategoryName || "",
      sourceSpecs.map((entry) => `${entry.label} ${entry.value}`).join(" "),
    ]
      .join(" ")
      .trim();
    const inferredCategoryId = await this.inferCategoryIdFromText({
      text: discoveryText,
      mlCreds,
      accountKey,
    });

    const categoryContext = await this.resolveCategoryContext({
      categoryId: inferredCategoryId,
      mlCreds,
      accountKey,
    });
    const listingTypeOptions = await this.resolveListingTypeOptions({
      mlCreds,
      accountKey,
      categoryId: inferredCategoryId,
      currentListingTypeId: "gold_special",
    });

    const mappedSpecs = this.mapSpecsRowsToCategoryAttributes(
      [
        {
          section_name: "Ficha tecnica da origem",
          section_key: "secondary",
          rows: sourceSpecs,
        },
      ],
      categoryContext.attributes_meta,
    );
    const mergedAttributes = this.mergeAttributesWithCategoryMeta(
      mappedSpecs.matched,
      categoryContext.attributes_meta,
    );
    const splittedAttributes = this.splitAttributesForUi(mergedAttributes);

    const syntheticItem = {
      id: sourceItemId,
      title,
      category_id: inferredCategoryId || "",
      category_name: categoryContext.category_name || sourceCategoryName || null,
      price,
      currency_id: "BRL",
      available_quantity: availableQuantity,
      buying_mode: "buy_it_now",
      listing_type_id: "gold_special",
      condition: "new",
      pictures: uniqueImages.map((imageUrl) => ({ source: imageUrl })),
      attributes: splittedAttributes.payload,
      sale_terms: [],
      shipping: null,
      variations: [],
      permalink: sourceUrl,
      seller_id: toNumberOrNull(sourceShopNumeric),
      family_name: null,
      max_title_length: categoryContext.max_title_length || 120,
    };

    const draftPayload = normalizeDraftPayload(syntheticItem, description);
    draftPayload.clone_mode = "unitario";
    draftPayload.variations = [];
    draftPayload.source_platform = "shopee";
    draftPayload.category_name =
      categoryContext.category_name || draftPayload.category_name || sourceCategoryName;
    draftPayload.category_path = categoryContext.category_path || sourceCategoryPath || null;
    draftPayload.max_title_length = Number.isFinite(Number(categoryContext.max_title_length))
      ? Math.floor(Number(categoryContext.max_title_length))
      : draftPayload.max_title_length || 120;
    draftPayload.condition_options = categoryContext.condition_options;
    draftPayload.listing_type_options = listingTypeOptions;
    draftPayload.attributes = splittedAttributes.payload;
    draftPayload.attributes_main = splittedAttributes.main;
    draftPayload.attributes_secondary = splittedAttributes.secondary;
    draftPayload.attributes_unmatched = mappedSpecs.unmatched;
    draftPayload.source_item_snapshot = {
      ...(draftPayload.source_item_snapshot || {}),
      platform: "shopee",
      source_category_path: sourceCategoryPath || null,
    };

    const notes = [];
    if (!inferredCategoryId) {
      notes.push("Nao foi possivel sugerir categoria do Mercado Livre automaticamente. Revise a categoria antes de validar/publicar.");
    }
    if (!Number.isFinite(Number(price)) || Number(price) <= 0) {
      notes.push("Preco nao foi identificado com seguranca na origem Shopee. Revise manualmente.");
    }
    if (!splittedAttributes.payload.length && sourceSpecs.length) {
      notes.push("Atributos da Shopee nao foram mapeados para IDs do Mercado Livre automaticamente. Revise os atributos obrigatorios.");
    }
    if (notes.length) {
      draftPayload.notes = notes;
    }

    await this.applyShippingContextToDraftPayload({
      draftPayload,
      categoryContext,
      mlCreds,
      accountKey,
    });

    const permalink = sourceUrl;
    const sourceTitle = title || sourceItemId;

    return {
      source: {
        source_url: sourceUrl,
        source_item_id: sourceItemId,
        source_title: sourceTitle,
        source_price: price,
        source_currency_id: "BRL",
        source_permalink: permalink,
        source_thumbnail: uniqueImages[0] || null,
        source_seller_id: toNumberOrNull(sourceShopNumeric),
        source_seller_nickname: null,
        source_category_id: String(item?.cat_id || "").trim() || null,
        source_category_name: sourceCategoryName,
        source_listing_type_id: "gold_special",
        source_condition: "new",
        source_platform: "shopee",
      },
      draft_payload: draftPayload,
    };
  }

  static async fetchPreviewFromHtmlFallback({
    source,
    mlCreds,
    accountKey,
    itemId,
    primaryError = null,
  }) {
    const publicUrls = buildPublicItemUrls(itemId, source);
    let response = null;
    let html = "";
    let publicUrl = publicUrls[0] || String(source || "").trim();

    for (const candidateUrl of publicUrls) {
      const currentResponse = await fetch(candidateUrl, {
        method: "GET",
        headers: {
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        },
      });
      const currentHtml = await currentResponse.text().catch(() => "");
      response = currentResponse;

      if (currentResponse.ok && currentHtml.trim()) {
        html = currentHtml;
        publicUrl = candidateUrl;
        break;
      }
    }

    if (!response || !html.trim()) {
      if (primaryError) throw primaryError;
      throw new CloneDraftError(
        "Nao foi possivel obter preview do anuncio a partir da pagina publica.",
        (response && response.status) || 500,
        "preview_html_fetch_failed",
      );
    }

    return this.buildMlPreviewFromHtml({
      html,
      publicUrl,
      source,
      itemId,
      mlCreds,
      accountKey,
      primaryError,
    });
  }

  static async buildMlPreviewFromHtml({
    html,
    publicUrl,
    source,
    itemId,
    mlCreds,
    accountKey,
    primaryError = null,
  }) {
    const nordicPreview = extractMlPreviewFromNordicContext(html);
    const embeddedPreview = extractMlPreviewFromEmbeddedJson(html, itemId);
    const jsonLdList = extractJsonLdObjects(html);
    const product = pickProductFromJsonLd(jsonLdList) || {};
    const offers = Array.isArray(product?.offers)
      ? product.offers[0] || {}
      : product?.offers || {};
    const ogTitle = normalizeExtractedText(
      extractMetaContent(html, "og:title") ||
        extractMetaContent(html, "twitter:title") ||
        "",
    ).replace(/\s*\|\s*MercadoLivre.*$/i, "");
    const ogDescription = normalizeExtractedText(
      extractMetaContent(html, "og:description") ||
        extractMetaContent(html, "twitter:description") ||
        extractMetaContent(html, "description") ||
        "",
    );
    const ogImage =
      extractMetaContent(html, "og:image") ||
      extractMetaContent(html, "twitter:image") ||
      "";

    const title =
      String(nordicPreview?.title || "").trim() ||
      String(embeddedPreview?.title || "").trim() ||
      String(product?.name || "").trim() ||
      ogTitle ||
      decodeBasicHtmlEntities(
        firstRegexGroup(html, /<title[^>]*>([\s\S]*?)<\/title>/i) || "",
      );

    const description =
      String(nordicPreview?.description || "").trim() ||
      String(embeddedPreview?.description || "").trim() ||
      extractDescriptionFromHtml(
        html,
        String(product?.description || ogDescription || "").trim(),
      );

    const price =
      toNumberOrNull(nordicPreview?.price) ||
      toNumberOrNull(embeddedPreview?.price) ||
      toNumberOrNull(offers?.price) ||
      toNumberOrNull(extractMetaContent(html, "product:price:amount")) ||
      toNumberOrNull(firstRegexGroup(html, /"price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i));

    const currency =
      String(nordicPreview?.currency_id || "").trim().toUpperCase() ||
      String(embeddedPreview?.currency_id || "").trim().toUpperCase() ||
      String(offers?.priceCurrency || "").trim().toUpperCase() ||
      String(extractMetaContent(html, "product:price:currency") || "")
        .trim()
        .toUpperCase() ||
      String(firstRegexGroup(html, /"currency_id"\s*:\s*"([A-Z]{3})"/i) || "")
        .trim()
        .toUpperCase() ||
      "BRL";

    const categoryId =
      String(nordicPreview?.category_id || "").trim().toUpperCase() ||
      String(embeddedPreview?.category_id || "").trim().toUpperCase() ||
      String(firstRegexGroup(html, /"category_id"\s*:\s*"([A-Z0-9_]+)"/i) || "")
        .trim()
        .toUpperCase();

    const listingTypeId =
      String(nordicPreview?.listing_type_id || "")
        .trim()
        .toLowerCase() ||
      String(embeddedPreview?.listing_type_id || "")
        .trim()
        .toLowerCase() ||
      String(firstRegexGroup(html, /"listing_type_id"\s*:\s*"([a-z0-9_]+)"/i) || "")
        .trim()
        .toLowerCase() || "gold_special";

    const condition =
      String(nordicPreview?.condition || "")
        .trim()
        .toLowerCase() ||
      String(embeddedPreview?.condition || "")
        .trim()
        .toLowerCase() ||
      String(firstRegexGroup(html, /"condition"\s*:\s*"([a-z_]+)"/i) || "")
        .trim()
        .toLowerCase() || "new";

    const sellerId =
      toNumberOrNull(nordicPreview?.seller_id) ||
      toNumberOrNull(embeddedPreview?.seller_id) ||
      toNumberOrNull(
        firstRegexGroup(html, /"seller_id"\s*:\s*([0-9]+)/i),
      );

    const sellerNickname =
      String(nordicPreview?.seller_nickname || "").trim() ||
      String(embeddedPreview?.seller_nickname || "").trim() ||
      String(offers?.seller?.name || "").trim() ||
      String(
        firstRegexGroup(html, /"seller_nickname"\s*:\s*"([^"]+)"/i) || "",
      ).trim() ||
      null;

    const imagesRaw = [];
    const addImage = (value) => {
      const src = String(value || "").trim();
      if (!src) return;
      if (!/^https?:\/\//i.test(src)) return;
      imagesRaw.push(src);
    };
    for (const entry of Array.isArray(nordicPreview?.images) ? nordicPreview.images : []) {
      addImage(entry);
    }
    for (const entry of Array.isArray(embeddedPreview?.images) ? embeddedPreview.images : []) {
      addImage(entry);
    }
    if (Array.isArray(product?.image)) {
      for (const entry of product.image) addImage(entry);
    } else {
      addImage(product?.image);
    }
    addImage(ogImage);
    addImage(firstRegexGroup(html, /"thumbnail"\s*:\s*"(https?:\/\/[^"]+)"/i));
    for (const htmlImage of extractMlImageUrlsFromHtml(html)) {
      addImage(htmlImage);
    }

    const uniqueImages = dedupeMlImageUrls(imagesRaw, 10);
    const firstImage = uniqueImages[0] || null;

    const sourcePermalink =
      String(nordicPreview?.source_permalink || "").trim() ||
      String(embeddedPreview?.source_permalink || "").trim() ||
      String(offers?.url || "").trim() ||
      extractCanonicalUrlFromHtml(html) ||
      removeHashFromUrl(publicUrl) ||
      null;
    const resolvedItemId =
      normalizeItemId(nordicPreview?.item_id) ||
      normalizeItemId(embeddedPreview?.item_id) ||
      String(itemId || "").trim().toUpperCase();

    const specsBlocks =
      Array.isArray(nordicPreview?.specs_blocks) && nordicPreview.specs_blocks.length
        ? nordicPreview.specs_blocks
        : Array.isArray(embeddedPreview?.specs_blocks) && embeddedPreview.specs_blocks.length
          ? embeddedPreview.specs_blocks
          : extractSpecsFromHtml(html);
    const hasMeaningfulData =
      !!String(title || "").trim() &&
      !/^Item\s+ML[A-Z]?\d+$/i.test(String(title || "").trim()) &&
      (Number.isFinite(Number(price)) ||
        uniqueImages.length > 0 ||
        !!String(categoryId || "").trim() ||
        !!String(description || "").trim() ||
        specsBlocks.some((block) => Array.isArray(block?.rows) && block.rows.length));

    if (!hasMeaningfulData) {
      if (primaryError) throw primaryError;
      throw new CloneDraftError(
        "A pagina publica foi carregada, mas nao trouxe dados suficientes para clonar o anuncio.",
        422,
        "preview_html_content_insufficient",
      );
    }

    const syntheticItem = {
      id: resolvedItemId,
      title: title || `Item ${itemId}`,
      price,
      currency_id: currency || "BRL",
      category_id: categoryId || "",
      listing_type_id: listingTypeId || "gold_special",
      condition: condition || "new",
      seller_id: sellerId,
      thumbnail: firstImage,
      permalink: sourcePermalink,
      pictures: uniqueImages.map((sourceUrl) => ({ source: sourceUrl })),
      available_quantity: 1,
      buying_mode: "buy_it_now",
      attributes: [],
      sale_terms: [],
      shipping: null,
      variations: [],
    };

    const categoryContext = await this.resolveCategoryContext({
      categoryId,
      mlCreds,
      accountKey,
    });
    const listingTypeOptions = await this.resolveListingTypeOptions({
      mlCreds,
      accountKey,
      categoryId,
      currentListingTypeId: listingTypeId,
    });
    const specsMapped = this.mapSpecsRowsToCategoryAttributes(
      specsBlocks,
      categoryContext.attributes_meta,
    );
    const mergedAttributes = this.mergeAttributesWithCategoryMeta(
      specsMapped.matched,
      categoryContext.attributes_meta,
    );
    const splittedAttributes = this.splitAttributesForUi(mergedAttributes);

    const draftPayload = normalizeDraftPayload(syntheticItem, description);
    const sourceCategoryName =
      (String(nordicPreview?.category_path || embeddedPreview?.category_path || "")
        .trim()
        .split(" > ")
        .filter(Boolean)
        .slice(-1)[0] || null) ||
      categoryId ||
      null;
    draftPayload.source_platform = "mercadolivre";
    draftPayload.category_name =
      categoryContext.category_name || draftPayload.category_name || sourceCategoryName;
    draftPayload.category_path =
      categoryContext.category_path ||
      String(nordicPreview?.category_path || "").trim() ||
      String(embeddedPreview?.category_path || "").trim() ||
      null;
    draftPayload.max_title_length = Number.isFinite(Number(categoryContext.max_title_length))
      ? Math.floor(Number(categoryContext.max_title_length))
      : draftPayload.max_title_length || 120;
    draftPayload.condition_options = categoryContext.condition_options;
    draftPayload.listing_type_options = listingTypeOptions;
    draftPayload.attributes = splittedAttributes.payload;
    draftPayload.attributes_main = splittedAttributes.main;
    draftPayload.attributes_secondary = splittedAttributes.secondary;
    draftPayload.attributes_unmatched = specsMapped.unmatched;
    draftPayload.family_name = resolveFamilyNameFromDraft(draftPayload);

    await this.applyShippingContextToDraftPayload({
      draftPayload,
      categoryContext,
      mlCreds,
      accountKey,
    });

    const sourceTitle = title || draftPayload.title || `Item ${itemId}`;

    return {
      source: {
        source_url: String(source || publicUrl).trim(),
        source_item_id: syntheticItem.id,
        source_title: sourceTitle,
        source_price: price,
        source_currency_id: currency || "BRL",
        source_permalink: sourcePermalink,
        source_thumbnail: firstImage,
        source_seller_id: sellerId,
        source_seller_nickname: sellerNickname,
        source_category_id: categoryId || "",
        source_category_name:
          categoryContext.category_name ||
          sourceCategoryName,
        source_listing_type_id: listingTypeId || "",
        source_condition: condition || null,
        source_platform: "mercadolivre",
      },
      draft_payload: draftPayload,
      fallback_source: "html_page",
    };
  }

  static async fetchPreviewFromBrowserCapture({
    source,
    html,
    mlCreds,
    accountKey,
  }) {
    const capturedHtml = String(html || "").trim();
    if (!capturedHtml) {
      throw new CloneDraftError(
        "A captura do navegador veio vazia. Abra o anuncio no Mercado Livre e clique no botao novamente.",
        400,
        "browser_capture_empty",
      );
    }

    const rawSource = String(source || "").trim();
    let sourceRef = null;
    try {
      sourceRef = rawSource ? parseSourceReference(rawSource) : null;
    } catch {
      sourceRef = null;
    }

    const detectedItemId =
      sourceRef?.itemId ||
      normalizeItemId(
        firstRegexGroup(capturedHtml, /meli:\/\/item\?id=(M[A-Z]{2}\d{6,})/i),
      ) ||
      normalizeItemId(
        firstRegexGroup(capturedHtml, /"item_id"\s*:\s*"?(M[A-Z]{2}\d{6,})"?/i),
      ) ||
      normalizeItemId(
        firstRegexGroup(capturedHtml, /"itemId"\s*:\s*"?(M[A-Z]{2}\d{6,})"?/i),
      );

    const publicUrl =
      sourceRef?.sourceUrl ||
      extractCanonicalUrlFromHtml(capturedHtml) ||
      extractMetaContent(capturedHtml, "og:url") ||
      rawSource ||
      "";

    return this.buildMlPreviewFromHtml({
      html: capturedHtml,
      publicUrl,
      source: rawSource || publicUrl,
      itemId: detectedItemId,
      mlCreds,
      accountKey,
      primaryError: null,
    });
  }

  static async fetchPreviewFromSource({ source, mlCreds, accountKey }) {
    const sourceRef = parseSourceReference(source);
    if (sourceRef.platform === "shopee") {
      return this.fetchPreviewFromShopeeSource({
        source: sourceRef.sourceUrl || source,
        mlCreds,
        accountKey,
      });
    }

    const itemId = sourceRef.itemId;
    const normalizedSourceUrl = sourceRef.sourceUrl || String(source || "").trim();
    let htmlFallbackPreview = null;
    let htmlFallbackError = null;

    try {
      htmlFallbackPreview = await this.fetchPreviewFromHtmlFallback({
        source: normalizedSourceUrl,
        mlCreds,
        accountKey,
        itemId,
        primaryError: null,
      });
      if (htmlFallbackPreview) {
        return htmlFallbackPreview;
      }
    } catch (error) {
      htmlFallbackError = error;
    }

    let item = null;
    try {
      item = await this.mlGetItemPreferPublic(itemId, { mlCreds, accountKey });
    } catch (error) {
      const shouldReportScrapeFailure =
        htmlFallbackError || this.shouldUseHtmlFallback(error);
      if (!shouldReportScrapeFailure) throw error;
      throw new CloneDraftError(
        "Nao foi possivel obter os dados pela pagina publica do anuncio, e a API do Mercado Livre bloqueou o acesso. Tente informar o link publico completo do anuncio ou tente novamente em alguns minutos.",
        Number(htmlFallbackError?.status || error?.status || 502),
        "ml_public_scrape_unavailable",
        {
          item_id: itemId,
          html_error: htmlFallbackError
            ? {
                code: htmlFallbackError.code || "html_scrape_error",
                message: htmlFallbackError.message,
                status: htmlFallbackError.status || null,
              }
            : null,
          api_error: {
            code: error.code || "ml_api_error",
            message: error.message,
            status: error.status || null,
          },
        },
      );
    }

    let descriptionPlainText = "";
    try {
      const desc = await this.mlGetJsonPreferPublic(
        `/items/${encodeURIComponent(itemId)}/description`,
        { mlCreds, accountKey },
      );
      descriptionPlainText = String(
        desc?.plain_text || desc?.text || "",
      ).trim();
    } catch {
      descriptionPlainText = "";
    }

    const sourcePicturesCount = sanitizePictures(item).length;
    const sourceAttributesCount = sanitizeAttributes(item?.attributes).length;
    const shouldTryHtmlFallback =
      !descriptionPlainText ||
      descriptionPlainText.length < 80 ||
      sourcePicturesCount < 2 ||
      sourceAttributesCount < 8;
    if (shouldTryHtmlFallback) {
      try {
        htmlFallbackPreview = await this.fetchPreviewFromHtmlFallback({
          source: normalizedSourceUrl,
          mlCreds,
          accountKey,
          itemId,
          primaryError: null,
        });
        const htmlDescription = String(
          htmlFallbackPreview?.draft_payload?.description_plain_text || "",
        ).trim();
        if (
          htmlDescription &&
          (!descriptionPlainText || htmlDescription.length > descriptionPlainText.length)
        ) {
          descriptionPlainText = htmlDescription;
        }
      } catch {
        htmlFallbackPreview = null;
      }
    }

    let sellerNickname = null;
    const sellerId = toNumberOrNull(item?.seller_id);
    if (sellerId) {
      try {
        const seller = await this.mlGetJsonPreferPublic(`/users/${sellerId}`, {
          mlCreds,
          accountKey,
        });
        sellerNickname =
          seller?.nickname != null && String(seller.nickname).trim()
            ? String(seller.nickname).trim()
            : null;
      } catch {
        sellerNickname = null;
      }
    }

    const categoryId = String(item?.category_id || "").trim().toUpperCase();
    const categoryContext = await this.resolveCategoryContext({
      categoryId,
      mlCreds,
      accountKey,
    });
    const listingTypeOptions = await this.resolveListingTypeOptions({
      mlCreds,
      accountKey,
      categoryId,
      currentListingTypeId: String(item?.listing_type_id || "").trim(),
    });
    const fallbackMappedAttributes = Array.isArray(htmlFallbackPreview?.draft_payload?.attributes)
      ? htmlFallbackPreview.draft_payload.attributes
      : [];
    let mergedAttributes = this.mergeAttributesWithCategoryMeta(
      [
        ...fallbackMappedAttributes,
        ...(Array.isArray(item?.attributes) ? item.attributes : []),
      ],
      categoryContext.attributes_meta,
    );
    const splittedAttributes = this.splitAttributesForUi(mergedAttributes);

    const draftPayload = normalizeDraftPayload(item, descriptionPlainText);
    const fallbackPictures = Array.isArray(htmlFallbackPreview?.draft_payload?.pictures)
      ? htmlFallbackPreview.draft_payload.pictures
      : [];
    if (fallbackPictures.length) {
      const currentPictures = Array.isArray(draftPayload.pictures) ? draftPayload.pictures : [];
      const mergedSources = dedupeMlImageUrls(
        [
          ...currentPictures.map((entry) => entry?.source || entry),
          ...fallbackPictures.map((entry) => entry?.source || entry),
        ],
        10,
      );
      if (mergedSources.length) {
        draftPayload.pictures = mergedSources.map((source) => ({ source }));
      }
    }
    draftPayload.source_platform = "mercadolivre";
    draftPayload.category_name =
      categoryContext.category_name || draftPayload.category_name || null;
    draftPayload.category_path = categoryContext.category_path || null;
    draftPayload.max_title_length = Number.isFinite(Number(categoryContext.max_title_length))
      ? Math.floor(Number(categoryContext.max_title_length))
      : draftPayload.max_title_length || 120;
    draftPayload.condition_options = categoryContext.condition_options;
    draftPayload.listing_type_options = listingTypeOptions;
    draftPayload.attributes = splittedAttributes.payload;
    draftPayload.attributes_main = splittedAttributes.main;
    draftPayload.attributes_secondary = splittedAttributes.secondary;
    draftPayload.attributes_unmatched = Array.isArray(
      htmlFallbackPreview?.draft_payload?.attributes_unmatched,
    )
      ? htmlFallbackPreview.draft_payload.attributes_unmatched
      : [];
    draftPayload.family_name = resolveFamilyNameFromDraft(draftPayload);

    await this.applyShippingContextToDraftPayload({
      draftPayload,
      categoryContext,
      mlCreds,
      accountKey,
    });

    const pictures = Array.isArray(draftPayload.pictures) ? draftPayload.pictures : [];
    const firstPicture = pictures[0]?.source || item?.thumbnail || null;

    return {
      source: {
        source_url: normalizedSourceUrl,
        source_item_id: String(item?.id || itemId).trim().toUpperCase(),
        source_title: String(item?.title || "").trim(),
        source_price: toNumberOrNull(item?.price),
        source_currency_id: String(item?.currency_id || "").trim() || "BRL",
        source_permalink:
          item?.permalink != null && String(item.permalink).trim()
            ? String(item.permalink).trim()
            : null,
        source_thumbnail: firstPicture ? String(firstPicture) : null,
        source_seller_id: sellerId,
        source_seller_nickname: sellerNickname,
        source_category_id: String(item?.category_id || "").trim(),
        source_category_name:
          categoryContext.category_name ||
          String(item?.category_name || "").trim() ||
          null,
        source_listing_type_id: String(item?.listing_type_id || "").trim(),
        source_condition: String(item?.condition || "").trim() || null,
        source_platform: "mercadolivre",
      },
      draft_payload: draftPayload,
    };
  }

  static async createDraftFromSource({
    source,
    mlCreds,
    accountKey,
    userId = null,
  }) {
    const preview = await this.fetchPreviewFromSource({ source, mlCreds, accountKey });

    const draftPayloadText = JSON.stringify(preview.draft_payload || {});
    const status = "em_revisao";
    const resolvedAccountKey = normalizeAccountKey(accountKey || mlCreds?.account_key);
    const meliContaId = toNumberOrNull(mlCreds?.meli_conta_id);
    const actor = toNumberOrNull(userId);

    const sql = `
      INSERT INTO ml.anuncio_clone_drafts (
        account_key,
        meli_conta_id,
        created_by,
        updated_by,
        source_url,
        source_item_id,
        source_seller_id,
        source_seller_nickname,
        source_title,
        source_permalink,
        status,
        draft_payload
      ) VALUES (
        $1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb
      )
      RETURNING *
    `;

    try {
      const result = await db.query(sql, [
        resolvedAccountKey,
        meliContaId,
        actor,
        preview.source.source_url,
        preview.source.source_item_id,
        preview.source.source_seller_id,
        preview.source.source_seller_nickname,
        preview.source.source_title,
        preview.source.source_permalink,
        status,
        draftPayloadText,
      ]);
      return mapDraftRow(result.rows[0]);
    } catch (error) {
      if (error?.code === "42P01") {
        throw new CloneDraftError(
          "Tabela de rascunhos nao encontrada. Rode npm run migrate no ml/ antes de usar a tela de clonagem.",
          500,
          "draft_table_missing",
        );
      }
      throw error;
    }
  }

  static async createDraftFromBrowserCapture({
    source,
    html,
    mlCreds,
    accountKey,
    userId = null,
  }) {
    const preview = await this.fetchPreviewFromBrowserCapture({
      source,
      html,
      mlCreds,
      accountKey,
    });

    const draftPayloadText = JSON.stringify(preview.draft_payload || {});
    const status = "em_revisao";
    const resolvedAccountKey = normalizeAccountKey(accountKey || mlCreds?.account_key);
    const meliContaId = toNumberOrNull(mlCreds?.meli_conta_id);
    const actor = toNumberOrNull(userId);

    const sql = `
      INSERT INTO ml.anuncio_clone_drafts (
        account_key,
        meli_conta_id,
        created_by,
        updated_by,
        source_url,
        source_item_id,
        source_seller_id,
        source_seller_nickname,
        source_title,
        source_permalink,
        status,
        draft_payload
      ) VALUES (
        $1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb
      )
      RETURNING *
    `;

    try {
      const result = await db.query(sql, [
        resolvedAccountKey,
        meliContaId,
        actor,
        preview.source.source_url,
        preview.source.source_item_id,
        preview.source.source_seller_id,
        preview.source.source_seller_nickname,
        preview.source.source_title,
        preview.source.source_permalink,
        status,
        draftPayloadText,
      ]);
      return mapDraftRow(result.rows[0]);
    } catch (error) {
      if (error?.code === "42P01") {
        throw new CloneDraftError(
          "Tabela de rascunhos nao encontrada. Rode npm run migrate no ml/ antes de usar a tela de clonagem.",
          500,
          "draft_table_missing",
        );
      }
      throw error;
    }
  }

  static async listDrafts({ mlCreds, accountKey, limit = 20 }) {
    const params = [];
    const scopeFilter = buildScopeFilter(
      {
        meliContaId: toNumberOrNull(mlCreds?.meli_conta_id),
        accountKey: normalizeAccountKey(accountKey || mlCreds?.account_key),
      },
      params,
    );
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    params.push(safeLimit);

    const sql = `
      SELECT d.*
      FROM ml.anuncio_clone_drafts d
      WHERE ${scopeFilter}
      ORDER BY d.created_at DESC
      LIMIT $${params.length}
    `;

    const result = await db.query(sql, params);
    return result.rows.map(mapDraftRow);
  }

  static async getDraftById({ draftId, mlCreds, accountKey }) {
    const id = Number(draftId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new CloneDraftError("Rascunho invalido.", 400, "draft_invalid");
    }

    const params = [id];
    const scopeFilter = buildScopeFilter(
      {
        meliContaId: toNumberOrNull(mlCreds?.meli_conta_id),
        accountKey: normalizeAccountKey(accountKey || mlCreds?.account_key),
      },
      params,
    );

    const sql = `
      SELECT d.*
      FROM ml.anuncio_clone_drafts d
      WHERE d.id = $1 AND ${scopeFilter}
      LIMIT 1
    `;

    const result = await db.query(sql, params);
    const row = result.rows[0];
    if (!row) {
      throw new CloneDraftError("Rascunho nao encontrado.", 404, "draft_not_found");
    }
    return mapDraftRow(row);
  }

  static mergeDraftPayload(currentPayload, patch = {}) {
    const payload = { ...(currentPayload || {}) };

    if (patch.title != null) {
      const title = String(patch.title || "").trim();
      if (!title) {
        throw new CloneDraftError("Titulo nao pode ficar vazio.", 400, "title_required");
      }
      payload.title = title;
    }

    if (patch.family_name != null) {
      const familyName = String(patch.family_name || "").trim();
      payload.family_name = familyName || null;
    }

    if (patch.clone_mode != null) {
      const mode = normalizeCloneMode(patch.clone_mode);
      if (!mode) {
        throw new CloneDraftError(
          "Modo de clonagem invalido. Use unitario ou variacoes.",
          400,
          "clone_mode_invalid",
        );
      }
      payload.clone_mode = mode;
    }

    if (patch.price != null) {
      const price = toNumberOrNull(patch.price);
      if (price == null || price <= 0) {
        throw new CloneDraftError("Preco invalido para o rascunho.", 400, "price_invalid");
      }
      payload.price = Number(price);
    }

    if (patch.currency_id != null) {
      const currency = String(patch.currency_id || "").trim().toUpperCase();
      if (!currency) {
        throw new CloneDraftError("Moeda invalida.", 400, "currency_invalid");
      }
      payload.currency_id = currency;
    }

    if (patch.category_id != null) {
      const category = String(patch.category_id || "").trim().toUpperCase();
      if (!category) {
        throw new CloneDraftError("Categoria invalida.", 400, "category_invalid");
      }
      payload.category_id = category;
    }

    if (patch.listing_type_id != null) {
      const listingType = String(patch.listing_type_id || "").trim();
      if (!listingType) {
        throw new CloneDraftError("Tipo de anuncio invalido.", 400, "listing_type_invalid");
      }
      payload.listing_type_id = listingType;
    }

    if (patch.buying_mode != null) {
      const buyingMode = String(patch.buying_mode || "").trim();
      if (!buyingMode) {
        throw new CloneDraftError("Modo de compra invalido.", 400, "buying_mode_invalid");
      }
      payload.buying_mode = buyingMode;
    }

    if (patch.condition != null) {
      const condition = String(patch.condition || "").trim().toLowerCase();
      if (!condition) {
        throw new CloneDraftError("Condicao invalida.", 400, "condition_invalid");
      }
      payload.condition = condition;
    }

    if (patch.available_quantity != null) {
      const quantity = Math.floor(Number(patch.available_quantity));
      if (!Number.isFinite(quantity) || quantity < 0) {
        throw new CloneDraftError("Quantidade invalida.", 400, "quantity_invalid");
      }
      payload.available_quantity = quantity;
    }

    if (patch.description_plain_text != null) {
      payload.description_plain_text = String(patch.description_plain_text || "").trim();
    }

    const attributes = parseJsonInput(patch.attributes, "Atributos", {
      allowArray: true,
      allowObject: false,
    });
    if (attributes !== undefined) {
      payload.attributes = sanitizeAttributes(attributes);
    }

    const attributesExtra = parseJsonInput(
      patch.attributes_extra,
      "Atributos adicionais",
      {
        allowArray: true,
        allowObject: false,
      },
    );
    if (attributesExtra !== undefined) {
      payload.attributes_extra = sanitizeAttributes(attributesExtra);
    }

    const saleTerms = parseJsonInput(patch.sale_terms, "Termos de venda", {
      allowArray: true,
      allowObject: false,
    });
    if (saleTerms !== undefined) {
      payload.sale_terms = sanitizeSaleTerms(saleTerms);
    }

    if (patch.pictures != null) {
      if (typeof patch.pictures === "string") {
        const lines = String(patch.pictures)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(0, 10);
        payload.pictures = lines.map((source) => ({ source }));
      } else if (Array.isArray(patch.pictures)) {
        const cleaned = patch.pictures
          .map((entry) => {
            if (typeof entry === "string") return { source: entry.trim() };
            if (entry && typeof entry === "object") {
              const source = String(entry.source || "").trim();
              return source ? { source } : null;
            }
            return null;
          })
          .filter(Boolean)
          .slice(0, 10);
        payload.pictures = cleaned;
      } else {
        throw new CloneDraftError(
          "Imagens precisam ser texto (uma URL por linha) ou lista.",
          400,
          "pictures_invalid",
        );
      }
    }

    const shipping = parseJsonInput(patch.shipping, "Shipping", {
      allowArray: false,
      allowObject: true,
    });
    if (shipping !== undefined) {
      payload.shipping = sanitizeShipping(shipping);
    }

    const variations = parseJsonInput(patch.variations, "Variacoes", {
      allowArray: true,
      allowObject: false,
    });
    if (variations !== undefined) {
      payload.variations = sanitizeVariations(variations);
    }

    if (patch.warranty != null) {
      const warranty = String(patch.warranty || "").trim();
      payload.warranty = warranty || null;
    }

    if (patch.video_id != null) {
      const videoId = String(patch.video_id || "").trim();
      payload.video_id = videoId || null;
    }

    payload.max_title_length =
      Number.isFinite(Number(payload.max_title_length)) &&
      Number(payload.max_title_length) > 0
        ? Math.floor(Number(payload.max_title_length))
        : 120;
    if (!Array.isArray(payload.attributes_extra)) {
      payload.attributes_extra = [];
    }
    payload.family_name = resolveFamilyNameFromDraft(payload);

    return payload;
  }

  static async updateDraftReview({
    draftId,
    patch = {},
    mlCreds,
    accountKey,
    userId = null,
  }) {
    const current = await this.getDraftById({ draftId, mlCreds, accountKey });
    const payload = this.mergeDraftPayload(current.draft_payload, patch);
    const categoryContext = await this.resolveCategoryContext({
      categoryId: payload?.category_id || current?.draft_payload?.category_id,
      mlCreds,
      accountKey,
    });
    await this.applyShippingContextToDraftPayload({
      draftPayload: payload,
      categoryContext,
      mlCreds,
      accountKey,
    });

    const nextStatusRaw =
      patch?.status != null ? String(patch.status || "").trim().toLowerCase() : null;
    const nextStatus = nextStatusRaw || current.status || "em_revisao";
    if (!["em_revisao", "pronto_publicar", "publicado", "cancelado"].includes(nextStatus)) {
      throw new CloneDraftError("Status invalido para o rascunho.", 400, "status_invalid");
    }

    const reviewNotes =
      patch?.review_notes != null
        ? String(patch.review_notes || "").trim()
        : current.review_notes || "";

    const updatedBy = toNumberOrNull(userId);

    const sql = `
      UPDATE ml.anuncio_clone_drafts
      SET
        draft_payload = $2::jsonb,
        status = $3,
        review_notes = $4,
        updated_by = $5,
        updated_at = now()
      WHERE id = $1
      RETURNING *
    `;

    const result = await db.query(sql, [
      Number(draftId),
      JSON.stringify(payload),
      nextStatus,
      reviewNotes,
      updatedBy,
    ]);

    return mapDraftRow(result.rows[0]);
  }

  static buildValidationPayload(draft) {
    const normalizedVariations = sanitizeVariations(draft?.variations);
    const normalizedAttributes = sanitizeAttributes(draft?.attributes);
    const normalizedExtraAttributes = sanitizeAttributes(draft?.attributes_extra);
    const mergedAttributesRaw = mergeAttributeLists(
      normalizedAttributes,
      normalizedExtraAttributes,
    );
    const mergedAttributes = filterUnsupportedSyntheticAttributes(
      mergedAttributesRaw,
      draft,
    );
    const requestedMode = normalizeCloneMode(draft?.clone_mode);
    const hasVariations = normalizedVariations.length > 0;
    const useVariations =
      requestedMode === "variacoes"
        ? hasVariations
        : requestedMode === "unitario"
          ? false
          : hasVariations;
    const resolvedFamilyName = resolveFamilyNameFromDraft(draft);

    const payload = stripUndefinedFromObject({
      title: draft?.title,
      family_name: resolvedFamilyName || undefined,
      category_id: draft?.category_id,
      price: toNumberOrNull(draft?.price),
      currency_id: draft?.currency_id,
      available_quantity: useVariations
        ? undefined
        : Math.max(1, Math.floor(toNumberOrNull(draft?.available_quantity) || 1)),
      buying_mode: draft?.buying_mode || "buy_it_now",
      listing_type_id: draft?.listing_type_id || "gold_special",
      condition: draft?.condition || "new",
      description:
        draft?.description_plain_text != null
          ? String(draft.description_plain_text || "")
          : undefined,
      pictures: Array.isArray(draft?.pictures) ? draft.pictures : undefined,
      attributes: mergedAttributes.length ? mergedAttributes : undefined,
      sale_terms: Array.isArray(draft?.sale_terms) ? draft.sale_terms : undefined,
      shipping:
        draft?.shipping && typeof draft.shipping === "object"
          ? draft.shipping
          : undefined,
      variations: useVariations ? normalizedVariations : undefined,
      warranty: draft?.warranty || undefined,
      video_id: draft?.video_id || undefined,
    });

    if (!payload.title || !payload.category_id || !payload.price) {
      throw new CloneDraftError(
        "Rascunho incompleto para validacao. Revise titulo, categoria e preco.",
        400,
        "draft_incomplete",
      );
    }

    if (useVariations && Array.isArray(payload.variations) && payload.variations.length) {
      delete payload.available_quantity;
    }

    return payload;
  }

  static normalizePicturesForCreate(pictures) {
    if (!Array.isArray(pictures)) return undefined;
    const cleaned = pictures
      .map((entry) => {
        if (typeof entry === "string") {
          const source = String(entry || "").trim();
          return source ? { source } : null;
        }
        if (entry && typeof entry === "object") {
          const source = String(entry.source || entry.url || "").trim();
          return source ? { source } : null;
        }
        return null;
      })
      .filter(Boolean)
      .slice(0, 10);
    return cleaned.length ? cleaned : undefined;
  }

  static normalizeVariationsForCreate(variations) {
    if (!Array.isArray(variations) || !variations.length) return undefined;
    const out = [];

    for (const variation of variations) {
      const attributeCombinations = sanitizeAttributes(variation?.attribute_combinations);
      if (!attributeCombinations.length) continue;

      const item = stripUndefinedFromObject({
        price: toNumberOrNull(variation?.price),
        available_quantity: Math.max(
          0,
          Math.floor(toNumberOrNull(variation?.available_quantity) || 0),
        ),
        seller_custom_field:
          variation?.seller_custom_field != null &&
          String(variation.seller_custom_field).trim()
            ? String(variation.seller_custom_field).trim()
            : undefined,
        attribute_combinations: attributeCombinations,
        attributes: sanitizeAttributes(variation?.attributes),
        picture_ids: Array.isArray(variation?.picture_ids)
          ? variation.picture_ids
              .map((value) => String(value || "").trim())
              .filter(Boolean)
          : undefined,
      });

      out.push(item);
    }

    return out.length ? out : undefined;
  }

  static buildCreatePayload(draft) {
    const validated = this.buildValidationPayload(draft);
    const mergedAttributes = sanitizeAttributes(validated?.attributes);
    const descriptionPlainText =
      draft?.description_plain_text != null
        ? String(draft.description_plain_text || "").trim()
        : "";
    const normalizedValidatedVariations = this.normalizeVariationsForCreate(
      validated?.variations,
    );

    const payload = {
      ...validated,
      description: undefined,
      pictures: this.normalizePicturesForCreate(draft?.pictures),
      attributes: mergedAttributes.length ? mergedAttributes : undefined,
      sale_terms: sanitizeSaleTerms(draft?.sale_terms),
      shipping: sanitizeShipping(draft?.shipping),
      variations: normalizedValidatedVariations,
    };

    if (descriptionPlainText) {
      payload.description = { plain_text: descriptionPlainText };
    }

    return stripUndefinedFromObject(payload);
  }

  static async persistValidationResult({ draftId, validationResult, userId = null }) {
    const sql = `
      UPDATE ml.anuncio_clone_drafts
      SET
        last_validation = $2::jsonb,
        updated_by = $3,
        updated_at = now()
      WHERE id = $1
    `;
    await db.query(sql, [
      Number(draftId),
      JSON.stringify(validationResult),
      toNumberOrNull(userId),
    ]);
  }

  static async runValidationAgainstMl({
    draftId,
    draftPayload,
    state,
    userId = null,
  }) {
    const payload = this.buildValidationPayload(draftPayload);
    const validationAttempts = [];
    const runValidationAttempt = async (requestPayload) => {
      const response = await this.authFetch(
        state,
        `${ML_API_BASE}/items/validate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestPayload),
        },
      );
      const rawText = await response.text().catch(() => "");
      const rawJson = parseJsonColumn(rawText, null);
      const responseData = rawJson != null ? rawJson : rawText;
      return { response, responseData, requestPayload };
    };

    let attempt = await runValidationAttempt(payload);
    validationAttempts.push({
      request: attempt.requestPayload,
      response: attempt.responseData,
      http_status: attempt.response.status,
    });

    if (
      !attempt.response.ok &&
      attempt.requestPayload?.title != null &&
      isTitleInvalidForRequestedCall(attempt.responseData)
    ) {
      const retryPayload = stripUndefinedFromObject({
        ...attempt.requestPayload,
        title: undefined,
      });
      const retry = await runValidationAttempt(retryPayload);
      validationAttempts.push({
        request: retry.requestPayload,
        response: retry.responseData,
        http_status: retry.response.status,
      });
      attempt = retry;
    }

    const warningsOnly = isWarningsOnlyMlValidationResponse(attempt.responseData);

    const result = {
      validated_at: new Date().toISOString(),
      http_status: attempt.response.status,
      ok: attempt.response.ok,
      warnings_only: warningsOnly,
      request: attempt.requestPayload,
      response: attempt.responseData,
      attempts: validationAttempts,
    };

    await this.persistValidationResult({
      draftId,
      validationResult: result,
      userId,
    });

    return {
      ok: attempt.response.ok,
      warnings_only: warningsOnly,
      http_status: attempt.response.status,
      validation: result,
    };
  }

  static async validateDraftAgainstMl({ draftId, mlCreds, accountKey, userId = null }) {
    const draft = await this.getDraftById({ draftId, mlCreds, accountKey });
    const state = await this.prepareState({ mlCreds, accountKey });
    return this.runValidationAgainstMl({
      draftId,
      draftPayload: draft.draft_payload,
      state,
      userId,
    });
  }

  static async publishDraft({
    draftId,
    mlCreds,
    accountKey,
    userId = null,
    skipValidation = false,
  }) {
    const draft = await this.getDraftById({ draftId, mlCreds, accountKey });
    if (draft.status === "cancelado") {
      throw new CloneDraftError(
        "Nao e possivel publicar um rascunho cancelado.",
        400,
        "draft_canceled",
      );
    }

    if (draft.status === "publicado" && draft.published_item_id) {
      return {
        already_published: true,
        draft,
        publication: {
          item_id: draft.published_item_id,
          permalink: draft.published_permalink,
          published_at: draft.published_at,
        },
      };
    }

    const state = await this.prepareState({ mlCreds, accountKey });
    let validation = null;
    if (!skipValidation) {
      validation = await this.runValidationAgainstMl({
        draftId,
        draftPayload: draft.draft_payload,
        state,
        userId,
      });
      if (!validation.ok && validation.warnings_only !== true) {
        throw new CloneDraftError(
          "A validacao falhou. Ajuste o rascunho antes de publicar.",
          422,
          "publish_validation_failed",
          { validation },
        );
      }
    }

    const createPayload = this.buildCreatePayload(draft.draft_payload);
    const publishAttempts = [];
    const runPublishAttempt = async (requestPayload) => {
      const response = await this.authFetch(state, `${ML_API_BASE}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
      });
      const rawText = await response.text().catch(() => "");
      const rawJson = parseJsonColumn(rawText, null);
      const responseData = rawJson != null ? rawJson : rawText;
      return { response, responseData, requestPayload };
    };

    let publishAttempt = await runPublishAttempt(createPayload);
    publishAttempts.push({
      request: publishAttempt.requestPayload,
      response: publishAttempt.responseData,
      http_status: publishAttempt.response.status,
    });

    if (
      !publishAttempt.response.ok &&
      publishAttempt.requestPayload?.title != null &&
      isTitleInvalidForRequestedCall(publishAttempt.responseData)
    ) {
      const retryPayload = stripUndefinedFromObject({
        ...publishAttempt.requestPayload,
        title: undefined,
      });
      const retry = await runPublishAttempt(retryPayload);
      publishAttempts.push({
        request: retry.requestPayload,
        response: retry.responseData,
        http_status: retry.response.status,
      });
      publishAttempt = retry;
    }

    if (
      !publishAttempt.response.ok &&
      publishAttempt.requestPayload?.family_name != null &&
      responseMentionsField(publishAttempt.responseData, ["family_name"])
    ) {
      const retryPayload = stripUndefinedFromObject({
        ...publishAttempt.requestPayload,
        family_name: undefined,
      });
      const retry = await runPublishAttempt(retryPayload);
      publishAttempts.push({
        request: retry.requestPayload,
        response: retry.responseData,
        http_status: retry.response.status,
      });
      publishAttempt = retry;
    }

    if (
      !publishAttempt.response.ok &&
      publishAttempt.requestPayload?.description != null &&
      responseMentionsField(publishAttempt.responseData, ["description"])
    ) {
      const descriptionText = String(
        draft?.draft_payload?.description_plain_text || "",
      ).trim();

      if (
        typeof publishAttempt.requestPayload.description === "object" &&
        descriptionText
      ) {
        const retryWithText = await runPublishAttempt({
          ...publishAttempt.requestPayload,
          description: descriptionText,
        });
        publishAttempts.push({
          request: retryWithText.requestPayload,
          response: retryWithText.responseData,
          http_status: retryWithText.response.status,
        });
        publishAttempt = retryWithText;
      }

      if (!publishAttempt.response.ok) {
        const retryWithoutDescription = await runPublishAttempt(
          stripUndefinedFromObject({
            ...publishAttempt.requestPayload,
            description: undefined,
          }),
        );
        publishAttempts.push({
          request: retryWithoutDescription.requestPayload,
          response: retryWithoutDescription.responseData,
          http_status: retryWithoutDescription.response.status,
        });
        publishAttempt = retryWithoutDescription;
      }
    }

    const response = publishAttempt.response;
    const responseData = publishAttempt.responseData;

    if (!response.ok) {
      const rawJson =
        responseData && typeof responseData === "object" ? responseData : null;
      const rawText = typeof responseData === "string" ? responseData : "";
      const apiMessage =
        rawJson?.message ||
        rawJson?.error ||
        rawText ||
        `Falha ao publicar item (HTTP ${response.status}).`;
      throw new CloneDraftError(apiMessage, response.status, "publish_ml_error", {
        ml_response: responseData,
        attempts: publishAttempts,
      });
    }

    const rawJson =
      responseData && typeof responseData === "object" ? responseData : null;
    const publishedItemId = String(
      rawJson?.id || rawJson?.item_id || "",
    )
      .trim()
      .toUpperCase();
    const publishedPermalink =
      rawJson?.permalink != null && String(rawJson.permalink).trim()
        ? String(rawJson.permalink).trim()
        : null;

    if (!publishedItemId) {
      throw new CloneDraftError(
        "Publicacao sem item retornado pela API do Mercado Livre.",
        502,
        "publish_missing_item_id",
        { ml_response: responseData },
      );
    }

    const publishResult = {
      published_at: new Date().toISOString(),
      http_status: response.status,
      ok: true,
      request: publishAttempt.requestPayload,
      response: responseData,
      validation: validation?.validation || null,
      attempts: publishAttempts,
    };

    const sql = `
      UPDATE ml.anuncio_clone_drafts
      SET
        status = 'publicado',
        published_item_id = $2,
        published_permalink = $3,
        published_at = now(),
        last_publish_result = $4::jsonb,
        updated_by = $5,
        updated_at = now()
      WHERE id = $1
      RETURNING *
    `;

    let updatedRow = null;
    try {
      const result = await db.query(sql, [
        Number(draftId),
        publishedItemId,
        publishedPermalink,
        JSON.stringify(publishResult),
        toNumberOrNull(userId),
      ]);
      updatedRow = result.rows[0];
    } catch (error) {
      if (error?.code === "42703") {
        throw new CloneDraftError(
          "Colunas de publicacao nao encontradas na tabela de rascunhos. Rode npm run migrate no ml/ para aplicar as migracoes mais recentes.",
          500,
          "publish_columns_missing",
        );
      }
      throw error;
    }

    return {
      already_published: false,
      draft: mapDraftRow(updatedRow),
      publication: {
        item_id: publishedItemId,
        permalink: publishedPermalink,
        published_at: publishResult.published_at,
        response: responseData,
      },
    };
  }
}

module.exports = {
  ClonarAnuncioService,
  CloneDraftError,
  extractItemIdFromSource,
};
