# Alinhamento do shell global e limpeza visual Seller

## Contexto

A landing principal de DACHBYTE Seller já usa o shell global da suíte por meio de
`data-dx-shell="seller"`. Ele entrega o cabeçalho canônico com as entradas Seller,
Business, Ads, Explorar produtos, Entrar e o CTA comercial. A landing Magalu e suas
páginas legais foram entregues sem esse ponto de montagem e, por isso, começam na
navegação interna antiga do Seller.

## Objetivo imediato

Garantir uma jornada coerente em Magalu, Termos e Privacidade, inserindo o mesmo shell
global da landing Seller. A navegação contextual do Seller continua logo abaixo do
shell, como já ocorre na landing principal; ela não será substituída nem terá novas
destinações nesta etapa.

## Implementação

- Inserir `<div data-dx-shell="seller" data-dx-module="Seller"></div>` imediatamente
  após a abertura de `body` em `landing-magalu.html`, `legal-magalu-terms.html` e
  `legal-magalu-privacy.html`.
- Manter os links, a mensagem de pré-lançamento, a estrutura semântica e o CTA da
  Magalu existentes.
- Ajustar somente o CSS que for indispensável para impedir duplicidade visual ou
  quebra de espaçamento entre o shell global e a barra contextual.
- Cobrir por teste de contrato que as três páginas Magalu tenham o ponto de montagem
  canônico, além dos testes já existentes de rotas e conteúdo.

## Próxima etapa: limpeza visual Seller

Depois desta correção, fazer uma revisão concentrada nas landings Mercado Livre,
Shopee, Rastreio e Magalu. A revisão compara navegação interna, CTAs, espaçamentos,
rodapés e responsividade para remover variações legadas sem alterar os caminhos de
produto nem os fluxos autenticados.

## Fora de escopo

- Não criar integração OAuth Magalu nem expor credenciais.
- Não mudar regras de acesso, rotas autenticadas ou conteúdo operacional.
- Não migrar nesta alteração páginas Business, Ads ou telas internas; elas serão
  avaliadas em uma frente posterior de limpeza visual da suíte.

## Validação

- Testes de contrato das páginas públicas Seller e Magalu.
- Verificação estática de HTML/CSS e `git diff --check`.
- Verificação da resposta HTTPS de Magalu, Termos e Privacidade após publicação.
