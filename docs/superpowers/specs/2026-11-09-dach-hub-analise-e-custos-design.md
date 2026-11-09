# DACH Hub — Análise por canal e custos da empresa (desenho)

Data: 09/11/2026. Status: A1 feita (telas /hub/analise e /hub/analise/produtos); A2 em diante pendentes.

## 1. Objetivo

Trazer para o DACH Hub as análises que o antigo módulo Price (`apps/business/price`) prometia — vendas, mais vendidos e margem **por canal e por conta** — e fazer do Hub a fonte única do custo dos produtos para os módulos de canal (Mercado Livre, Shopee, Magalu) que estiverem vinculados a ele.

## 2. O que vem do Price e o que fica de fora

O Price nunca foi validado com contas reais e tem login, banco e telas próprios. Do Price aproveitamos só **fórmulas puras** (sem banco, fáceis de mover) e o **desenho de dados**:

| Origem no Price | Uso no Hub |
|---|---|
| `src/finance/profit.js` (`calculateProfit`, `allocateItems`) | resultado por pedido e rateio por item/SKU |
| `src/finance/fees.js` (`normalizeFeeResult`, fingerprint) | taxas reais por pedido, versionadas. A parte do ML precisa ser completada (hoje só lê comissão e frete; faltam billing e descontos) |
| `src/marketing/metrics.js` | ROAS, ACOS, TACOS e margem pós-Ads (etapa A3) |
| `src/finance/cash.js` (`projectCash`) | recebíveis e projeção de caixa (etapa A3) |
| `src/market/analytics.js` e `src/decision/engine.js` | faixa de preço de concorrentes e recomendação de preço (etapa A4, junto do gestor de anúncios) |
| Tabelas `fee_snapshots`, `profit_components`, `profit_snapshot_items`, `marketplace_receivables`, `ads_metrics` | modelos para as tabelas novas do Hub, sempre com a **conta de canal** como coluna |

Fica de fora: autenticação própria (o Hub usa o login único da DACHBYTE), frontend (MutationObserver frágil), banco `volt_price`. Quando as etapas A1 e A2 estiverem no ar, o Price pode ser aposentado (mesmo processo do SKU Leader).

## 3. Etapas da área "Análise"

### A1 — Vendas por canal (só dados que o Hub já tem)
Base: `hub.channel_orders` (conta, status, total, data) e `hub.order_lines` (anúncio, SKU do canal, quantidade, preço, `item_id`).
- Faturamento, pedidos, ticket médio e cancelamentos por canal e por conta, com comparação ao período anterior de mesmo tamanho.
- **Mais vendidos multicanal:** ranking por item do Hub (SKU da empresa), somando os canais, com a participação de cada canal e conta. Linhas sem vínculo (`pending_link`) aparecem agrupadas pelo SKU do canal, com aviso.
- Curva ABC multicanal (cortes A 80% e B 95%, como nos módulos).
- Exportação CSV. Filtros: período, canal, conta.

### A2 — Margem por canal
Depende do cadastro de custos (seção 4) e das taxas reais por pedido:
- Mercado Livre: pedido + billing/descontos + envio do seller.
- Shopee: escrow (comissão, serviço, transação, cupom do seller, frete líquido, repasse).
- Magalu: relatório financeiro (`/seller/v1/financial-analysis/orders`; exige o scope financeiro).
- Resultado = bruto − taxas − frete − imposto − custo (e Ads na A3). Margem por canal, por conta e por SKU; pedidos com prejuízo; "SKU X: 18% no ML, 6% na Shopee".
- O custo usado é o **custo vigente na data da venda** (seção 4.2).

### A3 — Ads e caixa
Margem pós-Ads por canal e conta; recebíveis previstos por marketplace e projeção de caixa (D+7 a D+90).

### A4 — Preço
Faixa de preço de concorrentes e recomendação de preço, integradas ao gestor de anúncios (roadmap §15, etapa G2).

## 4. Cadastro de custos da empresa (Hub como fonte única)

### 4.1 Chave do custo
- O custo pertence ao **item do Hub** (`hub.items`, SKU da empresa). Kits têm custo = soma dos componentes (`hub.kit_components`).
- Cada SKU/anúncio dos canais aponta para o item. Vínculo automático por **EAN**, depois por **SKU igual**; o que sobrar vai para as pendências, para vínculo manual.
- Não usamos EAN como chave: kits sem EAN, mesmo EAN para unidade e caixa, produtos sem GTIN e variações sem EAN próprio quebrariam o custo.

### 4.2 Histórico com data de vigência
- Cada alteração cria uma versão com `valid_from`. Leitura padrão: "custo do item na data X".
- Margem de pedidos antigos não muda quando o custo muda.
- Alertas de "custo subiu ≥5% em 30 dias" (ML, Magalu) passam a ler esse histórico.

### 4.3 Componentes do custo
- **Custo do produto** no item (igual em todos os canais).
- **Custos extras por canal ou conta**, opcionais: embalagem, operacional, outros (ex.: Full no ML × envio próprio na Shopee).
- **Alíquota de imposto por conta de canal**, com um padrão da empresa — contas diferentes podem estar em CNPJs/regimes diferentes.
- Tudo editado só no Hub.

### 4.4 Vínculo de cada módulo com o Hub
Cada módulo (ML, Shopee, Magalu) ganha a opção **"Usar custos do DACH Hub"**.

**A primeira vinculação é sempre manual, pela tela de Integrações do módulo** (no ML, `Conta › Integrações`, `/conta/integracoes`, onde já ficam MarkFlow e Trello; Shopee e Magalu ganham o mesmo padrão):
- Card **"DACH Hub — custos dos produtos"**. Só aparece como disponível quando a empresa tem o DACH Hub contratado (consulta ao hub de acessos, módulo `dach_hub`); sem contrato, o card mostra "Disponível para quem assina o DACH Hub" e não permite conectar.
- Só administradores da empresa conectam ou desconectam.
- Fluxo: **Conectar** → prévia (diferenças de custo e SKUs que ficariam sem custo) → escolha de qual custo vale → **Aceitar e vincular**. Nada é vinculado automaticamente, nem quando a empresa contrata o Hub.
- No mesmo card: status (vinculado desde, por quem, última atualização dos custos) e **Desvincular**.

**Vínculo ativo — o Hub é a única fonte:**
- Tela de custos do módulo fica **somente leitura**, com o aviso "Custos gerenciados pelo DACH Hub" e o botão "Editar no DACH Hub" (abre o item no Hub; respeita a permissão do usuário no Hub).
- Importação de custos por planilha, edição item a item e alíquota local ficam bloqueadas no módulo.
- **Todo cálculo do módulo que usa custo lê do mesmo lugar:** margem, calculadora, precificação da Shopee, preço promocional do Magalu, alertas de custo. Nenhum cálculo pode continuar lendo o cadastro local.
- SKU do módulo sem vínculo com item do Hub aparece como **"sem custo no Hub"** no módulo e entra nas pendências do Hub. Nunca vira custo zero silencioso.

**Ao ligar o vínculo:**
- Prévia obrigatória: diferenças entre módulo e Hub por SKU ("R$ 12 no ML, R$ 14 no Hub") e **quantos SKUs ficariam sem custo**.
- Decisão única: levar os custos do módulo para o Hub (conflitos: vale o mais recente, com lista para conferência) ou adotar os do Hub.
- Aviso de que quem editava custo no módulo passa a precisar de acesso ao Hub.

**Vínculo desligado, empresa sem Hub ou Hub cancelado:**
- O módulo usa e edita o próprio cadastro, como hoje.
- Ao desligar/cancelar, o módulo volta a editar já com os últimos custos (e histórico) recebidos do Hub. Nada se perde.

### 4.5 Atualização e disponibilidade
- O módulo guarda uma **cópia local** dos custos do Hub. Se o Hub estiver fora do ar, a margem continua com o último valor conhecido; a tela mostra a data da última atualização.
- Mecanismo de atualização: o Hub avisa os módulos vinculados a cada alteração (evento/webhook interno) e os módulos fazem uma conferência periódica como garantia. Detalhe a definir no plano de implementação.
- A empresa precisa ser a **mesma** no Hub e nos módulos (mesmo cadastro no hub de acessos). O vínculo só é oferecido quando isso se confirma.

### 4.6 Ordem de implantação
1. Publicar o Hub (rota `/hub` no Caddy, containers web e worker) e estabilizá-lo.
2. Cadastro de custos e etapa A2 dentro do Hub, sem vínculo com módulos.
3. Vínculo em **um** módulo primeiro, liberado para poucas empresas.
4. Demais módulos, depois de validado.

## 5. Dados novos (previsão)
- `hub.item_costs` (item, custo do produto, `valid_from`, autor, origem).
- `hub.item_channel_costs` (item × canal/conta, embalagem, operacional, outros, `valid_from`).
- `hub.account_tax_rates` (conta de canal, alíquota, `valid_from`) e padrão em `hub.tenant_settings`.
- `hub.order_fees` (pedido, versão, fingerprint, componentes, origem API) e `hub.order_results` (pedido, bruto, taxas, frete, imposto, custo, resultado, rateio por linha).
- `hub.module_cost_links` (empresa × módulo, ativo, ligado em, por quem).
- API interna: `GET /hub/internal/costs?tenant=&skus=&at=` e evento de alteração para os módulos vinculados.

## 6. Pontos críticos (revisão de 09/11/2026)
1. Histórico com data de vigência (4.2) — obrigatório antes de qualquer margem.
2. Imposto por conta/CNPJ (4.3).
3. SKU sem vínculo nunca vira custo zero (4.4).
4. Implantação gradual, um módulo por vez, só com o Hub estável (4.6).
5. Custos extras por canal (4.3), permissão de edição (4.4), leitura única em todos os cálculos (4.4), mecanismo de atualização (4.5) e empresa única (4.5).
