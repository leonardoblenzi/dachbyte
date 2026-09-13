// services/removerPromocaoService.js
const fetch = require("node-fetch");
const TokenService = require("./tokenService");
const config = require("../config/config");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PROMOTION_TYPES_TO_SCAN = [
  "PRICE_DISCOUNT",
  "SELLER_CAMPAIGN",
  "DEAL",
  "DOD",
  "LIGHTNING",
  "MARKETPLACE_CAMPAIGN",
  "VOLUME",
  "PRE_NEGOTIATED",
  "SMART",
  "PRICE_MATCHING",
  "UNHEALTHY_STOCK",
];

const ACTIVE_PROMOTION_STATUSES = new Set([
  "started",
  "active",
  "pending",
  "scheduled",
  "programmed",
]);

function accountKeyFrom(opts = {}) {
  const key =
    opts.accountKey ||
    opts.key ||
    opts.mlCreds?.account_key ||
    opts.mlCreds?.accountKey ||
    process.env.ACCOUNT_KEY ||
    process.env.SELECTED_ACCOUNT ||
    null;
  return (key || "sem-conta").toLowerCase();
}

function resolveCredsFrom(opts = {}) {
  const key = accountKeyFrom(opts);
  return {
    app_id: opts.mlCreds?.app_id || process.env.APP_ID || process.env.ML_APP_ID,
    client_secret:
      opts.mlCreds?.client_secret || process.env.CLIENT_SECRET || process.env.ML_CLIENT_SECRET,
    refresh_token:
      opts.mlCreds?.refresh_token || process.env.REFRESH_TOKEN || process.env.ML_REFRESH_TOKEN,
    access_token:
      opts.mlCreds?.access_token || process.env.ACCESS_TOKEN || process.env.ML_ACCESS_TOKEN,
    redirect_uri:
      opts.mlCreds?.redirect_uri || process.env.REDIRECT_URI || process.env.ML_REDIRECT_URI,
    meli_conta_id: opts.mlCreds?.meli_conta_id || null,
    account_key: key,
    accountKey: key,
  };
}

function urls() {
  return {
    users_me: config?.urls?.users_me || "https://api.mercadolibre.com/users/me",
    items_base: config?.urls?.items || "https://api.mercadolibre.com/items",
    seller_promos:
      config?.urls?.seller_promotions || "https://api.mercadolibre.com/seller-promotions",
  };
}

async function prepararAuthState(options = {}) {
  const creds = resolveCredsFrom(options);
  const merged = {
    ...creds,
    access_token: options.access_token || creds.access_token,
    account_key: creds.account_key || creds.accountKey || null,
  };
  const token = await TokenService.renovarTokenSeNecessario(merged);
  return {
    token,
    creds: merged,
    key: merged.account_key || "sem-conta",
  };
}

async function authFetch(url, init, state) {
  const doCall = async (token) => {
    const headers = { ...(init?.headers || {}), Authorization: `Bearer ${token}` };
    return fetch(url, { ...init, headers });
  };

  let response = await doCall(state.token);
  if (response.status !== 401) return response;

  const renewed = await TokenService.renovarToken(state.creds);
  state.token = renewed.access_token || state.token;
  if (state.creds) {
    state.creds.access_token = state.token;
    if (renewed?.refresh_token) state.creds.refresh_token = renewed.refresh_token;
    if (renewed?.expires_in) {
      state.creds.access_expires_at = new Date(
        Date.now() + Number(renewed.expires_in) * 1000,
      ).toISOString();
    }
  }
  return doCall(state.token);
}

function normalizePromotionRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  if (Array.isArray(payload?.promotions)) return payload.promotions;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function promotionTypeOf(promotion) {
  return String(promotion?.type || promotion?.promotion_type || "").trim().toUpperCase();
}

function promotionIdOf(promotion) {
  return String(
    promotion?.id ||
      promotion?.promotion_id ||
      promotion?.campaign_id ||
      promotion?.code ||
      "",
  ).trim();
}

function promotionStatusOf(promotion) {
  return String(promotion?.status || promotion?.item_status || "").trim().toLowerCase();
}

function isActivePromotion(promotion) {
  return ACTIVE_PROMOTION_STATUSES.has(promotionStatusOf(promotion));
}

function promotionKey(promotion) {
  return [
    promotionTypeOf(promotion) || "UNKNOWN",
    promotionIdOf(promotion) || "sem-id",
    promotionStatusOf(promotion) || "sem-status",
  ].join("|");
}

async function readJsonOrText(response) {
  const text = await response.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function buildItemPromotionsUrl(baseUrl, mlbId, { type = null, promotionId = null } = {}) {
  const qs = new URLSearchParams({ app_version: "v2" });
  if (type) qs.set("promotion_type", String(type).toUpperCase());
  if (promotionId) qs.set("promotion_id", String(promotionId));
  return `${baseUrl}/items/${encodeURIComponent(mlbId)}?${qs.toString()}`;
}

async function fetchItemPromotions(baseUrl, mlbId, state, baseHeaders, query = {}) {
  const url = buildItemPromotionsUrl(baseUrl, mlbId, query);
  const response = await authFetch(url, { method: "GET", headers: baseHeaders }, state);
  if (response.status === 404) return { ok: true, rows: [] };
  if (!response.ok) {
    return { ok: false, rows: [], status: response.status, body: await readJsonOrText(response) };
  }
  const payload = await response.json().catch(() => []);
  return { ok: true, rows: normalizePromotionRows(payload) };
}

async function listItemPromotions(baseUrl, mlbId, state, baseHeaders, log) {
  const scans = [{ type: null }, ...PROMOTION_TYPES_TO_SCAN.map((type) => ({ type }))];
  const byKey = new Map();
  const failures = [];

  for (const scan of scans) {
    const result = await fetchItemPromotions(baseUrl, mlbId, state, baseHeaders, scan);
    if (!result.ok) {
      failures.push(`${scan.type || "GENERIC"} HTTP ${result.status}`);
      continue;
    }
    for (const row of result.rows) {
      const normalized = { ...row, type: promotionTypeOf(row) || scan.type || row?.type };
      byKey.set(promotionKey(normalized), normalized);
    }
  }

  if (failures.length) {
    log(`Consultas de promocao com falha para ${mlbId}: ${failures.join(", ")}`);
  }

  return [...byKey.values()];
}

function buildDeleteUrls(baseUrl, mlbId, promotion) {
  const type = promotionTypeOf(promotion);
  const promotionId = promotionIdOf(promotion);
  const candidates = [];

  if (type && promotionId) {
    candidates.push(buildItemPromotionsUrl(baseUrl, mlbId, { type, promotionId }));
  }
  if (type) candidates.push(buildItemPromotionsUrl(baseUrl, mlbId, { type }));
  candidates.push(buildItemPromotionsUrl(baseUrl, mlbId));

  return [...new Set(candidates)];
}

function deleteResponseLooksSuccessful(payload, mlbId) {
  if (!payload || typeof payload !== "object") return true;
  const successfulIds = Array.isArray(payload.successful_ids) ? payload.successful_ids : [];
  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  if (successfulIds.some((id) => String(id).toUpperCase() === String(mlbId).toUpperCase())) {
    return true;
  }
  if (errors.length > 0) return false;
  return payload.error == null && payload.message !== "error";
}

function formatPromotionList(list) {
  return list.map((promotion) => {
    const type = promotionTypeOf(promotion) || "UNKNOWN";
    const status = promotionStatusOf(promotion) || "sem-status";
    const id = promotionIdOf(promotion);
    return id ? `${type} ${id} - ${status}` : `${type} - ${status}`;
  });
}

class PromocaoService {
  static async removerPromocaoUnico(mlbId, optionsOrState = {}) {
    const state =
      optionsOrState && optionsOrState.token && optionsOrState.creds
        ? optionsOrState
        : await prepararAuthState(optionsOrState);

    const log = (msg, ...rest) =>
      (optionsOrState.logger || console).log(`[${state.key}] ${msg}`, ...rest);

    try {
      const U = urls();
      const baseHeaders = { "Content-Type": "application/json" };

      log(`Verificando anuncio ${mlbId}...`);
      const rItem = await authFetch(
        `${U.items_base}/${encodeURIComponent(mlbId)}`,
        { method: "GET", headers: baseHeaders },
        state,
      );
      if (!rItem.ok) throw new Error(`Erro ao buscar anuncio: HTTP ${rItem.status}`);
      const itemData = await rItem.json();

      const rMe = await authFetch(U.users_me, { method: "GET", headers: baseHeaders }, state);
      if (!rMe.ok) throw new Error(`Falha em users/me: HTTP ${rMe.status}`);
      const userData = await rMe.json();
      if (itemData.seller_id !== userData.id) {
        throw new Error("Este anuncio nao pertence a sua conta");
      }

      let lista = await listItemPromotions(U.seller_promos, mlbId, state, baseHeaders, log);
      let ativas = lista.filter(isActivePromotion);
      log(`Promocoes encontradas: ${lista.length}; ativas: ${ativas.length}`, lista);

      if (ativas.length === 0) {
        return {
          success: true,
          message: "Item nao possui promocoes ativas no momento",
          mlb_id: mlbId,
          titulo: itemData.title,
          preco_atual: itemData.price,
          tinha_promocao: false,
          promocoes_encontradas: formatPromotionList(lista),
        };
      }

      const resultadoRemocao = {
        metodos_tentados: [],
        sucesso: false,
        promocoes_removidas: [],
        promocoes_com_erro: [],
      };

      for (let pass = 1; pass <= 3 && ativas.length > 0; pass += 1) {
        log(`Rodada de remocao ${pass}: ${ativas.length} promocao(oes) ativa(s)`);

        for (const promocao of ativas) {
          const tipo = promotionTypeOf(promocao) || "UNKNOWN";
          const idPromo = promotionIdOf(promocao) || "sem-id";
          const urlsTentadas = buildDeleteUrls(U.seller_promos, mlbId, promocao);
          let remocaoSucesso = false;
          let ultimoErro = null;

          for (const deleteUrl of urlsTentadas) {
            try {
              const rDel = await authFetch(
                deleteUrl,
                { method: "DELETE", headers: baseHeaders },
                state,
              );
              const delRes = await readJsonOrText(rDel);
              log(`Resultado DELETE ${tipo} (${rDel.status}):`, delRes);

              if (rDel.ok && deleteResponseLooksSuccessful(delRes, mlbId)) {
                remocaoSucesso = true;
                resultadoRemocao.sucesso = true;
                resultadoRemocao.promocoes_removidas.push(`${tipo} - ${idPromo}`);
                resultadoRemocao.metodos_tentados.push(`OK ${tipo} (${idPromo})`);
                break;
              }

              ultimoErro = delRes?.message || delRes?.error || delRes?.raw || `HTTP ${rDel.status}`;
            } catch (err) {
              ultimoErro = err?.message || String(err);
            }
          }

          if (!remocaoSucesso) {
            resultadoRemocao.promocoes_com_erro.push(
              `${tipo} (${idPromo}) - ${ultimoErro || "falha ao remover"}`,
            );
            resultadoRemocao.metodos_tentados.push(
              `ERRO ${tipo} (${idPromo}) - ${ultimoErro || "falha ao remover"}`,
            );
          }
        }

        await sleep(3000);
        lista = await listItemPromotions(U.seller_promos, mlbId, state, baseHeaders, log);
        ativas = lista.filter(isActivePromotion);
      }

      const promocoesRestantes = ativas;
      const rItem2 = await authFetch(
        `${U.items_base}/${encodeURIComponent(mlbId)}`,
        { method: "GET", headers: baseHeaders },
        state,
      );
      const item2 = rItem2.ok ? await rItem2.json() : {};
      const aindaTemPromocao = promocoesRestantes.length > 0;

      return {
        success: resultadoRemocao.sucesso || !aindaTemPromocao,
        message:
          resultadoRemocao.sucesso || !aindaTemPromocao
            ? "Promocoes processadas com sucesso"
            : "Algumas promocoes nao puderam ser removidas",
        mlb_id: mlbId,
        titulo: itemData.title,
        preco_antes: itemData.price,
        preco_depois: item2.price,
        preco_original_antes: itemData.original_price,
        preco_original_depois: item2.original_price,
        tinha_promocao: true,
        ainda_tem_promocao: aindaTemPromocao,
        metodos_tentados: resultadoRemocao.metodos_tentados,
        promocoes_encontradas: formatPromotionList(lista),
        promocoes_removidas: resultadoRemocao.promocoes_removidas,
        promocoes_com_erro: resultadoRemocao.promocoes_com_erro,
        promocoes_restantes: formatPromotionList(promocoesRestantes),
      };
    } catch (error) {
      (optionsOrState.logger || console).error(
        `Erro ao processar ${mlbId}:`,
        error?.message || error,
      );
      return {
        success: false,
        message: error?.message || String(error),
        mlb_id: mlbId,
        error: true,
      };
    }
  }

  static async processarRemocaoLote(processId, mlbIds, delay, processamentosRemocao, options = {}) {
    const logger = options.logger || console;
    const status = processamentosRemocao[processId];
    try {
      const state = await prepararAuthState(options);

      status.status = "processando";
      logger.log(`[${state.key}] Iniciando processamento em lote: ${mlbIds.length} anuncios`);

      for (let i = 0; i < mlbIds.length; i += 1) {
        const mlbId = String(mlbIds[i] || "").trim();
        if (!mlbId) continue;

        try {
          logger.log(`[${state.key}] Processando ${i + 1}/${mlbIds.length}: ${mlbId}`);
          const resultado = await this.removerPromocaoUnico(mlbId, state);

          status.resultados.push(resultado);
          if (resultado.success) status.sucessos += 1;
          else status.erros += 1;
        } catch (error) {
          logger.error(`[${state.key}] Erro ao processar ${mlbId}:`, error?.message || error);
          status.erros += 1;
          status.resultados.push({
            success: false,
            mlb_id: mlbId,
            message: error?.message || String(error),
            error: true,
          });
        }

        status.processados += 1;
        status.progresso = Math.round((status.processados / status.total_anuncios) * 100);

        if (i < mlbIds.length - 1 && delay > 0) {
          logger.log(`[${state.key}] Aguardando ${delay}ms antes do proximo...`);
          await sleep(delay);
        }
      }

      status.status = "concluido";
      status.concluido_em = new Date();
      logger.log(
        `[${state.key}] Processamento concluido: ${status.sucessos} sucessos, ${status.erros} erros`,
      );
    } catch (error) {
      status.status = "erro";
      status.concluido_em = new Date();
      status.progresso = Math.round((status.processados / status.total_anuncios) * 100);
      logger.error("[bulk] Falha inicial no processamento:", error?.message || error);
    }
  }
}

module.exports = PromocaoService;
