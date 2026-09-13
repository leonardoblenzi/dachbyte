// services/excluirAnuncioService.js
const fetch = require('node-fetch');
const TokenService = require('./tokenService');
const config = require('../config/config');

const urls = {
  items: config?.urls?.items || 'https://api.mercadolibre.com/items',
  me: config?.urls?.users_me || 'https://api.mercadolibre.com/users/me'
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRelistBodyFromItem(item) {
  const body = {
    listing_type_id: item?.listing_type_id,
  };

  if (Array.isArray(item?.variations) && item.variations.length > 0) {
    body.variations = item.variations.map((variation) => ({
      id: variation.id,
      price: variation.price,
      quantity: variation.available_quantity,
    }));
    return body;
  }

  if (typeof item?.price === 'number') body.price = item.price;
  if (Number.isInteger(item?.available_quantity)) {
    body.quantity = item.available_quantity;
  }

  return body;
}

function extractItemSkus(item = {}) {
  const skus = new Set();
  const add = (value) => {
    const text = String(value || '').trim();
    if (text) skus.add(text);
  };
  const readAttributes = (attributes) => {
    if (!Array.isArray(attributes)) return;
    attributes.forEach((attribute) => {
      if (String(attribute?.id || '').toUpperCase() === 'SELLER_SKU') {
        add(attribute?.value_name || attribute?.value_id);
      }
    });
  };

  add(item.seller_custom_field);
  readAttributes(item.attributes);
  if (Array.isArray(item.variations)) {
    item.variations.forEach((variation) => {
      add(variation?.seller_custom_field);
      readAttributes(variation?.attributes);
    });
  }
  return Array.from(skus).join(' | ');
}

function accountKeyFrom(options = {}) {
  return (
    options.accountKey ||
    options.key ||
    options.mlCreds?.account_key ||
    options.mlCreds?.accountKey ||
    process.env.ACCOUNT_KEY ||
    process.env.SELECTED_ACCOUNT ||
    null
  );
}

function resolveCredsFrom(options = {}) {
  const mlCreds =
    options.mlCreds && typeof options.mlCreds === 'object'
      ? options.mlCreds
      : {};

  return {
    ...mlCreds,
    app_id:
      mlCreds.app_id ||
      options.app_id ||
      process.env.APP_ID ||
      process.env.ML_APP_ID ||
      null,
    client_secret:
      mlCreds.client_secret ||
      options.client_secret ||
      process.env.CLIENT_SECRET ||
      process.env.ML_CLIENT_SECRET ||
      null,
    refresh_token:
      mlCreds.refresh_token ||
      options.refresh_token ||
      process.env.REFRESH_TOKEN ||
      process.env.ML_REFRESH_TOKEN ||
      null,
    access_token:
      mlCreds.access_token ||
      options.access_token ||
      process.env.ACCESS_TOKEN ||
      process.env.ML_ACCESS_TOKEN ||
      null,
    redirect_uri:
      mlCreds.redirect_uri ||
      options.redirect_uri ||
      process.env.REDIRECT_URI ||
      process.env.ML_REDIRECT_URI ||
      null,
    account_key:
      mlCreds.account_key ||
      mlCreds.accountKey ||
      options.account_key ||
      options.accountKey ||
      accountKeyFrom(options),
    meli_conta_id:
      mlCreds.meli_conta_id ||
      mlCreds.meliContaId ||
      options.meli_conta_id ||
      options.meliContaId ||
      null,
    meli_user_id:
      mlCreds.meli_user_id ||
      mlCreds.meliUserId ||
      options.meli_user_id ||
      options.meliUserId ||
      null,
    site_id:
      mlCreds.site_id ||
      mlCreds.siteId ||
      options.site_id ||
      options.siteId ||
      null,
    status:
      mlCreds.status ||
      options.status ||
      null,
    access_expires_at:
      mlCreds.access_expires_at ||
      mlCreds.accessExpiresAt ||
      options.access_expires_at ||
      options.accessExpiresAt ||
      null,
    scope:
      mlCreds.scope ||
      options.scope ||
      null,
  };
}

async function prepararState(options = {}) {
  const baseCreds = resolveCredsFrom(options);
  const creds = {
    ...baseCreds,
    access_token: options.access_token || baseCreds.access_token,
  };

  if (!creds.account_key) {
    creds.account_key = accountKeyFrom(options);
  }

  const token = await TokenService.renovarTokenSeNecessario(creds);
  return {
    token: typeof token === 'string' ? token : token?.access_token || creds.access_token,
    creds,
    key: creds.account_key || 'sem-conta',
  };
}

async function authFetch(url, init, state) {
  const baseHeaders = init.headers || {};
  const headers = {
    ...baseHeaders,
    Authorization: `Bearer ${state.token}`,
  };

  let resp = await fetch(url, { ...init, headers });
  if (resp.status !== 401) return resp;

  const novoToken = await TokenService.renovarToken(state.creds);
  state.token = novoToken.access_token || state.token;
  if (state.creds) {
    state.creds.access_token = state.token;
    if (novoToken?.refresh_token) state.creds.refresh_token = novoToken.refresh_token;
    if (novoToken?.expires_in) {
      state.creds.access_expires_at = new Date(
        Date.now() + Number(novoToken.expires_in) * 1000
      ).toISOString();
    }
  }

  const headers2 = {
    ...baseHeaders,
    Authorization: `Bearer ${state.token}`,
  };
  return fetch(url, { ...init, headers: headers2 });
}

class ExclusaoService {
  static async prepararState(options = {}) {
    return prepararState(options);
  }

  static async atualizarStatus(mlbId, status, stateMaybe) {
    const mlb = String(mlbId || '').trim().toUpperCase();
    const nextStatus = String(status || '').trim().toLowerCase();
    const allowedStatuses = new Set(['active', 'paused', 'closed']);

    if (!mlb || !/^MLB\d{5,}$/.test(mlb)) {
      return {
        success: false,
        mlb_id: mlb,
        error: true,
        message: 'MLB ID e obrigatorio e deve ser valido.',
      };
    }

    if (!allowedStatuses.has(nextStatus)) {
      return {
        success: false,
        mlb_id: mlb,
        error: true,
        message: 'Status invalido para gestao de anuncios.',
      };
    }

    const state =
      stateMaybe && stateMaybe.token && stateMaybe.creds
        ? stateMaybe
        : await prepararState(stateMaybe || {});

    const steps = [];
    let statusInicial = null;
    let detalhesUltimaResposta = null;

    try {
      const itemUrl = `${urls.items}/${mlb}`;

      const rItem = await authFetch(itemUrl, { method: 'GET', headers: {} }, state);
      const itemText = await rItem.text();
      let itemJson = null;
      try {
        itemJson = JSON.parse(itemText);
      } catch {}
      detalhesUltimaResposta = itemText;

      if (!rItem.ok) {
        return {
          success: false,
          mlb_id: mlb,
          error: true,
          message: `Item invalido ou nao encontrado (HTTP ${rItem.status})`,
          detalhes_ml: itemText || null,
          steps: [{ step: 'item_erro', http_status: rItem.status, body_raw: itemText || null }],
        };
      }

      const item = itemJson || {};
      statusInicial = item.status || null;
      const sku = extractItemSkus(item);
      steps.push({
        step: 'item_carregado',
        status: statusInicial,
        seller_id: item.seller_id,
        sku,
      });

      const rMe = await authFetch(urls.me, { method: 'GET', headers: {} }, state);
      const meText = await rMe.text();
      let meJson = null;
      try {
        meJson = JSON.parse(meText);
      } catch {}
      detalhesUltimaResposta = meText;

      if (!rMe.ok || !meJson || !meJson.id) {
        return {
          success: false,
          mlb_id: mlb,
          error: true,
          message: `Falha ao validar dono do anuncio (HTTP ${rMe.status})`,
          detalhes_ml: meText || null,
          steps: [
            ...steps,
            { step: 'owner_erro', http_status: rMe.status, body_raw: meText || null },
          ],
        };
      }

      if (item.seller_id !== meJson.id) {
        return {
          success: false,
          mlb_id: mlb,
          error: true,
          message: 'Este anuncio nao pertence a sua conta Mercado Livre.',
          status_inicial: statusInicial,
          detalhes_ml: itemText || null,
          steps,
        };
      }

      steps.push({ step: 'owner_ok', me_id: meJson.id });

      if (String(statusInicial || '').toLowerCase() === nextStatus) {
        return {
          success: true,
          mlb_id: mlb,
          titulo: item.title || null,
          sku,
          message: `Anuncio ja estava com status ${nextStatus}.`,
          status_inicial: statusInicial,
          status_final: statusInicial,
          changed: false,
          steps: [...steps, { step: 'status_inalterado', status: statusInicial }],
        };
      }

      const rUpdate = await authFetch(
        itemUrl,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ status: nextStatus }),
        },
        state,
      );

      const updateText = await rUpdate.text();
      let updateJson = null;
      try {
        updateJson = JSON.parse(updateText);
      } catch {}
      detalhesUltimaResposta = updateText;

      if (!rUpdate.ok) {
        const detailMessage = updateJson?.message || updateJson?.error || `HTTP ${rUpdate.status}`;
        return {
          success: false,
          mlb_id: mlb,
          error: true,
          message: `Erro ao atualizar status do anuncio: ${detailMessage}`,
          status_inicial: statusInicial,
          status_final: statusInicial,
          detalhes_ml: updateText || null,
          steps: [
            ...steps,
            { step: 'status_erro', http_status: rUpdate.status, body_raw: updateText || null },
          ],
        };
      }

      steps.push({
        step: 'status_atualizado',
        from: statusInicial,
        to: nextStatus,
        http_status: rUpdate.status,
      });

      return {
        success: true,
        mlb_id: mlb,
        titulo: item.title || null,
        sku,
        message: `Status atualizado para ${nextStatus}.`,
        status_inicial: statusInicial,
        status_final: nextStatus,
        changed: true,
        detalhes_ml: updateText || null,
        steps,
      };
    } catch (err) {
      return {
        success: false,
        mlb_id: mlb,
        error: true,
        message: `Falha inesperada ao atualizar status: ${err.message}`,
        status_inicial: statusInicial,
        detalhes_ml: detalhesUltimaResposta,
        steps: [
          ...steps,
          { step: 'erro_inesperado', error_message: err.message },
        ],
      };
    }
  }

  static async relistar(mlbId, mode, stateMaybe) {
    const mlb = String(mlbId || '').trim().toUpperCase();
    const relistMode = String(mode || '').trim().toUpperCase();
    const state =
      stateMaybe && stateMaybe.token && stateMaybe.creds
        ? stateMaybe
        : await prepararState(stateMaybe || {});

    if (!['CLOSE_RELIST', 'PAUSE_RELIST'].includes(relistMode)) {
      return {
        success: false,
        mlb_id: mlb,
        error: true,
        message: 'Modo de relist invalido.',
      };
    }

    const itemUrl = `${urls.items}/${mlb}`;
    const steps = [];

    async function loadItem() {
      const rItem = await authFetch(itemUrl, { method: 'GET', headers: {} }, state);
      const itemText = await rItem.text();
      let itemJson = null;
      try {
        itemJson = JSON.parse(itemText);
      } catch {}

      if (!rItem.ok) {
        return {
          ok: false,
          response: {
            success: false,
            mlb_id: mlb,
            error: true,
            message: `Item invalido ou nao encontrado (HTTP ${rItem.status})`,
            detalhes_ml: itemText || null,
          },
        };
      }

      return { ok: true, item: itemJson || {}, raw: itemText };
    }

    async function postRelist(item) {
      const relistUrl = `${itemUrl}/relist`;
      const rRelist = await authFetch(
        relistUrl,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(buildRelistBodyFromItem(item)),
        },
        state,
      );
      const relistText = await rRelist.text();
      let relistJson = null;
      try {
        relistJson = JSON.parse(relistText);
      } catch {}

      if (!rRelist.ok) {
        const error = new Error(
          relistJson?.message || relistJson?.error || `HTTP ${rRelist.status}`,
        );
        error.body = relistText;
        error.status = rRelist.status;
        throw error;
      }

      return relistJson || {};
    }

    try {
      const loaded = await loadItem();
      if (!loaded.ok) return loaded.response;

      const item = loaded.item;
      const sku = extractItemSkus(item);
      steps.push({
        step: 'item_carregado',
        status: item.status || null,
        seller_id: item.seller_id,
        sku,
      });
      const ownerCheck = await authFetch(urls.me, { method: 'GET', headers: {} }, state);
      const ownerText = await ownerCheck.text();
      let ownerJson = null;
      try {
        ownerJson = JSON.parse(ownerText);
      } catch {}

      if (!ownerCheck.ok || !ownerJson?.id) {
        return {
          success: false,
          mlb_id: mlb,
          error: true,
          message: `Falha ao validar dono do anuncio (HTTP ${ownerCheck.status})`,
          detalhes_ml: ownerText || null,
        };
      }

      if (item.seller_id !== ownerJson.id) {
        return {
          success: false,
          mlb_id: mlb,
          error: true,
          message: 'Este anuncio nao pertence a sua conta Mercado Livre.',
          status_inicial: item.status || null,
        };
      }

      if (relistMode === 'CLOSE_RELIST') {
        const closeResult = await this.atualizarStatus(mlb, 'closed', state);
        steps.push({ step: 'close', success: !!closeResult.success, message: closeResult.message });
        if (!closeResult.success) return { ...closeResult, steps };

        const relisted = await postRelist(item);
        const newId = relisted?.id || relisted?.item_id || null;
        return {
          success: true,
          mlb_id: mlb,
          mlb_old: mlb,
          mlb_new: newId,
          relisted_id: newId,
          sku,
          status_inicial: item.status || null,
          status_final: 'relisted',
          message: newId ? `Anuncio relistado como ${newId}.` : 'Anuncio relistado.',
          result: relisted,
          steps: [...steps, { step: 'relist', success: true, new_id: newId }],
        };
      }

      const pauseResult = await this.atualizarStatus(mlb, 'paused', state);
      steps.push({ step: 'pause', success: !!pauseResult.success, message: pauseResult.message });
      if (!pauseResult.success) return { ...pauseResult, steps };

      try {
        const relisted = await postRelist(item);
        const newId = relisted?.id || relisted?.item_id || null;
        return {
          success: true,
          mlb_id: mlb,
          mlb_old: mlb,
          mlb_new: newId,
          relisted_id: newId,
          sku,
          status_inicial: item.status || null,
          status_final: 'relisted',
          fallback_closed: false,
          message: newId ? `Anuncio relistado como ${newId}.` : 'Anuncio relistado.',
          result: relisted,
          steps: [...steps, { step: 'relist_from_pause', success: true, new_id: newId }],
        };
      } catch (pauseRelistError) {
        const closeResult = await this.atualizarStatus(mlb, 'closed', state);
        steps.push({
          step: 'fallback_close',
          success: !!closeResult.success,
          message: closeResult.message,
          reason: pauseRelistError.message,
        });
        if (!closeResult.success) return { ...closeResult, steps };

        const relisted = await postRelist(item);
        const newId = relisted?.id || relisted?.item_id || null;
        return {
          success: true,
          mlb_id: mlb,
          mlb_old: mlb,
          mlb_new: newId,
          relisted_id: newId,
          sku,
          status_inicial: item.status || null,
          status_final: 'relisted',
          fallback_closed: true,
          fallback_reason: pauseRelistError.message,
          message: newId ? `Anuncio relistado como ${newId}.` : 'Anuncio relistado com fallback.',
          result: relisted,
          steps: [...steps, { step: 'relist_after_fallback', success: true, new_id: newId }],
        };
      }
    } catch (err) {
      return {
        success: false,
        mlb_id: mlb,
        error: true,
        message: `Falha ao relistar anuncio: ${err.message}`,
        detalhes_ml: err.body || null,
        steps: [...steps, { step: 'relist_error', error_message: err.message }],
      };
    }
  }

  static async excluirUnico(mlbId, stateMaybe) {
    const mlb = String(mlbId || '').trim().toUpperCase();
    const state =
      stateMaybe && stateMaybe.token && stateMaybe.creds
        ? stateMaybe
        : await prepararState(stateMaybe || {});

    const steps = [];
    let statusInicial = null;
    let statusPosFechamento = null;
    let detalhesUltimaResposta = null;

    try {
      const itemUrl = `${urls.items}/${mlb}`;

      const rItem = await authFetch(itemUrl, { method: 'GET', headers: {} }, state);
      const itemText = await rItem.text();
      let itemJson = null;
      try {
        itemJson = JSON.parse(itemText);
      } catch {}
      detalhesUltimaResposta = itemText;

      if (!rItem.ok) {
        const msgBase = `Item invalido ou nao encontrado (HTTP ${rItem.status})`;
        return {
          success: false,
          mlb_id: mlb,
          error: true,
          message: msgBase,
          detalhes_ml: itemText || null,
          steps: [
            ...steps,
            { step: 'item_erro', http_status: rItem.status, body_raw: itemText || null },
          ],
        };
      }

      const item = itemJson || {};
      statusInicial = item.status || null;
      const sku = extractItemSkus(item);
      const itemSubStatuses = []
        .concat(item.sub_status || [])
        .concat(item.sub_statuses || [])
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean);
      const canDeleteDirectlyFromModeration =
        String(statusInicial || '').toLowerCase() === 'under_review' &&
        itemSubStatuses.includes('forbidden');
      steps.push({
        step: 'item_carregado',
        status: statusInicial,
        sub_statuses: itemSubStatuses,
        seller_id: item.seller_id,
        sku,
      });

      const rMe = await authFetch(urls.me, { method: 'GET', headers: {} }, state);
      const meText = await rMe.text();
      let meJson = null;
      try {
        meJson = JSON.parse(meText);
      } catch {}
      detalhesUltimaResposta = meText;

      if (!rMe.ok || !meJson || !meJson.id) {
        return {
          success: false,
          mlb_id: mlb,
          error: true,
          message: `Falha ao validar dono do anuncio (HTTP ${rMe.status})`,
          detalhes_ml: meText || null,
          steps: [
            ...steps,
            { step: 'owner_erro', http_status: rMe.status, body_raw: meText || null },
          ],
        };
      }

      steps.push({ step: 'owner_ok', me_id: meJson.id });

      if (item.seller_id !== meJson.id) {
        return {
          success: false,
          mlb_id: mlb,
          error: true,
          message: 'Este anuncio nao pertence a sua conta Mercado Livre.',
          status_inicial: statusInicial,
          detalhes_ml: itemText || null,
          steps,
        };
      }

      if (statusInicial !== 'closed' && !canDeleteDirectlyFromModeration) {
        const bodyClose = JSON.stringify({ status: 'closed' });
        const rClose = await authFetch(
          itemUrl,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: bodyClose,
          },
          state,
        );

        const closeText = await rClose.text();
        let closeJson = null;
        try {
          closeJson = JSON.parse(closeText);
        } catch {}
        detalhesUltimaResposta = closeText;

        if (!rClose.ok) {
          const closeCauseCode = closeJson?.cause?.[0]?.code || null;
          const nonModifiableStatus = ['under_review', 'inactive', 'not_yet_active'];
          const isNonModifiableStatus =
            closeCauseCode === 'item.status.not_modifiable' ||
            nonModifiableStatus.includes(String(statusInicial || '').toLowerCase());

          if (isNonModifiableStatus) {
            return {
              success: false,
              mlb_id: mlb,
              error: true,
              message:
                'O Mercado Livre não permite excluir este anúncio via API enquanto ele estiver em revisão/moderação. É preciso corrigir o anúncio no painel do Mercado Livre e aguardar ele sair desse estado antes de fechar/excluir.',
              status_inicial: statusInicial,
              status_pos_fechamento: statusPosFechamento,
              non_modifiable_status: true,
              detalhes_ml: closeText || null,
              steps: [
                ...steps,
                {
                  step: 'fechar_bloqueado_por_status',
                  http_status: rClose.status,
                  status: statusInicial,
                  cause_code: closeCauseCode,
                  body_raw: closeText || null,
                },
              ],
            };
          }

          return {
            success: false,
            mlb_id: mlb,
            error: true,
            message: `Erro ao fechar anuncio antes de excluir: HTTP ${rClose.status}`,
            status_inicial: statusInicial,
            detalhes_ml: closeText || null,
            steps: [
              ...steps,
              {
                step: 'fechar_erro',
                http_status: rClose.status,
                body_raw: closeText || null,
              },
            ],
          };
        }

        statusPosFechamento = closeJson?.status || 'closed';
        steps.push({
          step: 'fechado_sucesso',
          from: statusInicial,
          to: statusPosFechamento,
        });
      } else if (canDeleteDirectlyFromModeration) {
        statusPosFechamento = statusInicial;
        steps.push({
          step: 'exclusao_direta_permitida_por_moderacao',
          status: statusInicial,
          sub_statuses: itemSubStatuses,
        });
      } else {
        statusPosFechamento = statusInicial;
        steps.push({
          step: 'ja_estava_closed',
          status: statusInicial,
        });
      }

      const bodyDelete = JSON.stringify({ deleted: true });
      const rDel = await authFetch(
        itemUrl,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: bodyDelete,
        },
        state,
      );

      const delText = await rDel.text();
      let delJson = null;
      try {
        delJson = JSON.parse(delText);
      } catch {}
      detalhesUltimaResposta = delText;

      if (!rDel.ok) {
        let msg = `Erro ao excluir anuncio: HTTP ${rDel.status}`;
        if (delJson?.error || delJson?.message) {
          msg += ` - ${delJson.error || delJson.message}`;
        }

        return {
          success: false,
          mlb_id: mlb,
          error: true,
          message: msg,
          status_inicial: statusInicial,
          status_pos_fechamento: statusPosFechamento,
          deletado: false,
          detalhes_ml: delText || null,
          steps: [
            ...steps,
            {
              step: 'exclusao_erro',
              http_status: rDel.status,
              body_raw: delText || null,
            },
          ],
        };
      }

      steps.push({
        step: 'exclusao_sucesso',
        http_status: rDel.status,
        body_raw: delText || null,
      });

      return {
        success: true,
        mlb_id: mlb,
        titulo: item.title || null,
        sku,
        message: 'Anuncio fechado e excluido com sucesso.',
        status_inicial: statusInicial,
        status_pos_fechamento: statusPosFechamento,
        deletado: true,
        detalhes_ml: delText || null,
        steps,
      };
    } catch (err) {
      return {
        success: false,
        mlb_id: mlb,
        error: true,
        message: `Falha inesperada ao excluir anuncio: ${err.message}`,
        status_inicial: statusInicial,
        status_pos_fechamento: statusPosFechamento,
        detalhes_ml: detalhesUltimaResposta,
        steps: [
          ...steps,
          { step: 'erro_inesperado', error_message: err.message },
        ],
      };
    }
  }

  static async excluirLote(mlbIds, processoId, statusRef, delayEntre = 2000) {
    const state = await prepararState();

    statusRef.status = 'processando';

    for (let i = 0; i < mlbIds.length; i++) {
      const id = String(mlbIds[i] || '').trim();
      if (!id) continue;

      const resultado = await this.excluirUnico(id, state);
      statusRef.resultados.push(resultado);

      if (resultado.success) statusRef.sucessos++;
      else statusRef.erros++;

      statusRef.processados++;
      statusRef.progresso = Math.round(
        (statusRef.processados / mlbIds.length) * 100,
      );

      if (i < mlbIds.length - 1) {
        await delay(delayEntre);
      }
    }

    statusRef.status = 'concluido';
    statusRef.concluido_em = new Date();
  }
}

module.exports = ExclusaoService;
