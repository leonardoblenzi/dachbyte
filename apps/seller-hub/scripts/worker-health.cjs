"use strict";

// Healthcheck do worker do DACH Hub: saudável se o worker gravou o sinal de vida nos últimos 30 s.
const Redis = require("ioredis");

const redis = new Redis(process.env.HUB_REDIS_URL || process.env.REDIS_URL || "redis://redis:6379", {
  maxRetriesPerRequest: 1,
  connectTimeout: 2000,
});
const timer = setTimeout(() => process.exit(1), 4000);

redis.get("seller-hub:worker:heartbeat")
  .then((raw) => {
    const heartbeat = JSON.parse(raw || "{}");
    if (!(Number(heartbeat.ts) > Date.now() - 30_000)) process.exitCode = 1;
  })
  .catch(() => { process.exitCode = 1; })
  .finally(() => {
    clearTimeout(timer);
    redis.disconnect();
  });
