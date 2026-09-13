# Volt Core: Pedido com Pagamento na Entrega e PDV Óptico Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar pedidos ópticos com total definido e pagamento na entrega, concluindo caixa e recebíveis somente quando o cliente retirar o produto.

**Architecture:** `volt_core.sales` passa a distinguir pedido pendente de entrega de venda finalizada. `salesService` concentra reserva, conclusão e cancelamento em transações; a extensão óptica continua criando OP/OS na criação e contribui a entrega no mesmo client transacional. O PDV e a lista usam dados paginados do servidor, sem reconstruir o estado financeiro no navegador.

**Tech Stack:** Node.js, Express 5, PostgreSQL, React 19, Vite, Node test runner.

---

### Task 1: Restaurar a landing pública do Volt Core

**Files:**
- Modify: `business/volt_core/src/app.js:58-70`
- Test: `business/volt_core/src/modules/core/runtimeHttp.test.js:75-84`

- [ ] **Step 1: Executar o teste de regressão isolado**

Run: `cmd /c node --test --test-name-pattern="public /core route" src\modules\core\runtimeHttp.test.js`

Expected: FAIL com `404 !== 200`.

- [ ] **Step 2: Registrar duas rotas explícitas de landing**

Trocar a rota com array por handlers explícitos, mantendo o arquivo validado antes de registrá-los:

```js
if (fs.existsSync(landingPath)) {
  app.use(express.static(publicPath, { index: false }));
  app.get("/core", (_req, res) => res.sendFile(landingPath));
  app.get("/landing", (_req, res) => res.sendFile(landingPath));
}
```

- [ ] **Step 3: Confirmar a correção**

Run: `cmd /c node --test --test-name-pattern="public /core route" src\modules\core\runtimeHttp.test.js`

Expected: PASS, status `200`, HTML e texto `Volt Core`.

- [ ] **Step 4: Commitar a estabilização**

```bash
git add business/volt_core/src/app.js business/volt_core/src/modules/core/runtimeHttp.test.js
git commit -m "fix(volt-core): serve public core landing"
```

### Task 2: Persistir o ciclo de pedido pendente de entrega

**Files:**
- Create: `business/volt_core/db/016_delivery_payment_sales.sql`
- Modify: `business/volt_core/src/modules/core/runtime/services/salesService.js:400-900`
- Modify: `business/volt_core/src/modules/core/runtime/services/dataQueryService.js:113-171`
- Modify: `business/volt_core/src/controllers/RuntimeController.js:257-272`
- Modify: `business/volt_core/src/routes/core.routes.js:91-95`
- Test: `business/volt_core/src/modules/core/preGoLiveRegression.test.js`

- [ ] **Step 1: Escrever os testes de contrato para pedido pendente**

Adicionar testes com client transacional simulado que comprovem:

```js
test("delivery payment creates a reserved order without cash or receivables", async () => {
  const result = await sales.createSale("company-a", {
    paymentTiming: "delivery",
    customerId: "customer-1",
    promisedDeliveryDate: "2026-09-15",
    items: [{ productId: "frame-1", quantity: 1 }],
  });
  assert.equal(result.sale.status, "pending_delivery");
  assert.deepEqual(result.sale.payments, []);
  assert.equal(cashInsertCalls.length, 0);
  assert.equal(receivableInsertCalls.length, 0);
});

test("delivery completion records the real entry and creates the remaining installments", async () => {
  const result = await sales.completeSaleDelivery("company-a", "sale-1", {
    payments: [
      { method: "pix", amount: 300 },
      { method: "store_credit", amount: 900, installments: 3, dueDate: "2026-10-15" },
    ],
  });
  assert.equal(result.sale.status, "finalized");
  assert.equal(cashInsertCalls.length, 1);
  assert.equal(receivableInsertCalls.length, 3);
});
```

- [ ] **Step 2: Rodar os testes e confirmar que falham pelo comportamento ausente**

Run: `cmd /c node --test --test-name-pattern="delivery payment" src\modules\core\preGoLiveRegression.test.js`

Expected: FAIL porque não existem `paymentTiming`, `completeSaleDelivery` e os lançamentos adiados.

- [ ] **Step 3: Criar a migration de entrega**

Criar `016_delivery_payment_sales.sql` com campos consultáveis e índice para a lista operacional:

```sql
alter table volt_core.sales
  add column if not exists payment_timing text not null default 'immediate',
  add column if not exists promised_delivery_date date,
  add column if not exists delivered_at timestamptz;

create index if not exists idx_volt_core_sales_company_delivery
  on volt_core.sales (company_id, status, promised_delivery_date, created_at desc);
```

- [ ] **Step 4: Extrair as operações compartilhadas de pagamento**

Em `salesService.js`, manter `normalizeSalePayments` e `createSaleFinancialRecords` como os únicos pontos que validam soma, vencimentos, caixa e recebíveis. Adicionar helpers com contratos claros:

```js
function isDeliveryPayment(input = {}) {
  return String(input.paymentTiming || "").toLowerCase() === "delivery";
}

function assertDeliveryOrderInput({ customer, promisedDeliveryDate }) {
  if (!customer) throw deliveryError("Pedido com pagamento na entrega exige cliente cadastrado", "DELIVERY_CUSTOMER_REQUIRED");
  if (!isValidDate(promisedDeliveryDate)) throw deliveryError("Informe a previsao de entrega", "DELIVERY_DATE_REQUIRED");
}
```

`createSale` deve usar `pending_delivery`, `payments: []`, `payment_timing: 'delivery'` e `promised_delivery_date` quando a opção estiver ativa. Ela continua criando itens, saída de reserva e hooks de OP/OS, mas não chama `createSaleFinancialRecords`, não gera recibo final e não exige caixa aberto.

- [ ] **Step 5: Implementar conclusão na retirada**

Adicionar `completeSaleDelivery(companyId, saleId, input)` no mesmo serviço. A transação deve bloquear a venda, exigir status `pending_delivery`, validar caixa aberto conforme configuração, normalizar pagamentos com o total persistido, atualizar a venda e criar financeiro:

```js
update volt_core.sales
set status = 'finalized', payments = $3::jsonb, delivered_at = now(),
    sold_at = $4, updated_at = now()
where company_id = $1 and id = $2
returning ...;
```

O método deve chamar o novo hook `sale.afterDeliveryCompleted`, gerar recibo, evento e auditoria. Se já estiver `finalized`, retornar o resultado idempotente sem duplicar caixa, recebíveis ou recibo.

- [ ] **Step 6: Expor a conclusão pela API**

Adicionar controller e rota protegida por `sales:write`:

```js
router.post(
  "/runtime/companies/:companyId/sales/:saleId/complete-delivery",
  requireRuntimePermission("sales:write"),
  asyncHandler(RuntimeController.completeSaleDelivery),
);
```

- [ ] **Step 7: Tornar leitura e cancelamento coerentes**

Retornar `paymentTiming`, `promisedDeliveryDate`, `deliveredAt` e `opticalOrderStatus` em `listSalesPage`. Incluir filtros `Em producao`, `Pronto para retirada` e `Na entrega`. No cancelamento de `pending_delivery`, restaurar as reservas `source_type='sale'` e não criar estornos financeiros vazios.

- [ ] **Step 8: Rodar os testes de domínio**

Run: `cmd /c node --test src\modules\core\preGoLiveRegression.test.js src\modules\core\runtimeHttp.test.js src\modules\core\coreOperations.test.js`

Expected: PASS.

- [ ] **Step 9: Commitar o ciclo persistente**

```bash
git add business/volt_core/db/016_delivery_payment_sales.sql business/volt_core/src/modules/core/runtime/services/salesService.js business/volt_core/src/modules/core/runtime/services/dataQueryService.js business/volt_core/src/controllers/RuntimeController.js business/volt_core/src/routes/core.routes.js business/volt_core/src/modules/core/preGoLiveRegression.test.js
git commit -m "feat(volt-core): settle delivery payment orders"
```

### Task 3: Sincronizar entrega de pedido óptico com a venda financeira

**Files:**
- Modify: `business/volt_core/src/extensions/optical/manifest.js:40-58`
- Modify: `business/volt_core/src/extensions/optical/backend/saleHooks.js:12-82`
- Test: `business/volt_core/src/modules/core/preGoLiveRegression.test.js`

- [ ] **Step 1: Escrever o teste de ciclo óptico na entrega**

Adicionar teste que cria pedido com OP/OS em `ready`, conclui a entrega e afirma que os dois registros ficam `delivered`; o mesmo teste deve garantir que tentativa antes de `ready` retorna `OPTICAL_ORDER_NOT_READY_FOR_DELIVERY`.

- [ ] **Step 2: Rodar o teste e confirmar RED**

Run: `cmd /c node --test --test-name-pattern="optical delivery" src\modules\core\preGoLiveRegression.test.js`

Expected: FAIL porque o hook não existe.

- [ ] **Step 3: Adicionar o hook de conclusão da entrega**

Declarar `sale.afterDeliveryCompleted` no manifest e implementar no `saleHooks.js`, reutilizando o mesmo `client` da venda:

```js
async function afterDeliveryCompleted({ client, companyId, sale, actorUserId }) {
  const order = await loadOpticalOrderForDelivery(client, companyId, sale.id);
  if (!order) return null;
  if (order.status !== "ready") throw deliveryError("Pedido optico ainda nao esta pronto para retirada", "OPTICAL_ORDER_NOT_READY_FOR_DELIVERY");
  await markOpticalOrderAndServiceOrderDelivered(client, companyId, order, actorUserId);
  return { response: { opticalOrder: { ...order, status: "delivered" } } };
}
```

O hook deve gravar os dois eventos de workflow e preservar o vínculo atual com a venda.

- [ ] **Step 4: Rodar o teste de novo**

Run: `cmd /c node --test --test-name-pattern="optical delivery" src\modules\core\preGoLiveRegression.test.js`

Expected: PASS.

- [ ] **Step 5: Commitar a integração óptica**

```bash
git add business/volt_core/src/extensions/optical/manifest.js business/volt_core/src/extensions/optical/backend/saleHooks.js business/volt_core/src/modules/core/preGoLiveRegression.test.js
git commit -m "feat(optical): deliver ready orders with payment settlement"
```

### Task 4: Ajustar PDV e lista de Pedidos

**Files:**
- Modify: `business/volt_core/src/client/sales/opticalSaleState.js:10-265`
- Modify: `business/volt_core/src/client/sales/OpticalSalesPdvView.jsx:330-785`
- Modify: `business/volt_core/src/client/actions/handlers/catalog.js:300-430`
- Modify: `business/volt_core/src/client/main.jsx:1940-2135`
- Modify: `business/volt_core/src/client/styles.css`
- Test: `business/volt_core/src/modules/core/preGoLiveRegression.test.js`

- [ ] **Step 1: Escrever a regressão de contrato da interface**

Adicionar teste de fonte que garanta que o PDV envia `paymentTiming: 'delivery'` e `promisedDeliveryDate`, a lista contém a ação `Concluir retirada`, e a chamada usa `/complete-delivery`.

- [ ] **Step 2: Rodar o teste e confirmar RED**

Run: `cmd /c node --test --test-name-pattern="delivery payment UI contract" src\modules\core\preGoLiveRegression.test.js`

Expected: FAIL porque a interface ainda exige pagamentos no PDV.

- [ ] **Step 3: Modelar o modo de pagamento no estado do PDV**

Adicionar `paymentTiming: 'immediate'` ao rascunho. Em modo `delivery`, `deriveOpticalSaleState` deve expor `isPaymentOnDelivery`; `validateOpticalSale` deve exigir cliente, itens e `promisedDate`, mas não pagamentos; `buildOpticalSaleSubmitPayload` deve enviar:

```js
{
  paymentTiming: "delivery",
  promisedDeliveryDate: draft.promisedDate,
  payments: [],
}
```

- [ ] **Step 4: Alterar a experiência do checkout**

No resumo, substituir o bloco de pagamentos por escolha segmentada `Pagar agora` / `Pagar na entrega`. No segundo modo, mostrar o total já definido e uma mensagem única: `O pagamento sera informado na retirada.` O campo de previsão no bloco Cliente e entrega ganha indicação de obrigatório. Revisão e botão passam para `Criar pedido`.

- [ ] **Step 5: Atualizar a lista existente de Pedidos**

Em `SalesOrders`, mudar as colunas para `Pedido`, `Data`, `Cliente`, `Itens`, `Andamento`, `Total`, `Financeiro`, `Acoes`. Para pedido pendente, mostrar `R$ X a receber` e `Pagamento definido na retirada`; para venda concluída, mostrar entrada recebida e parcelas abertas. Deixar `Concluir retirada` como ação primária somente quando o pedido óptico estiver pronto; manter detalhes, edição e cancelamento no menu secundário.

- [ ] **Step 6: Criar o modal de conclusão curto**

Usar a infraestrutura de modal existente para apresentar total fixo, pagamentos reais e saldo. A ação envia `POST /sales/:saleId/complete-delivery`, atualiza recursos `sales`, `receivables`, `cash_movements`, `optical_orders` e `service_orders`, e exibe erro sem fechar o modal.

- [ ] **Step 7: Aplicar estilos responsivos**

Criar classes específicas para badges operacional/financeiro, ação primária de retirada e resumo de liquidação. Em telas estreitas, manter a tabela em rolagem horizontal e preservar o botão de ação visível.

- [ ] **Step 8: Rodar regressões do contrato de UI**

Run: `cmd /c node --test --test-name-pattern="delivery payment UI contract" src\modules\core\preGoLiveRegression.test.js`

Expected: PASS.

- [ ] **Step 9: Commitar o fluxo de operador**

```bash
git add business/volt_core/src/client/sales/opticalSaleState.js business/volt_core/src/client/sales/OpticalSalesPdvView.jsx business/volt_core/src/client/actions/handlers/catalog.js business/volt_core/src/client/main.jsx business/volt_core/src/client/styles.css business/volt_core/src/modules/core/preGoLiveRegression.test.js
git commit -m "feat(volt-core): manage delivery payment orders in PDV"
```

### Task 5: Padronizar receita clínica e remover microcopy redundante

**Files:**
- Modify: `business/volt_core/src/client/sales/OpticalSalesPdvView.jsx:76-210`
- Modify: `business/volt_core/src/client/sales/opticalSaleState.js:219-265`
- Modify: `business/volt_core/src/client/styles.css`
- Test: `business/volt_core/src/modules/core/preGoLiveRegression.test.js`

- [ ] **Step 1: Escrever o teste do payload e da grade clínica**

Adicionar teste que exige `prescription-table`, as linhas `Para longe` e `Para perto`, `rightDnp`, `leftDnp` e a serialização de `metadata.near` no payload óptico.

- [ ] **Step 2: Rodar o teste e confirmar RED**

Run: `cmd /c node --test --test-name-pattern="clinical prescription grid" src\modules\core\preGoLiveRegression.test.js`

Expected: FAIL porque a receita ainda é um conjunto vertical de campos.

- [ ] **Step 3: Criar o adaptador de receita**

Em `opticalSaleState.js`, separar campos temporários de perto e enviar somente o contrato persistente:

```js
function buildPrescriptionPayload(prescription = {}) {
  const { nearRightSpherical, nearRightCylindrical, nearRightAxis, nearRightAddition, nearRightDnp, nearLeftSpherical, nearLeftCylindrical, nearLeftAxis, nearLeftAddition, nearLeftDnp, ...distance } = prescription;
  return {
    ...distance,
    metadata: {
      ...(distance.metadata || {}),
      near: { right: { spherical: nearRightSpherical, cylindrical: nearRightCylindrical, axis: nearRightAxis, addition: nearRightAddition, dnp: nearRightDnp }, left: { spherical: nearLeftSpherical, cylindrical: nearLeftCylindrical, axis: nearLeftAxis, addition: nearLeftAddition, dnp: nearLeftDnp } },
    },
  };
}
```

- [ ] **Step 4: Substituir o formulário vertical pela grade**

Renderizar metadados clínicos uma vez e uma tabela com `Uso`, `Olho`, `Esférico`, `Cilíndrico`, `Eixo`, `Adição` e `DNP`; preencher OD/OE para longe com campos atuais e perto com os campos temporários. Usar `step=0.25` em dioptrias, `min=0 max=180` no eixo e `step=0.5` no DNP.

- [ ] **Step 5: Remover textos repetidos**

Eliminar as subseções visuais `Receita do cliente`, `Medidas de montagem`, o segundo `Laboratório` e o rótulo visual duplicado de Cliente. Manter `aria-label`, `label` associado ou texto auxiliar somente onde há regra operacional, como cliente obrigatório em pedido óptico.

- [ ] **Step 6: Rodar o teste de grade**

Run: `cmd /c node --test --test-name-pattern="clinical prescription grid" src\modules\core\preGoLiveRegression.test.js`

Expected: PASS.

- [ ] **Step 7: Commitar o refinamento clínico**

```bash
git add business/volt_core/src/client/sales/OpticalSalesPdvView.jsx business/volt_core/src/client/sales/opticalSaleState.js business/volt_core/src/client/styles.css business/volt_core/src/modules/core/preGoLiveRegression.test.js
git commit -m "feat(optical): align PDV prescription with clinical layout"
```

### Task 6: Verificação integrada e entrega da branch de teste

**Files:**
- Verify: `business/volt_core/package.json`
- Verify: `business/volt_core/src/modules/core/runtimeHttp.test.js`
- Verify: `business/volt_core/src/modules/core/preGoLiveRegression.test.js`

- [ ] **Step 1: Executar testes completos**

Run: `cmd /c npm test`

Expected: todos os testes aprovados, incluindo a landing, pedido pendente, conclusão, OP/OS, grade de receita e contratos de interface.

- [ ] **Step 2: Gerar build de produção**

Run: `cmd /c npm run build`

Expected: Vite finaliza sem erro.

- [ ] **Step 3: Inspecionar mudanças e integridade de whitespace**

Run: `git diff --check HEAD~5..HEAD`

Expected: sem saída.

- [ ] **Step 4: Publicar a branch de teste somente com autorização explícita**

```bash
git push origin voltdev
```

Não publicar antes da autorização do usuário; informar os commits e as verificações concluídas.

## Fila de correcoes do PDV optico

Estas correcoes foram identificadas durante a validacao manual e devem ser feitas antes da proxima rodada de QA operacional.

### Prioridade 1: Preservar o rascunho da venda

**Status:** Concluida em `voltdev`. O rascunho usa `sessionStorage` isolado por empresa e operador, sobrevive a navegacao/recarregamento e pode ser descartado somente com confirmacao.

**Problema:** `OpticalSalesPdv` guarda o rascunho somente em estado local. Ao navegar para outra pagina/aba ou ao atualizar o workspace depois de criar cliente ou produto, a extensao e remontada e `createEmptyOpticalSaleDraft()` apaga dados ja preenchidos.

**Correcao:** criar uma sessao de venda em andamento por empresa e operador, mantida acima do componente do PDV. A sessao deve sobreviver a navegacao, refresh de recursos e CRUD auxiliar, e ser apagada somente por `Nova venda`, conclusao confirmada ou descarte explicitamente confirmado pelo operador.

### Prioridade 2: Unificar busca e selecao de produto/cliente

**Status:** Concluida em `voltdev`. O card de selecao agora e unico, mostra os dados operacionais e oferece `Trocar`; os resultados retornam somente depois da troca ou de uma nova digitacao.

**Problema:** ao selecionar um resultado, o componente mostra o card de selecionado e tambem mantem o mesmo registro em `visibleResults` ou `visibleCustomers`. O operador ve a mesma informacao duas vezes e nao fica claro qual bloco representa a escolha ativa.

**Correcao:** enquanto houver produto ou cliente selecionado, renderizar apenas um card operacional consolidado:

- Produto: nome, SKU, EAN, categoria, estoque e preco, com `Trocar` e `Adicionar`.
- Cliente: nome, documento, telefone, e-mail e segmento, com `Trocar` e `Usar cliente avulso`.
- A lista de resultados volta somente quando o operador escolher `Trocar` ou editar a busca; o item selecionado nunca aparece duplicado na lista.

**Arquivos provaveis:** `business/volt_core/src/client/extensions/optical/OpticalSalesPdv.jsx`, `business/volt_core/src/client/extensions/optical/OpticalSalesPdvView.jsx`, `business/volt_core/src/client/main.jsx` e o estado compartilhado da sessao de venda.

### Prioridade 3: Previsao no checkout e leitura de Pedidos

**Status:** Concluida em `voltdev`. A secao agora se chama `Cliente`; a previsao aparece somente em `Pagar na entrega`, sem horario. Pedidos separa cliente, entrega, andamento e financeiro, usa os novos filtros tambem no servidor e mantem apenas `Concluir retirada` como acao primaria.
