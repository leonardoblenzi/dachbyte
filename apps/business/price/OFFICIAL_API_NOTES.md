# Notas de integração oficial

Data da revisão: 2026-08-11.

## Tray

A documentação oficial informa:

- autorização em `https://{dominio_da_loja}/auth.php`;
- callback retorna `code`, `api_address`, `store` e `store_host`;
- troca de code em `{api_address}/auth` com consumer key/secret;
- retorno inclui access token, refresh token e respectivas datas de expiracao;
- refresh em `{api_address}/auth?refresh_token=...` devolve novos tokens;
- pedidos em `{api_address}/orders?access_token=...`;
- filtros oficiais incluem `status`, `limit`, `page`, `sort` e datas;
- `paging.maxLimit` documentado como 50;
- pedido completo em `/orders/:id/complete`.

O VoltPrice pagina automaticamente e aceita periodo/status no sync.

## Mercado Livre

A documentacao oficial informa:

- access token com `expires_in=21600` (6 horas);
- refresh token e de uso unico;
- a cada refresh e emitido um novo refresh token e apenas o ultimo continua valido;
- `/orders/{ORDER_ID}` fornece `order_items[].sale_fee`;
- `payments[].marketplace_fee` tambem aparece no pedido quando aplicavel;
- billing por order: `/billing/integration/group/ML/order/details?order_ids=...`;
- o endpoint por order aceita ate 60 order ids na chamada;
- a orientacao oficial para billing e evitar polling/batch massivo, armazenar os resultados e nao consultar repetidamente o mesmo pedido.

Por isso o VoltPrice serializa refresh com lock de banco e aplica cache local para consulta financeira.

### Market / busca de listings

- a API oficial permite consultar listings ativos em `/sites/{SITE_ID}/search` por `seller_id` ou `nickname`;
- a resposta traz paginação, filtros e resultados das listagens ativas;
- o VoltPrice só interpreta desaparecimento como ruptura quando conclui o snapshot paginado;
- buscas truncadas pelo limite operacional não alteram disponibilidade de listings ausentes.

### Product Ads

- a documentação oficial atual marca os endpoints legados de Product Ads como desativados em 26/02/2026;
- o novo fluxo organiza anúncios em campanhas e ad groups;
- por isso a Sprint 5 entrega a camada comum, importação idempotente e atribuição, sem chamar um endpoint legado;
- a sincronização automática deve ser habilitada somente depois de validar advertiser, campanha/ad group e escopos na conta real.

## Shopee

A base do conector esta implementada no formato Open Platform V2:

- partner/shop HMAC SHA-256;
- authorization;
- exchange code -> tokens;
- refresh access token;
- shop-level signed calls;
- order list/detail;
- payment escrow detail por `order_sn`.

A pagina oficial `open.shopee.com` retornou bloqueio para leitura automatizada no ambiente de validacao. Assim, todos os paths estao em env. Antes do primeiro deploy conectado, validar no console autenticado do app Shopee:

1. endpoint regional/base URL;
2. path de auth_partner;
3. path de token exchange;
4. path de refresh;
5. path de payment/escrow detail;
6. permissoes do app para Order e Payment;
7. formato/validade de refresh token da conta/regiao.

Isso evita depender de uma suposicao fixa no codigo.

## Google Ads

A API oficial usa GAQL em `GoogleAdsService.Search` ou `SearchStream` para relatórios. O modelo da Sprint 5 comporta custo, impressões, cliques, conversões e receita atribuída. A automação depende de OAuth/customer ID e developer token próprios.

## TikTok Ads

A API for Business oficial disponibiliza relatórios integrados com spend, impressões, cliques e conversões. A ativação automática depende de app, token, advertiser e escopos da conta.

## Meta Ads

A fonte e o contrato comum estão prontos, mas OAuth, conta de anúncios e permissões do Marketing API devem ser configurados e validados no app Meta antes de qualquer job automático.
