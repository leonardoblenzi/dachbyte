# GMV bruto = Total do pedido
Data: 2026-09-04

BASE
- Feito exclusivamente sobre o ultimo `ml(2).zip` enviado pelo usuario.

REGRA CORRETA
GMV = total bruto do pedido:
  valor dos produtos + frete pago pelo comprador

O GMV NAO e o valor liquido recebido no pagamento.

Exemplo validado:
- Produtos: R$ 734,44
- Frete comprador: R$ 96,71
- GMV: R$ 831,15

Custos separados:
- CMV: R$ 435,88
- Comissao ML liquida: R$ 73,04
- Impostos: R$ 83,12
- Tarifa Envios vendedor: R$ 0,00
- Cupom vendedor: R$ 25,00

Resultado:
  831,15 - 435,88 - 73,04 - 83,12 - 0,00 - 25,00 = R$ 214,11

Margem:
  214,11 / 831,15 = 25,76%

REBATE
- O rebate de R$ 22,72 permanece apenas informativo quando ja esta refletido
  na comissao liquida.
- Nao e somado novamente ao Resultado.

OUTRO EXEMPLO DA CONVERSA
- Produtos: R$ 1.144,08
- Frete comprador: R$ 935,27
- GMV bruto correto pela regra final: R$ 2.079,35
- Portanto, R$ 1.900,66 nao e mais tratado como GMV nesse conceito.

O QUE FOI ALTERADO
- `services/financeiroMlService.js`
  - removeu a regra de GMV baseada em pagamento liquido/net_received_amount;
  - GMV agora usa `order.total_amount + frete comprador`;
  - fallback usa soma dos itens + frete comprador;
  - comissao, cupom, imposto, CMV e tarifa de envio continuam custos separados;
  - arredondamento monetario por linha foi alinhado para o Resultado fechar
    exatamente com os valores exibidos na tabela;
  - equilibrio/un. e folga/un. continuam baseados no preco do produto e custos,
    sem transformar frete comprador em preco unitario do item;
  - FONTE_GMV e IDS_PAGAMENTO foram removidos do XLSX.

- `views/financeiro-ml-margem.html`
  - tooltips atualizados para explicar que GMV e o total bruto do pedido;
  - Base imposto e Frete comprador descritos de forma consistente.

COLUNAS
- Mantida a decisao anterior: a unica coluna nova de status no final continua
  sendo `STATUS`.
- `FONTE_GMV` e `IDS_PAGAMENTO` nao aparecem mais no XLSX.

STATUS / TODOS OS PEDIDOS
- A coleta de todos os pedidos e a coluna STATUS da ultima versao foram preservadas.
- Nenhuma regressao foi introduzida nesse fluxo.

VALIDACOES EXECUTADAS
- `node --check services/financeiroMlService.js`: OK
- Testes GMV + UI atualizados: 15/15 OK
- Testes jobs-panel: 29/29 OK
- Caso R$ 831,15 / Resultado R$ 214,11 / Margem 25,76%: OK
- Caso R$ 2.079,35 de GMV bruto: OK
- XLSX: `STATUS` permanece como ultima coluna; FONTE_GMV/IDS_PAGAMENTO removidos: OK
- HTML: sem IDs duplicados; tabela de periodo permanece com 18 colunas: OK

ARQUIVOS DE RUNTIME PARA DEPLOY
- services/financeiroMlService.js
- views/financeiro-ml-margem.html

Os dois arquivos em `tests/` estao incluidos para manter a suite do projeto
coerente com a nova regra.

DEPLOY
1. Extraia o patch na raiz da pasta `ml/`.
2. Substitua os arquivos.
3. Reinicie o processo WEB.
4. Force refresh / atualize os dados da Rentabilidade.
5. Revalide o pedido 2000018284539198:
   - GMV esperado: R$ 831,15
   - Resultado esperado: R$ 214,11
   - Margem esperada: 25,76%
