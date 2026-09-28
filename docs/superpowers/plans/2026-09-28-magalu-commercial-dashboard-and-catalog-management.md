# Magalu: dashboard comercial e gestão de catálogo — plano de implementação

> Execute no checkout `main` já escolhido pelo usuário. Não incluir diretórios de backup, `.codex/` ou `.superpowers/brainstorm/` em commits.

## 1. Contratos de seleção por SKU/lista

**Arquivos**
- Modificar: `apps/seller-magalu/src/repositories/skuMassRepository.js`
- Modificar: `apps/seller-magalu/src/controllers/skuManagementController.js`
- Modificar: `apps/seller-magalu/public/js/magalu-sku-management.js`
- Modificar: `apps/seller-magalu/views/app.html`
- Modificar: `apps/seller-magalu/tests/sku-mass-management.test.js`
- Criar: `apps/seller-magalu/tests/sku-selection-input.test.js`

**Passos**
1. Escrever testes para parser de lista (linhas, vírgula e ponto-e-vírgula), deduplicação preservando ordem e limite de lote.
2. Adicionar um endpoint de resolução explícita, filtrado pela `account_id` e tenant atual, que retorna encontrados e não encontrados sem gravar dados.
3. Usar o mesmo resolvedor no preview; ignorar itens não encontrados somente após exibi-los na interface, e bloquear preview quando nenhum SKU for elegível.
4. Adicionar modos Filtros, SKU e Lista na tela, com resumo de normalização antes de operações.
5. Rodar os testes específicos e `node --check`.

## 2. Gestão unificada de catálogo

**Arquivos**
- Modificar: `apps/seller-magalu/views/app.html`
- Modificar: `apps/seller-magalu/public/js/magalu-app.js`
- Modificar: `apps/seller-magalu/src/routes/index.js`
- Modificar: `apps/seller-magalu/tests/sku-mass-management.test.js`

**Passos**
1. Remover o item de menu duplicado `SKUs` e manter `Gestão de catálogo` como item operacional único.
2. Fazer `/magalu/catalogo` redirecionar para `/magalu/gestao-skus`; manter a navegação e o shell compatíveis.
3. Preservar links de detalhe/reconciliação através da tela unificada, sem alterar a rota/API de catálogo usada por outros consumidores.
4. Testar redirects e ausência de dois itens concorrentes no menu.

## 3. Dashboard comercial

**Arquivos**
- Modificar: `apps/seller-magalu/src/repositories/orderRepository.js`
- Criar: `apps/seller-magalu/src/controllers/dashboardController.js`
- Modificar: `apps/seller-magalu/src/routes/api.routes.js`
- Modificar: `apps/seller-magalu/views/app.html`
- Modificar: `apps/seller-magalu/public/js/magalu-app.js`
- Criar: `apps/seller-magalu/tests/dashboard-commercial.test.js`

**Passos**
1. Escrever testes do agregado comercial e isolamento por conta.
2. Acrescentar ao repositório apenas os agregados necessários (ticket médio e métricas temporais existentes), sem dados pessoais.
3. Criar endpoint dashboard Hub-first que compõe catálogo, pedidos, entrega e operações, usando a conta global selecionada.
4. Exibir estado vazio honesto quando não houver sync de pedidos; manter Ads como integração pendente, sem valor numérico.
5. Ajustar resumo de scopes por grupos reais, não por uma constante de três.
6. Rodar testes específicos, depois `npm test --prefix apps/seller-magalu` e `git diff --check`.

## 4. Navegação Integrações e regressão

**Arquivos**
- Modificar: `apps/seller-magalu/views/app.html`
- Modificar: `apps/seller-magalu/public/js/magalu-app.js`
- Modificar: `apps/seller-magalu/src/routes/index.js`
- Criar/modificar: testes de rotas e shell

**Passos**
1. Remover Sincronização do menu e apontar cartões/ações para Integrações.
2. Manter `/magalu/sincronizacao` como redirect legado.
3. Confirmar que conta global, tema e shell continuam funcionando em todas as rotas.

## Verificação final

1. `node --check` para JS alterado.
2. Testes específicos de seleção, dashboard, catálogo e navegação.
3. `npm test --prefix apps/seller-magalu`.
4. `git diff --check`.
5. Revisar `git status -sb`, adicionando somente os arquivos da entrega.
6. Commit/push/deploy somente se solicitado depois da revisão funcional.
