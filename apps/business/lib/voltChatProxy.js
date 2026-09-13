"use strict";

const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const VOLT_CHAT_API_URL =
  process.env.DACHBYTE_CHAT_API_URL
  || process.env.VOLT_CHAT_UPSTREAM_URL
  || "http://127.0.0.1:8001";

async function proxyVoltChatApi(req, res) {
  // Express removes /business/chat-api from req.url when Business is hosted
  // below its public prefix. Use that mounted path and retain originalUrl only
  // for direct invocation compatibility.
  const targetPath = String(req.url || req.originalUrl || "").replace(/^\/chat-api/, "") || "/";
  const targetUrl = new URL(targetPath, VOLT_CHAT_API_URL);
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    const lowerKey = key.toLowerCase();
    if (["connection", "content-length", "host", "origin", "referer"].includes(lowerKey)) continue;
    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(key, item));
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const init = {
    method: req.method,
    headers,
    redirect: "manual",
  };

  if (!["GET", "HEAD"].includes(req.method)) {
    init.body = req;
    init.duplex = "half";
  }

  try {
    const upstream = await fetch(targetUrl, init);
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (!["connection", "content-encoding", "transfer-encoding"].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    if (!upstream.body || req.method === "HEAD") {
      return res.end();
    }

    await pipeline(Readable.fromWeb(upstream.body), res);
    return undefined;
  } catch (error) {
    if (res.headersSent) {
      if (!res.destroyed) res.destroy(error);
      return undefined;
    }
    return res.status(502).json({
      success: false,
      error: "Falha ao comunicar com a API do Volt Chat.",
      detail: error instanceof Error ? error.message : "Erro desconhecido",
    });
  }
}

module.exports = { proxyVoltChatApi };
