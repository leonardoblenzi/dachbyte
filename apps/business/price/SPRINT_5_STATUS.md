# Sprint 5 — Marketing e rentabilidade pós-mídia

Status: implementada.

## Entregue

- Fontes de Mercado Livre Ads, Shopee Ads, Meta Ads, Google Ads, TikTok Ads e importação manual.
- Importação idempotente e versionada de métricas por `sourceRef`.
- Campanhas, impressões, cliques, conversões, spend, receita e pedidos atribuídos.
- ROAS, ACOS, TACOS, CPC, CTR, CVR, CAC e margem de contribuição pós-Ads.
- Cupons, moedas, promoções e comissões de afiliados com separação seller/marketplace.
- Custos atribuídos por pedido integrados ao cálculo versionado de Profit.
- Alertas de spend sem receita, ROAS destrutivo, TACOS alto e margem pós-Ads negativa.
- Workspace operacional de Ads e auditoria de todas as mutações.
- RLS/FORCE RLS nas novas tabelas tenant-owned.

## Conectores

O modelo e a ingestão estão prontos para conectores oficiais. Mercado Livre Product Ads está em transição para o novo fluxo de campanhas/ad groups. Google Ads usa GAQL via Search/SearchStream e TikTok Ads usa relatórios integrados. Shopee, Meta e os escopos de cada conta devem ser validados nos consoles oficiais antes de ativar jobs automáticos; nenhum endpoint foi presumido.
