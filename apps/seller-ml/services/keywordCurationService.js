"use strict";

const crypto = require("crypto");

const MISTRAL_API_URL = "https://api.mistral.ai/v1/chat/completions";
const DEFAULT_MODEL = "mistral-small-latest";
const CACHE_TTL_MS = Math.max(60_000, Number(process.env.KEYWORD_CURATION_CACHE_TTL_MS || 6 * 60 * 60 * 1000));
const CACHE_LIMIT = Math.max(10, Number(process.env.KEYWORD_CURATION_CACHE_LIMIT || 500));
const cache = new Map();

function text(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function getApiKey() {
  return text(process.env.ML_MISTRAL_API_KEY || process.env.MISTRAL_API_KEY || process.env.MISTRAL_AI_API_KEY);
}

function getModel() {
  return text(process.env.ML_MISTRAL_MODEL || process.env.MISTRAL_MODEL) || DEFAULT_MODEL;
}

function normalizeTerm(value) {
  return text(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function rowFromCandidate(row, source = "mistral_keyword_curation_fill") {
  if (!row?.term) return null;
  const score = Math.max(1, Math.min(100, safeNumber(row.score, 1) || 1));
  return {
    term: row.term,
    total: safeNumber(row.total, null),
    score,
    sample_size: safeNumber(row.sample_size, null),
    coverage_pct: safeNumber(row.coverage_pct, null),
    level: score >= 70 ? "high" : score >= 35 ? "medium" : "low",
    label: text(row.label || "Mantida para completar o ranking"),
    source,
  };
}

function compactCandidate(row) {
  const term = normalizeTerm(row?.term || row?.keyword || row?.value || "");
  if (!term) return null;
  return {
    term,
    total: safeNumber(row?.total ?? row?.occurrence_count ?? row?.count, null),
    score: Math.max(1, Math.min(100, safeNumber(row?.score, 1) || 1)),
    sample_size: safeNumber(row?.sample_size, null),
    label: text(row?.label || ""),
  };
}

function uniqueCandidates(candidates = []) {
  const seen = new Set();
  return (Array.isArray(candidates) ? candidates : [])
    .map(compactCandidate)
    .filter(Boolean)
    .filter((row) => {
      if (seen.has(row.term)) return false;
      seen.add(row.term);
      return true;
    })
    .slice(0, 80);
}

function hashPayload(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function pruneCache() {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (!value || now - value.created_at > CACHE_TTL_MS) cache.delete(key);
  }
  while (cache.size > CACHE_LIMIT) {
    const firstKey = cache.keys().next().value;
    if (!firstKey) break;
    cache.delete(firstKey);
  }
}

function extractJson(raw) {
  const value = text(raw);
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(value.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function normalizeAiResult(payload, candidates) {
  const byTerm = new Map(candidates.map((row) => [row.term, row]));
  const rows = Array.isArray(payload?.keywords_final)
    ? payload.keywords_final
    : Array.isArray(payload?.keywords)
      ? payload.keywords
      : [];
  const seen = new Set();
  const ranked = rows
    .map((row) => {
      const term = normalizeTerm(row?.term || row?.keyword || row?.value || "");
      if (!term || seen.has(term)) return null;
      seen.add(term);
      const original = byTerm.get(term) || null;
      const score = Math.max(1, Math.min(100, safeNumber(row?.score, original?.score || 1) || 1));
      const total = safeNumber(row?.total ?? row?.occurrences ?? row?.ocorrencias, original?.total);
      return {
        term,
        total,
        score,
        sample_size: safeNumber(row?.sample_size, original?.sample_size),
        coverage_pct: safeNumber(row?.coverage_pct, null),
        level: score >= 70 ? "high" : score >= 35 ? "medium" : "low",
        label: text(row?.label || row?.motivo || row?.reason || original?.label || "Curado por IA"),
        source: "mistral_keyword_curation",
      };
    })
    .filter(Boolean)
    .slice(0, 30);

  if (ranked.length < 30) {
    const removed = new Set(
      (Array.isArray(payload?.removidas_por_redundancia) ? payload.removidas_por_redundancia : [])
        .map(normalizeTerm)
        .filter(Boolean),
    );
    const filler = candidates
      .filter((row) => row?.term && !seen.has(row.term) && !removed.has(row.term))
      .sort((a, b) => (safeNumber(b.score, 0) - safeNumber(a.score, 0)) || (safeNumber(b.total, 0) - safeNumber(a.total, 0)));
    for (const row of filler) {
      if (ranked.length >= 30) break;
      const normalized = rowFromCandidate(row);
      if (!normalized) continue;
      ranked.push(normalized);
      seen.add(normalized.term);
    }
  }

  const suggestions = (Array.isArray(payload?.long_tail) ? payload.long_tail : Array.isArray(payload?.suggestions) ? payload.suggestions : [])
    .map(normalizeTerm)
    .filter(Boolean)
    .filter((term, index, arr) => arr.indexOf(term) === index)
    .slice(0, 10);

  return {
    ranked,
    suggestions,
    removed: Array.isArray(payload?.removidas_por_redundancia) ? payload.removidas_por_redundancia.map(normalizeTerm).filter(Boolean).slice(0, 40) : [],
    notes: Array.isArray(payload?.observacoes) ? payload.observacoes.map(text).filter(Boolean).slice(0, 6) : [],
  };
}

function buildPrompt({ title, category, candidates }) {
  return [
    "Voce e especialista em SEO de anuncios do Mercado Livre.",
    "Tarefa: curar palavras-chave candidatas extraidas de titulos de concorrentes.",
    "Remova termos redundantes, genericos demais, invertidos sem naturalidade ou duplicados semanticos.",
    "Priorize termos que um comprador realmente usaria na busca.",
    "Retorne ate 30 keywords finais e tente preencher as 30 sempre que houver candidatos aproveitaveis.",
    "Nao seja conservador demais: se um termo for comercialmente util e nao redundante, mantenha-o mesmo com score menor.",
    "Prefira frases de 2 a 4 palavras quando forem naturais.",
    "Use score 1-100 baseado em relevancia comercial e recorrencia.",
    "Retorne apenas JSON valido neste formato:",
    "{\"keywords_final\":[{\"term\":\"\",\"score\":0,\"total\":0,\"label\":\"\"}],\"removidas_por_redundancia\":[],\"long_tail\":[],\"observacoes\":[]}",
    "",
    `Titulo do anuncio: ${text(title) || "-"}`,
    `Categoria: ${text(category) || "-"}`,
    `Candidatos: ${JSON.stringify(candidates)}`,
  ].join("\n");
}

async function callMistral({ title, category, candidates }) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { available: false, source: "local_fallback", reason: "missing_mistral_api_key" };
  }

  const payloadForHash = { title: text(title), category: text(category), candidates };
  const cacheKey = hashPayload({ model: getModel(), ...payloadForHash });
  pruneCache();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.created_at <= CACHE_TTL_MS) {
    return { ...cached.value, cached: true };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(3_000, Number(process.env.MISTRAL_TIMEOUT_MS || 12_000)));
  try {
    const response = await fetch(MISTRAL_API_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: getModel(),
        temperature: 0.15,
        max_tokens: 1600,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "Responda somente JSON valido, sem markdown.",
          },
          {
            role: "user",
            content: buildPrompt({ title, category, candidates }),
          },
        ],
      }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        available: false,
        source: "local_fallback",
        reason: body?.message || body?.error?.message || `mistral_http_${response.status}`,
      };
    }
    const content = body?.choices?.[0]?.message?.content || "";
    const parsed = extractJson(content);
    if (!parsed) {
      return { available: false, source: "local_fallback", reason: "invalid_mistral_json" };
    }
    const normalized = normalizeAiResult(parsed, candidates);
    if (!normalized.ranked.length) {
      return { available: false, source: "local_fallback", reason: "empty_mistral_keywords" };
    }
    const value = {
      available: true,
      source: "mistral",
      model: getModel(),
      keywords: normalized,
    };
    cache.set(cacheKey, { created_at: Date.now(), value });
    return value;
  } catch (error) {
    return {
      available: false,
      source: "local_fallback",
      reason: error?.name === "AbortError" ? "mistral_timeout" : error?.message || "mistral_error",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function refineKeywords({ title = "", category = "", candidates = [] } = {}) {
  const compact = uniqueCandidates(candidates);
  if (!compact.length) {
    return { available: false, source: "local_fallback", reason: "empty_candidates" };
  }
  return callMistral({ title, category, candidates: compact });
}

module.exports = {
  refineKeywords,
};
