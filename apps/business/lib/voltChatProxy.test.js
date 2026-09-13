"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough, Readable } = require("stream");
const { proxyVoltChatApi } = require("./voltChatProxy");

test("proxy do VoltChat transmite downloads sem criar arrayBuffer", async (t) => {
  const originalFetch = global.fetch;
  let arrayBufferCalled = false;
  const chunks = [Buffer.alloc(64 * 1024, 1), Buffer.alloc(64 * 1024, 2)];

  global.fetch = async () => ({
    status: 200,
    headers: new Headers({
      "content-length": String(chunks.reduce((total, chunk) => total + chunk.length, 0)),
      "content-type": "application/octet-stream",
    }),
    body: Readable.toWeb(Readable.from(chunks)),
    async arrayBuffer() {
      arrayBufferCalled = true;
      throw new Error("arrayBuffer nao deve ser usado");
    },
  });
  t.after(() => {
    global.fetch = originalFetch;
  });

  const response = new PassThrough();
  const received = [];
  response.status = (statusCode) => {
    response.statusCode = statusCode;
    return response;
  };
  response.setHeader = (name, value) => {
    response.headers ||= {};
    response.headers[name.toLowerCase()] = value;
  };
  response.on("data", (chunk) => received.push(chunk));

  await proxyVoltChatApi({
    originalUrl: "/chat-api/downloads/desktop/latest",
    method: "GET",
    headers: {},
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(arrayBufferCalled, false);
  assert.deepEqual(Buffer.concat(received), Buffer.concat(chunks));
});

test("proxy do VoltChat removes the Business mount path before contacting the API", async (t) => {
  const originalFetch = global.fetch;
  let targetUrl;
  global.fetch = async (url) => {
    targetUrl = String(url);
    return { status: 204, headers: new Headers(), body: null };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const response = new PassThrough();
  response.status = (statusCode) => {
    response.statusCode = statusCode;
    return response;
  };
  response.setHeader = () => {};
  response.end = () => {};

  await proxyVoltChatApi({
    originalUrl: "/business/chat-api/messages",
    url: "/messages",
    method: "GET",
    headers: {},
  }, response);

  assert.match(targetUrl, /\/messages$/);
  assert.equal(targetUrl.includes("/business/chat-api"), false);
});
