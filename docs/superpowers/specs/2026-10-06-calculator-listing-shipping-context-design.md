# Calculadora ML: contexto do envio do anúncio

## Objetivo

Ao carregar um MLB/SKU, mostrar o modo de envio configurado no anúncio sem confundi-lo com quem arca com o frete na simulação. Expor o custo de envio do vendedor, quando consultado, como estimativa anterior à venda.

## Dados e apresentação

- O lookup já devolve `shipping_mode`, `logistic_type`, `free_shipping`, `seller_shipping` e `shipping_source` do anúncio selecionado.
- No modo **Usar anúncio**, o bloco Frete mostra uma linha somente leitura com o modo real (`me2`, `me1`, `custom` ou não especificado), o tipo logístico quando conhecido e se o anúncio oferece frete grátis ao comprador.
- Os dois botões do bloco controlam apenas qual valor entra na simulação: custo do vendedor ou valor pago pelo comprador. Seus rótulos no modo anúncio devem explicitar essa finalidade; o primeiro botão não representa o modo logístico. Em ME2, a seleção inicial deriva de `free_shipping`. Em ME1 e `not_specified`/entrega a combinar, a seleção inicial é **Pago pelo comprador**, mesmo se `free_shipping` vier verdadeiro. O usuário pode alterar a hipótese da simulação.
- Em simulação manual, os controles e o padrão atual permanecem.
- Quando o anúncio oferece frete grátis e a consulta de custo retorna um valor, o campo de custo do vendedor é preenchido e identificado como **Estimativa do Mercado Livre**. Valor zero também é mostrado como estimativa, sem o chamar de tarifa definitiva. Se a consulta falhar, a tela mostra **Estimativa indisponível; informe o custo**, sem sugerir que zero foi confirmado.
- Quando o comprador paga, o custo do vendedor começa em zero; o valor do comprador é opcional e depende do destino. Em ME1 e entrega a combinar, o campo opcional permanece visível por padrão. A interface não inventa uma tarifa a partir do MLB.

## Limite financeiro

Antes de uma venda, `/users/{seller}/shipping_options/free` fornece uma cotação aproximada para o vendedor. O custo definitivo de um pedido vem de `/shipments/{id}/costs` (`senders[].cost` e `receiver.cost`). A Calculadora trabalha com anúncios, sem um shipment específico, e por isso nunca apresenta a cotação como valor efetivamente cobrado.

## Implementação e verificação

- Uma regra pura transforma os atributos de envio do lookup em textos, modalidade de simulação inicial e estado da cotação; a tela usa essa regra ao carregar cada variação.
- A apresentação do contexto fica oculta na simulação manual e reaparece no modo anúncio com um item carregado.
- Testes cobrem ME2 com frete grátis, ME2 pago pelo comprador, ME1, entrega a combinar, modalidade desconhecida, estimativa indisponível e troca de variação. Nenhuma fórmula financeira ou endpoint de escrita é alterado.
