# Planilha de correção de REF por EAN

## Objetivo

Criar uma planilha Excel com apenas os registros problemáticos da planilha principal, usando os cadastros Tray como fonte de verdade.

## Regra de comparação

- O EAN é a chave de comparação.
- Quando o EAN estiver nos cadastros Tray e a REF for diferente, a REF Tray será apresentada como a referência para substituição.
- Quando o EAN não existir na fonte, o registro será marcado para revisão manual.
- EAN vazio ou com o marcador `-1` será marcado como inválido para substituição automática.

## Estrutura da saída

Uma aba `Erros` com as colunas: Status, EAN, REF atual, REF verdadeira, MLB, SKU, Título e Origem da REF verdadeira.

Os registros serão ordenados por status e EAN. Somente linhas que precisem de ação serão incluídas.

## Limites

As planilhas de origem não serão alteradas. A saída não aplicará uma REF quando a fonte não tiver uma correspondência inequívoca pelo EAN.

## Validação

Validar a contagem por status, conferir amostras de divergências contra a fonte e procurar erros de fórmula na planilha gerada.
