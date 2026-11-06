# DACH Hub — Fase 1: catálogo mestre e estoque central

**Status:** rascunho de desenho, para discussão · **Data:** 06/11/2026
**Base:** mapa de funções da Tray (`docs/research/2026-11-06-tray-mapa-de-funcoes.md`) e levantamento dos módulos atuais.

## 1. Objetivo

Um lugar só onde o seller vê cada produto (SKU) e o estoque dele em todos os canais. Quando vende em um canal, o estoque cai nos outros automaticamente. Ninguém mais vende o que não tem.

**Dentro da Fase 1**
- **Catálogo mestre:** um produto (SKU DACH) ligado a todos os seus anúncios no ML, no Magalu e na Shopee.
- **Vínculo anúncio ↔ produto:** casamento automático por SKU e EAN; o resto vai para uma fila de pendências e é resolvido manualmente.
- **Estoque central** com histórico de movimentos (ledger) e kits.
- **Regras de estoque por conta e por anúncio:** igual ao central, fixo, % do estoque, teto, trava mínima e reserva de segurança.
- **Baixa automática:** venda baixa o estoque e cancelamento devolve; em seguida o novo saldo é enviado aos outros anúncios.
- **Modo observação:** o Hub calcula e mostra o que enviaria, sem escrever nos canais, até a conta ser ativada.
- **Reconciliação:** detectar quando o estoque no canal foi mudado por fora (Tray, ANYMARKET, Bling, manual).

**Fora da Fase 1** (fases seguintes)
- Preço por canal.
- Publicar anúncios a partir do mestre.
- Central de pedidos com NF-e e etiquetas.
- Atendimento unificado.
- Novos canais.

## 2. Lições da Tray aplicadas

| Na Tray | No DACH Hub |
|---|---|
| Produto da loja é a fonte; anúncio só existe ligado a ele | `hub.items` (SKU DACH) é a fonte; `hub.listings` aponta para ele |
| "Aguardando correção / anúncio não relacionado" e "relacionamento inteligente" | Fila **Pendências › Anúncios sem vínculo**, com sugestão automática por SKU, EAN e título |
| "Pedidos não inclusos": venda sem vínculo não baixa estoque | Fila **Pendências › Vendas sem vínculo**; ao vincular, o Hub aplica a baixa retroativa |
| Estoque do anúncio "igual da loja / fixo"; pausar quando acaba | Regra de estoque por conta, sobrescrevível por anúncio; trava mínima zera o anúncio |
| "Sincronismo após publicação" por anúncio | Chave **sincronizar estoque** por anúncio (liga/desliga sem desvincular) |
| Até 10 contas por canal | Contas vêm dos módulos (já são multi-conta) |
| Fraquezas: relatórios só operacionais; lojistas grandes ainda somam outros hubs e ERP por fora (na loja estudada: Hub2b, ANYMARKET e Bling) | Diferencial: estoque cruzado com vendas, cobertura e margem que a DACHBYTE já calcula |

## 3. Arquitetura (conexão própria com os marketplaces)

```
                 ┌─────────────────────── DACH Hub ───────────────────────┐
  navegador ───▶ │ hub-web (Express + JS)        hub-worker (BullMQ)       │
                 │ conectores próprios: mercadolivre · magalu · shopee     │
                 │ schema hub.* (contas, tokens cifrados, catálogo, estoque)│
                 └──────┬──────────────────┬──────────────────┬───────────┘
                        │ OAuth + API      │ OAuth + API      │ OAuth + API
                        ▼                  ▼                  ▼
                  Mercado Livre          Magalu             Shopee
            (app "DACH Hub" próprio) (client próprio)  (app próprio, ERP System)

  Hub de cobrança/identidade ◀── login da suíte, recurso por conta conectada, medição de vendas
  DACH ML / DACH Magalu / DACH Shopee: independentes; não participam da Fase 1
```

**Decisões**
1. **App novo, `apps/seller-hub`**, no mesmo stack dos módulos Seller (Node/Express, imagem `dachbyte/seller`, Postgres e Redis existentes). O Hub de cobrança continua cuidando de identidade, cobrança e recursos; o DACH Hub vira mais um produto (`slug: "dach_hub"`).
2. **O DACH Hub conecta as contas dos clientes sozinho**, sem passar pelos módulos DACH ML, DACH Magalu e DACH Shopee. O cliente pode usar só o Hub, só um módulo, ou os dois.
   - **Apps próprios em cada marketplace** (app "DACH Hub" no ML, client próprio no ID Magalu, app próprio na Shopee Open Platform), com tokens, webhooks e limites de requisição separados dos módulos.
   - **Por que não reaproveitar os apps dos módulos:** no Mercado Livre o refresh token é de **uso único**; cada renovação invalida o anterior. Dois sistemas renovando o token da mesma conta no mesmo app derrubam um ao outro. Com apps separados, cada sistema tem o seu par de tokens. Os webhooks também são por app (pedidos chegam direto no Hub) e o limite de requisições do ML é por app (o Hub não consome a cota dos módulos).
   - **Custo:** o seller que usar módulo e Hub autoriza duas vezes (uma por produto). Uma "conexão única" (um cofre de credenciais compartilhado entre Hub e módulos) fica para uma fase futura, se fizer sentido.
3. **Código dos conectores:** fica dentro do `seller-hub` (`src/connectors/{mercadolivre,magalu,shopee}`), com uma interface comum: `authorizeUrl`, `exchangeCode`, `refresh`, `listListings`, `getListing`, `writeStock`, `verifyStock`, `listOrders`, `getOrder`, `parseWebhook`. As partes já testadas nos módulos são **copiadas e adaptadas como padrão**, sem dependência em tempo de execução:
   - preflight e verificação da escrita de estoque do ML (`EstoqueAtualizacaoService`);
   - escrita protegida do Magalu (`write_operations`);
   - sincronização de produtos e pedidos da Shopee (`ProductSyncService`, `OrderSyncService`);
   - normalização de SKU e EAN do SKU Tracker.

   Se depois Hub e módulos quiserem compartilhar código, esses conectores viram uma biblioteca em `apps/shared/marketplaces`.
4. **Escrita protegida** (padrão `write_operations` do Magalu): idempotência, uma operação ativa por anúncio, verificação depois de enviar, estados `divergente/incerto` e auditoria.
5. **Ledger de estoque:** o saldo é a soma dos movimentos, nunca um número sobrescrito. Todo número tem origem rastreável (venda X, ajuste do usuário Y, importação Z).

### 3.1 Conectar uma conta (fluxo do cliente)

1. **Conta › Contas conectadas › "Conectar Mercado Livre / Magalu / Shopee"** (só administrador da empresa).
2. O Hub gera um `state` assinado e de uso único (empresa, usuário, canal, expiração de 10 min) e redireciona para a autorização do marketplace:
   - ML: `auth.mercadolivre.com.br/authorization`;
   - Magalu: ID Magalu;
   - Shopee: `auth_partner`.
3. O retorno chega em `/hub/auth/{canal}/callback`. O Hub valida o `state`, troca o código por tokens e identifica a conta (seller id, apelido, loja):
   - **conta já ligada a outra empresa** → bloqueia e avisa (o mesmo cuidado de posse que o Magalu tem hoje);
   - **conta nova** → cria `hub.channel_accounts` e registra o recurso no Hub de cobrança (`/v1/internal/resources/sync`, `module_slug: "dach_hub"`).
4. Grava os tokens **cifrados** (AES-256-GCM, chave própria do Hub, padrão `enc::v1::` do ML) em `hub.channel_tokens`.
5. Renovação automática:
   - antes de expirar;
   - com **lock por conta** (Redis ou advisory lock), relendo o token salvo antes de renovar, por causa do refresh de uso único;
   - em falha definitiva, a conta fica "Reconectar necessário", com aviso no painel e por e-mail.
6. Assina os webhooks do app: ML `orders_v2` e `items`; Magalu `orders_*` e `portfolios_stock`; Shopee push de pedido e estoque.
7. Dispara a primeira importação de anúncios, em modo observação.
8. **Desconectar:** revoga quando a API permite, apaga os tokens, para as sincronizações e marca o recurso como desvinculado no Hub.

Um painel "Saúde da conexão" por conta mostra: conectado, expira em, última sincronização, webhooks recebidos nas últimas 24h e erros.

**Tabelas novas:**
```text
hub.channel_tokens   channel_account_id, access_token_enc, refresh_token_enc, expires_at,
                     refresh_expires_at, scopes, atualizado_em, falhas_refresh, status
hub.oauth_states     state (hash), tenant_id, user_id, canal, expires_at, used_at
hub.webhook_events   id, canal, conta, topico, recurso, payload, recebido_em,
                     processado_em, status   (idempotente por canal+tópico+recurso+data)
```

## 4. Modelo de dados (schema `hub`)

```text
hub.tenants_settings      tenant_id, modo (observacao|ativo), fuso, criado_em
hub.items                 id, tenant_id, sku, nome, ean, marca, unidade, custo, peso/dim,
                          tipo (simples|kit), ativo, origem (import_canal|planilha|manual), atualizado_em
                          unique (tenant_id, sku)
hub.kit_components        kit_item_id, component_item_id, quantidade
hub.locations             id, tenant_id, nome (ex.: "CD Arapongas"), padrao bool
hub.stock_balances        item_id, location_id, on_hand, reserved, available (calc), atualizado_em
hub.stock_movements       id, item_id, location_id, tipo (venda|cancelamento|ajuste|importacao|
                          inventario|devolucao), quantidade (+/-), origem_tipo, origem_id,
                          canal, conta_id, usuario_id, observacao, criado_em
hub.channel_accounts      id, tenant_id, canal (ml|magalu|shopee), conta_externa_id, rotulo,
                          modulo_account_id, sync_estoque (off|observacao|ativo), regra_padrao_id
hub.listings              id, channel_account_id, anuncio_id, variacao_id, sku_canal, ean, titulo,
                          status_canal, fulfillment bool, estoque_canal, estoque_enviado,
                          item_id (null = sem vínculo), vinculo (auto_sku|auto_ean|sugerido|manual),
                          sincronizar bool, regra_id, visto_em
                          unique (channel_account_id, anuncio_id, variacao_id)
hub.stock_rules           id, tenant_id, escopo (conta|anuncio), modo (igual|fixo|percentual),
                          valor, teto, trava_minima, reserva_seguranca, zerar_quando_trava bool
hub.channel_orders        id, channel_account_id, pedido_externo, status, itens jsonb,
                          movimento_aplicado bool, pendente_vinculo bool, recebido_em
hub.stock_pushes          id, listing_id, quantidade_desejada, quantidade_anterior, motivo,
                          estado (planejado|enfileirado|enviado|verificado|divergente|falhou|ignorado),
                          idempotency_key, tentativas, erro, criado_em, verificado_em
hub.audit_events          id, tenant_id, usuario_id, acao, detalhes jsonb, criado_em
```

**Regras de cálculo** (por anúncio sincronizado, recalculado quando muda o saldo do item):
1. `base = disponível do item` (on_hand − reserved). Para kits, `min(disponível do componente / quantidade)`.
2. Aplica a regra: igual → `base`; fixo → `valor`; percentual → `floor(base × valor%)`.
3. Desconta a reserva de segurança: `max(0, x − reserva)`.
4. Trava mínima: se `base ≤ trava_minima`, o anúncio recebe 0.
5. Aplica o teto: `min(x, teto)`.
6. Anúncio Full ou Fulfillment nunca recebe escrita (o estoque é do canal); entra só como leitura.

## 5. Fluxos

**5.1 Entrada de uma conta**
1. Na entrada, o Hub importa os anúncios de cada conta (pelo conector).
2. Vínculo automático por SKU normalizado e depois por EAN, reaproveitando a normalização `sku_key`/`ean_key` do SKU Tracker (`skuleader.sku_links`).
3. O que não casar vai para **Pendências › Anúncios sem vínculo**, com sugestão por título.
4. Cria os itens mestres a partir dos SKUs encontrados, ou por planilha.

**5.2 Estoque inicial**
O usuário escolhe por conta ou por item: importar uma planilha, adotar o estoque de um canal de referência ou adotar o menor estoque entre os canais. Isso gera um movimento `importacao`.

**5.3 Venda**
1. Chega o evento de pedido do conector (webhook ou sincronização).
2. O Hub identifica os itens e grava um movimento `venda` (−), de forma idempotente por pedido e item.
3. Recalcula os anúncios irmãos e agenda `stock_pushes`.
4. Junta várias vendas do mesmo SKU numa janela de 5 a 10 segundos e envia um único lote por conta, respeitando o limite de cada canal.
5. Se a venda não tem vínculo, vai para **Vendas sem vínculo**; ao vincular, a baixa é aplicada na hora.

**5.4 Cancelamento ou devolução:** movimento (+) e o mesmo recálculo.

**5.5 Reconciliação** (a cada X minutos, e sob demanda)
1. Compara `estoque_canal` com `estoque_enviado`.
2. Se o canal foi mudado por fora, marca **divergente**.
3. Política por conta: "sobrescrever com o valor do Hub" (padrão no modo ativo) ou "só alertar".

**5.6 Modo observação → ativo**
- Toda conta começa em observação: o Hub planeja os envios (`estado = planejado`) e mostra "o que mudaria".
- O usuário ativa conta por conta, depois de conferir.
- Um único **botão de pausa** por conta ou geral para tudo na hora.

## 6. Telas

1. **Visão geral:**
   - itens, vínculos, pendências, divergências e envios com erro;
   - estoque em risco (cruzado com as vendas dos últimos 30 dias que os módulos já têm).
2. **Catálogo:**
   - lista de itens com estoque disponível e anúncios por canal (badges ML, Magalu, Shopee);
   - detalhe do item com anúncios vinculados, regra, estoque enviado × no canal e histórico de movimentos.
3. **Pendências:** anúncios sem vínculo, com sugestão e ação de vincular ou criar item; vendas sem vínculo; divergências.
4. **Estoque:**
   - ajuste manual com motivo;
   - importação e exportação por planilha;
   - inventário (contagem que gera ajustes);
   - histórico de movimentos com filtros.
5. **Regras e contas:** modo de cada conta (desligado, observação, ativo), regra padrão da conta e exceções por anúncio.
6. **Sincronização:** fila de envios com estado, tentativas e erro, e reenvio manual.

**Visual:** mesma estrutura do módulo Mercado Livre (shell, menu lateral, barra superior, tema escuro, mobile, KPIs com hover comparativo), por meio do pacote compartilhado `apps/shared/seller-ui/`, extraído do `ml-shell`, com o **tema de cor Violeta DACH** (roxo frio com destaque menta). Ver roadmap, seção 12. A extração do shell é a primeira tarefa da etapa E1.

## 7. Etapas de entrega

| Etapa | Entrega | Escreve nos canais? |
|---|---|---|
| **E1 — Fundação e vínculos** | Pacote visual `apps/shared/seller-ui` extraído do ML; app `seller-hub`, schema `hub`, produto no Hub; apps próprios nos 3 marketplaces e fluxo "Conectar conta"; leitura de anúncios pelos conectores do Hub; importação; vínculo automático; telas Catálogo e Pendências | Não |
| **E2 — Estoque mestre** | Ledger, saldos, kits, planilha, estoque inicial, regras; cálculo e "o que mudaria" (modo observação) | Não |
| **E3 — Vendas e envio** | Webhooks próprios de pedidos; baixa e devolução; escrita de estoque com verificação; ativação por conta; pausa geral | Sim, por conta ativada |
| **E4 — Reconciliação e piloto** | Divergências, alertas, painel; piloto com um cliente (ou conta de teste) em 1 conta por canal antes de abrir para todos | Sim |

## 8. Riscos e decisões em aberto

1. **Dois sistemas escrevendo estoque (regra de produto).** Muitos clientes já sincronizam estoque por outra plataforma (Tray, ANYMARKET, Hub2b, ERP). Se o DACH Hub também escrever, um sobrescreve o outro. O produto precisa tratar isso:
   - no onboarding, um checklist explicando que a sincronização de estoque precisa ficar em um sistema só;
   - o modo observação detecta escritas externas (divergências recorrentes) e avisa antes de ativar;
   - a ativação fica bloqueada enquanto houver divergência recorrente sem resolução.
2. **Fonte do estoque físico.** No início vale a planilha ou o canal de referência. Depois, um ERP (Bling, Tiny, Omie) ou o VoltStock (`apps/business/stock`) podem virar a fonte do saldo físico.
3. **Shopee.** A API de produção está em homologação (conexão de lojas pausada). Shopee entra em observação até liberar.
4. **Full e Fulfillment** (ML Full, Magalu Fulfillment): só leitura.
5. **Volume.** Referência de um seller grande (loja estudada): cerca de 10 mil anúncios no Magalu, 3,4 mil na Shopee e milhares no ML. A importação precisa ser incremental e em lotes; os envios, agrupados e respeitando os limites de cada canal.
6. **Variações.** ML (família/user products, variações), Magalu (SKU por variação) e Shopee (item + model). O vínculo é sempre no nível da variação vendável.
7. **Cobrança.** Definida como **% sobre vendas** (GMV dos canais), com faixas e mínimo mensal. Ver `2026-11-06-dach-hub-roadmap.md`, seção 2. O Hub já mede pedidos em `/v1/internal/resources/orders/measurement`; falta medir o GMV.

## 9. Conectores próprios por canal

Como o Hub não depende dos módulos, cada conector é implementado no `seller-hub`, usando os módulos só como **referência do que já funciona** em produção.

| | Mercado Livre | Magalu | Shopee |
|---|---|---|---|
| **App necessário** | Criar app "DACH Hub" no DevCenter do ML (redirect `/hub/auth/mercadolivre/callback`, URL de notificações `/hub/webhooks/mercadolivre`, tópicos `orders_v2`, `items`) | Criar client próprio no ID Magalu (CLI `idm client create`), com redirect e escopos de portfólio, preço, estoque e pedidos. A solicitação de escopo pede justificativa | Criar app na Shopee Open Platform, categoria **ERP System** (todas as APIs, exceto Chat), testar no sandbox e pedir o **Go Live** |
| **Aprovação** | Não precisa de aprovação para começar; certificação de parceiro é opcional | Escopos podem passar por análise do Magalu | **Go Live obrigatório** (revisão). A DACHBYTE já teve o perfil de parceiro recusado por falta de integrações ativas; é o maior risco de prazo |
| **Tokens** | access 6h; **refresh de uso único** → lock por conta obrigatório | OAuth do ID Magalu; renovação com lock, o mesmo padrão | access ~4h; refresh renovado a cada uso (validar na doc oficial) |
| **Ler anúncios** | `/users/{id}/items/search` (scan) + `/items?ids=` (lotes de 20); SKU por `SELLER_SKU`/`seller_custom_field` na variação (lógica do `financeiroMlSkuCatalogSyncService`) | Portfólio de SKUs, preço e estoque (lógica do `catalogSyncService`); limite de paginação de 20 mil por status → descoberta por partes | `get_item_list` + `get_item_base_info` + `get_model_list` (lógica do `ProductSyncService`), lendo o estoque **sempre** |
| **Gravar estoque** | `PUT /items/{id}` (com variações), preflight com estoque esperado, bloquear Full e multi-origem, verificar até 4 releituras (padrão do `EstoqueAtualizacaoService`) | API de estoque do portfólio com o padrão `write_operations` (idempotência, verificação) | `update_stock` com `seller_stock` em lote, verificação por `get_model_list` (o módulo atual usa o formato antigo `normal_stock`; **não copiar**) |
| **Pedidos** | Webhook `orders_v2` → `GET /orders/{id}`; polling de segurança | Webhook `orders_order` / `orders_delivery` → reconciliação (padrão do `webhookProcess`) | Push de pedido → `get_order_detail`; polling curto (10 min) de segurança (o módulo atual faz só 2×/dia) |
| **Full / Fulfillment** | Só leitura (`logistic_type=fulfillment`) | Só leitura (Magalu Fulfillment) | n/a |

**Ordem de ativação recomendada:**
1. **Magalu:** client próprio rápido de criar; webhooks completos.
2. **Mercado Livre:** app sem aprovação, mas exige o cuidado com o refresh de uso único.
3. **Shopee:** depende do Go Live. Desenvolver e testar no **sandbox** (a instância de homologação já preparada pode ser reaproveitada como referência) enquanto a aprovação corre.

**O que muda nas etapas:**
- **E1:** criar os 3 apps; fluxo "Conectar conta" com tokens cifrados e renovação; leitura de anúncios pelos conectores do Hub.
- **E3:** webhooks próprios de pedidos e a escrita de estoque pelos conectores do Hub.

**Convivência com os módulos DACH:** a mesma conta pode estar conectada ao Hub e ao DACH ML, DACH Magalu ou DACH Shopee (apps diferentes, tokens diferentes). Se o módulo também gravar estoque (ex.: "atualização de estoque em massa" do DACH ML), vale a mesma regra de conflito de qualquer outro sistema: o Hub detecta a divergência e avisa. Mais adiante, o módulo pode mostrar "estoque desta conta é gerenciado pelo DACH Hub".

**Fontes:**
- [ML: autenticação e autorização (refresh token de uso único)](https://developers.mercadolivre.com.br/pt_br/envio-de-produto/autenticacao-e-autorizacao)
- [Relato sobre `invalid_grant` por reuso do refresh no ML](https://dev.to/javiersivack/el-refresh-token-de-mercado-libre-es-de-un-solo-uso-como-no-desconectar-a-tus-vendedores-137g)
- [Magalu: criação de aplicação (CLI `idm`)](https://developers.magalu.com/docs/first_steps/create_an_application/create_application.en/)
- [Shopee: categorias de app (cópia da doc, não oficial)](https://www.scribd.com/document/807484756/api-call-shopee)
- [Shopee: guia Go Live (Qiscus)](https://documentation.qiscus.com/app-center/shopee)

Validar na documentação oficial da Shopee as regras atuais de categoria e de token.

## 10. Arquitetura técnica (decidida)

**Estilo:** monólito modular por domínio, com dois processos (web e worker) num único app `apps/seller-hub`. Os marketplaces entram por **portas e adaptadores**. Internamente é orientado a eventos, com fila e **outbox transacional**. Microsserviços ficam fora: time pequeno, infraestrutura já existente e nenhum ganho agora.

**Linguagem e stack**
- **JavaScript (CommonJS) + JSDoc com `// @ts-check`**, igual aos módulos Seller: a mesma imagem Docker e o mesmo deploy, tipagem verificada no editor e no CI, sem passo de build.
- Node + Express; Postgres com migrations SQL (schema `hub`), sem ORM; BullMQ/Redis para filas.
- Front com views do servidor e JS sem framework, usando o pacote `apps/shared/seller-ui` (padrão ML, tema Violeta).
- Testes com `node:test`.

**Estrutura**
```
apps/seller-hub/
  src/
    modules/
      accounts/   contas conectadas, OAuth, tokens cifrados, saúde da conexão
      catalog/    itens (SKU DACH), kits, anúncios, vínculos, pendências
      stock/      ledger, saldos, regras, cálculo do que enviar por anúncio
      sync/       fila de envios, verificação, reconciliação, modo observação
      orders/     pedidos recebidos, baixa e devolução
      billing/    medição de vendas para o Hub de cobrança
    connectors/   contract.js + channels.js (catálogo de canais) + mercadolivre/ magalu/ shopee/
    platform/     db, filas, cifra, auth da suíte, logs, config
    web/          rotas, controllers, views
    jobs/         workers (importação, envios, webhooks, reconciliação)
  db/migrations/
  tests/
```
Cada módulo expõe uma interface pública (`index.js`). Outro módulo nunca lê as tabelas de um vizinho por fora dessa interface.

**Paradigma por camada**

| Camada | Estilo |
|---|---|
| Conectores | **Classes** que estendem `ChannelConnector` (marketplace ou loja virtual): `authorizeUrl`, `exchangeCode`, `refresh`, `listListings`, `getListing`, `writeStock`, `verifyStock`, `listOrders`, `getOrder`, `parseWebhook` |
| Tokens e limite de requisições | **Classes** com estado (lock por conta, renovação, fila de chamadas) |
| Regras de negócio | **Funções puras**: cálculo da quantidade por anúncio, kits, cascata de regras, casamento SKU/EAN, normalização |
| Banco | **Repositórios** (funções com SQL explícito) |
| Casos de uso | **Serviços** que orquestram repositório + regra pura + outbox numa transação |

**Garantias**
- **Idempotência:**
  - baixa por pedido + item;
  - envio por chave de idempotência;
  - webhook por canal + tópico + recurso.
- **Outbox:** movimento de estoque e evento de saída gravados na mesma transação; um worker publica na fila.
- **Concorrência:** uma operação ativa por anúncio; lock por conta na renovação de token; lotes por conta respeitando o limite de cada canal.
- **Segurança:** tokens cifrados (AES-256-GCM); `state` OAuth assinado e de uso único; permissões por papel (administrador da empresa conecta contas e ativa escrita).

**Testes**
1. Unitários em todas as funções puras.
2. **Contrato dos conectores:** o mesmo conjunto de testes para ML, Magalu e Shopee, com respostas reais gravadas do sandbox.
3. Integração dos repositórios e casos de uso contra um Postgres de teste (ex.: venda reprocessada não baixa duas vezes).
4. Modo observação antes de qualquer escrita real.
5. Validação das telas no navegador, em desktop e em 375 px.

### 10.1 Canais futuros: novos marketplaces e lojas virtuais

O Hub nasce com 3 marketplaces, mas já está preparado para outros canais (ex.: Amazon, Americanas, Casas Bahia; e lojas virtuais como Nuvemshop, Shopify, WooCommerce, VTEX, Loja Integrada, Tray).

**Catálogo de canais (`src/connectors/channels.js`):** é o único lugar que lista os canais. Cada definição declara:
- `kind`: `marketplace` ou `store` (loja virtual). A tela de Contas agrupa por tipo.
- `auth`: `oauth` (o seller autoriza no site do canal) ou `credentials` (o seller informa URL da loja e chave de API num formulário gerado a partir de `credentialFields`).
- `capabilities`: `listings`, `stockWrite`, `priceWrite`, `orders`, `fulfillment`. O núcleo consulta antes de agendar trabalho (ex.: importação só para canal com `listings`).
- `settingsFromEnv` e `create`: variáveis de ambiente do canal e criação do conector.

**O que não muda ao adicionar um canal:** banco (o `channel` é texto validado pelo catálogo, sem lista fixa), rotas, fila de importação, matching do catálogo e telas. Os rótulos vêm de `/api/channels`.

**Formato comum:** em loja virtual, `listingId` é o id do produto na loja e `variationId` o da variante. O mesmo `ListingRecord` serve para os dois tipos.

**Passos para um canal novo:**
1. Criar `src/connectors/<canal>/` com o conector (estende `ChannelConnector`) e o mapper.
2. Acrescentar a definição em `channels.js`.
3. Rodar os testes de contrato e de extensibilidade (`tests/connectors-contract.test.js`, `tests/channels-extensibility.test.js`).

### 10.2 Importação de anúncios

- Uma execução por conta de cada vez (`hub.import_runs`, índice parcial). Pedir de novo devolve a execução ativa.
- O worker (`npm run worker`, fila BullMQ `hub-import`) percorre o canal página a página: renova o token a cada página, grava os anúncios e o progresso, e no fim marca `last_import_at`.
- Sem Redis configurado, a importação roda no próprio processo web (desenvolvimento e prévia).
- Execução sem sinal de vida há 15 minutos é encerrada como falha no próximo pedido, para a conta não travar.
- A primeira importação começa sozinha logo depois de conectar a conta; depois, o botão **Importar agora** em Contas conectadas.
