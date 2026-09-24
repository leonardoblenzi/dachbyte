"use strict";

const IORedis = require("ioredis");
const env = require("./env");

let client;

function buildClient() {
  const redis = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
  });
  redis.on("error", (error) => {
    console.error("[seller-magalu:redis]", error?.message || error);
  });
  return redis;
}

function getRedis() {
  if (!client) client = buildClient();
  return client;
}

async function ensureRedisConnected(redis = getRedis()) {
  if (redis.status === "wait") await redis.connect();
  return redis;
}

async function createRedisConnection() {
  return ensureRedisConnected(buildClient());
}

module.exports = { getRedis, ensureRedisConnected, createRedisConnection };
