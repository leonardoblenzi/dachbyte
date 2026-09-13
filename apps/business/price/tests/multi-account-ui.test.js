"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", "public", file), "utf8");
const integrations = read("tray-connection.js");
const orderLinking = read("orders-marketplace-link.js");
const styles = read("styles.css");

test("workspace de integrações agrupa canais e permite selecionar uma conta", () => {
  assert.match(integrations, /const channels=\["tray","meli","shopee"\]/);
  assert.match(integrations, /integration-workspace/);
  assert.match(integrations, /integration-channel-list/);
  assert.match(integrations, /dataset\.selectChannel/);
  assert.match(integrations, /conta\$\{count===1\?"":"s"\} vinculada/);
  assert.match(integrations, /data-link-channel/);
  assert.match(integrations, /Vincular conta \$\{integrationNames\[channel\]\}/);
});

test("cada grupo possui um controle Vincular independente da seleção", () => {
  assert.match(integrations, /className = "integration-channel-row"/);
  assert.match(integrations, /className = "integration-link-button"/);
  assert.match(integrations, /linkButton\.setAttribute\("aria-label", `Vincular conta \$\{integrationNames\[channel\]\}`\)/);
  assert.match(integrations, /if \(channel === "tray"\) \{[\s\S]*?renderTrayIntegrations\(root, "tray"\)/);
  assert.match(integrations, /connectUrl\(`\/integrations\/\$\{channel\}\/connect`\)/);
});

test("contas de marketplace expõem CRUD por conexão e link copiado com segurança", () => {
  assert.match(integrations, /data-save-connection/);
  assert.match(integrations, /data-refresh-connection/);
  assert.match(integrations, /data-disconnect-connection/);
  assert.match(integrations, /api\(`\/integrations\/\$\{id\}`/);
  assert.match(integrations, /\/integrations\/\$\{button\.dataset\.refreshConnection\}\/refresh/);
  assert.match(integrations, /\/integrations\/\$\{button\.dataset\.disconnectConnection\}\/disconnect/);
  assert.match(integrations, /\/integrations\/\$\{channel\}\/links/);
  assert.match(integrations, /readonly/);
  assert.match(integrations, /navigator\.clipboard\.writeText/);
  assert.doesNotMatch(integrations, /toast\([^\n]*authorizationUrl/);
});

test("Tray mantém as lojas conectadas e suas ações no painel", () => {
  assert.match(integrations, /function trayPanel\(connections\)/);
  assert.match(integrations, /connectionEditor\(connection\)/);
  assert.match(integrations, /bindConnectionActions\(panel, root, channel\)/);
  assert.match(integrations, /trayPanel\(byChannel\.tray \|\| \[\]\)/);
});

test("vínculo manual de pedido escolhe marketplace e conta ativa", () => {
  assert.match(orderLinking, /marketplaceLinkDialog/);
  assert.match(orderLinking, /id="marketplaceLinkChannel"/);
  assert.match(orderLinking, /id="marketplaceLinkConnection"/);
  assert.match(orderLinking, /connectionId/);
  assert.match(orderLinking, /\/integrations\//);
  assert.match(orderLinking, /marketplace_connection_display_name/);
  assert.match(orderLinking, /connection\.status === "active"/);
  assert.match(orderLinking, /requestGeneration/);
  assert.match(orderLinking, /node\.dataset\.orderId/);
  assert.match(orderLinking, /if \(generation !== requestGeneration\) return/);
  assert.doesNotMatch(orderLinking, /currentOrderButton/);
  assert.match(orderLinking, /Promise\.all\(\[api\("\/integrations\/"\), api\(`\/orders\/\$\{target\.orderId\}`\)\]\)/);
  assert.match(orderLinking, /authoritativeOrder\.marketplace_connection_id/);
  assert.match(orderLinking, /authoritativeOrder\.marketplace_order_id/);
  assert.match(orderLinking, /aria-labelledby/);
  assert.match(orderLinking, /marketplaceLinkDialogTitle/);
  assert.match(orderLinking, /data-account-label-processed/);
  assert.match(orderLinking, /#orderRows \[data-link\]:not\(\[data-account-label-processed\]\)/);
  assert.match(orderLinking, /addEventListener\("click"/);
});

test("layout de múltiplas contas é responsivo e mantém foco visível", () => {
  for (const selector of [
    ".integration-workspace",
    ".integration-channel-list",
    ".integration-channel",
    ".integration-channel.selected",
    ".connection-row",
    ".connection-actions",
    ".oauth-link-output",
    ".integration-channel:focus-visible",
  ]) assert.ok(styles.includes(selector), `faltou estilo ${selector}`);
});
