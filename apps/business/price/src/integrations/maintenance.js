"use strict";

const { withPlatformAdmin, query } = require("../db");
const tray = require("./tray");
const meli = require("./mercadoLivre");
const shopee = require("./shopee");
const { markConnectionError } = require("./tokenStore");

let started = false;
let running = false;

function refreshFunction(channel) {
  if (channel === "tray") return tray.refreshLocked;
  if (channel === "meli") return meli.refreshLocked;
  if (channel === "shopee") return shopee.refreshLocked;
  return null;
}

async function runTokenMaintenance() {
  if (running) return;
  running = true;
  try {
    const connections = await withPlatformAdmin("", async (client) => (
      await client.query(
        `SELECT id, tenant_id, channel, token_expires_at, refresh_expires_at
         FROM volt_price.integration_connections
         WHERE status='active'
           AND refresh_token_cipher IS NOT NULL
           AND (token_expires_at IS NULL OR token_expires_at < now() + interval '45 minutes')
         ORDER BY token_expires_at NULLS FIRST`,
      )
    ).rows);

    for (const connection of connections) {
      const owner = (
        await query(
          `SELECT user_id
           FROM volt_price.memberships
           WHERE tenant_id=$1 AND status='active'
           ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, created_at
           LIMIT 1`,
          [connection.tenant_id],
        )
      ).rows[0];
      if (!owner) continue;

      const auth = {
        tenantId: connection.tenant_id,
        userId: owner.user_id,
        isPlatformAdmin: false,
      };
      const fn = refreshFunction(connection.channel);
      if (!fn) continue;

      try {
        await fn(auth, connection.id);
        console.log(`[volt-price] token ${connection.channel} renovado automaticamente (${connection.id}).`);
      } catch (error) {
        console.warn(`[volt-price] falha no refresh automatico ${connection.channel}:`, error.message);
        await markConnectionError(auth, connection.id, `Auto refresh: ${error.message}`).catch(() => {});
      }
    }
  } catch (error) {
    if (error.code !== "42P01") console.warn("[volt-price] token maintenance:", error.message);
  } finally {
    running = false;
  }
}

function startTokenMaintenance() {
  if (started || process.env.VOLT_PRICE_TOKEN_MAINTENANCE === "false") return;
  started = true;
  const intervalMs = Math.max(15 * 60_000, Number(process.env.VOLT_PRICE_TOKEN_MAINTENANCE_MS || 60 * 60_000));
  setTimeout(() => runTokenMaintenance().catch(() => {}), 15_000).unref?.();
  setInterval(() => runTokenMaintenance().catch(() => {}), intervalMs).unref?.();
}

module.exports = { startTokenMaintenance, runTokenMaintenance };
