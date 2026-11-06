"use strict";

// Cache do painel por conta e periodo (memoria do processo web).
// Abrir o painel de novo nao recalcula margem, vendas e ritmo do mes.
const TTL_SEC = 300;
const MAX_ENTRIES = 200;
const entries = new Map();

function key(accountId, periodKey) { return `${Number(accountId)}:${String(periodKey)}`; }

function get(accountId, periodKey) {
  const entry = entries.get(key(accountId, periodKey));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { entries.delete(key(accountId, periodKey)); return null; }
  return entry.payload;
}

function set(accountId, periodKey, payload) {
  entries.set(key(accountId, periodKey), { payload, expiresAt: Date.now() + TTL_SEC * 1000 });
  if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
}

// Ex.: depois de renomear a conta, o proximo painel ja mostra o nome novo.
function invalidateAccount(accountId) {
  const prefix = `${Number(accountId)}:`;
  for (const cacheKey of [...entries.keys()]) if (cacheKey.startsWith(prefix)) entries.delete(cacheKey);
}

module.exports = { TTL_SEC, get, set, invalidateAccount };
