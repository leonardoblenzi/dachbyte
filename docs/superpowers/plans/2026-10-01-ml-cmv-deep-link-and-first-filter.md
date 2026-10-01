# ML CMV Deep Link and First Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir abrir o custo de um SKU em nova guia pelo atalho do CMV e evitar a consulta automática de Margem antes do primeiro filtro.

**Architecture:** `financeiro-ml-margem.js` produz links com fragmento `#costs/sku/<SKU>` e interpreta esse fragmento no boot. Clique primário sem modificadores continua trocando a aba interna; o navegador trata os demais cliques. O boot mantém datas de sete dias, porém aguarda a primeira submissão antes de consultar Margem. Um estado vazio esconde resultados estáticos até haver resposta bem-sucedida.

**Tech Stack:** JavaScript vanilla, HTML, CSS, `node:test`, Playwright CLI para verificação de navegador.

---

## Arquivos

- Modificar: `apps/seller-ml/public/js/financeiro-ml-margem.js` — link do CMV, entrada por fragmento, carregamento sob demanda.
- Modificar: `apps/seller-ml/views/financeiro-ml-margem.html` — estados vazios e versão do JS.
- Modificar: `apps/seller-ml/public/css/financeiro-ml.css` — apresentação dos estados vazios e link.
- Modificar: `apps/seller-ml/tests/financeiro-ml-integrated-costs-ui.test.js` — link/deep link.
- Modificar: `apps/seller-ml/tests/financeiro-ml-margem-ui.test.js` — primeira consulta.
- Criar: `apps/seller-ml/tests/financeiro-ml-margin-navigation-runtime.test.js` — exercitar o boot, submissão e cliques com um DOM mínimo em `vm`.

### Task 1: Link nativo de SKU e seletor

- [ ] Adicionar testes em `financeiro-ml-integrated-costs-ui.test.js`: `costLinkHref("SKU A/B")` deve produzir fragmento codificado; `renderPeriodCostAction` de uma pendência deve retornar `<a href=...>`; cada opção com SKU no seletor deve ser `<a href=...>`; o listener deve interceptar somente clique primário sem `ctrlKey`, `metaKey`, `shiftKey` ou `altKey`.
- [ ] Rodar `node --test apps/seller-ml/tests/financeiro-ml-integrated-costs-ui.test.js` e confirmar falha porque o atalho ainda é `<button>`.
- [ ] Criar `costLinkHref(sku)` em `financeiro-ml-margem.js` como `${window.location.pathname}#costs/sku/${encodeURIComponent(sku)}`; fazer `renderPeriodCostAction` e as escolhas do modal emitirem âncoras. Usar `event.button === 0` e ausência de modificadores antes de `preventDefault()` e `openCostForSku`; não interceptar os demais cliques. Manter o atalho de múltiplos SKUs como seletor e cada SKU com seu próprio `href`.
- [ ] Rodar o teste vermelho novamente e confirmar verde; executar `node --check apps/seller-ml/public/js/financeiro-ml-margem.js`.

### Task 2: Entrada profunda e carregamento apenas após Filtrar

- [ ] Adicionar testes em `financeiro-ml-integrated-costs-ui.test.js` e `financeiro-ml-margem-ui.test.js`: `readCostDeepLink("#costs/sku/SKU%20A")` retorna `SKU A`, fragmentos inválidos retornam vazio; boot com link profundo chama `openCostForSku` e não chama `loadMargin`; boot normal chama `initDates` e `setActiveTab("summary")`, mas não `loadMargin`; o formulário mantém uma chamada por submissão. Exigir IDs de estado inicial em três painéis.
- [ ] Rodar os dois testes e confirmar falha pelas chamadas automáticas/ausência do estado vazio.
- [ ] Em `DOMContentLoaded`, inicializar datas, interpretar `location.hash` e abrir custos diretamente quando válido; caso contrário abrir Resumo sem consultar Margem. Ao clicar em outra aba superior, limpar apenas fragmento `#costs/sku/...` com `history.replaceState` antes de alternar. Tratar erro de `decodeURIComponent` como fragmento inválido.
- [ ] Adicionar bloco `.fml-filter-empty` a Resumo, Margem por período e Equilíbrio; usar `data-awaiting-filter="true"` nos painéis, escondendo demais filhos enquanto aguardam. Remover o atributo nos três após sucesso de `loadMargin`, deixando o estado vazio em caso de erro. Manter `state.marginLoaded` para que **Atualizar** antes da primeira resposta use a mesma chamada não-forçada de **Filtrar**.
- [ ] Atualizar mensagem inicial do status para “Escolha o período e clique em Filtrar.”; elevar a chave de cache do JS/CSS na view e ajustar o teste de versão.
- [ ] Rodar os testes e os dois `node --check`; confirmar verde.

### Task 3: Navegador, regressão e entrega

- [ ] Rodar `node --test apps/seller-ml/tests/financeiro-ml-integrated-costs-ui.test.js apps/seller-ml/tests/financeiro-ml-margem-ui.test.js apps/seller-ml/tests/financeiro-ml-margin-navigation-runtime.test.js apps/seller-ml/tests/financeiro-ml-margin-inline-cost-ui.test.js apps/seller-ml/tests/financeiro-ml-gmv.test.js` e `git diff --check`.
- [ ] Com uma página local servida com respostas de API simuladas, verificar no navegador: zero requests de `/margin` no boot; primeiro **Filtrar** faz um request; clique primário do CMV abre custos na página; Ctrl+clique e botão do meio criam nova guia focada no SKU; modal de vários SKUs não escolhe um SKU sozinho.
- [ ] Revisar `git diff` contra a especificação `docs/superpowers/specs/2026-10-01-ml-cmv-new-tab-and-filter-timing-design.md`; commitar apenas os cinco arquivos da implementação.
- [ ] Integrar por fast-forward à `main`, enviar ao GitHub e recriar apenas `seller-ml-web` na VPS se o checkout remoto estiver limpo em arquivos rastreados. Verificar status healthy, logs e presença do asset atualizado no container.
