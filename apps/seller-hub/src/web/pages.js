// @ts-check
"use strict";

/** @param {unknown} value */
function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
}

const ASSET_VERSION = "20261109a";

/** Páginas do DACH Hub. Cada uma vira um item do menu lateral. */
const PAGES = {
  "/": { title: "Painel", kicker: "Visão geral", lead: "Produtos, anúncios e vínculos de todos os canais conectados.", view: "overview" },
  "/saude": { title: "Saúde das contas", kicker: "Visão geral", lead: "Conexões, pedidos, conferências de estoque, envios e divergências de cada conta.", view: "health" },
  "/catalogo": { title: "Produtos", kicker: "Catálogo", lead: "Cada produto (SKU DACH) com os anúncios ligados a ele em cada canal.", view: "items" },
  "/pendencias": { title: "Pendências", kicker: "Catálogo", lead: "Anúncios que ainda não estão ligados a um produto. Sem vínculo, a venda não baixa estoque.", view: "pending" },
  "/estoque": { title: "Saldos", kicker: "Estoque", lead: "Estoque mestre de cada produto. Kits usam o menor componente.", view: "stock" },
  "/estoque/observacao": { title: "O que mudaria", kicker: "Estoque", lead: "Quanto o Hub enviaria para cada anúncio, comparado ao que está no canal. Nada é enviado nesta fase.", view: "plan" },
  "/estoque/movimentos": { title: "Movimentos", kicker: "Estoque", lead: "Histórico de cada alteração de estoque, com origem e motivo.", view: "movements" },
  "/estoque/envios": { title: "Envios", kicker: "Estoque", lead: "Estoque enviado aos canais em modo ativo, conferido relendo o anúncio.", view: "pushes" },
  "/pedidos": { title: "Pedidos", kicker: "Vendas", lead: "Todos os pedidos dos canais: situação, prazo de envio, valores e a baixa de estoque de cada item.", view: "orders" },
  "/pedidos/detalhe": { title: "Pedido", kicker: "Vendas", lead: "Valores, envio, itens e linha do tempo do pedido.", view: "orderDetail" },
  "/expedicao": { title: "Separação", kicker: "Expedição", lead: "Fila de pedidos a separar e lotes com a lista de separação somada por produto.", view: "expedition" },
  "/expedicao/lote": { title: "Lote de separação", kicker: "Expedição", lead: "Lista de separação do lote (kits abertos nos componentes) e o andamento da conferência.", view: "pickingBatch" },
  "/expedicao/conferencia": { title: "Conferência", kicker: "Expedição", lead: "Bipe o pedido e os itens com o leitor de código de barras. A foto do pacote fica guardada no pedido.", view: "checkout" },
  "/expedicao/etiquetas": { title: "Etiquetas", kicker: "Expedição", lead: "Etiquetas de envio geradas nos canais (Mercado Livre, Magalu e Shopee), um arquivo por conta.", view: "labels" },
  "/expedicao/coletas": { title: "Coletas", kicker: "Expedição", lead: "Coletas das transportadoras e marketplaces: embarque por bipagem e romaneio para assinatura.", view: "pickups" },
  "/expedicao/coleta": { title: "Coleta", kicker: "Expedição", lead: "Bipe os pacotes que vão nesta coleta.", view: "pickup" },
  "/automacoes": { title: "Automações", kicker: "Vendas", lead: "Status internos dos pedidos e regras automáticas: quando algo acontece, se as condições batem, o Hub age.", view: "automations" },
  "/avisos": { title: "Avisos", kicker: "Visão geral", lead: "Avisos para a equipe criados pelas automações.", view: "notifications" },
  "/cobranca/vendas": { title: "Vendas do mês", kicker: "Conta", lead: "Vendas medidas para a cobrança do DACH Hub (% sobre vendas), com o extrato pedido a pedido.", view: "billing" },
  "/estoque/divergencias": { title: "Divergências", kicker: "Estoque", lead: "Estoque que mudou nos canais por fora do Hub, encontrado na conferência.", view: "divergences" },
  "/estoque/regras": { title: "Regras por conta", kicker: "Estoque", lead: "Modo de estoque de cada conta e a regra padrão de envio.", view: "rules" },
  "/contas": { title: "Contas conectadas", kicker: "Conta", lead: "Marketplaces e lojas virtuais conectados diretamente ao DACH Hub.", view: "accounts" },
};

/**
 * HTML de uma página: o conteúdo fica em <main data-shell-content> e o
 * seller-shell monta o menu lateral e a barra superior em volta.
 * @param {keyof typeof PAGES} path
 * @param {{ name: string, isAdmin: boolean }} viewer
 */
function renderPage(path, viewer) {
  const page = PAGES[path];
  return `<!doctype html>
<html lang="pt-BR" data-seller-theme="violet">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(page.title)} · DACH Hub</title>
  <link rel="icon" href="/brand/dachbyte/hub/mark.svg?v=2" type="image/svg+xml">
  <script>try{var t=JSON.parse(localStorage.getItem("dachbyte:hub:shell:theme")||"null");document.documentElement.setAttribute("data-theme",t||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"));}catch(e){}</script>
  <link rel="stylesheet" href="/hub/ui/seller-shell.css?v=${ASSET_VERSION}">
  <link rel="stylesheet" href="/hub/assets/hub.css?v=${ASSET_VERSION}">
</head>
<body>
  <main data-shell-content data-view="${esc(page.view)}" data-admin="${viewer.isAdmin ? "1" : "0"}">
    <section class="seller-hero">
      <div><span class="seller-kicker">${esc(page.kicker)}</span><h1>${esc(page.title)}</h1><p>${esc(page.lead)}</p></div>
    </section>
    <div data-view-root><div class="seller-card"><div class="seller-empty"><strong>Carregando…</strong></div></div></div>
  </main>
  <script src="/hub/ui/seller-shell.js?v=${ASSET_VERSION}"></script>
  <script src="/hub/assets/hub-stock.js?v=${ASSET_VERSION}"></script>
  <script src="/hub/assets/hub-sync.js?v=${ASSET_VERSION}"></script>
  <script src="/hub/assets/hub-automations.js?v=${ASSET_VERSION}"></script>
  <script src="/hub/assets/hub-expedition.js?v=${ASSET_VERSION}"></script>
  <script src="/hub/assets/hub-app.js?v=${ASSET_VERSION}"></script>
</body>
</html>`;
}

module.exports = { PAGES, renderPage, ASSET_VERSION };
