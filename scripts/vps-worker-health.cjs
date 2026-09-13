"use strict";
const { createRequire } = require("node:module");
const path = require("node:path");
const workerRequire = createRequire(path.resolve(__dirname, "../apps/seller-ml/package.json"));
const Redis = workerRequire("ioredis");
const redis = new Redis(process.env.REDIS_URL, {maxRetriesPerRequest: 1, connectTimeout: 2000});
const timer = setTimeout(() => process.exit(1), 4000);
redis.get("promo:worker:heartbeat").then(raw => {
  const heartbeat = JSON.parse(raw || "{}");
  if (!(Number(heartbeat.ts) > Date.now() - 30000)) process.exitCode = 1;
}).catch(() => { process.exitCode = 1; }).finally(() => { clearTimeout(timer); redis.disconnect(); });
