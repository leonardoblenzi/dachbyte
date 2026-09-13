# Phase E Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remover linguagem óptica das duas áreas compartilhadas do Volt Core e deixar uma regressão que proteja o tenant Geral.

**Architecture:** A correção permanece no contrato atual do frontend, sem criar nova abstração. Um teste estrutural em `commercialPhaseE.test.js` valida os textos compartilhados de `main.jsx`; depois do deploy, dados de QA são cadastrados pela interface para executar o golden path óptico.

**Tech Stack:** Node.js `node:test`, React/JSX, Vite.

---

### Task 1: Tornar a copy compartilhada genérica

**Files:**
- Modify: `business/volt_core/src/modules/core/commercialPhaseE.test.js`
- Modify: `business/volt_core/src/client/main.jsx:263`
- Modify: `business/volt_core/src/client/main.jsx:1537`

- [ ] **Step 1: Escrever a regressão que falha**

Adicionar a `commercialPhaseE.test.js`:

```js
test("phase E shared Core copy stays generic for companies without the optical vertical", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "..", "client", "main.jsx"), "utf8");
  assert.match(main, /products:\s*\["Produtos e servicos",\s*"Produtos, servicos, precos e estoque\."\]/);
  assert.match(main, /label:\s*"Informe o estoque dos produtos"/);
  assert.doesNotMatch(main, /Armacoes, lentes, acessorios, servicos, precos e estoque\./);
  assert.doesNotMatch(main, /Informe o estoque das armacoes/);
});
```

- [ ] **Step 2: Confirmar RED**

Executar:

```powershell
cmd /c node --test src\modules\core\commercialPhaseE.test.js
```

Esperado: falha nas asserções dos novos textos porque `main.jsx` ainda contém a copy óptica.

- [ ] **Step 3: Aplicar a implementação mínima**

Em `main.jsx`, substituir somente:

```js
products: ["Produtos e servicos", "Produtos, servicos, precos e estoque."],
```

e:

```js
{ label: "Informe o estoque dos produtos", done: workspace?.workspaceVersion === 2 ? Boolean(firstUse.hasPositiveStock) : (workspace?.stock || []).some((item) => Number(item.quantity) > 0), page: "inventory" },
```

- [ ] **Step 4: Confirmar GREEN e regressões**

Executar em `business/volt_core`:

```powershell
cmd /c node --test src\modules\core\commercialPhaseE.test.js
cmd /c npm test
cmd /c npm run build
git diff --check
```

Esperado: todos os comandos com exit code `0`; o build pode manter apenas o aviso já conhecido de tamanho de chunk.

- [ ] **Step 5: Auditar o escopo e commitar**

Executar na raiz:

```powershell
git status --short
git diff --name-only HEAD
git add business/volt_core/src/modules/core/commercialPhaseE.test.js business/volt_core/src/client/main.jsx
git commit -m "fix(volt-core): keep general tenant copy generic"
git push origin voltdev
```

Esperado: nenhum arquivo fora de `business/volt_core` no diff; push fast-forward para `voltdev`.

### Task 2: Executar o golden path óptico no staging

**Files:**
- Modify: nenhum arquivo; dados criados apenas no tenant de QA do staging.

- [ ] **Step 1: Depois do deploy, criar dados identificáveis**

Pela interface do staging, criar cliente, armação, lente e receita com nomes/SKUs iniciados por `QA-FE`, registrando estoque positivo para os dois produtos.

- [ ] **Step 2: Executar o fluxo óptico**

Criar venda com cliente, receita, armação e lente; validar baixa de estoque, recebível/financeiro e criação de OP/OS.

- [ ] **Step 3: Cancelar pelo fluxo oficial**

Cancelar a venda e confirmar estorno de estoque, situação financeira e transições de OP/OS, registrando os IDs para o relatório final da Fase E.
