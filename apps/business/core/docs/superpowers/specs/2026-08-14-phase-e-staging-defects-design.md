# Fase E — correções finais encontradas no staging

## Objetivo

Corrigir os defeitos observados no golden path óptico do staging: OS persistida que não aparece na lista paginada, datas de receita preenchidas que chegam nulas ao banco e atualização visual tardia após o cancelamento de uma venda.

## Escopo

- Apenas `business/volt_core` na branch `voltdev`.
- Sem migration.
- Sem alterações em ML, Shopee, Stock, Chat ou outros módulos.

## Evidências e causas

O banco contém 35 ordens de serviço da Ótica Nacional, incluindo a `OS-41`. A consulta paginada obtém essas linhas, mas chama `serviceOrder.decorateRows` sem fornecer `client`. O hook óptico exige `client.query`, lança erro e faz a carga silenciosa do frontend permanecer vazia.

A receita `QA-FE Cliente Optica` foi persistida com os graus e o médico, mas `exam_date` e `valid_until` ficaram nulos. A captura das datas será endurecida no campo controlado e o backend deixará de converter silenciosamente uma data não vazia e inválida em `null`.

O cancelamento é confirmado no banco, porém a linha pode conservar o estado anterior até nova interação. A resposta da API será aplicada imediatamente ao estado local e, em seguida, os recursos `sales`, `serviceOrders` e `opticalOrders` serão recarregados como fonte de verdade.

## Design

### Listagem de OS

O hook `serviceOrder.decorateRows` adotará o mesmo contrato tolerante já usado pelo decorador de produtos: quando o chamador não estiver dentro de uma transação com cliente explícito, usará a interface de banco do Core. Chamadas transacionais continuarão utilizando o cliente recebido.

### Datas da receita

Campos `date` do modal usarão explicitamente o evento nativo de entrada para atualizar o estado controlado. No backend, data vazia continuará opcional; qualquer valor não vazio fora dos formatos aceitos resultará em erro 400 com código estável, sem gravação parcial.

### Cancelamento e invalidação

O handler usará a venda devolvida pelo endpoint para atualizar a linha correspondente imediatamente. Depois fará a reconciliação explícita de vendas, OP e OS. A falha de uma carga complementar não deve desfazer o cancelamento confirmado, mas deve manter o recurso marcado para nova tentativa.

## Testes

Antes do código de produção serão adicionadas regressões que demonstrem:

1. o decorador de OS funciona com cliente explícito e com o fallback do Core;
2. o recurso paginado devolve uma OS óptica em vez de falhar;
3. datas válidas chegam ao SQL e datas não vazias inválidas são rejeitadas;
4. o campo de data atualiza o estado pelo evento de entrada;
5. o cancelamento aplica a resposta da API e solicita recarga de `sales`, `serviceOrders` e `opticalOrders`.

Depois serão executados o teste focal, a suíte completa do Volt Core, o build e `git diff --check`.

