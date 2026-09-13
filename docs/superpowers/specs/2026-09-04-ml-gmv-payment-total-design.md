# GMV pelo total do pagamento — Margem de Venda ML

## Objetivo

Corrigir a rentabilidade realizada para que o GMV de cada pedido represente o
valor financeiro total apresentado pelo Mercado Livre no pagamento, e não
apenas a soma dos itens vendidos.

## Escopo aprovado

Integrar de forma cirúrgica a correção V2 fornecida pelo usuário nos arquivos
atuais do projeto, preservando mudanças não relacionadas já existentes.

Arquivos de produção previstos:

- `ml/services/financeiroMlService.js`
- `ml/views/financeiro-ml-margem.html`

## Regra de cálculo

Para cada pedido pago:

1. Ler os pagamentos válidos da order.
2. Priorizar `transaction_details.net_received_amount` (ou seu equivalente
   direto) como total do pagamento.
3. Quando disponível, usar `total_paid_amount - marketplace_fee` como fonte
   alternativa do total.
4. Se o total do pagamento não estiver disponível, reconstruí-lo com os
   componentes financeiros já lidos da mesma venda.
5. Em filtros que selecionam apenas parte dos itens do pedido, alocar o GMV
   proporcionalmente à receita dos itens selecionados.

O resultado e a margem passam a usar esse GMV:

`resultado = GMV - (CMV + comissões ML + impostos + tarifa de envio + cupom do vendedor)`

`margem = resultado / GMV`

CMV, comissões, imposto, tarifa de envio e cupom continuam custos separados;
não são abatidos para definir o GMV.

## Regras preservadas

- A base fiscal continua sendo valor dos produtos da order mais frete pago pelo
  comprador.
- Preço médio unitário, taxa efetiva de comissão e equilíbrio por unidade
  continuam baseados na receita dos produtos, por serem métricas de
  precificação.
- Rebate ML permanece informativo porque já está refletido na comissão líquida.

## Auditoria e interface

A exportação de Margem por período incluirá `FONTE_GMV`, `IDS_PAGAMENTO` e
`VALOR_PRODUTOS`, além do novo `GMV` calculado. Os textos de ajuda da interface
passarão a explicar que o GMV é o total do pagamento e que a base fiscal é
independente dele.

## Testes e validação

Antes da alteração, serão criados testes que falhem para:

- total direto de pagamento;
- fallback de total;
- resultado e margem calculados sobre o GMV;
- manutenção da receita de produto nos cálculos de precificação.

Após a implementação, serão executados os testes relevantes e a validação de
sintaxe. O caso de referência `2000018084427526` deve produzir GMV de
R$ 1.900,66 quando os dados de pagamento correspondentes estiverem disponíveis.
