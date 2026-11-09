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
  assert.match(js, /magalu: p => calculator\(p, channelRates\.magalu\)/);
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

test("simulação de estoque: cobertura, ponto de pedido e compra sugerida como nas telas de Estoque", () => {
  const { stockPlan } = require("../public/brand/dachbyte/landing-experience.js");
  assert.deepEqual(stockPlan(100, 8, 15), { coverage: 12.5, days: 12, risk: "alto", orderBy: -3, gapDays: 3, lostSales: 20, suggestion: 296 });
  assert.equal(stockPlan(0, 5, 10).risk, "ruptura");
  assert.equal(stockPlan(0, 5, 10).lostSales, 50);
  assert.equal(stockPlan(40, 8, 3).risk, "critico");
  assert.equal(stockPlan(240, 8, 15).risk, "atencao");
  assert.equal(stockPlan(240, 8, 15).suggestion, 176, "desconta o que ainda sobra quando a reposição chega");
  assert.equal(stockPlan(400, 5, 10).risk, "ok");
  assert.equal(stockPlan(400, 5, 10).suggestion, 0);
});

test("landings mostram funções que existem nos módulos, sem a fila por prazo nem etiquetas inventadas", () => {
  const js = read("public", "brand", "dachbyte", "landing-experience.js");
  assert.doesNotMatch(js, /Por prazo \(DACHBYTE\)|orderQueue|deadlineState/);
  assert.match(js, /shopee: stock/);
  const general = read("apps", "gateway", "views", "seller", "landing-general.html");
  assert.doesNotMatch(general, /Etiqueta pendente|Coleta confirmada|Separar até/);
  for (const name of landings.slice(1)) {
    const html = read("apps", "gateway", "views", "seller", name);
    assert.match(html, /class="seller-features"/, name);
    assert.doesNotMatch(html, /id="leitura"|id="operacao"|\bIA\b/, name);
  }
});

test("cada página de canal tem a própria cor (ML amarelo, Shopee vermelho, Magalu azul)", () => {
  const css = read("public", "brand", "dachbyte", "seller", "landing.css");
  assert.match(css, /html\[data-dachbyte-app="seller-ml"\] \{ --seller-primary: var\(--seller-ml\)/);
  assert.match(css, /html\[data-dachbyte-app="seller-shopee"\] \{ --seller-primary: var\(--seller-shopee\)/);
  assert.match(css, /html\[data-dachbyte-app="seller-magalu"\] \{ --seller-primary: var\(--seller-magalu\)/);
  assert.doesNotMatch(css, /rgba\(255,138,63/);
  for (const name of landings) assert.match(read("apps", "gateway", "views", "seller", name), /dx-contact-split/, name);
});

test("revisão de UX: Magalu com as taxas do módulo, simulação depois das funções e acessibilidade", () => {
  const { margin, channelRates } = require("../public/brand/dachbyte/landing-experience.js");
  assert.deepEqual(margin(100, 0, 8, channelRates.magalu), { revenue: 100, fees: 18, profit: 17, margin: 17, breakEven: 80.46 });
  const sellerJs = read("public", "brand", "dachbyte", "seller", "landing.js");
  assert.match(sellerJs, /querySelector\('#funcoes, #modulos'\)/);
  assert.match(sellerJs, /ArrowRight/);
  assert.match(sellerJs, /Pular para o conteúdo/);
  const js = read("public", "brand", "dachbyte", "landing-experience.js");
  assert.match(js, /aria-valuetext/);
  for (const name of landings) assert.match(read("apps", "gateway", "views", "seller", name), /class="seller-ticker" aria-hidden="true"/, name);
});
