# Catálogo enxuto da seleção Seller

## Objetivo

Restringir a seleção compartilhada do Seller aos produtos Mercado Livre, Shopee e Tracking. DACH Ads, Log, Madeira e Leader usam jornadas e logins próprios e não devem ser apresentados nessa tela.

## Contexto

A página `/selecao-plataforma` é entregue pelo Gateway em `apps/gateway/server.js` a partir de `apps/seller-ml/views/selecao-plataforma.html`. Os cartões visíveis são filtrados no navegador pelas permissões retornadas pelo Hub; cada destino também é protegido no servidor por `createSuiteGoHandler`.

## Decisão

Remover da marcação da seleção Seller os cartões `dach_ads`, `davanttilog`, `madeiramadeira` e `skuleader`, bem como os aliases de renovação que apenas atendem a cartões removidos. Não remover as rotas `go` dos módulos legados: elas continuam sendo portas compatíveis, protegidas pela autorização no Gateway, para os respectivos fluxos próprios.

## Regras de acesso

- Mercado Livre, Shopee e Tracking só aparecem e ficam acionáveis quando a sessão possui o módulo correspondente retornado pelo Hub.
- A remoção visual não concede nem revoga nenhuma permissão no Hub.
- DACH Ads não participa da seleção Seller; sua autenticação e URL são independentes.
- Uma tentativa direta às rotas de módulos removidos permanece submetida à verificação de autorização do Gateway.

## Critérios de aceite

- A página contém somente os cartões `ml`, `shopee` e `tracking`.
- O código que filtra permissões preserva os aliases desses três módulos.
- Nenhum cartão ou alias de Ads, Log, Madeira ou Leader permanece na seleção.
- As rotas de compatibilidade dos módulos removidos continuam declaradas no Gateway.
