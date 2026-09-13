"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "tray-connection.js"), "utf8");
const envExample = fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8");
const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");

test("Tray authorization uses the dedicated store URL form and browser redirect", () => {
  assert.match(source, /id="trayConnectForm"/);
  assert.match(source, /id="trayHost"[^>]*type="url"/);
  assert.match(source, /Autorizar na Tray/);
  assert.match(source, /async function startTrayAuthorization/);
  assert.match(source, /api\("\/integrations\/tray\/connect",\{method:"POST"/);
  assert.match(source, /location\.assign\(result\.authorizationUrl\)/);
  assert.match(source, /new URLSearchParams\(location\.search\)/);
  assert.match(source, /history\.replaceState/);
});

test("Tray card renders only safe connection lifecycle metadata", () => {
  assert.match(source, /connection_status/);
  assert.match(source, /token_expires_at/);
  assert.match(source, /last_refresh_at/);
  assert.match(source, /last_error/);
  assert.doesNotMatch(source, /trayConsumerSecret|consumer_secret|refreshToken.*trayHost|accessToken.*trayHost/i);
});

test("Tray OAuth deployment instructions name the Render variables and callback", () => {
  assert.match(envExample, /^VOLT_PRICE_TRAY_CONSUMER_KEY=/m);
  assert.match(envExample, /^VOLT_PRICE_TRAY_CONSUMER_SECRET=/m);
  assert.match(readme, /VOLT_PRICE_PUBLIC_BASE_URL/);
  assert.match(readme, /\/volt-price\/api\/integrations\/tray\/callback/);
  assert.match(readme, /n[aã]o.*(?:exibe|envia).*token/i);
  assert.match(readme, /renova.*automaticamente/i);
});
