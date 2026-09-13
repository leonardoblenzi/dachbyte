const googleTrends = require("google-trends-api");

function safeJsonParse(name, raw) {
  const t = String(raw || "").trim();
  if (!t) throw new Error(`${name}_empty_response`);
  if (t.startsWith("<")) throw new Error(`${name}_returned_html_blocked`);
  return JSON.parse(t);
}

function clamp(n, a, b) {
  const x = Number(n);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

function timeframeFromPeriod(period) {
  // seus presets
  if (period === "7d") return "now 7-d";
  if (period === "30d") return "today 1-m";
  if (period === "90d") return "today 3-m";
  return "today 1-m";
}

function ttlForPeriod(period) {
  if (period === "7d") return 60 * 60 * 1000; // 1h
  if (period === "30d") return 6 * 60 * 60 * 1000; // 6h
  if (period === "90d") return 24 * 60 * 60 * 1000; // 24h
  return 6 * 60 * 60 * 1000; // default 6h
}

// cache in-memory simples (MVP)
const CACHE = new Map(); // key -> { exp, data }
function cacheGet(key) {
  const it = CACHE.get(key);
  if (!it) return null;
  if (Date.now() > it.exp) {
    CACHE.delete(key);
    return null;
  }
  return it.data;
}
function cacheSet(key, data, ttlMs) {
  CACHE.set(key, { exp: Date.now() + ttlMs, data });
}
// --- Trends hardening: lock + breaker + rate limit ---

let TRENDS_LOCK = Promise.resolve();

async function withTrendsLock(fn) {
  const prev = TRENDS_LOCK;
  let release;
  TRENDS_LOCK = new Promise((r) => (release = r));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

const RL = new Map(); // key -> { resetAt, count }
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const it = RL.get(key);
  if (!it || now > it.resetAt) {
    RL.set(key, { resetAt: now + windowMs, count: 1 });
    return true;
  }
  if (it.count >= max) return false;
  it.count += 1;
  return true;
}

function isTrendsBlockedError(msg) {
  const s = String(msg || "").toLowerCase();
  return (
    s.includes("returned_html_blocked") ||
    s.includes("captcha") ||
    s.includes("consent") ||
    s.includes("429") ||
    s.includes("too many requests")
  );
}

function blockKey(name, geo, timeframe) {
  return `trends_block:v1:${name}:${geo}:${timeframe || "na"}`;
}

function nextBlockMs(prevMs) {
  if (!prevMs) return 10 * 60 * 1000; // 10 min
  if (prevMs < 30 * 60 * 1000) return 30 * 60 * 1000; // 30 min
  return 60 * 60 * 1000; // 60 min
}
// UF map (Trends pode devolver nomes por extenso dependendo do retorno)
const UF_MAP = new Map([
  ["acre", "AC"],
  ["alagoas", "AL"],
  ["amapa", "AP"],
  ["amazonas", "AM"],
  ["bahia", "BA"],
  ["ceara", "CE"],
  ["distrito federal", "DF"],
  ["espirito santo", "ES"],
  ["goias", "GO"],
  ["maranhao", "MA"],
  ["mato grosso", "MT"],
  ["mato grosso do sul", "MS"],
  ["minas gerais", "MG"],
  ["para", "PA"],
  ["paraiba", "PB"],
  ["parana", "PR"],
  ["pernambuco", "PE"],
  ["piaui", "PI"],
  ["rio de janeiro", "RJ"],
  ["rio grande do norte", "RN"],
  ["rio grande do sul", "RS"],
  ["rondonia", "RO"],
  ["roraima", "RR"],
  ["santa catarina", "SC"],
  ["sao paulo", "SP"],
  ["sergipe", "SE"],
  ["tocantins", "TO"],
]);

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

async function suggest(req, res) {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "q_required" });

    const key = `suggest:v1:${q.toLowerCase()}`;
    const cached = cacheGet(key);
    if (cached) return res.json(cached);

    const url =
      "https://suggestqueries.google.com/complete/search" +
      `?client=firefox&hl=pt-BR&gl=BR&q=${encodeURIComponent(q)}`;

    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error(`suggest_http_${r.status}`);

    const data = await r.json(); // formato: [query, [sugestoes...], ...]
    const items = Array.isArray(data?.[1]) ? data[1].slice(0, 20) : [];

    const out = { query: q, items };
    cacheSet(key, out, 60 * 60 * 1000); // 1h

    res.set("Cache-Control", "no-store");
    res.json(out);
  } catch (e) {
    res
      .status(500)
      .json({ error: "seo_suggest_failed", message: String(e?.message || e) });
  }
}

async function keywords(req, res) {
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "na";

  if (!rateLimit(`kw:${ip}`, 20, 60 * 1000)) {
    return res.status(429).json({
      error: "rate_limited",
      message: "Aguarde um pouco e tente novamente.",
    });
  }

  try {
    const q = String(req.query.q || "").trim();
    const period = String(req.query.period || "30d");
    if (!q) return res.status(400).json({ error: "q_required" });

    const timeframe = timeframeFromPeriod(period);
    const geo = "BR";

    const bKey = blockKey("keywords", geo, timeframe);
    const blockedPayload = cacheGet(bKey);

    const key = `kw:v1:${q.toLowerCase()}:${period}`;
    const cached = cacheGet(key);
    if (cached) return res.json(cached);

    // Sugestões (Autocomplete) — sempre tenta garantir algo útil
    const sugKey = `suggest:v1:${q.toLowerCase()}`;
    let sug = cacheGet(sugKey);
    if (!sug) {
      const url =
        "https://suggestqueries.google.com/complete/search" +
        `?client=firefox&hl=pt-BR&gl=BR&q=${encodeURIComponent(q)}`;

      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const data = r.ok ? await r.json() : null;
      const items = Array.isArray(data?.[1]) ? data[1].slice(0, 20) : [];
      sug = { query: q, items };
      cacheSet(sugKey, sug, 60 * 60 * 1000); // 1h
    }

    // Trends: best-effort
    let trendsOk = true;
    let trendsError = null;

    let related = null;
    let byRegion = null;

    // se já está bloqueado (breaker), não chama Trends
    if (blockedPayload) {
      trendsOk = false;
      trendsError = "trends_blocked_cached";
    } else {
      let blockedNow = false;

      // 1) relatedQueries
      try {
        const relatedRaw = await withTrendsLock(() =>
          googleTrends.relatedQueries({
            keyword: q,
            geo,
            timeframe,
            hl: "pt-BR",
            timezone: 180,
          }),
        );
        related = safeJsonParse("relatedQueries", relatedRaw);
      } catch (e) {
        trendsOk = false;
        trendsError = String(e?.message || e);

        if (isTrendsBlockedError(trendsError)) {
          blockedNow = true;
          const prev = cacheGet(bKey);
          const prevMs = prev?._blockMs || 0;
          const ms = nextBlockMs(prevMs);
          cacheSet(bKey, { _blockMs: ms, _blockedUntil: Date.now() + ms }, ms);
        }
      }

      // 2) interestByRegion (só tenta se não bloqueou no passo anterior)
      if (!blockedNow) {
        try {
          const byRegionRaw = await withTrendsLock(() =>
            googleTrends.interestByRegion({
              keyword: q,
              geo,
              timeframe,
              resolution: "REGION",
              hl: "pt-BR",
              timezone: 180,
            }),
          );
          byRegion = safeJsonParse("interestByRegion", byRegionRaw);
        } catch (e) {
          trendsOk = false;
          trendsError = trendsError || String(e?.message || e);

          if (isTrendsBlockedError(trendsError)) {
            const prev = cacheGet(bKey);
            const prevMs = prev?._blockMs || 0;
            const ms = nextBlockMs(prevMs);
            cacheSet(
              bKey,
              { _blockMs: ms, _blockedUntil: Date.now() + ms },
              ms,
            );
          }
        }
      }
    }

    const top =
      related?.default?.rankedList?.[0]?.rankedKeyword?.map((x) => ({
        term: x?.query || "",
        score: Number(x?.value || 0),
      })) || [];

    const rising =
      related?.default?.rankedList?.[1]?.rankedKeyword?.map((x) => ({
        term: x?.query || "",
        growthPct:
          x?.value == null
            ? null
            : String(x.value).toLowerCase().includes("breakout")
              ? 9999
              : Number(x.value || 0),
      })) || [];

    const ufItems =
      byRegion?.default?.geoMapData
        ?.map((x) => {
          const name = String(x?.geoName || "").trim();
          const code = String(x?.geoCode || "").trim();
          let uf = null;

          const m = code.match(/BR-([A-Z]{2})$/);
          if (m) uf = m[1];
          if (!uf) uf = UF_MAP.get(norm(name)) || null;

          const val = Array.isArray(x?.value)
            ? Number(x.value[0] || 0)
            : Number(x?.value || 0);

          if (!uf) return null;
          return { uf, interest: clamp(val, 0, 100) };
        })
        .filter(Boolean) || [];

    ufItems.sort((a, b) => b.interest - a.interest);

    const out = {
      query: q,
      period,
      timeframe,
      trends: {
        ok: trendsOk,
        error: trendsOk ? null : trendsError,
      },
      related: {
        top: top.slice(0, 20),
        rising: rising.slice(0, 20),
      },
      suggestions: sug.items,
      byUf: ufItems,
    };

    // cache mais agressivo ajuda MUITO a evitar bloqueio
    cacheSet(key, out, ttlForPeriod(period));
    res.set("Cache-Control", "no-store");
    return res.json(out);
  } catch (e) {
    return res.status(500).json({
      error: "seo_keywords_failed",
      message: String(e?.message || e),
    });
  }
}

const { listSeoReferenceProducts } = require("../repositories/productSqlRepository");
const ShopeeAdsService = require("../services/ShopeeAdsService");
const { resolveShop } = require("../utils/resolveShop");
const {
  callAdsWithAutoRefresh,
} = require("../services/ShopeeAdsTokenService");

async function compare(req, res) {
  // ✅ declara fora do try para o catch conseguir acessar
  let terms = [];
  let period = "30d";
  let timeframe = null;
  let key = null;

  try {
    const rawTerms = String(req.query.terms || "").trim();
    period = String(req.query.period || "30d");

    if (!rawTerms) return res.status(400).json({ error: "terms_required" });

    terms = rawTerms
      .split(/[,\|]/g)
      .map((s) => String(s || "").trim())
      .filter(Boolean)
      .slice(0, 4);

    if (terms.length < 2) {
      return res.status(400).json({ error: "min_2_terms_required" });
    }

    timeframe = timeframeFromPeriod(period);
    const geo = "BR";

    key = `cmp:v1:${terms.join("|").toLowerCase()}:${period}`;
    const cached = cacheGet(key);
    if (cached) return res.json(cached);
    const bKey = blockKey("compare", geo, timeframe);
    const blockedPayload = cacheGet(bKey);
    if (blockedPayload) {
      const out = {
        terms,
        period,
        timeframe,
        trends: { ok: false, error: "trends_blocked_cached" },
        series: [],
        summary: {},
        message: "Google Trends indisponível no momento (bloqueio/consent).",
      };
      cacheSet(key, out, 10 * 60 * 1000);
      return res.json(out);
    }
    const raw = await withTrendsLock(() =>
      googleTrends.interestOverTime({
        keyword: terms,
        geo,
        timeframe,
        hl: "pt-BR",
        timezone: 180,
      }),
    );

    const parsed = safeJsonParse("interestOverTime", raw);
    const timeline = parsed?.default?.timelineData || [];

    const series = terms.map((t, idx) => ({
      term: t,
      points: timeline.map((row) => ({
        time: Number(row?.time || 0) * 1000,
        value: Number(row?.value?.[idx] ?? 0),
      })),
    }));

    const summary = {};
    for (const s of series) {
      const vals = s.points.map((p) => p.value);
      const avg = vals.length
        ? vals.reduce((a, b) => a + b, 0) / vals.length
        : 0;
      const max = vals.length ? Math.max(...vals) : 0;
      const last = vals.length ? vals[vals.length - 1] : 0;
      summary[s.term] = { avg: Math.round(avg * 10) / 10, max, last };
    }

    const out = {
      terms,
      period,
      timeframe,
      trends: { ok: true, error: null },
      series,
      summary,
    };

    cacheSet(key, out, ttlForPeriod(period));
    res.set("Cache-Control", "no-store");
    return res.json(out);
  } catch (e) {
    const msg = String(e?.message || e);

    const blocked =
      msg.includes("returned_html_blocked") ||
      msg.includes("captcha") ||
      msg.includes("consent") ||
      msg.includes("429");

    if (isTrendsBlockedError(msg)) {
      const out = {
        terms,
        period,
        timeframe,
        trends: { ok: false, error: msg },
        series: [],
        summary: {},
        message: "Google Trends indisponível no momento (bloqueio/consent).",
      };

      // seta o breaker
      const bKey = blockKey("compare", "BR", timeframe);
      const prev = cacheGet(bKey);
      const prevMs = prev?._blockMs || 0;
      const ms = nextBlockMs(prevMs);
      cacheSet(bKey, { _blockMs: ms, _blockedUntil: Date.now() + ms }, ms);

      // cacheia o resultado "blocked" (TTL dinâmico)
      if (key) cacheSet(key, out, ttlBlocked(period));

      res.set("Cache-Control", "no-store");
      return res.json(out);
    }

    return res.status(500).json({ error: "seo_compare_failed", message: msg });
  }
}

function ttlBlocked(period) {
  if (period === "7d") return 10 * 60 * 1000;
  if (period === "30d") return 20 * 60 * 1000;
  if (period === "90d") return 30 * 60 * 1000;
  return 20 * 60 * 1000;
}

function safeBigInt(q) {
  try {
    if (!q) return null;
    const s = String(q).trim();
    if (!/^\d+$/.test(s)) return null;
    return BigInt(s);
  } catch {
    return null;
  }
}

async function refProducts(req, res) {
  try {
    const shop = await resolveShop(req, req.params.shopId);

    const q = String(req.query.q || "").trim();
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 30)));

    const rows = await listSeoReferenceProducts(shop.id, q, limit);

    return res.json({
      response: {
        items: rows.map((p) => ({
          itemId: String(p.itemId),
          title: p.title || null,
          imageUrl: p.images?.[0]?.url || null,
        })),
      },
    });
  } catch (e) {
    const status = e?.statusCode || 500;
    return res.status(status).json({
      error: "seo_ref_products_failed",
      message: String(e?.message || e),
    });
  }
}

async function shopeeRecommendedKeywords(req, res) {
  try {
    const shop = await resolveShop(req, req.params.shopId); // ✅ precisa existir ANTES de qualquer uso

    const itemId = String(req.query.itemId || "").trim();
    if (!itemId) return res.status(400).json({ error: "itemId_required" });

    const q = String(req.query.q || "").trim();

    const raw = await callAdsWithAutoRefresh({
      shop, // ✅ passa shop explicitamente
      call: (accessToken) =>
        ShopeeAdsService.get_recommended_keyword_list({
          accessToken,
          shopId: shop.shopId, // ✅ agora shop existe
          itemId,
          inputKeyword: q || undefined,
        }),
    });

    // Shopee pode retornar "suggested_keywords" (documentacao atual) e,
    // em alguns cenarios legados, "suggested_keyword_list".
    const list = Array.isArray(raw?.response?.suggested_keywords)
      ? raw.response.suggested_keywords
      : Array.isArray(raw?.response?.suggested_keyword_list)
        ? raw.response.suggested_keyword_list
        : [];

    const normalized = list
      .map((x) => ({
        keyword: String(x?.keyword || "").trim(),
        quality_score:
          x?.quality_score != null ? Number(x.quality_score) : null,
        search_volume:
          x?.search_volume != null ? Number(x.search_volume) : null,
        suggested_bid:
          x?.suggested_bid != null ? Number(x.suggested_bid) : null,
      }))
      .filter((x) => x.keyword);

    const byVolume = [...normalized].sort(
      (a, b) => (b.search_volume || 0) - (a.search_volume || 0),
    );
    const byQuality = [...normalized].sort(
      (a, b) => (b.quality_score || 0) - (a.quality_score || 0),
    );

    const qNorm = q.toLowerCase();
    const findRank = (arr) => {
      const idx = arr.findIndex((x) => x.keyword.toLowerCase() === qNorm);
      return idx >= 0 ? idx + 1 : null;
    };

    const match =
      normalized.find((x) => x.keyword.toLowerCase() === qNorm) || null;

    return res.json({
      request_id: raw?.request_id,
      warning: raw?.warning,
      error: raw?.error || "",
      message: raw?.message,
      response: {
        item_id: String(raw?.response?.item_id ?? itemId),
        input_keyword: raw?.response?.input_keyword ?? q,
        suggested_keywords: normalized,
        rankings: {
          by_volume: byVolume,
          by_quality: byQuality,
          match,
          rank_by_volume: q ? findRank(byVolume) : null,
          rank_by_quality: q ? findRank(byQuality) : null,
        },
      },
    });
  } catch (e) {
    const status = e?.statusCode || e?.response?.status || 500;
    return res.status(status).json({
      error: {
        code: e?.code || "seo_shopee_recommended_keywords_failed",
        message:
          status === 500
            ? "Erro interno do servidor"
            : String(e?.message || e),
        details: String(e?.message || e),
      },
    });
  }
}

module.exports = {
  suggest,
  keywords,
  compare,
  refProducts,
  shopeeRecommendedKeywords,
};
