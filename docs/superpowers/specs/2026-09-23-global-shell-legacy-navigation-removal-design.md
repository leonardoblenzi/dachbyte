# Shell global único e remoção de navegação legada

## Contexto

As landings públicas da suíte começaram a usar o shell global DACHBYTE por meio de
`data-dx-shell`. Parte delas, porém, ainda entrega uma navegação própria no HTML e a
oculta somente depois que `landing-experience.js` executa. Como o script é carregado
no fim da página, a barra antiga pode aparecer brevemente antes de o shell global
assumir a interface.

O comportamento foi confirmado em Seller, Business, Core e Stock. O Price já parte
somente do shell global. No Chat, a barra própria não é ocultada: ela convive com o
shell e cria duas navegações para a mesma página.

## Objetivo

Deixar o shell global como a única navegação pública da DACHBYTE e eliminar o flash,
o código visual morto e a duplicidade de navegação, sem alterar rotas autenticadas,
APIs, conteúdo funcional ou permissões.

## Arquitetura proposta

### Shell global

- Todas as páginas públicas Seller e Business terão o host `data-dx-shell` logo após
  a abertura de `body`.
- O carregamento e a montagem do shell serão idempotentes e independentes das
  seções interativas das landings. A existência ou a ausência de uma navegação antiga
  não poderá interromper scripts de demos, abas ou CTAs.
- O menu global será a única fonte de links entre famílias e produtos. Magalu será
  incluído no grupo Seller com a indicação de disponibilidade futura.

### Remoção de navegação legada

- Remover o HTML, comportamento e CSS exclusivos das barras `seller-nav`, `navbar`,
  `nav-logo`, `nav-links`, `lp-nav` e equivalentes das landings públicas de Seller,
  Business, Core, Stock e Chat.
- Não usar `display: none`, `aria-hidden` ou atrasos de JavaScript como solução.
  A regra temporária `.dx-legacy-nav` e o código que procura/oculta menus antigos
  serão removidos quando nenhuma landing pública depender deles.
- Preservar tickers, heros, demonstrações e rodapés que pertencem ao conteúdo da
  landing, não à navegação global.

### Chat

- Remover a barra local do Chat para que não exista uma segunda navegação.
- Manter os CTAs funcionais: o download do aplicativo desktop será uma ação do hero
  e o acesso autenticado continuará disponível pelo shell global e pelo CTA local.
- Não alterar a rota do aplicativo, a autenticação, o download nem o conteúdo do
  produto.

## Páginas cobertas

- Seller: landing principal, Mercado Livre, Shopee, Rastreio, Magalu, Termos Magalu
  e Privacidade Magalu.
- Business: landing geral, Core, Stock, Price e Chat.
- Ads não entra nesta mudança porque já não apresenta uma navegação legada paralela
  no escopo analisado.

## Validação

- Testes de contrato asseguram que todas as páginas cobertas contêm o host do shell
  global, carregam seus assets e não contêm marcadores de navegação legada.
- Teste unitário para a montagem idempotente do shell e para as seções interativas
  que antes dependiam de `seller-landing.js`.
- Testes focados de landing, `git diff --check` e inspeção manual em desktop e mobile.
- Após publicação, verificar respostas HTTPS de todas as rotas públicas afetadas e
  confirmar visualmente que não há flash nem duplicidade de cabeçalho.

## Fora de escopo

- Mudanças de identidade, paleta, conteúdo de produto, APIs, OAuth, login, acesso
  por módulo ou regras comerciais.
- Alteração de e-mails de contato existentes; isto exige uma decisão própria sobre
  o canal comercial oficial.
- Refatorações de telas autenticadas.
