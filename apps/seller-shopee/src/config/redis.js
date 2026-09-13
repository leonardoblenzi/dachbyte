// src/config/redis.js
const IORedis = require("ioredis");

const redisUrl = process.env.REDIS_URL;

const client = redisUrl
  ? new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    })
  : null;

// ✅ BullMQ pode receber connection como IORedis instance (recomendado)
const connection = client || { host: "localhost", port: 6379 };

module.exports = { client, redisUrl, connection };
