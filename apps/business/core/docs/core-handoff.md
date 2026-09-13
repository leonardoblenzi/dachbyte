# Volt Core - Core Handoff (historico)

> Aviso: este documento registra a fase inicial do motor em memoria e nao representa sozinho o estado atual. O runtime Postgres, migrations, autenticacao, UI e regras de deploy estao documentados no `README.md`; use o codigo e o README como fonte vigente.

Documento de continuidade para retomar o desenvolvimento do core do Volt Core em outro chat.

## Contexto do Produto

O Volt Core faz parte da linha `business/` do ecossistema Davantti.

Ideia central:

```text
Volt Core = core padrao + extensoes por setor
```

Regra arquitetural:

```text
Core nao conhece otica.
Otica usa e estende o Core.
```

O core padrao precisa funcionar sozinho para uma empresa comum controlar:

- clientes;
- produtos e servicos;
- estoque;
- vendas;
- pagamentos;
- caixa;
- contas a receber;
- recibos nao fiscais;
- relatorios;
- dashboard;
- usuarios e permissoes.

Depois que o core estiver persistido e com UI, setores especificos como otica devem adicionar campos, telas e fluxos sem alterar o funcionamento base.

## Estrutura Atual

Base criada em:

```text
business/
  volt_core/
    src/
      app.js
      server.js
      controllers/
      middlewares/
      modules/
        core/
      routes/
```

Padrao escolhido:

```text
Express + CommonJS
routes -> controllers -> modules/core/services
```

Foi escolhido o estilo mais proximo de `shopee/src`, por escalar melhor que o padrao mais antigo do `ml/`.

## Arquivos Principais

```text
business/volt_core/src/modules/core/coreOperationsService.js
```

Motor operacional do core. Concentra regras de clientes, produtos, estoque, vendas, caixa, recebiveis, dashboard, usuarios, auditoria e eventos.

```text
business/volt_core/src/controllers/CoreOperationsController.js
```

Controller HTTP para expor as funcoes operacionais.

```text
business/volt_core/src/routes/core.routes.js
```

Rotas REST do core.

```text
business/volt_core/src/modules/core/templates/general.js
```

Template do core padrao para empresa comum.

```text
business/volt_core/src/modules/core/templates/optical.js
```

Template inicial de otica. Ele estende o `general`.

```text
business/volt_core/src/modules/core/repositories/inMemoryCoreRepository.js
```

Repositorio em memoria para dados operacionais. Ainda nao ha banco persistente.

```text
business/volt_core/src/modules/core/repositories/inMemoryCompanyConfigRepository.js
```

Repositorio em memoria para configuracao de empresa/template/modulos.

```text
business/volt_core/src/modules/core/paymentMethods.js
```

Catalogo de formas de pagamento e comportamento financeiro.

```text
business/volt_core/src/modules/core/stateMachines.js
```

Maquinas de estado de recebiveis, vendas e caixa.

```text
business/volt_core/src/modules/core/validators.js
```

Validadores formais para entradas do motor.

```text
business/volt_core/src/modules/core/events.js
```

Eventos internos em memoria.

```text
business/volt_core/src/middlewares/requirePermission.js
```

Middleware de permissao para rotas sensiveis.

```text
business/volt_core/src/modules/core/coreOperations.test.js
business/volt_core/src/modules/core/core.test.js
```

Testes do motor.

## Modulos Registrados

Arquivo:

```text
business/volt_core/src/modules/core/registries/modules.js
```

Modulos atuais:

- `companies`: empresas;
- `users`: usuarios e permissoes;
- `customers`: clientes;
- `products`: produtos e servicos;
- `inventory`: estoque;
- `sales`: vendas;
- `payments`: pagamentos;
- `receivables`: contas a receber;
- `receipts`: recibos;
- `service_orders`: ordem de servico;
- `reports`: relatorios;
- `cash_register`: caixa;
- `finance`: financeiro futuro;
- `fiscal`: fiscal futuro;
- `optical_prescriptions`: receita optica.

## Segmentos Registrados

Arquivo:

```text
business/volt_core/src/modules/core/registries/segments.js
```

Segmentos atuais:

- `general`: empresa padrao, disponivel;
- `optical`: otica, disponivel como template inicial;
- `retail`: loja comum, planejado;
- `technical_assistance`: assistencia tecnica, planejado.

## Telas Registradas

Arquivo:

```text
business/volt_core/src/modules/core/registries/screens.js
```

Telas atuais:

- `dashboard`;
- `sales`;
- `customers`;
- `products`;
- `inventory`;
- `receivables`;
- `cash_register`;
- `service_orders`;
- `optical_prescriptions`;
- `reports`;
- `settings`;
- `master_companies`;
- `master_modules`.

## Template General

Arquivo:

```text
business/volt_core/src/modules/core/templates/general.js
```

Ativa por padrao:

- empresas;
- usuarios;
- clientes;
- produtos;
- estoque;
- vendas;
- pagamentos;
- contas a receber;
- caixa;
- recibos;
- relatorios.

Categorias padrao:

- Produtos;
- Servicos;
- Acessorios.

Status padrao:

- `orcamento`;
- `vendido`;
- `cancelado`.

Roles padrao:

- `owner`: permissao `*`;
- `seller`: clientes, produtos leitura, vendas, caixa leitura, recibos e relatorios;
- `stock`: produtos, estoque e relatorios.

## Template Optical

Arquivo:

```text
business/volt_core/src/modules/core/templates/optical.js
```

Estende o `general` e adiciona:

- `service_orders`;
- `optical_prescriptions`;
- telas de OS e receitas opticas;
- categorias de armacoes e lentes;
- status de producao;
- campos tecnicos de receita optica.

Ainda nao existe modulo operacional de otica. Existe apenas o template/configuracao inicial.

## Formas de Pagamento

Arquivo:

```text
business/volt_core/src/modules/core/paymentMethods.js
```

Formas atuais:

- `cash`: dinheiro, caixa imediato;
- `pix`: Pix, caixa imediato;
- `debit_card`: cartao de debito, caixa imediato;
- `credit_card`: cartao de credito, gera recebivel, aceita parcelas;
- `promissory_note`: nota promissoria, gera recebivel, exige vencimento;
- `check`: cheque, gera recebivel, exige data de deposito/vencimento;
- `store_credit`: crediario interno, gera recebivel, aceita parcelas;
- `bank_transfer`: transferencia bancaria, caixa imediato.

Regra financeira:

```text
dinheiro, pix, debito e transferencia -> caixa imediato
credito, nota promissoria, cheque e crediario -> contas a receber
recebivel baixado/compensado -> caixa
```

## Maquinas de Estado

Arquivo:

```text
business/volt_core/src/modules/core/stateMachines.js
```

### Recebiveis

Fluxo principal:

```text
open -> partial -> received
open -> received
open -> canceled
```

Fluxo de cheque:

```text
awaiting_deposit -> deposited -> compensated
awaiting_deposit -> returned
deposited -> returned
returned -> awaiting_deposit
```

Estados finais:

- `received`;
- `compensated`;
- `canceled`.

### Vendas

```text
completed -> canceled
```

### Caixa

```text
open -> closed
```

## Garantias do Motor

O motor atual possui:

- transacoes em memoria com rollback para operacoes criticas;
- validadores formais;
- maquinas de estado explicitas;
- eventos internos;
- auditoria enriquecida;
- numeracao operacional por empresa;
- filtros basicos de relatorio/listas;
- permissao via middleware quando `x-volt-core-user-id` e enviado;
- estorno rastreavel em cancelamento de venda com caixa/recebivel movimentado.

## Funcoes Principais do Service

Arquivo:

```text
business/volt_core/src/modules/core/coreOperationsService.js
```

### Empresa

- `upsertCompanyProfile(companyId, input)`
- `getCompanyProfile(companyId)`
- `getMasterCompanies()`

### Clientes

- `createCustomer(companyId, input)`
- `listCustomers(companyId, filters)`
- `getCustomer(companyId, customerId)`
- `updateCustomer(companyId, customerId, input)`
- `setCustomerActive(companyId, customerId, active)`

### Produtos

- `createProduct(companyId, input)`
- `listProducts(companyId, filters)`
- `getProduct(companyId, productId)`
- `updateProduct(companyId, productId, input)`
- `setProductActive(companyId, productId, active)`
- `searchSaleCatalog(companyId, query)`

### Estoque

- `addInventoryEntry(companyId, input)`
- `addInventoryExit(companyId, input)`
- `addInventoryAdjustment(companyId, input)`
- `listInventoryMovements(companyId)`
- `getStockPosition(companyId)`

Observacao:

- ajuste de estoque exige motivo;
- venda baixa estoque automaticamente;
- cancelamento de venda restaura estoque.

### Vendas / PDV

- `getPosContext(companyId, filters)`
- `createSale(companyId, input)`
- `listSales(companyId, filters)`
- `getSale(companyId, saleId)`
- `cancelSale(companyId, saleId, input)`

Venda suporta:

- cliente cadastrado ou cliente avulso;
- item com quantidade;
- preco unitario;
- desconto por item;
- desconto total;
- multiplas formas de pagamento;
- baixa automatica de estoque;
- criacao automatica de caixa/recebiveis;
- geracao automatica de recibo.

### Recibos

- `listReceipts(companyId)`
- `getReceiptBySale(companyId, saleId)`
- `getReceiptHtmlBySale(companyId, saleId)`

`receipt/html` gera HTML imprimivel de recibo nao fiscal.

### Caixa

- `openCashSession(companyId, input)`
- `closeCashSession(companyId, sessionId, input)`
- `listCashSessions(companyId)`
- `getCashSummary(companyId)`
- `createManualCashMovement(companyId, input)`
- `listCashMovements(companyId, filters)`

Caixa suporta:

- abertura;
- saldo inicial;
- fechamento;
- valor esperado;
- valor contado;
- diferenca;
- movimentos manuais;
- movimentos automaticos de venda/recebimento;
- data operacional;
- timezone da empresa.

### Recebiveis

- `listReceivables(companyId, filters)`
- `getReceivable(companyId, receivableId)`
- `getReceivablesSummary(companyId)`
- `getReceivablesBoard(companyId)`
- `markReceivableReceived(companyId, receivableId, input)`
- `markCheckDeposited(companyId, receivableId, input)`
- `markCheckReturned(companyId, receivableId, input)`
- `cancelReceivable(companyId, receivableId, input)`

Recebiveis suportam:

- recebimento parcial;
- recebimento total;
- parcelas de cartao/crediario;
- nota promissoria;
- cheque aguardando deposito;
- cheque depositado;
- cheque devolvido;
- cheque compensado;
- cancelamento quando ainda nao baixado.

### Dashboard

- `getDashboard(companyId)`

Retorna:

- cards;
- tarefas;
- atalhos rapidos;
- resumo operacional.

Cards atuais:

- vendas;
- caixa;
- a receber hoje;
- vencidos;
- cheques para depositar;
- estoque baixo.

Tarefas atuais:

- abrir caixa;
- recebiveis vencidos;
- cheques para depositar;
- produtos com estoque baixo.

### Relatorios

- `getReportsOverview(companyId, filters)`
- `getSalesReport(companyId, filters)`
- `getInventoryReport(companyId, filters)`

Filtros implementados:

- `dateFrom`;
- `dateTo`;
- `status`;
- `customerId`;
- `paymentMethod`;
- `productId`;
- `category`;
- `lowStock`.

### Usuarios / Permissoes

- `createUser(companyId, input)`
- `listUsers(companyId)`
- `updateUser(companyId, userId, input)`
- `listRoles()`
- `listPermissions()`
- `checkPermission(companyId, userId, permission)`

Middleware:

```text
business/volt_core/src/middlewares/requirePermission.js
```

Regras:

- se `x-volt-core-master: true`, libera;
- se `x-volt-core-user-id` for enviado, verifica permissao;
- se nenhum header for enviado, libera para manter compatibilidade em dev.

### Auditoria e Eventos

- `getAuditLogs(companyId)`
- `getEvents(companyId)`

Auditoria guarda:

- action;
- actorUserId;
- actorRole;
- entityType;
- entityId;
- before;
- after;
- amount;
- reason;
- createdAt.

Eventos internos atuais incluem:

- `company.profile.updated`;
- `customer.created`;
- `customer.updated`;
- `product.created`;
- `product.updated`;
- `sale.created`;
- `sale.canceled`;
- `stock.moved`;
- `cash.opened`;
- `cash.closed`;
- `cash.movement.created`;
- `cash.reversed`;
- `receivable.created`;
- `receivable.updated`;
- `receivable.received`.

## Endpoints Principais

Arquivo:

```text
business/volt_core/src/routes/core.routes.js
```

### Configuracao

```text
GET  /core/segments
GET  /core/modules
GET  /core/screens
GET  /core/templates/:segmentKey
POST /core/companies/:companyId/bootstrap
POST /core/companies/:companyId/apply-template
GET  /core/companies/:companyId/configuration
PATCH /core/companies/:companyId/overrides
```

### Master

```text
GET /core/master/companies
```

### Pagamentos / Roles / Permissoes

```text
GET /core/payment-methods
GET /core/roles
GET /core/permissions
```

### Empresa

```text
GET   /core/companies/:companyId/profile
PATCH /core/companies/:companyId/profile
```

### Clientes

```text
POST  /core/companies/:companyId/customers
GET   /core/companies/:companyId/customers
GET   /core/companies/:companyId/customers/:customerId
PATCH /core/companies/:companyId/customers/:customerId
POST  /core/companies/:companyId/customers/:customerId/deactivate
POST  /core/companies/:companyId/customers/:customerId/activate
```

### Produtos

```text
POST  /core/companies/:companyId/products
GET   /core/companies/:companyId/products
GET   /core/companies/:companyId/products/search-sale
GET   /core/companies/:companyId/products/:productId
PATCH /core/companies/:companyId/products/:productId
POST  /core/companies/:companyId/products/:productId/deactivate
POST  /core/companies/:companyId/products/:productId/activate
```

### Estoque

```text
POST /core/companies/:companyId/inventory/entries
POST /core/companies/:companyId/inventory/exits
POST /core/companies/:companyId/inventory/adjustments
GET  /core/companies/:companyId/inventory/movements
GET  /core/companies/:companyId/inventory/stock
```

### PDV / Vendas

```text
GET  /core/companies/:companyId/pos/context
POST /core/companies/:companyId/sales
GET  /core/companies/:companyId/sales
GET  /core/companies/:companyId/sales/:saleId
POST /core/companies/:companyId/sales/:saleId/cancel
```

### Recibos

```text
GET /core/companies/:companyId/receipts
GET /core/companies/:companyId/sales/:saleId/receipt
GET /core/companies/:companyId/sales/:saleId/receipt/html
```

### Caixa

```text
POST /core/companies/:companyId/cash/sessions
GET  /core/companies/:companyId/cash/sessions
POST /core/companies/:companyId/cash/sessions/:sessionId/close
POST /core/companies/:companyId/cash/movements
GET  /core/companies/:companyId/cash/movements
GET  /core/companies/:companyId/cash/summary
```

### Recebiveis

```text
GET  /core/companies/:companyId/receivables
GET  /core/companies/:companyId/receivables/summary
GET  /core/companies/:companyId/receivables/board
GET  /core/companies/:companyId/receivables/:receivableId
POST /core/companies/:companyId/receivables/:receivableId/receive
POST /core/companies/:companyId/receivables/:receivableId/deposit-check
POST /core/companies/:companyId/receivables/:receivableId/return-check
POST /core/companies/:companyId/receivables/:receivableId/cancel
```

### Dashboard / Relatorios

```text
GET /core/companies/:companyId/dashboard
GET /core/companies/:companyId/reports/overview
GET /core/companies/:companyId/reports/sales
GET /core/companies/:companyId/reports/inventory
```

### Usuarios / Auditoria / Eventos

```text
POST  /core/companies/:companyId/users
GET   /core/companies/:companyId/users
PATCH /core/companies/:companyId/users/:userId
GET   /core/companies/:companyId/users/:userId/can
GET   /core/companies/:companyId/audit-logs
GET   /core/companies/:companyId/events
```

## Testes

Comando:

```text
cmd /c npm run volt_core:test
```

Estado atual:

```text
15 testes passando
```

Cobertura de teste atual inclui:

- template optical;
- template general;
- overrides master;
- venda com baixa de estoque;
- CRUD de cliente/produto;
- abertura e fechamento de caixa;
- contexto de PDV;
- recibo HTML;
- cancelamento de venda;
- recebiveis de credito/nota promissoria;
- cheque depositado/compensado;
- transicao invalida de cheque;
- cancelamento bloqueado com recebivel baixado;
- filtros de relatorio;
- eventos e auditoria;
- dashboard acionavel;
- permissoes;
- bloqueio por estoque insuficiente;
- servico sem controle de estoque.

## Limitacoes Atuais

Ainda nao existe:

- banco persistente;
- UI visual;
- autenticacao real;
- login/sessao;
- API de fiscal;
- financeiro completo de contas a pagar;
- modulo operacional de otica;
- importacao/exportacao CSV/XLSX;
- PDF real do recibo;
- impressao termica integrada;
- testes HTTP end-to-end;
- concorrencia real/transacao de banco;
- multiunidade.

## Decisoes Importantes

1. Repositorios ainda sao em memoria.

Motivo: fechar primeiro a regra de dominio antes de persistir.

2. Middleware de permissao e permissivo sem header.

Motivo: facilitar desenvolvimento local. Quando autenticar de verdade, o middleware deve exigir usuario/empresa sempre.

3. Cancelamento de venda com recebivel ja baixado e bloqueado por padrao.

Para permitir, deve passar:

```js
{
  allowSettledReversal: true,
  reason: "motivo"
}
```

Nesse caso o motor cria estorno de caixa rastreavel.

4. Recebiveis sao separados de caixa.

Dinheiro que ainda nao caiu nao entra no caixa. Isso e essencial para UX e confiabilidade.

5. O dashboard deve ser acionavel.

Ele nao e apenas grafico. Ele mostra o que precisa ser resolvido hoje.

## Proximos Passos Recomendados

### 1. Persistencia

Criar banco para o core antes de UI pesada.

Sugestao de tabelas:

- `volt_core_companies`
- `volt_core_company_profiles`
- `volt_core_users`
- `volt_core_customers`
- `volt_core_products`
- `volt_core_inventory_movements`
- `volt_core_sales`
- `volt_core_sale_items`
- `volt_core_sale_payments`
- `volt_core_receivables`
- `volt_core_cash_sessions`
- `volt_core_cash_movements`
- `volt_core_receipts`
- `volt_core_audit_logs`
- `volt_core_events`
- `volt_core_company_configurations`
- `volt_core_company_modules`
- `volt_core_company_screens`

Importante:

- usar transacoes reais no banco em `createSale`, `cancelSale`, `markReceivableReceived`, `open/closeCashSession`;
- manter os contratos de service parecidos para facilitar troca do repositorio em memoria.

### 2. Autenticacao e Permissao Real

Hoje permissao depende de headers.

Fazer:

- login do Volt Core;
- sessao/JWT;
- resolver `companyId` do usuario autenticado;
- bloquear acesso cross-company;
- exigir permissao em todas as rotas sensiveis;
- definir acesso master Davantti separado do usuario comum.

### 3. UI do Core

Prioridade de telas:

1. Dashboard;
2. Venda/PDV;
3. Produtos;
4. Clientes;
5. Estoque;
6. Contas a receber;
7. Caixa;
8. Relatorios;
9. Configuracoes;
10. Usuarios/permissoes;
11. Painel master.

### 4. UX da Venda Balcao

Tela de venda deve ser rapida:

- busca por SKU/nome/codigo;
- cliente avulso rapido;
- adicionar produto com teclado;
- alterar quantidade inline;
- desconto por item;
- desconto total;
- formas de pagamento multiplas;
- restante a pagar sempre visivel;
- aviso quando gerar recebiveis;
- finalizar e imprimir recibo;
- nova venda imediata.

### 5. UX de Recebiveis

Tela deve funcionar como rotina diaria:

- vencidos;
- vencem hoje;
- proximos 7 dias;
- cheques para depositar;
- cheques depositados aguardando compensacao;
- cheques devolvidos;
- acao rapida: receber, receber parcial, depositar, compensar, devolver, cancelar.

### 6. Caixa

Evoluir:

- abertura obrigatoria opcional por configuracao;
- sangria;
- reforco;
- fechamento por forma de pagamento;
- divergencia por forma de pagamento;
- relatorio de fechamento imprimivel;
- bloqueio de venda se caixa estiver fechado, se a empresa configurar assim.

### 7. Recibo

Evoluir:

- modelo personalizavel;
- logo da empresa;
- dados completos;
- PDF;
- impressao termica;
- reimpressao;
- envio por WhatsApp/email, futuramente.

### 8. Relatorios

Adicionar:

- exportacao CSV/XLSX;
- vendas por vendedor;
- vendas por cliente;
- vendas por categoria;
- margem/lucro;
- giro de estoque;
- produtos sem movimento;
- recebiveis por status;
- caixa por periodo;
- fechamento diario.

### 9. Modulo de Otica

So iniciar depois do core persistido/UI base.

Entidades provaveis:

- `optical_prescriptions`;
- `optical_service_orders`;
- `optical_laboratories`;
- `optical_lenses`;
- `optical_frames`;
- `optical_order_status_history`.

Fluxo:

```text
venda -> OS optica -> receita -> laboratorio -> producao -> pronto -> entregue
```

### 10. Fiscal

Deixar para fase posterior.

Nao implementar emissao fiscal manualmente no inicio. Usar integracao futura com API de terceiros.

Possiveis integrações:

- Focus NFe;
- PlugNotas;
- Nuvem Fiscal.

## Como Retomar em Outro Chat

Mensagem sugerida:

```text
Leia business/volt_core/docs/core-handoff.md e continue o Volt Core a partir do core atual.
O core ja tem motor em memoria com vendas, estoque, caixa, recebiveis, dashboard, recibo, permissoes, auditoria, eventos e testes.
Nao implemente setor/otica ainda. Proximo foco: persistencia do core ou UI do core, conforme eu pedir.
```

Antes de mexer:

```text
git status -sb
cmd /c npm run volt_core:test
```

Se for persistencia, preservar comportamento dos testes atuais.

Se for UI, usar os endpoints ja documentados em `core.routes.js`.
