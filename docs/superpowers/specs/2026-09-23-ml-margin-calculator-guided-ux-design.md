# Calculadora de Margem ML — UX Guiada

## Objetivo

Modernizar a calculadora de margem do Seller Mercado Livre sem reduzir a precisão dos cálculos. A tela deve permitir tanto carregar um anúncio real da conta por MLB/SKU quanto simular manualmente de forma clara.

## Fluxo e hierarquia

1. O caminho por anúncio permanece no topo: MLB ou SKU carrega preço, categoria, tipo de anúncio, comissão e tarifa conhecidos.
2. Em simulação manual, preço e custo do produto vêm primeiro. O bloco de comissão oferece um controle segmentado **Clássico / Premium**, em vez do select nativo.
3. Quando a origem é um anúncio carregado, o tipo de anúncio real fica selecionado e bloqueado, assim como a comissão obtida do Mercado Livre. A pessoa ainda pode ajustar custos que não são fornecidos pela origem.
4. Frete é uma escolha segmentada:
   - **Mercado Envios:** exibe `Tarifa Mercado Envios cobrada do vendedor`, enviada como `seller_shipping`.
   - **Pago pelo comprador:** exibe `Valor pago pelo comprador` opcional, enviado como `buyer_shipping_taxable`. Em branco ou zero, não afeta custo nem margem; se informado, participa apenas da base fiscal, como o motor atual já faz.
5. Impostos e operação seguem visíveis no fluxo principal: regime/alíquota, imposto, embalagem/operação e outros custos. Meta de margem continua como entrada opcional ao final.
6. O painel lateral passa a chamar-se **Lucro por unidade**; remove-se a repetição “Resultado / Resultado da simulação”. Métricas, detalhamento e aviso de segurança permanecem.

## Direção visual

Seguir os tokens existentes da calculadora DACH ML: laranja `#ff9a4d` / `#c86a22` para orientação e meta, teal `#0f766e` / `#0d9488` para ação e resultado, grafite e neutros frios para estrutura. A referência externa inspira a hierarquia, não a paleta.

Tipografia: títulos em 650–700, rótulos em 600–650, texto e valores de entrada em 400–500. Reservar 700–800 para CTA e números de resultado. Isso reduz a sensação de campos excessivamente pesados sem sacrificar contraste.

## Limites

- Sem mudança no endpoint, no motor de precificação ou no contrato de payload.
- `buyer_shipping_taxable` continua sendo valor fiscal, nunca custo do vendedor.
- Não publicar, alterar preço ou estoque do anúncio.
- Responsividade preserva uma coluna em telas estreitas.

## Validação

- Teste de DOM garante os dois controles segmentados, a ausência da redundância no cabeçalho e campos fiscais condicionais.
- Teste de JavaScript valida a normalização de modalidade de frete e o payload enviado ao endpoint.
- Teste do serviço confirma que frete do comprador não compõe os custos e é usado na base tributável.
