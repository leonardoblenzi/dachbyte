# Status de pedidos na Margem por período ML

## Objetivo

Exibir todos os pedidos do intervalo na visão e exportação de Margem por
período, com o status atual normalizado do pedido, sem alterar os indicadores
financeiros da aba Resumo.

## Escopo

### Resumo financeiro

Os KPIs já existentes permanecem com a regra atual: usam somente os pedidos
pagos/aprovados e mantêm as definições atuais de GMV, custos, resultado,
margem, base fiscal e intervalo financeiro. Esta entrega não muda os números
do Resumo.

### Margem por período

A tabela passa a ter uma coleta adicional de todos os pedidos do vendedor no
intervalo, sem o filtro `order.status=paid`. Ela mantém as colunas existentes
e acrescenta uma única coluna final, `Status`.

Os status exibidos são normalizados para:

- Concluído
- A caminho
- Preparando
- Cancelado
- Devolução
- Devolvido
- Problema

O filtro `Status pedido` restringe apenas essa tabela e sua exportação. O
filtro existente `Status anúncio` continua destinado aos anúncios e à
precificação de equilíbrio.

### Exportação

O XLSX de Margem por período exporta as mesmas linhas vistas na tabela e inclui
`STATUS` como última coluna. As colunas atuais de auditoria financeira,
incluindo `GMV`, `FONTE_GMV`, `IDS_PAGAMENTO` e `PRECO_PRODUTO`, são
preservadas.

## Separação de coleta e cálculo

O serviço terá dois fluxos independentes:

1. Coleta de pedidos pagos, já existente, alimenta exclusivamente o resumo e
   seus KPIs.
2. Coleta de todos os pedidos, limitada ao mesmo intervalo e limite máximo,
   alimenta exclusivamente as linhas por período, o filtro de status e o XLSX.

O GMV de uma linha continua a usar pagamentos aprovados quando disponíveis e o
fallback financeiro já existente quando necessário. Linhas não pagas podem
aparecer para auditoria de status, mas não entram nos totais do Resumo.

## Data e limites

O intervalo de consulta segue o filtro de datas selecionado. Para os pedidos
adicionais da tabela, a consulta usa `date_created` para permitir que pedidos
ainda não fechados sejam exibidos no período em que foram criados. A data
mostrada preserva o dia local do timestamp do Mercado Livre.

O limite de pedidos continua controlado por `ML_FINANCE_MARGIN_ORDER_LIMIT`;
linhas são deduplicadas por `order_id` antes da paginação.

## Verificação

Testes devem provar que:

- o resumo continua construído somente a partir dos pedidos pagos;
- a tabela inclui pedidos de diferentes estados com o status normalizado;
- o filtro de status não altera o resumo;
- o XLSX inclui a coluna final `STATUS` sem remover as colunas financeiras já
  existentes;
- a tabela HTML/JS e seus estados vazios/carregando usam a contagem correta de
  colunas.
