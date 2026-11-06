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

## 3. Arquitetura

```
                ┌──────────── DACH Hub (novo) ────────────┐
 navegador ───▶ │ hub-web (Express + JS)   hub-worker (BullMQ)│
                │      schema hub.* no Postgres              │
                └───────┬──────────────────────┬────────────┘
                        │ API interna (token)  │ eventos (venda, estoque)
          ┌─────────────┼──────────────┬───────┴──────┐
          ▼             ▼              ▼              ▼
     seller-ml     seller-magalu   seller-shopee    Hub (cobrança/identidade)
   (conector ML) (conector Magalu) (conector Shopee)
```

**Decisões**
1. **App novo, `apps/seller-hub`**, no mesmo stack dos módulos Seller (Node/Express, imagem `dachbyte/seller`, Postgres e Redis existentes). Fica separado do Hub de cobrança: o Hub continua cuidando de identidade, cobrança e recursos; o DACH Hub vira mais um produto (`slug: "dach_hub"`) no catálogo do Hub.
2. **Os módulos de canal são os conectores.** O DACH Hub nunca chama a API do ML, do Magalu ou da Shopee direto: tokens, limites de requisição e regras de cada canal continuam no módulo que já os domina. Cada módulo ganha uma pequena **API interna** (`/internal/hub/*`, token de serviço) com quatro funções:
   - `GET listings`: anúncios/variações com SKU, EAN, título, status, estoque atual e se é Full/Fulfillment (paginado, incremental por `updated_since`).
   - `POST stock-writes`: grava estoque de um lote de anúncios, com chave de idempotência; responde por item (aceito, falhou, ignorado).
   - `GET stock-writes/:id`: verificação depois da escrita (o valor ficou no canal?).
   - **Eventos de saída:** o módulo avisa o Hub (fila Redis compartilhada ou POST interno) quando chega venda nova, cancelamento ou mudança de estoque no canal.
3. **Escrita protegida no padrão que o Magalu já usa** (`magalu.write_operations`): idempotência, uma operação ativa por SKU, verificação depois de enviar, estados `divergent/uncertain` e auditoria. O mesmo padrão vale para os três conectores.
4. **Ledger de estoque:** o saldo é a soma dos movimentos, nunca um número sobrescrito. Todo número tem uma origem rastreável (venda X, ajuste do usuário Y, importação Z).

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
| **E1 — Fundação e vínculos** | Pacote visual `apps/shared/seller-ui` extraído do ML; app `seller-hub`, schema `hub`, produto no Hub; `GET listings` nos 3 conectores; importação; vínculo automático; telas Catálogo e Pendências | Não |
| **E2 — Estoque mestre** | Ledger, saldos, kits, planilha, estoque inicial, regras; cálculo e "o que mudaria" (modo observação) | Não |
| **E3 — Vendas e envio** | Eventos de pedido dos conectores; baixa e devolução; `stock-writes` com verificação; ativação por conta; pausa geral | Sim, por conta ativada |
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

## 9. Conectores por canal: o que existe e o que falta

Nenhum módulo tem hoje uma API interna de catálogo ou estoque. A única rota interna é `POST /internal/hub/retirement`, com `SELLER_RETIREMENT_TOKEN`. Também não dá para contar com o mesmo banco: o ML usa `ML_DATABASE_URL` (schema `ml`), a Shopee usa `SHOPEE_DATABASE_URL` (schema `public`) e o Magalu tem o schema `magalu`. Por isso o Hub conversa só por API interna, nunca por join entre bancos.

| | Mercado Livre (`seller-ml`) | Magalu (`seller-magalu`) | Shopee (`seller-shopee`) |
|---|---|---|---|
| **Espelho de anúncios** | Parcial. Lê a API ao vivo; o cache `ml.mercadolivre_sku_catalog_items` (conta, SKU, MLB, variação, estoque, EAN) é preenchido pela fila `financeiro-ml-sku-catalog-sync`, com disparo manual ou semanal | Completo: `magalu.skus`, `prices`, `stocks`, com sync por fila e webhook | Completo: `"Product"` e `"ProductModel"` (SKU, estoque, GTIN). Porém o estoque só é relido a cada 5 execuções e o sync é manual |
| **SKU** | `seller_custom_field` / `SELLER_SKU` (por variação) + `ml.mercadolivre_sku_reference_overrides` (vínculo manual) | SKU do portfólio | `itemSku` / `modelSku` |
| **Escrita de estoque** | **Robusta:** `EstoqueAtualizacaoService.processStockChanges` (fila Bull, preflight com estoque esperado, bloqueia Full e multi-origem, verificação com até 4 releituras, `applied/divergent`). O resultado fica só no Redis | **Robusta:** `magalu.write_operations` (idempotência, verificação, auditoria) + fila `stockUpdate` | **Fraca:** `ShopeeProductWriteService.updateStock`, síncrona, item a item, sem verificação, campo legado `normal_stock`, não atualiza o espelho |
| **Pedidos** | **Não salva.** Polling ao vivo de `/orders/search`. O webhook aceita só `public_offers` e `public_candidates` (`orders_v2`, `items` e `stock` são ignorados) | Salva (`magalu.orders`, `order_items`, `deliveries`) e recebe webhook `orders_order` / `orders_delivery` | Salva (`"Order"`, `"OrderItem"` com SKU), mas por polling **só 2× por dia** (seg–sex, 6h e 18h). O push `order_status_update` e `reserved_stock_change` vira só aviso |
| **Contas/tokens** | `meli_contas` + `meli_tokens` (criptografados), multi-conta | `magalu.accounts` + tokens cifrados | `"Shop"` + `"OAuthToken"` (**texto puro**) |
| **Fila** | Bull v3, worker separado | BullMQ | BullMQ (workers no processo web) |

### Trabalho por conector

**Mercado Livre**
1. `GET /internal/hub/listings`: reaproveitar o scan do `financeiroMlSkuCatalogSyncService` (`extractCatalogRows`), incluindo inativos e Full (marcados), com paginação e `updated_since`.
2. Webhook: passar a aceitar `orders_v2` (venda e cancelamento) e `items` / `stock` (mudança feita por fora), com fila e publicação de evento para o Hub. Sem isso, a baixa ficaria dependente de polling.
3. `POST /internal/hub/stock-writes`: embrulhar `processStockChanges` (o preflight e a verificação já existem) e devolver o resultado por linha ao Hub, já que hoje ele fica só no Redis.
4. Créditos: escritas do Hub não devem consumir os créditos de "atualização de estoque em massa" (`hubCreditsService`); a cobrança passa a ser do produto DACH Hub.

**Magalu**
1. `GET /internal/hub/listings` lendo `skus` + `stocks` (o espelho já existe).
2. Eventos: o `webhookProcess` já trata `orders_*` e `portfolios_stock`; é só publicar o evento para o Hub depois de reconciliar.
3. `POST /internal/hub/stock-writes` criando `write_operations` com origem `dach_hub` (o caminho de escrita protegida já existe; falta só a entrada sem preview manual).

**Shopee**
1. Estoque confiável: sincronizar o estoque a cada execução para os itens vinculados, ou por `reserved_stock_change`. Hoje o espelho fica defasado.
2. Escrita: trocar para `seller_stock`, gravar em lote, verificar depois (`get_model_list`), atualizar o espelho e registrar operação idempotente (seguir o padrão do Magalu).
3. Pedidos: sincronizar ao receber o push `order_status_update`, mais um polling curto (ex.: a cada 10 min) como rede de segurança, no lugar de 2× por dia.
4. Segurança: cifrar `"OAuthToken"` (hoje em texto puro) antes de dar ao Hub poder de escrita.
5. Lembrete: a conexão de lojas em produção está pausada (homologação); Shopee entra em **observação** até liberar.

### Impacto nas etapas

- **E1 (vínculos):** listings dos 3 conectores. ML e Magalu são diretos; a Shopee exige o sync de estoque confiável.
- **E3 (vendas e envio):**
  - ML: webhook de pedidos e escrita interna.
  - Magalu: só a ligação, porque o resto já existe.
  - Shopee: reescrita da escrita de estoque e pedidos quase em tempo real.
- **Ordem sugerida de ativação:** Magalu primeiro (menos trabalho e mais seguro), depois Mercado Livre, depois Shopee (quando homologar).
