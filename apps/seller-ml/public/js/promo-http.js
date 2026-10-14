// promo-http.js
// Helpers HTTP reutilizaveis da central de promocoes.
(function initPromoHttp(global) {
  "use strict";

  if (!global || global.PromoHttp) return;

  const selectionPreparePending = new Map();

  const toAbs = (p) =>
    /^https?:\/\//i.test(p) ? p : p.startsWith("/") ? p : `/${p}`;

  const withBase = (p) => {
    if (/^https?:\/\//i.test(String(p || ""))) return String(p);
    if (typeof global.withBase === "function") return global.withBase(toAbs(p));
    if (global.ML?.url) return global.ML.url(toAbs(p));
    return toAbs(p);
  };

  function buildSelectionPrepareKey(body) {
    const payload = body && typeof body === "object" ? body : {};
    const normalizedMlbs = Array.isArray(payload.mlbs)
      ? [
          ...new Set(
            payload.mlbs
              .map((id) => String(id || "").trim().toUpperCase())
              .filter(Boolean),
          ),
        ].sort()
      : [];
    const mlbs = normalizedMlbs.length ? normalizedMlbs : null;
    return JSON.stringify({
      promotion_id: payload.promotion_id || null,
      promotion_type: payload.promotion_type || null,
      status: payload.status || null,
      mlb: String(payload.mlb || "").trim().toUpperCase() || null,
      mlbs,
      percent_max:
        payload.percent_max == null || payload.percent_max === ""
          ? null
          : Number(payload.percent_max),
      discount_max:
        payload.discount_max == null || payload.discount_max === ""
          ? null
          : Number(payload.discount_max),
      stock_min:
        payload.stock_min == null || payload.stock_min === ""
          ? null
          : Number(payload.stock_min),
      stock_max:
        payload.stock_max == null || payload.stock_max === ""
          ? null
          : Number(payload.stock_max),
      lightning_stock:
        payload.lightning_stock == null || payload.lightning_stock === ""
          ? null
          : Number(payload.lightning_stock),
    });
  }

  async function getJSONAny(paths) {
    let lastErr;

    for (const p of paths) {
      const url = withBase(p);

      try {
        const r = await fetch(url, {
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });

        const finalUrl = r && r.url ? r.url : url;
        const ct = (r.headers.get("content-type") || "").toLowerCase();
        const looksHtml = ct.includes("text/html");

        if (!r.ok || looksHtml) {
          const body = await r.text().catch(() => "");
          lastErr = new Error(`HTTP ${r.status} ${url}`);
          lastErr.cause = {
            status: r.status,
            url,
            finalUrl,
            contentType: ct,
            body: body ? body.slice(0, 400) : "",
          };

          console.error(`Falha em ${url}`, lastErr.cause);

          if (
            String(finalUrl).includes("/select-conta") ||
            String(finalUrl).includes("/login")
          ) {
            console.warn(
              "Endpoint devolveu HTML de pagina (provavel redirect do backend):",
              finalUrl,
            );
          }
          continue;
        }

        return await r.json();
      } catch (e) {
        lastErr = e;
        console.error("Falha em", url, e?.message || e);
      }
    }

    throw lastErr || new Error("Nenhum endpoint respondeu");
  }

  async function postSelectionPrepare(body) {
    const key = buildSelectionPrepareKey(body);
    if (selectionPreparePending.has(key)) {
      return selectionPreparePending.get(key);
    }

    const request = (async () => {
      const deadline = Date.now() + 10 * 60 * 1000;

      const requestJson = async (url, options = {}) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        try {
          const response = await fetch(withBase(url), {
            credentials: "same-origin",
            cache: "no-store",
            headers: {
              Accept: "application/json",
              ...(options.body ? { "Content-Type": "application/json" } : {}),
            },
            ...options,
            signal: controller.signal,
          });
          const data = await response.json().catch(() => ({}));
          return { response, data };
        } finally {
          clearTimeout(timeout);
        }
      };

      let first;
      try {
        first = await requestJson("/api/promocoes/selection/prepare", {
          method: "POST",
          body: JSON.stringify(body || {}),
        });
      } catch (error) {
        if (error?.name === "AbortError") {
          throw new Error("A preparação demorou para responder. Tente novamente.");
        }
        throw error;
      }

      if (first.response.status !== 202 || !first.data?.pending) {
        return {
          ok: first.response.ok,
          status: first.response.status,
          data: first.data,
        };
      }

      const statusUrl = String(first.data?.status_url || "").trim();
      if (!statusUrl) {
        throw new Error("A preparação foi iniciada, mas o backend não retornou o identificador de acompanhamento.");
      }

      let retryMs = Math.max(1000, Number(first.data.retry_after_ms) || 2000);
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, retryMs));
        let polled;
        try {
          polled = await requestJson(statusUrl, { method: "GET" });
        } catch (error) {
          if (error?.name === "AbortError") continue;
          throw error;
        }
        if (polled.response.status === 202 && polled.data?.pending) {
          retryMs = Math.max(1000, Number(polled.data.retry_after_ms) || retryMs);
          continue;
        }
        return {
          ok: polled.response.ok,
          status: polled.response.status,
          data: polled.data,
        };
      }
      throw new Error("A validação ainda está em processamento. Tente novamente em alguns instantes.");
    })();

    selectionPreparePending.set(key, request);

    try {
      return await request;
    } finally {
      selectionPreparePending.delete(key);
    }
  }

  async function postCreditQuote(body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(withBase("/api/promocoes/credits/quote"), {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body || {}),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      return { ok: response.ok && data?.ok !== false, status: response.status, data };
    } catch (error) {
      if (error?.name === "AbortError") {
        return {
          ok: false,
          status: 0,
          data: { error: "A previa de creditos demorou para responder." },
        };
      }
      return {
        ok: false,
        status: 0,
        data: { error: error?.message || "Falha ao calcular a previa de creditos." },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  function confirmCreditQuote(quote, { label = "operacao promocional" } = {}) {
    const data = quote?.data || quote || {};
    const estimated = Number(data?.estimated_credits || 0);
    const quantity = Math.max(0, Number(data?.quantity || 0));
    const unlimited = data?.unlimited === true;
    const recentRepeat = data?.recent_repeat === true;

    if (unlimited && !recentRepeat) return true;
    if (estimated <= 0 && !recentRepeat) return true;

    const lines = [
      `Esta ${label} vai processar aproximadamente ${new Intl.NumberFormat("pt-BR").format(quantity)} anuncio(s).`,
      estimated > 0
        ? `Custo estimado: ${new Intl.NumberFormat("pt-BR").format(estimated)} credito(s).`
        : "Esta conta possui uso ilimitado.",
    ];
    if (data?.available_credits != null && !unlimited) {
      lines.push(
        `Saldo disponivel: ${new Intl.NumberFormat("pt-BR").format(Number(data.available_credits || 0))} credito(s).`,
      );
    }
    if (recentRepeat) {
      lines.push(
        "Atencao: uma operacao identica foi executada recentemente. A reaplicacao usa a tarifa de repeticao para evitar processamento desnecessario.",
      );
    }
    lines.push("Deseja continuar?");
    return global.confirm(lines.join("\n\n"));
  }

  const usersPaths = () => ["/api/promocoes/users"];

  const itemsPaths = (promotionId, type, qs) => {
    const suffix = `?promotion_type=${encodeURIComponent(type)}&app_version=v2${
      qs ? `&${qs}` : ""
    }`;
    const pid = encodeURIComponent(promotionId);
    return [`/api/promocoes/promotions/${pid}/items${suffix}`];
  };

  const offerIdsPaths = (mlb, opts = {}) => {
    const query = new URLSearchParams();
    if (opts.promotion_id) query.set("promotion_id", String(opts.promotion_id));
    if (opts.promotion_type) query.set("promotion_type", String(opts.promotion_type));
    if (opts.candidate_id) query.set("candidate_id", String(opts.candidate_id));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return [`/api/promocoes/items/${encodeURIComponent(mlb)}/offer-ids${suffix}`];
  };

  global.PromoHttp = {
    toAbs,
    withBase,
    getJSONAny,
    postSelectionPrepare,
    postCreditQuote,
    confirmCreditQuote,
    usersPaths,
    itemsPaths,
    offerIdsPaths,
  };
})(window);
