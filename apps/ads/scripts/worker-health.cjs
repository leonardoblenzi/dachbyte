"use strict";

const Redis = require("ioredis");
const redisUrl = String(process.env.REDIS_URL || "").trim();
const key = String(process.env.ADS_WORKER_HEARTBEAT_KEY || "ads:worker:heartbeat").trim();
if (!redisUrl) process.exit(1);

const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 2000 });
const timer = setTimeout(() => process.exit(1), 4000);

redis
  .get(key)
  .then((raw) => {
    const heartbeat = JSON.parse(raw || "{}");
    if (!(Number(heartbeat.ts) > Date.now() - 30_000)) process.exitCode = 1;
  })
  .catch(() => {
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(timer);
    redis.disconnect();
  });
