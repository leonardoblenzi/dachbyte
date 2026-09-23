# Global Shell Legacy Navigation Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminar o flash e a duplicidade de navegação nas landings públicas, deixando o shell global DACHBYTE como única barra em Seller e Business.

**Architecture:** Cada página pública terá o host `data-dx-shell` e o script do shell no início do `body`. O shell será idempotente e não ocultará markup externo; as páginas deixarão de emitir suas barras antigas. CTAs, tickers, heros e demonstrações permanecem como conteúdo do produto.

**Tech Stack:** HTML estático, JavaScript navegador/CommonJS, React (Chat), CSS estático, `node:test`, Docker Compose.

---

## Arquivos e responsabilidades

- `public/brand/dachbyte/landing-experience.js`: catálogo global, montagem idempotente e experiências compartilhadas.
- `public/brand/dachbyte/landing-experience.css`: estilos do shell sem regra transitória de ocultação.
- `apps/seller-ml/public/seller-landing.{js,css}`: demos Seller sem dependência de `seller-nav`.
- `apps/seller-ml/views/*.html`: host/script inicial e nenhuma barra Seller antiga.
- `apps/business/**/landing.html` e Chat: nenhum header próprio concorrente.
- `tests/landing-experience.test.js` e `tests/public-shell-no-legacy-navigation.test.js`: contratos da estrutura pública.

### Task 1: Escrever contratos vermelhos

**Files:**
- Modify: `tests/landing-experience.test.js`
- Create: `tests/public-shell-no-legacy-navigation.test.js`

- [ ] **Step 1: Criar o teste HTML para todos os templates públicos**

```js
for (const page of pages) {
  const html = read(...page);
  assert.match(html, /<body>\s*<div data-dx-shell=/, page.join('/'));
  assert.doesNotMatch(html, /seller-nav|class="navbar"|<header>/, page.join('/'));
}
```

`pages` deve conter Seller geral, ML, Shopee, Rastreio, Magalu e as páginas Business, Core e Stock.

- [ ] **Step 2: Cobrir Chat e shell compartilhado**

```js
assert.doesNotMatch(chatLanding, /lp-nav-wrap|lp-nav-links/);
assert.match(chatLanding, /DESKTOP_DOWNLOAD_URL/);
assert.match(source, /label: 'Magalu · em breve'/);
assert.doesNotMatch(source, /hideLegacyNavigation|dx-legacy-nav/);
```

- [ ] **Step 3: Confirmar falha antes da implementação**

Run: `node --test tests/landing-experience.test.js tests/public-shell-no-legacy-navigation.test.js`

Expected: FAIL por markup antigo, Magalu ausente e função de ocultação existente.

- [ ] **Step 4: Commitar os testes vermelhos**

Run:
```powershell
git add tests/landing-experience.test.js tests/public-shell-no-legacy-navigation.test.js
git commit -m "test: cover global shell navigation cleanup"
```

### Task 2: Refatorar o shell compartilhado

**Files:**
- Modify: `public/brand/dachbyte/landing-experience.js`
- Modify: `public/brand/dachbyte/landing-experience.css`
- Test: `tests/landing-experience.test.js`

- [ ] **Step 1: Adicionar Magalu e resolver a chave ativa**

```js
{ label: 'Magalu · em breve', href: '/seller/magalu', key: 'magalu' },
// no mapeamento Seller:
magalu: 'magalu',
```

- [ ] **Step 2: Remover a ocultação tardia e proteger experiências contra dupla montagem**

Apagar `hideLegacyNavigation` e sua chamada em `mount`. No início de `buildExperience`, incluir:

```js
if (el.dataset.dxExperienceMounted === 'true') return;
el.dataset.dxExperienceMounted = 'true';
```

Manter o retorno de `mount` quando `host.dataset.mounted` existir.

- [ ] **Step 3: Excluir CSS transitório**

Remover `.dx-legacy-nav` e regras `.dx-marketing .seller-nav__*`; preservar `.dx-global`, experiências, contato, footer e responsividade que não depende da barra antiga.

- [ ] **Step 4: Executar e confirmar verde**

Run: `node --test tests/landing-experience.test.js`

Expected: PASS.

- [ ] **Step 5: Commitar**

```powershell
git add public/brand/dachbyte/landing-experience.js public/brand/dachbyte/landing-experience.css tests/landing-experience.test.js
git commit -m "refactor: make global landing shell self-contained"
```

### Task 3: Remover a barra Seller preservando demos

**Files:**
- Modify: `apps/seller-ml/views/landing-general.html`
- Modify: `apps/seller-ml/views/landing-mercado-livre.html`
- Modify: `apps/seller-ml/views/landing-shopee.html`
- Modify: `apps/seller-ml/views/landing-tracking.html`
- Modify: `apps/seller-ml/views/landing-magalu.html`
- Modify: `apps/seller-ml/views/legal-magalu-terms.html`
- Modify: `apps/seller-ml/views/legal-magalu-privacy.html`
- Modify: `apps/seller-ml/public/seller-landing.js`
- Modify: `apps/seller-ml/public/seller-landing.css`

- [ ] **Step 1: Inserir shell cedo em todas as páginas**

Usar, antes de ticker ou `main`, e remover inclusões tardias/dinâmicas:

```html
<body>
  <div data-dx-shell="seller" data-dx-module="Mercado Livre"></div>
  <script src="/brand/dachbyte/landing-experience.js?v=20260923.1"></script>
```

Usar o nome de módulo correto em cada landing; páginas legais usam `Seller`.

- [ ] **Step 2: Remover cada `<nav class="seller-nav">...</nav>`**

Preservar ticker, `main`, hero, links legais, CTAs e footer.

- [ ] **Step 3: Separar as demos do código de menu**

Excluir `data-seller-menu`, `data-seller-nav`, `setOpen` e o retorno antecipado de `seller-landing.js`. Manter a criação de `data-dx-experience` por rota e inicializar as abas com uma função `initSellerDemos()` que nunca consulta `seller-nav`.

- [ ] **Step 4: Remover CSS exclusivo da navegação**

Excluir `.seller-nav`, `.seller-nav__inner`, `.seller-nav__links`, `.seller-nav__actions`, `.seller-menu`, regras `is-open` e breakpoints exclusivos. Preservar conteúdo e footer.

- [ ] **Step 5: Verificar e commitar**

Run: `node --test tests/landing-experience.test.js tests/seller-landing-contract.test.js tests/seller-magalu-public-pages.test.js tests/public-shell-no-legacy-navigation.test.js`

Expected: PASS.

```powershell
git add apps/seller-ml/views apps/seller-ml/public tests
git commit -m "refactor: remove legacy Seller navigation"
```

### Task 4: Remover as barras Business e do Chat

**Files:**
- Modify: `apps/business/public/landing.html`
- Modify: `apps/business/core/public/landing.html`
- Modify: `apps/business/stock/apps/web/public/landing.html`
- Modify: `apps/business/chat/sordchat-frontend/src/pages/Landing.js`
- Modify: arquivo CSS do Chat que define `.lp-nav*`

- [ ] **Step 1: Mover o script global para junto do host**

Em cada landing HTML Business:

```html
<body>
  <div data-dx-shell="business" data-dx-module="Core"></div>
  <script src="/brand/dachbyte/landing-experience.js?v=20260923.1"></script>
```

Usar `Business`, `Core` e `Stock` nos arquivos correspondentes e remover a tag repetida do final do `body`.

- [ ] **Step 2: Remover somente blocos de navegação local**

Excluir `<nav>...</nav>` de Business, o `<header>` de navegação de Core e `<nav class="navbar">...</nav>` de Stock. Não tocar em fundos, canvas, ticker, hero ou conteúdo.

- [ ] **Step 3: Limpar Chat sem perder ações**

Em `Landing.js`, remover `<header className="lp-nav-wrap">...</header>`. Inserir no conjunto de ações do hero:

```jsx
<a className="lp-btn" href={DESKTOP_DOWNLOAD_URL}><Download size={17} />App desktop</a>
<Link className="lp-btn lp-btn--primary" to="/login">Entrar <ArrowRight size={17} /></Link>
```

Excluir apenas `.lp-nav-wrap`, `.lp-nav`, `.lp-nav-links`, `.lp-nav-actions` e breakpoints exclusivamente associados, mantendo `.lp-btn` e hero.

- [ ] **Step 4: Executar validação e commitar**

Run: `node --test tests/landing-experience.test.js tests/public-shell-no-legacy-navigation.test.js`

Run: `npm --prefix apps/business/chat/sordchat-frontend run build`

Expected: PASS e build sem erro.

```powershell
git add apps/business tests
git commit -m "refactor: unify Business landings under global shell"
```

### Task 5: Verificar e publicar

**Files:**
- Verify: arquivos das tasks 1 a 4

- [ ] **Step 1: Rodar os contratos completos e verificar diff**

Run: `node --test tests/landing-experience.test.js tests/seller-landing-contract.test.js tests/seller-magalu-public-pages.test.js tests/public-shell-no-legacy-navigation.test.js`

Run: `git diff --check HEAD~4..HEAD`

Expected: todos PASS, sem whitespace inválido.

- [ ] **Step 2: Garantir que não restaram marcadores públicos**

Run: `rg -n "seller-nav|dx-legacy-nav|hideLegacyNavigation|lp-nav-wrap|class=\\\"navbar\\\"" apps/seller-ml/views apps/seller-ml/public public/brand/dachbyte apps/business`

Expected: nenhum resultado fora de testes/comentários autorizados.

- [ ] **Step 3: Publicar a main controlando a imagem compartilhada**

Run local: `git push origin main`

Na VPS:

```bash
cd /opt/dachbyte/repository
git stash push -m codex-preserve-vps-executable-modes -- infra/business-db-ops.sh infra/business-production-ops.sh
git pull --ff-only origin main
git stash pop
cd infra
docker compose --env-file ./env/compose.env -f compose.vps.yml build --no-cache gateway seller-ml-web seller-ml-worker
docker compose --env-file ./env/compose.env -f compose.vps.yml up -d --no-deps --force-recreate gateway seller-ml-web seller-ml-worker
```

- [ ] **Step 4: Verificar saúde e rotas**

```bash
docker compose --env-file ./env/compose.env -f compose.vps.yml ps
for path in /seller /seller/mercado-livre /seller/shopee /seller/rastreio /seller/magalu /business /business/core /business/stock /business/price /business/chat; do
  printf '%s ' "$path"; curl -fsS -o /dev/null -w '%{http_code}\n' "https://dachbyte.tech$path"
done
```

Expected: serviços `healthy`, rotas `200` e inspeção desktop/mobile sem flash ou cabeçalho duplicado.
