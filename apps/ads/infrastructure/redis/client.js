"use strict";

const Redis = require("ioredis");
const { env } = require("../../config/env");

let client;

function getRedis() {
  if (!env.redisUrl) throw new Error("REDIS_URL is required");
  if (!client) {
    client = new Redis(env.redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
    client.on("error", (error) => console.error("[dach-ads:redis] error", error));
  }
  return client;
}

async function closeRedis() {
  if (!client) return;
  const current = client;
  client = null;
  await current.quit().catch(() => current.disconnect());
}

module.exports = { getRedis, closeRedis };
