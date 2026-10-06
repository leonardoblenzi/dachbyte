# Calculadora ML: frete dividido em anúncios ME2

## Problema confirmado

Um anúncio ME2 pode cobrar frete do comprador e ainda gerar custo de envio para o vendedor. Hoje, `fetchSellerShipping` devolve custo zero sempre que `shipping.free_shipping` é falso. Depois, a interface zera o campo do vendedor ao selecionar “Pago pelo comprador”. Assim, o lucro subtrai R$ 0,00 de frete mesmo quando há cobrança ao vendedor.

As imagens enviadas mostram MLBs e preços diferentes. O valor de R$ 8,40 exibido na tela do Mercado Livre é evidência do frete dividido, não o custo a aplicar automaticamente ao MLB da calculadora.

## Comportamento aprovado

- Em **Usar anúncio**, quando o anúncio é ME2 e o comprador paga o frete (`free_shipping=false`), o bloco Frete mostra ao mesmo tempo **Custo do vendedor** e **Valor pago pelo comprador**. Não há seleção exclusiva entre esses dois valores nesse caso.
- O custo do vendedor é consultado para aquele anúncio e preço pelo endpoint `/users/{seller_id}/shipping_options/free`, com `free_shipping=false` e o contexto do item, tipo de anúncio e logística. O campo é preenchido com a cotação, identificado como **estimativa do ML** e permanece editável.
- O valor do comprador é opcional e começa vazio/zero: sem destino do comprador, a calculadora não inventa esse valor. Se informado, entra somente na base fiscal já adotada pela calculadora; não reduz diretamente o lucro como custo do vendedor nem é tratado como receita do produto.
- A parte do vendedor é sempre subtraída do lucro, mesmo quando o comprador também paga frete. Não se modifica a fórmula financeira: corrigem-se a obtenção, preservação e transmissão dos dois valores.
- Se a cotação do vendedor falhar ou não trouxer um custo confiável, o campo fica vazio, aparece um alerta e os números de lucro, margem, ROI e preços derivados são marcados como incompletos até o usuário informar explicitamente o custo, inclusive zero se essa for sua confirmação. Zero preenchido pelo sistema sem cotação não é aceito como valor confirmado.
- Para ME2 com frete grátis, ME1, entrega a combinar e **Simulação manual**, mantém-se o comportamento atual, salvo ajustes estritamente necessários para não apagar um custo de vendedor confirmado.
- A cotação pertence ao preço no momento da consulta. Se o preço do anúncio for editado na simulação, a interface avisa que o frete estimado pode mudar e exige nova consulta ou confirmação manual antes de apresentar os resultados como completos. O preço para a meta permanece uma projeção, não uma promessa de tarifa final.

## Fonte e limites

A [documentação de custos de envio do ML](https://developers.mercadolivre.com.br/pt_br/produto-consulta-de-usuarios/custos-de-envio) orienta consultar o custo aproximado do vendedor com `free_shipping=false` quando o frete fica a cargo do comprador. A cobrança efetiva de uma venda depende do envio e é obtida em `/shipments/{id}/costs`, separando `senders[].cost` de `receiver.cost`, conforme a [documentação de custos e cotações](https://developers.mercadolivre.com.br/pt_br/mercadolideres-lojas-oficiais/mercado-envios-custos-e-cotacoes). A calculadora, antes da venda, deve usar a palavra **estimativa**.

## Verificação necessária

- Teste de regressão reproduz ME2 com comprador e vendedor pagando valores diferentes; o lucro desconta o valor do vendedor.
- Testes do serviço cobrem cotação com `free_shipping=false`, falha/ausência de cotação e zero explicitamente retornado.
- Testes da interface cobrem dois campos simultâneos apenas nesse caso, preservação dos valores no payload, aviso de estimativa e estado incompleto quando o custo do vendedor é desconhecido.
- Testes existentes de ME2 grátis, ME1, entrega a combinar e modo manual continuam passando.
- QA visual confere o bloco Frete nos temas claro e escuro, inclusive quando a cotação está indisponível.
