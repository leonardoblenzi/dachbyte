"use strict";

// Landings do Seller (09/11/2026): formulário de contato (WhatsApp ou e-mail), simulação do Magalu,
// elementos sem 3D e aba do SAC fora do menu.
const fs = require("node:fs");
const path = require("node:path");

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const root = path.join(__dirname, "..");
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), "utf8");
const landings = ["landing-general.html", "landing-mercado-livre.html", "landing-shopee.html", "landing-magalu.html"];

test("landings do Seller: contato pelo formulário, sem e-mail antigo nem mailto, com prévia de compartilhamento", () => {
  for (const name of landings) {
    const html = read("apps", "gateway", "views", "seller", name);
    assert.match(html, /data-dx-contact-form/, name);
    assert.doesNotMatch(html, /mailto:|davanttisuite/, name);
    assert.match(html, /property="og:image"/, name);
  }
  const general = read("apps", "gateway", "views", "seller", "landing-general.html");
  assert.doesNotMatch(general, /Entregas e alertas|entregas que pedem ação|03 \/ PILOTO/);
  const js = read("public", "brand", "dachbyte", "landing-experience.js");
  assert.doesNotMatch(js, /davanttisuite|mailto:/);
  assert.match(js, /\/api\/contact\/commercial/);
  assert.match(js, /contact_preference/);
});

test("simulação do Magalu existe e tipo desconhecido não quebra a página", () => {
  const js = read("public", "brand", "dachbyte", "landing-experience.js");
  assert.match(js, /magalu: calculator/);
  assert.match(js, /if \(scene\) return scene\(bench\)/);
  assert.match(js, /Você vendeu no Magalu/);
});

test("elementos das landings sem inclinação 3D nem sombra deslocada", () => {
  const css = read("public", "brand", "dachbyte", "landing-experience.css");
  assert.doesNotMatch(css, /rotate[XY]\(|skewY\(|perspective\(/);
  assert.match(css, /@import url\('https:\/\/fonts\.googleapis\.com\/css2\?family=Inter/);
  const seller = read("public", "brand", "dachbyte", "seller", "landing.css");
  assert.doesNotMatch(seller, /box-shadow:\s*26px 26px 0/);
});

test("aba do SAC: sem posição salva fica a 58% da altura; valor antigo (preso no topo) é ignorado", () => {
  const widget = read("public", "support", "davantti-support-widget.js");
  assert.match(widget, /davantti:sac:launcher-top:v2/);
  assert.match(widget, /value === null \|\| value === undefined \|\| value === ""/);
  assert.doesNotMatch(widget, /addEventListener\("resize", function \(\) \{\s*saveLauncherTop/);
});

async function postLead(body) {
  const service = require("../apps/seller-ml/services/commercialLeadEmailService");
  const sent = [];
  service.sendCommercialLeadEmail = async (lead) => { sent.push(lead); return { sent: true }; };
  delete require.cache[require.resolve("../apps/seller-ml/routes/publicCommercialContactRoutes")];
  const routes = require("../apps/seller-ml/routes/publicCommercialContactRoutes");
  const app = express();
  app.use(express.json());
  app.use("/api/contact", routes);
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/contact/commercial`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json(), sent };
  } finally { server.close(); }
}

test("rota de contato: WhatsApp exige número com DDD, e-mail exige e-mail; robôs são descartados", async () => {
  const base = { name: "Loja Teste", channels: ["Shopee"] };
  const zap = await postLead({ ...base, contact_preference: "whatsapp", cellphone: "(11) 91234-5678", orders_volume: "300 a 1.000 pedidos por mês" });
  assert.equal(zap.status, 200);
  assert.equal(zap.sent[0].contactPreference, "whatsapp");
  assert.equal(zap.sent[0].ordersVolume, "300 a 1.000 pedidos por mês");
  assert.equal((await postLead({ ...base, contact_preference: "whatsapp", cellphone: "1234" })).status, 400);
  const mail = await postLead({ ...base, contact_preference: "email", email: "loja@exemplo.com.br" });
  assert.equal(mail.status, 200);
  assert.equal(mail.sent[0].email, "loja@exemplo.com.br");
  assert.equal((await postLead({ ...base, contact_preference: "email", email: "loja@" })).status, 400);
  const bot = await postLead({ ...base, contact_preference: "email", email: "x@y.com", website: "spam" });
  assert.equal(bot.status, 200);
  assert.equal(bot.sent.length, 0, "campo escondido preenchido: não envia");
  // Formulário antigo (sem preferência): e-mail e celular continuam obrigatórios.
  assert.equal((await postLead({ ...base, email: "a@b.com" })).status, 400);
});

test("destino padrão do lead é o e-mail do hub de acessos", () => {
  const service = read("apps", "seller-ml", "services", "commercialLeadEmailService.js");
  assert.match(service, /BREVO_COMMERCIAL_TO_EMAIL\) \|\|\s*"noreply@dachbyte\.tech"/);

});

test("fila da Shopee: por chegada os pedidos que vencem ficam no fim; por prazo, no topo", () => {
  const { orders, orderQueue, deadlineState } = require("../public/brand/dachbyte/landing-experience.js");
  const now = 10 * 60 + 30;
  const urgentPositions = (mode) => orderQueue(orders, mode).map((o, i) => [i + 1, deadlineState(o, now).state]).filter(([, s]) => s !== "ok").map(([p]) => p);
  assert.deepEqual(urgentPositions("arrival"), [5, 6]);
  assert.deepEqual(urgentPositions("deadline"), [1, 2]);
  assert.equal(deadlineState(orders.find((o) => o.id === "SH-4798"), 12 * 60).state, "late");
});

test("cada página de canal tem a própria cor (ML amarelo, Shopee vermelho, Magalu azul)", () => {
  const css = read("public", "brand", "dachbyte", "seller", "landing.css");
  assert.match(css, /html\[data-dachbyte-app="seller-ml"\] \{ --seller-primary: var\(--seller-ml\)/);
  assert.match(css, /html\[data-dachbyte-app="seller-shopee"\] \{ --seller-primary: var\(--seller-shopee\)/);
  assert.match(css, /html\[data-dachbyte-app="seller-magalu"\] \{ --seller-primary: var\(--seller-magalu\)/);
  assert.doesNotMatch(css, /rgba\(255,138,63/);
  for (const name of landings) assert.match(read("apps", "gateway", "views", "seller", name), /dx-contact-split/, name);
});
