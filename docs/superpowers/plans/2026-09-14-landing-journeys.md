# Seller e Business: navegação e demonstrações

**Objetivo:** implementar a direção aprovada: experiências comerciais interativas no Seller, preservar a personalidade Business e unificar os caminhos entre famílias, módulos e contato.

**Arquitetura:** componentes públicos independentes em `public/brand/dachbyte/landing-experience.{js,css}`, carregados somente nas landings. Exemplos locais sem APIs, contas ou dados reais. HTML semântico e CSS em perspectiva para profundidade sem dependência WebGL. Chat integra o mesmo componente por efeito React com limpeza. Price ganha uma página comercial em `/business/price`, preservando o login existente.

**Design:** fundo #090b10, painéis #131a27, texto #f4f2ec, secundário #b5becd. Seller usa laranja #ff8a3f e azul logístico #6c93ff; Business ciano #30d6dc e verde #2dd9a8. Preservar Exo 2 nos títulos existentes; controles com fonte legível de sistema e números tabulares. Assinatura: operação em perspectiva que muda com a decisão do visitante. Conteúdo longo alinhado à esquerda; hero curto, CTA identificável e navegação global em faixa própria.

## Sequência de execução

- [x] Conferir rotas, arquivos e testes existentes; preservar estado local.
- [x] Criar componente comum: navegação Seller/Business e produtos, foco visível, contato com e-mail acessível, layout responsivo e movimento reduzido.
- [x] Implementar simulador Seller de preço/desconto/Ads com fórmula explícita, ponto de equilíbrio e gráfico; fila Shopee com seleção/avanço/reset; mapa de rastreio com casos selecionáveis. Apresentar dados como fictícios.
- [x] Implementar fluxo Business com cenário, etapa ativa, consequência e reinício; preservar as demos existentes.
- [x] Integrar às quatro landings Seller e às landings Business/Stock/Core/Chat. Corrigir CTAs sem destino, marcas antigas e alegações não demonstradas no conteúdo público selecionado.
- [x] Acrescentar landing Price com retorno Business e acesso ao login existente; não modificar autenticação.
- [x] Testar cálculo de margem e transições de cenários, executar contratos existentes e inspecionar a faixa responsiva disponível no servidor local; corrigir ordem de conteúdo e colisão de CSS observadas.

## Verificação

`node --test tests/landing-experience.test.js tests/seller-landing-contract.test.js`

`node --check public/brand/dachbyte/landing-experience.js`

Inspeção no navegador: alterar preço e desconto, selecionar pedidos, avançar e reiniciar, selecionar exceções, percorrer integração Business; conferir navegação, contato, ausência de overflow em 390px e teclado. O health do staging não comprova essas alterações locais; deploy é uma etapa separada.
