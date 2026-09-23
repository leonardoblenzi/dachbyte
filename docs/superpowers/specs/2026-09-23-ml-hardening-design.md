# Hardening de Estoque e Calculadora ML

## Objetivo

Corrigir as falhas identificadas nas Etapas 3 e 4 do Seller ML sem ampliar o
escopo funcional: atualizações de estoque continuam exigindo revisão confiável,
e a Calculadora continua sendo somente de leitura.

## Decisão

Aplicar uma única alteração de hardening em três limites de confiança:

1. **Estoque:** o servidor exigirá `expected_current_stock` em toda linha e
   continuará a reconsultar o ML antes da escrita. A fila manterá somente os
   identificadores da conta; o worker carregará credenciais atuais no momento
   da execução. A confirmação de propriedade passará a bloquear respostas sem
   vendedor identificável.
2. **Calculadora:** as APIs terão a mesma autorização da página, rejeitarão
   contexto sem conta selecionada e não apresentarão comissão do ML como zero
   quando a cotação estiver indisponível. A cotação receberá o contexto
   logístico disponível e a interface criará opções por DOM, sem interpolar
   SKU ou rótulos em HTML.
3. **Qualidade:** cada proteção ganhará teste de regressão. Não haverá escrita
   no ML pela Calculadora, nem alteração de schema, infraestrutura ou variáveis
   de ambiente.

## Fluxo de dados

O navegador envia alterações de estoque contendo snapshot de quantidade. A API
rejeita linhas sem esse dado; a fila guarda conta, alterações e contexto de
auditoria, mas nunca tokens. Antes da execução, o worker resolve as credenciais
da conta e a rotina existente compara a quantidade atual do ML com o snapshot.

Para a Calculadora, o middleware de permissão bloqueia a chamada antes do
controller. O service exige `accountKey`, consulta a tarifa com dados de
logística disponíveis e transforma erro ou resposta inválida da cotação em erro
explícito ao cliente, preservando o modo manual apenas quando escolhido pelo
usuário.

## Critérios de aceitação

- Não é possível enfileirar atualização sem `expected_current_stock`.
- Dados de job Bull não contêm `accessToken`, `refresh_token` ou `mlCreds`.
- Uma resposta de item sem vendedor não é considerada pertencente à conta.
- Usuário sem `ml.precificacao.margem` não acessa as APIs da Calculadora.
- Falha na tarifa do ML não resulta em comissão zero no modo ML.
- A cotação envia contexto logístico disponível e a UI não usa `innerHTML`
  para valores retornados pelo ML.
- Testes focados e regressão existente passam.
