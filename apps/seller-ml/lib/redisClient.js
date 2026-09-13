const IORedis = require("ioredis");

const sharedClients = new Map();

function buildOptions() {
  const common = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
  const url = process.env.REDIS_URL;
  if (url) {
    return { url, options: common };
  }
  return {
    url: null,
    options: {
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: Number(process.env.REDIS_PORT || 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      ...common,
    },
  };
}

function createRedis() {
  const { url, options } = buildOptions();
  return url ? new IORedis(url, options) : new IORedis(options);
}

function makeRedis() {
  return createRedis();
}

function getSharedRedis(name = "default") {
  const key = String(name || "default");
  if (!sharedClients.has(key)) {
    const client = createRedis();
    client.on("end", () => {
      if (sharedClients.get(key) === client) sharedClients.delete(key);
    });
    client.on("error", () => {});
    sharedClients.set(key, client);
  }
  return sharedClients.get(key);
}

function normalizeBullScope(scope = "default") {
  const text = String(scope || "default").trim();
  if (!text) return "default";
  return text.replace(/\s+/g, "_").toLowerCase();
}

function makeBullClient(type = "client", scope = "default") {
  const normalizedScope = normalizeBullScope(scope);
  if (type === "client") {
    return getSharedRedis(`bull:${normalizedScope}:client`);
  }
  if (type === "subscriber") {
    return getSharedRedis(`bull:${normalizedScope}:subscriber`);
  }
  return createRedis();
}

module.exports = { makeRedis, getSharedRedis, makeBullClient };
