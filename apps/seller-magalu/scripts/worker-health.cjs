"use strict";

const Redis = require("ioredis");

const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379", {
  maxRetriesPerRequest: 1,
  connectTimeout: 2000,
});
const timer = setTimeout(() => process.exit(1), 4000);

redis.get("magalu:worker:heartbeat")
  .then((raw) => {
    const heartbeat = JSON.parse(raw || "{}");
    if (!(Number(heartbeat.ts) > Date.now() - 30_000)) process.exitCode = 1;
  })
  .catch(() => { process.exitCode = 1; })
  .finally(() => {
    clearTimeout(timer);
    redis.disconnect();
  });
