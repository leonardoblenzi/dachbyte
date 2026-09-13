// services/ml-auth.js
// Adaptador para obter access_token por conta usando seu services/tokenService.js
// Suporta múltiplas contas via variáveis de ambiente prefixadas por conta:
//   ML_<ACCOUNT>_APP_ID
//   ML_<ACCOUNT>_CLIENT_SECRET
//   ML_<ACCOUNT>_REFRESH_TOKEN
//   ML_<ACCOUNT>_ACCESS_TOKEN  (opcional; será atualizado após renovação)
//   ML_<ACCOUNT>_REDIRECT_URI  (opcional)
//
// Fallbacks globais (sem prefixo) também são aceitos: APP_ID, CLIENT_SECRET, REFRESH_TOKEN,
// ACCESS_TOKEN, REDIRECT_URI, ML_APP_ID, ML_CLIENT_SECRET, ML_REFRESH_TOKEN, ML_REDIRECT_URI.
// Mantém compatibilidade com seu TokenService (renovarTokenSeNecessario).

'use strict';

const TokenService = require('./tokenService');
const { isProductionEnvironment } = require('../../../lib/runtimeEnv');

function normKey(accountId) {
  return String(accountId || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_');
}

function pickEnv(name) {
  return process.env[name];
}

function resolveCredsForAccount(accountId) {
  const K = normKey(accountId);

  // Credenciais por conta (preferência)
  const perAccount = {
    app_id:        pickEnv(`ML_${K}_APP_ID`),
    client_secret: pickEnv(`ML_${K}_CLIENT_SECRET`),
    refresh_token: pickEnv(`ML_${K}_REFRESH_TOKEN`),
    access_token:  pickEnv(`ML_${K}_ACCESS_TOKEN`),
    redirect_uri:  pickEnv(`ML_${K}_REDIRECT_URI`),
  };

  // Fallbacks globais
  const globalCreds = {
    app_id:
      pickEnv('APP_ID') ||
      pickEnv('ML_APP_ID') ||
      pickEnv('MERCADOLIBRE_APP_ID'),
    client_secret:
      pickEnv('CLIENT_SECRET') ||
      pickEnv('ML_CLIENT_SECRET') ||
      pickEnv('MERCADOLIBRE_CLIENT_SECRET'),
    refresh_token:
      pickEnv('REFRESH_TOKEN') ||
      pickEnv('ML_REFRESH_TOKEN') ||
      pickEnv('MERCADOLIBRE_REFRESH_TOKEN'),
    access_token:
      pickEnv('ACCESS_TOKEN') ||
      pickEnv('MERCADOLIBRE_ACCESS_TOKEN'),
    redirect_uri:
      pickEnv('REDIRECT_URI') ||
      pickEnv('ML_REDIRECT_URI'),
  };

  return {
    // ordem: per-account -> global
    app_id:        perAccount.app_id        || globalCreds.app_id,
    client_secret: perAccount.client_secret || globalCreds.client_secret,
    refresh_token: perAccount.refresh_token || globalCreds.refresh_token,
    access_token:  perAccount.access_token  || globalCreds.access_token,
    redirect_uri:  perAccount.redirect_uri  || globalCreds.redirect_uri,
    account_key:   accountId, // para logs do seu TokenService
  };
}

/**
 * Obtém (ou renova) o access_token válido para a conta informada.
 * Retorna uma STRING com o token pronto para uso (Authorization: Bearer <token>).
 */
async function getAccessTokenForAccount(accountId /* , req opcional se quiser futuramente */) {
  if (!accountId) {
    throw new Error('getAccessTokenForAccount: accountId é obrigatório');
  }

  const creds = resolveCredsForAccount(accountId);
  // Usa seu TokenService para validar/renovar automaticamente
  const token = await TokenService.renovarTokenSeNecessario(creds);

  // Atualiza variáveis para manter compatibilidade com código legado
  const K = normKey(accountId);
  if (!isProductionEnvironment()) {
    process.env[`ML_${K}_ACCESS_TOKEN`] = token; // por conta
    process.env.ACCESS_TOKEN = token; // global (se algum trecho do projeto ainda usa)
  }

  return token;
}

module.exports = { getAccessTokenForAccount };
