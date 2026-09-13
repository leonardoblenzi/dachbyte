# Status de Pedidos na Margem por Período ML — Plano de Implementação

> **Para agentes:** sub-skill obrigatório: use `subagent-driven-development` (recomendado) ou `executing-plans` para executar este plano tarefa a tarefa.

**Objetivo:** Exibir todos os pedidos e seu status normalizado na tela e no XLSX de **Margem por período**, sem alterar nenhum KPI da tela **Resumo**.

**Arquitetura:** A coleta financeira existente, restrita a pedidos pagos, continua sendo a fonte exclusiva do Resumo, insights e precificação. Uma coleta separada de todos os pedidos, filtrada por `date_created`, alimenta apenas as linhas do período, o filtro de status e a exportação XLSX.

**Tecnologias:** Node.js/CommonJS, `node:test`, XLSX e HTML/JavaScript estático.

---

## Premissas e limites

- Não alterar `fetchPaidOrders`, nem a regra atual de pagamento aprovado usada para o GMV.
- Não incluir pedidos não pagos nos totais, cartões ou KPIs do Resumo.
- Preservar no XLSX os campos já corrigidos: `GMV`, `FONTE_GMV`, `IDS_PAGAMENTO` e `PRECO_PRODUTO`.
- Adicionar `STATUS` somente ao fim da exportação e da tabela de Margem por período.
- Não mexer em arquivos não relacionados já presentes no diretório de trabalho.

## Tarefa 1 — Normalizar o status do ciclo do pedido

**Arquivos:**
- Modificar: `ml/services/financeiroMlService.js`
- Testar: `ml/tests/financeiro-ml-gmv.test.js`

- [x] Escrever testes unitários para uma função pura que receba um pedido ML e retorne um status de apresentação.
- [x] Cobrir, no mínimo: pedido cancelado (`Cancelado`), envio entregue (`Concluído`), envio a caminho (`A caminho`), pedido pago/pronto para envio (`Preparando`), devolução aberta (`Devolução`), reembolso/devolvido (`Devolvido`) e reclamação/problema (`Problema`).
- [x] Executar o teste e confirmar que falha porque o auxiliar ainda não existe.
- [x] Implementar o normalizador, com precedência explícita para cancelamento, devolução/reembolso e problema antes do estado normal de envio.
- [x] Expor o auxiliar em `_test` junto dos auxiliares existentes, sem alterar a API pública.
- [x] Rodar: `node --test tests/financeiro-ml-gmv.test.js` a partir de `ml`.

## Tarefa 2 — Coletar todos os pedidos somente para o período

**Arquivos:**
- Modificar: `ml/services/financeiroMlService.js`
- Testar: `ml/tests/financeiro-ml-gmv.test.js`

- [x] Criar uma coleta paginada de todos os pedidos do vendedor, sem o parâmetro `order.status=paid`, usando `date_created` por padrão.
- [x] Deduplicar por ID de pedido, mantendo a versão com `last_updated` mais recente, e respeitar `total_available`.
- [x] Manter a coleta atual de pedidos pagos intacta como a única fonte do objeto `summary`.
- [x] Construir as linhas da Margem por período a partir da coleta completa, anexando o status normalizado a cada linha.
- [x] Preservar a resolução atual de GMV por pagamentos aprovados e o fallback existente; pedidos sem dados financeiros válidos precisam continuar seguros para renderização/exportação.
- [x] Estender `applyPeriodFilters` com `order_status`; a opção `in_progress` deve incluir `Preparando` e `A caminho`, e as demais opções devem comparar o status normalizado.
- [x] Adicionar testes que provem: a coleta de período não injeta `order.status=paid`; filtros de status reduzem apenas as linhas do período; e os dados do resumo não mudam por causa de um pedido não pago.
- [x] Rodar: `node --test tests/financeiro-ml-gmv.test.js` a partir de `ml`.

## Tarefa 3 — Exibir e exportar o status

**Arquivos:**
- Modificar: `ml/views/financeiro-ml-margem.html`
- Modificar: `ml/public/js/financeiro-ml-margem.js`
- Modificar: `ml/services/financeiroMlService.js`
- Testar: `ml/tests/financeiro-ml-margem-ui.test.js`
- Testar: `ml/tests/financeiro-ml-gmv.test.js`

- [x] Renomear o seletor atual para `Status anúncio` e adicionar o seletor `Status pedido` apenas no bloco de Margem por período.
- [x] Incluir as opções: Todos, Em andamento, Preparando, A caminho, Concluído, Cancelado, Devolução, Devolvido e Problema.
- [x] Acrescentar a coluna final `Status` à tabela de Margem por período. A tabela passará de 17 para 18 colunas; manter a tabela de equilíbrio com 17 colunas.
- [x] Atualizar todos os estados vazios/carregando/erro específicos da tabela de período para `colspan="18"`.
- [x] Renderizar o status como texto ou chip no último campo da linha, de forma segura para valores ausentes.
- [x] Acrescentar `STATUS` como última coluna da primeira planilha do XLSX, mantendo a ordem dos campos de auditoria já existente.
- [x] Ajustar largura/estilo apenas se necessário e elevar a versão do asset JavaScript para evitar cache antigo.
- [x] Adicionar testes estáticos para 18 cabeçalhos/células/colspan na tabela de período, 17 na tabela de equilíbrio, e testes de XLSX para cabeçalho e valor `STATUS`.
- [x] Rodar a suíte de testes de tela e serviço.

## Tarefa 4 — Verificação e integração

**Arquivos:** somente os alterados nas tarefas anteriores.

- [x] Conferir manualmente que o endpoint do Resumo continua recebendo e usando apenas os pedidos pagos existentes.
- [x] Conferir que a requisição da Margem por período busca todos os pedidos por criação e que o filtro de status não refaz os KPIs.
- [x] Rodar, a partir de `ml`:

```powershell
node --test tests/financeiro-ml-gmv.test.js tests/financeiro-ml-margem-ui.test.js
node --check services/financeiroMlService.js
node --check public/js/financeiro-ml-margem.js
npm run test:jobs-panel
git diff --check
```

- [x] Revisar `git diff` para confirmar que não houve regressão nos campos de GMV, fonte de GMV, IDs de pagamento e preço do produto.
- [x] Criar commits pequenos por tarefa concluída, então enviar a alteração para `main` quando os testes passarem.

## Critérios de aceite

1. Os KPIs do Resumo continuam calculados com a coleta atual de pedidos pagos.
2. Margem por período mostra todos os pedidos do intervalo usando a data de criação e exibe o Status ao fim de cada linha.
3. O filtro Status pedido afeta somente a tabela e o XLSX do período.
4. O XLSX mantém os campos corrigidos de GMV/preço de produto e ganha `STATUS` na última coluna.
5. Suíte de testes e verificações estáticas passam antes do merge/push.
