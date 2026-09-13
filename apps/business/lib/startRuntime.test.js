"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("container pins Volt Chat uvicorn to one worker", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "start.js"), "utf8");
  const docker = fs.readFileSync(path.resolve(__dirname, "../../..", "infra/docker/chat-api.Dockerfile"), "utf8");
  assert.match(docker, /"--workers", "1"/);
  assert.doesNotMatch(source, /spawn\(|startVoltChatApi/);
});
