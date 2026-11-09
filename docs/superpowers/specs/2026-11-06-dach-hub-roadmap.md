# DACH Hub — roadmap completo

**Status:** planejamento (nenhuma conta em produção definida) · **Data:** 06/11/2026
**Documentos relacionados:**
- Mapa de funções da Tray: `docs/research/2026-11-06-tray-mapa-de-funcoes.md`
- Desenho detalhado da Fase 1: `docs/superpowers/specs/2026-11-06-dach-hub-fase1-design.md`

---

## 1. O produto

**DACH Hub** é um hub de marketplaces: o seller cadastra o produto uma vez e opera estoque, preço, pedidos, anúncios e atendimento de todos os canais num lugar só. Por baixo, ele usa a inteligência que a DACHBYTE já tem (margem por pedido, custos, curva ABC, estoque em risco).

**É:**
- Catálogo mestre (SKU DACH) ligado aos anúncios de cada canal.
- Estoque central com baixa automática.
- Preço por canal com regra de margem.
- Central de pedidos (status, NF, etiqueta, expedição).
- Publicação multicanal e atendimento unificado.

**Não é:**
- Loja virtual (vitrine, checkout, pagamentos). Lojas como Tray, Nuvemshop e Shopify entram como **mais um canal**.
- Emissor fiscal próprio. A NF vem de um ERP ou emissor parceiro integrado.
- ERP financeiro.

**Canais na largada:** Mercado Livre, Magalu e Shopee, conectados **pelo próprio Hub** (apps próprios em cada marketplace), sem depender dos módulos DACH ML, DACH Magalu e DACH Shopee. Os próximos estão na Fase 5.

**Visual:** segue o padrão do módulo Mercado Livre, como todos os módulos Seller (ver seção 12).

**Diferencial contra a Tray e outros hubs:**
- Decisão com dinheiro: margem por pedido e por canal, preço com trava de margem, estoque cruzado com vendas e cobertura.
- Segurança de escrita: tudo passa por modo observação, verificação depois de enviar e auditoria.
- Os módulos profundos de cada canal (ML com Full, promoções, Product Ads; Magalu com campanhas e fiscal) continuam disponíveis junto.

---

## 2. Cobrança: % sobre vendas

**Modelo**
- Percentual sobre o **valor vendido nos canais** (GMV dos pedidos aprovados e não cancelados), apurado por mês. Referência de mercado: a Tray cobra de 0,4% a 1,25% conforme o plano.
- Faixas decrescentes por volume. Exemplo para validar: 1,0% até R$ 100 mil/mês, 0,7% até R$ 500 mil e 0,4% acima.
- **Mínimo mensal** para cobrir o custo de infraestrutura e suporte de contas pequenas (valor a definir).
- **Cancelamento e devolução** dentro do mês saem da base; depois do fechamento, entram como crédito no mês seguinte.

**Como medir** (aproveitando o Hub de cobrança)
- O Hub já tem **pós-pago mensal** (`src/modules/postpaid/*`), medição de pedidos por recurso (`/v1/internal/resources/orders/measurement` → `seller_postpaid_order_measurements`, contando só `order_count`) e faturas no Asaas.
- **O que falta no Hub:**
  1. a medição passar a aceitar **`gmv_cents`** (e `cancelled_gmv_cents`) por recurso e mês;
  2. um modelo de preço **percentual em faixas** no cálculo da fatura (`quoteService` / `cycleRunner`);
  3. um **extrato de pedidos cobrados** no portal (a Tray tem esse relatório), para o cliente conferir.
- **Fonte do GMV:** `hub.orders` (Fase 3; na Fase 1, `hub.channel_orders`). Fechamento mensal no fuso de São Paulo, igual ao pós-pago atual.
- **Pré-requisito:** todos os pedidos precisam estar salvos. Hoje o **ML não salva pedidos**; isso é resolvido na Fase 1 (etapa E3).

**Riscos**
- Divergência entre o GMV que o Hub mede e o que o cliente vê no canal. Mitigação: extrato por pedido e regra explícita de qual valor conta (com ou sem frete; sugestão: **sem frete**).
- Cliente que usa o Hub só para estoque, sem vender por ele: a base continua sendo o GMV dos canais conectados, e o mínimo mensal protege.

---

## 3. Visão das fases

| Fase | Entrega principal | Depende de | Tamanho |
|---|---|---|---|
| **1. Catálogo mestre e estoque central** | SKU DACH, vínculos, ledger de estoque, kits, regras por canal, baixa automática, reconciliação | — | G |
| **2. Gestor de anúncios** (seção 15) | Produto mestre controla preço, título, descrição, fotos e ficha dos anúncios já existentes, com reflexo nos canais; regra de preço por conta e anúncio | 1 | G |
| **3. Central de pedidos** | Pedidos de todos os canais normalizados, status e automações, NF via ERP, etiquetas, expedição e base da cobrança | 1 | G |
| **4. Publicação multicanal** | Cadastro mestre completo, mapeamento de categoria e atributo, criar anúncios em lote, fila de correção | 1 (2 ajuda) | G |
| **5. Atendimento e novos canais** | Caixa única de perguntas, mensagens e reclamações; mensagens automáticas; novos conectores | 3 | G |
| **Transversal** | Acesso pelo login único da DACHBYTE (seção 14), permissões, auditoria, notificações, relatórios, mobile, observabilidade | contínuo | — |

Ordem recomendada: **1 → 3 → 2 → 4 → 5** (revisada em 09/11/2026; acesso pelo login único na seção 14, gestor de anúncios na seção 15).
- A Fase 3 vem antes da 2 porque a cobrança por % depende da central de pedidos.
- Pedidos são o dia a dia que prende o cliente.
- Preço por canal já tem ferramentas parciais nos módulos.

---

## 4. Fase 1 — Catálogo mestre e estoque central (resumo)

O detalhe está em `2026-11-06-dach-hub-fase1-design.md`.
- **App e conectores:** app `apps/seller-hub` (schema `hub`) com **conectores próprios** (apps próprios no ML, no ID Magalu e na Shopee; OAuth, tokens cifrados e webhooks no Hub). Os módulos DACH ML, Magalu e Shopee são só referência de código; não há dependência entre eles.
- **Vínculo anúncio ↔ SKU:** automático por SKU e EAN, com filas de "anúncios sem vínculo" e "vendas sem vínculo".
- **Estoque:** ledger com kits e regras por conta e por anúncio (igual, fixo, %, teto, trava mínima, reserva).
- **Segurança:** modo observação, depois ativação por conta; reconciliação detecta quem escreve estoque por fora.
- **Etapas:** E1 vínculos → E2 estoque em observação → E3 vendas e envio real → E4 reconciliação e piloto.
- **Ativação dos canais:** Magalu → ML → Shopee (depois da homologação).

---

## 5. Fase 2 — Preço por canal

**Objetivo:** o seller define a margem que quer e o Hub calcula e mantém o preço certo em cada canal, considerando a comissão e os custos de cada um, sem nunca vender abaixo do mínimo.

**Funções**
- **Regra em cascata:** conta → categoria → anúncio (o mais específico vence), como "regra da conta" e "regra do anúncio" na Tray.
- **Modos da regra:**
  - igual ao preço mestre;
  - acréscimo ou desconto em % ou R$ (como na Tray);
  - **margem alvo**: o preço é calculado para atingir X% de margem depois de comissão, tarifa fixa, frete, imposto e custo.
- **Custos:**
  - custo único por SKU em `hub.items`, com histórico;
  - importação dos custos que já existem: ML `ml.mercadolivre_sku_costs` (por conta), Magalu `magalu.sku_costs`, Shopee `"Product"."costCents"` (por item).
  - Em conflito, o usuário escolhe a fonte.
- **Tabela de tarifas por canal e tipo de anúncio:**
  - comissão (ex.: ML Clássico/Premium por categoria), tarifa fixa e frete obrigatório (ML soma o custo de envio calculado);
  - os valores vêm dos conectores sempre que a API informa; senão, de uma tabela mantida pela DACHBYTE.
- **Ajustes finais do preço:** arredondamento (`,90` / `,99`), preço mínimo (trava de margem) e preço máximo.
- **Promoção:** preço promocional com período. As promoções do próprio canal (campanhas ML e Magalu) continuam nos módulos; o Hub só **respeita** e não sobrescreve preço de campanha ativa.
- **Sincronismo seletivo:** por anúncio, "sincronizar preço" liga ou desliga, como na Tray.
- **Pré-visualização:** antes de aplicar, mostra a lista "preço atual → novo → margem resultante", com alerta de margem negativa.

**Dados**
- `hub.item_prices`: preço base, promocional e período.
- `hub.price_rules`: escopo, modo, valores, arredondamento, mín./máx.
- `hub.channel_fee_tables`: canal, tipo de anúncio, categoria, comissão, tarifa fixa e regra de frete.
- `hub.price_pushes`: o mesmo padrão de `stock_pushes`.

**Conectores do Hub (escrita de preço)**
- **Magalu:** API de preço do portfólio, no padrão `write_operations` (referência: escrita protegida de preço do DACH Magalu).
- **ML:** `PUT /items/{id}` de preço com verificação, no padrão da escrita de estoque.
- **Shopee:** `update_price` em lote, com verificação.

**Telas:** regras de preço; simulador por SKU e canal (reaproveita as calculadoras de ML e Magalu); fila de mudanças e histórico; alertas de margem.

**Reaproveitamento:** calculadora e margem do ML (`financeiroMlService`), calculadora e margem do Magalu (`magaluPricingEngine`, `uxAnalyticsRepository.marginOverview`) e tarifas já usadas nesses módulos.

---

## 6. Fase 3 — Central de pedidos

**Objetivo:** todos os pedidos de todos os canais numa tela, com o fluxo pago → faturado → enviado → entregue e as ações de cada canal sem precisar entrar nele.

**Funções**
- **Pedido normalizado** em `hub.orders` / `hub.order_items`, com itens ligados ao SKU DACH, valores (produto, frete, comissão, líquido) e prazo "enviar até".
  - **Status canônico:** novo · pago · faturado · pronto para envio · enviado · entregue · cancelado · devolvido.
  - O status original do canal fica guardado.
- **Lista:**
  - filtros no padrão da Tray: canal, conta, status, período, prazo de envio, SKU, cliente, código no canal, NF, rastreio, impresso, cupom;
  - colunas configuráveis e exportação.
- **Detalhe:** linha do tempo, itens, valores e margem do pedido (diferencial DACHBYTE), dados fiscais, envio e histórico do canal.
- **Status personalizados e automações** ("regras e fluxos"):
  - condição: canal, status, forma de envio, pago, NF presente, rastreio presente, prazo vencendo;
  - ação: trocar status, avisar a equipe (e-mail ou notificação), marcar para separação, chamar um webhook.
- **Fiscal:**
  - integração com ERP ou emissor (Bling, Tiny, Omie, e o Emissor de NF-e da Tray onde fizer sentido) para emitir NF a partir do pedido;
  - envio da NF ao canal pelos conectores do Hub (referência: NF-e e finalização do DACH Magalu; ML e Shopee precisam do upload/envio fiscal).
- **Etiquetas:** baixar etiquetas em lote por canal (ML/Mercado Envios, Shopee logística, Magalu Entregas) e impressão agrupada.
- **Expedição:**
  - lista de separação (picking) por SKU e local;
  - conferência por bipagem (integração futura com o VoltStock);
  - pedidos atrasados e prazo vencendo;
  - rastreio em lote para canais com envio próprio (como "Pedidos a enviar" da Tray).
- **Estoque e cobrança:** cada pedido gera os movimentos da Fase 1 e entra na medição de GMV (seção 2).

**Conectores do Hub**
- **ML:** pedidos chegam pelo webhook `orders_v2` do app do Hub (Fase 1) e são salvos em `hub.orders`; ações de NF, etiqueta e envio.
- **Magalu:** webhooks de pedido e entrega do client do Hub; NF-e e finalização (referência: DACH Magalu).
- **Shopee:** push de pedido + polling curto; `ship_order`, documento de envio e etiqueta.

**Telas:** Pedidos (lista e detalhe); Expedição (separação, etiquetas, atrasados); Automações; Integrações fiscais; Extrato de pedidos cobrados.

**Etapas e andamento**
- **P1 — Base da central (feito, migração 006):**
  - situação padronizada nos três canais (novo, pago, faturado, pronto para envio, enviado, entregue, cancelado, devolvido) com a situação original guardada;
  - valores (produtos, frete, descontos, tarifas, líquido estimado), prazo de envio, transportadora, rastreio e comprador (nome, cidade/UF);
  - linha do tempo do pedido (recebido, mudanças de situação, baixa e devolução de estoque);
  - lista com filtros (situação, conta, período, busca por pedido/SKU/comprador/rastreio/NF, atrasados, vence em 24h, sem vínculo), contadores clicáveis e exportação CSV; detalhe do pedido;
  - **Vendas do mês:** base da cobrança (produtos sem frete, fuso de São Paulo), fechamento diário dos meses passados (`hub.gmv_closings`, 03:00) e crédito de cancelamento feito depois do fechamento; extrato pedido a pedido.
  - Pendente para cobrar de fato: o Hub de cobrança aceitar `gmv` na medição e o preço em faixas (seção 2).
- **P2 — Status internos e automações (feito, migração 007):**
  - status internos da empresa (nome e cor) e etiquetas livres nos pedidos; troca manual em lote ou no detalhe;
  - automações **quando → se → então**:
    - quando: pedido recebido, situação mudou (opcionalmente para uma situação), status interno mudou, prazo de envio vencendo em N horas, prazo vencido, execução manual (botão);
    - se (todas): canal, conta, situação, status interno, logística, Full, rastreio, NF, sem vínculo, valor, quantidade, SKU, UF, etiqueta;
    - então: mudar status interno, pôr/tirar etiqueta, avisar a equipe (página Avisos e alertas), chamar webhook https assinado (`X-DachHub-Signature`, sem endereços internos);
  - cada regra roda uma vez por ocorrência; encadeamento limitado a 3; histórico por regra e na linha do tempo do pedido; modelos prontos;
  - varredura de prazo a cada 10 min no worker.
- **P3 — Expedição (feito, migração 008):**
  - **Separação:** fila de pedidos pagos ainda não conferidos (prazo mais curto primeiro; Full fica fora); lote de separação com lista somada por produto, kits abertos nos componentes, imprimível; fechar o lote devolve à fila o que não foi conferido.
  - **Conferência com leitor de código de barras:** por pedido (bipa número, rastreio ou NF e depois os itens por EAN/SKU) ou por produto (bipa o item e o Hub acha o pedido de 1 unidade mais urgente); "sem código +1" para item sem etiqueta; aviso para item a mais, item de fora, pedido cancelado, Full ou já enviado; bipes de acerto/erro; problema na conferência ("falta no estoque") fica no pedido.
  - **Foto do pacote** (celular ou webcam), reduzida no navegador e guardada no pedido (prova em reclamação).
  - **Coletas:** embarque por bipagem (só pedido conferido, sem repetir), romaneio imprimível com assinaturas, fechar coleta = entregue à transportadora.
  - Novo gatilho de automação **"pedido conferido"**; tudo registrado na linha do tempo do pedido.
  - Quem opera o depósito usa a expedição sem ser administrador; desfazer conferência exige administrador.
- **P4 — Etiquetas por canal (feito, migração 009):** documentação oficial conferida em 06/11/2026.
  - **ML:** `GET /shipment_labels?shipment_ids=…&response_type=pdf|zpl2` (até 50; envio `ready_to_ship`/`ready_to_print`; "buffered" só libera na data indicada).
  - **Magalu:** `POST /seller/v1/logistics/shipping-labels` (canal + entregas, PDF ou ZPL) → link temporário do arquivo + rastreio; exige o escopo `open:order-logistics-seller` (contas conectadas antes precisam **reconectar**).
  - **Shopee:** rastreio (envio já programado) → `create_shipping_document` → `get_shipping_document_result` (READY) → `download_shipping_document`; PDF A4 ou térmica A6 (Shopee não tem ZPL).
  - Um arquivo por conta (o canal devolve o próprio PDF/ZPL); lote recusado é refeito pedido a pedido; falha explicada por pedido; Full, cancelado e já enviado não pedem etiqueta.
  - O rastreio devolvido pelo canal é gravado no pedido; impressão registrada na linha do tempo; arquivos guardados por 7 dias para reimprimir (limpeza diária no worker).
  - Telas: imprimir na Separação (selecionados), no lote e no pedido; página Etiquetas com os lotes recentes.
  - Pendente: programar o envio da Shopee (`ship_order`: coleta ou postagem) pelo Hub; hoje o envio precisa estar programado no painel da Shopee.
- **P5 — Fiscal:** NF via ERP (Bling primeiro) e envio da NF ao canal.

---

## 7. Fase 4 — Publicação multicanal

**Objetivo:** criar e manter anúncios em vários canais a partir do cadastro mestre, sem refazer o trabalho em cada um.

**Funções**
- **Cadastro mestre completo:** título, descrição, imagens e vídeo, EAN, marca, modelo, dimensões e peso da embalagem, garantia, variações (cor, tamanho e outras) e **atributos por canal** (como "Altura Amazon" e "Altura Mobly" na Tray).
- **Mapeamentos por conta:**
  - categoria mestre ↔ categoria do canal;
  - atributo mestre ↔ atributo do canal (com unidades);
  - variação mestre ↔ variação do canal.
- **Criar anúncios em lote:**
  1. escolher a conta e o tipo de anúncio (ex.: ML Clássico/Premium);
  2. selecionar os produtos "aptos" (com o mínimo exigido pelo canal);
  3. revisar (título por canal, preço pela regra da Fase 2, estoque pela regra da Fase 1);
  4. publicar.
- **Catálogo do canal:** sugerir catálogos existentes (ML catálogo, Shopee) e completar a ficha técnica.
- **Fila "aguardando correção":** falha ao criar, infração, moderação, ficha incompleta, com motivo e ação de corrigir. Correção sugerida por IA (a Tray já ensaia um "auto-fix").
- **Sincronismo seletivo pós-publicação:** descrição, imagens, ficha, preço e estoque, liga/desliga por anúncio.
- **Importar anúncios existentes** para criar ou completar o mestre (caminho inverso).
- **Multiplicar** anúncios entre contas do mesmo canal.

**Reaproveitamento:** cadastro, clonagem, características, validar dimensões e modelo em massa do ML; catálogo e gestão de SKU do Magalu; produtos da Shopee.

**Dados:** `hub.item_media`, `hub.item_attributes`, `hub.category_maps`, `hub.attribute_maps`, `hub.publication_jobs` / `publication_items` (estado por anúncio, motivo de falha).

---

## 8. Fase 5 — Atendimento unificado e novos canais

**Atendimento**
- **Caixa única:**
  - perguntas pré-venda, mensagens pós-venda e reclamações/mediações de todos os canais;
  - filtros por canal, conta, status e prazo de resposta (SLA).
- **Respostas prontas por categoria** e "responda rápido" (fila uma a uma), como no ML da Tray.
- **Sugestão de resposta por IA** com dados do produto e do pedido (o envio é sempre confirmado por uma pessoa).
- **Mensagens automáticas por evento do pedido:** pago, NF emitida, enviado (com rastreio), entregue; respeitando as regras de cada canal (ex.: restrições do ML para Mercado Envios).
- **Reclamações:** prazo do canal em destaque, anexos e histórico.
- **Relatórios:** tempo de resposta, volume por dia e por atendente, impacto na reputação.

**Novos canais** (priorizar por demanda dos clientes)
1. **Amazon**: grande alcance; envio próprio e FBA.
2. **MadeiraMadeira, Mobly e Leroy Merlin**: casa e móveis, alinhados ao perfil de vários clientes atuais.
3. **Americanas e Casas Bahia (Via)**.
4. **TikTok Shop, Shein e Temu**: canais novos em crescimento.
5. **Lojas virtuais como canal** (Tray, Nuvemshop, Shopify): o Hub sincroniza estoque, preço e pedidos com a loja do cliente.

**Arquitetura dos novos canais**
- Em vez de criar um módulo completo para cada um, criar **conectores leves dentro do `seller-hub`** com uma interface comum:
  - `listListings`
  - `writeStock`
  - `writePrice`
  - `listOrders`
  - `orderActions`
  - `publish`
  - `inbox`
- Cada conector usa sua própria fila e respeita o limite de requisições do canal.
- ML, Magalu e Shopee seguem a mesma interface, implementados como conectores do próprio Hub. Os módulos DACH continuam independentes, como produtos à parte.

---

## 9. Transversal

- **Permissões:** matriz por área (ver, editar, excluir, exportar), como a Tray, reaproveitando o padrão de permissões por módulo já usado no Seller (ML e Magalu). O papel administrador (Hub) vê tudo.
- **Auditoria:** toda escrita nos canais e toda alteração de regra fica registrada (quem, quando, antes e depois).
- **Notificações:** venda sem vínculo, divergência de estoque, falha de envio, margem negativa, pedido atrasado, reclamação aberta. No painel e por e-mail; WhatsApp como opção futura.
- **Relatórios:** vendas e margem por canal, conta e SKU; ritmo do mês; estoque em risco; extrato cobrado.
- **Visual e mobile:** padrão do Mercado Livre (seção 12). Pedidos, expedição e atendimento precisam funcionar bem no celular.
- **Observabilidade:** painel interno de filas (atrasos, falhas, reprocessos por conector) e alertas para a equipe DACHBYTE.
- **Segurança:**
  - tokens de canal cifrados em todos os módulos (a Shopee hoje grava em texto puro);
  - tokens dos canais cifrados no Hub (AES-256-GCM) com renovação sob lock por conta (o refresh do ML é de uso único);
  - modo observação obrigatório antes de qualquer escrita nova.
- **API pública e webhooks** (futuro): permitir que ERPs e parceiros leiam e escrevam no Hub.

---

## 10. Marcos sugeridos (sem datas)

1. **M1 — Hub em observação:** Fase 1 até E2. Catálogo, vínculos e "o que mudaria" no estoque, sem escrever.
2. **M2 — Estoque ativo:** Fase 1 completa no Magalu e no ML; reconciliação.
3. **M3 — Pedidos e cobrança:** Fase 3 com NF via ERP e etiquetas; Hub de cobrança medindo GMV; primeira fatura por %.
4. **M4 — Preço por canal:** Fase 2.
5. **M5 — Publicação:** Fase 4.
6. **M6 — Atendimento e primeiro canal novo:** Fase 5 com Amazon ou MadeiraMadeira.

---

## 11. Decisões em aberto

1. **Percentuais, faixas e mínimo mensal** da cobrança, e se o frete entra na base (sugestão: não).
2. **ERP fiscal parceiro** da Fase 3: Bling primeiro (muito usado pelos sellers), depois Tiny e Omie.
3. **Primeiro canal novo** da Fase 5.
4. **Nome comercial** e posição no portal: DACH Hub como produto próprio, ou "camada" que vem junto com os módulos Seller.
5. **Clientes que usam outros hubs:** o onboarding exige escolher um único sistema para estoque e preço por conta (ver Fase 1, riscos).
6. **Estoque físico:** quando integrar ERP e/ou VoltStock como fonte do saldo físico.
7. **Modo agência / multi-CNPJ** (inspirado no Magis5): um login operando várias empresas, cada cliente vendo só o que é dele, com estoque centralizado ou independente. Qual fase e se entra na cobrança por %.

---

## 12. Padrão visual: igual ao Mercado Livre

**Regra:** o DACH Hub tem a mesma **estrutura e comportamento** do módulo Mercado Livre (layout, menu, componentes, tipografia, espaçamentos, mobile), para que todos os módulos Seller pareçam um produto só. Quem usa o ML abre o Hub e já sabe navegar. **A cor é a única coisa que muda:** cada produto pode ter uma variação de tema, e o Hub usa um **tom de roxo próprio** (seção 12.5).

### 12.1 O que é reaproveitado do ML

| Elemento | Referência no ML | Uso no Hub |
|---|---|---|
| **Shell** | `public/js/ml-shell.js` + `public/css/ml-shell.css` | Menu lateral com categorias em card (ícone, título, dica) que abrem subitens; recolher no desktop; gaveta com ☰ no celular; seletor de conta com iniciais e conta padrão (pin) |
| **Barra superior** | `renderTopbar` | Breadcrumb e título da página; tema claro/escuro; status; sino com central de alertas (Hoje/Histórico); ajuda; sair. No celular, uma linha só com o menu "⋯" (como já está no ML) |
| **Tokens de cor e tema** | variáveis `--ml-shell-*`, `ml-master-theme.css`, `ml-ui-v3.css` | Os mesmos raios, sombras, fontes e cores de estado (verde, âmbar, vermelho). As **cores de marca** vêm do tema do produto: roxo no Hub (seção 12.5), com claro e escuro |
| **Cabeçalho de página** | hero card (kicker, título, descrição, ações) | Todas as telas |
| **Indicadores** | painel do ML (`painel.js` / `painel.css`): KPIs com variação e **hover comparativo** (`renderComparison`) | Painel do Hub, estoque, pedidos, cobrança |
| **Prioridades** | lista "O que merece atenção agora" com impacto em R$ | Pendências, divergências, vendas sem vínculo |
| **Cards de métrica e risco** | "Comercial e resultado", "Sinais operacionais" | Visão geral, saúde da sincronização |
| **Tabelas e filtros** | tabelas em card com rolagem própria; filtros em card | Catálogo, movimentos, pedidos, fila de envios |
| **Carregamento e processos** | `ml-loading` ("Atualizando dados" com %) e painel "Processos" (`jobs-panel.js`) | Importações, publicação em lote, envios de estoque e preço |
| **Modais, toasts, estados vazios** | padrões do ML | Iguais |

### 12.2 Como implementar sem copiar

O Magalu reimplementou o visual do ML num CSS próprio (`magalu-ml-parity.css` e vários arquivos de ajuste em cima). Funciona, mas cada mudança no ML precisa ser refeita à mão e os módulos vão se afastando com o tempo. O Hub **não deve repetir isso**.

1. **Extrair um pacote compartilhado `apps/shared/seller-ui/`:**
   - `seller-shell.css`: tokens, layout, menu lateral, barra superior, gaveta mobile, tema escuro.
   - `seller-shell.js`: o shell **configurável**. O ML hoje tem a navegação (`NAV_GROUPS`), as contas, os créditos, o status e os alertas fixos no código; isso passa a vir de uma configuração:
     ```js
     DachSellerShell.mount({
       product: "hub", basePath: "/hub",
       navGroups: [...],                 // categorias e itens do produto
       accounts: { endpoint, label },    // seletor de contas
       topbar: { credits: false, status: "/hub/api/health/sync", alerts: "/hub/api/alerts" },
     });
     ```
   - `seller-components.css` / `.js`: KPI com hover comparativo, lista de prioridades, cards, tabelas, filtros, modal, toast, carregamento e painel de processos.
2. **Servir uma vez só**, pelo gateway e Caddy, em `/seller-ui/*` com versão no endereço (`?v=`), para todos os módulos usarem o mesmo arquivo.
3. **Ordem de adoção:**
   1. **DACH Hub** nasce usando o pacote.
   2. **ML** passa a carregar o pacote, com a mesma aparência de hoje (validar com capturas antes/depois em desktop e 375 px).
   3. **Magalu** troca os CSS de paridade pelo pacote, aos poucos, tela por tela.
   4. **Shopee** por último (hoje tem layout próprio e não tem gaveta no celular).

### 12.3 Navegação do DACH Hub (mesmo formato de categorias do ML)

| Categoria | Itens |
|---|---|
| **Visão geral** | Painel |
| **Catálogo** | Produtos · Pendências (anúncios sem vínculo, vendas sem vínculo) · Kits |
| **Estoque** | Saldos · Movimentos · Inventário · Regras por canal · Sincronização |
| **Pedidos** (Fase 3) | Pedidos · Expedição · Automações |
| **Preços** (Fase 2) | Regras · Simulador · Alterações |
| **Publicação** (Fase 4) | Criar anúncios · Aguardando correção · Mapeamentos |
| **Atendimento** (Fase 5) | Caixa de entrada · Respostas prontas · Mensagens automáticas |
| **Conta** | Contas conectadas · Usuários · Plano e extrato de cobrança · Integrações · Ajuda (mesmo formato da seção Conta do ML e do Magalu) |

Itens de fases ainda não entregues não aparecem no menu.

**Barra superior do Hub:**
- No lugar de "Tokens", mostra o **consumo do mês** (vendas medidas e % do plano).
- O chip de status mostra a **saúde da sincronização** (Operacional / Atenção / Pausado).

### 12.4 Checklist visual de toda tela nova

- [ ] Usa o shell e o cabeçalho de página do pacote; nenhuma cor ou espaçamento fora dos tokens.
- [ ] Funciona no claro e no escuro.
- [ ] Testada em 375 px: nada mais largo que a tela; filtros em até 2 colunas; tabelas com rolagem própria; botões de ação acessíveis.
- [ ] Indicadores com comparação ao período anterior no hover, quando houver período.
- [ ] Textos em pt-BR com acentos; status traduzidos (nunca `delivered`, `partial` etc. na tela); nada de IDs técnicos (UUID) no lugar de nomes.
- [ ] Carregamento longo usa o overlay com %; processo longo aparece no painel "Processos".

### 12.5 Tema de cor do Hub: Violeta DACH

**Como funciona:** o pacote `seller-ui` separa os tokens em duas camadas.
- **Base**, igual para todos os módulos: estrutura, raios, sombras, tipografia e cores de estado (sucesso, alerta, erro).
- **Tema do produto**, que troca só as cores de marca: botão principal, links, item ativo do menu, destaques, gradiente do cabeçalho e tons da superfície.

O tema é escolhido no `mount` e aplicado em `<html data-seller-theme="violet">`:

```js
DachSellerShell.mount({ product: "hub", theme: "violet", /* ... */ });
```

```css
:root[data-seller-theme="violet"] { --seller-brand-500: #7550E3; /* ... */ }
:root[data-seller-theme="violet"][data-theme="dark"] { /* variante escura */ }
```

O ML continua no azul atual (`theme: "blue"`) e outros módulos podem ganhar a sua variação depois, sem mexer na estrutura.

**Referência e diferença.** A inspiração é o roxo de marcas do segmento, como a Mamba, mas com outra personalidade:

| | Mamba (referência) | Violeta DACH |
|---|---|---|
| Tom | roxo saturado e quente, com brilho neon magenta | **violeta mais frio e azulado**, sóbrio, sem neon |
| Destaque | **amarelo** nos botões | **menta/turquesa** só em pequenos destaques; botões em violeta |
| Uso | fundo roxo cheio, fotos e glow | superfícies claras e limpas (ou grafite-violeta no escuro); o roxo aparece em pontos de ação e no cabeçalho |
| Sensação | marketing, energia | ferramenta de gestão: confiável, calma, precisa |

**Paleta proposta** (validar no protótipo):

| Token | Claro | Escuro | Uso |
|---|---|---|---|
| `--seller-brand-50` | `#F4F1FE` | `#1C1533` | fundo de item ativo, chips suaves |
| `--seller-brand-100` | `#E9E2FD` | `#251C45` | hover suave, seleção |
| `--seller-brand-300` | `#B39CF6` | `#5C46A8` | bordas de foco, gráficos secundários |
| `--seller-brand-500` | `#7550E3` | `#9C82F5` | **principal**: botões, links, item ativo, ícones de destaque |
| `--seller-brand-600` | `#5F3BCB` | `#B4A0F8` | hover/pressionado do principal, títulos de destaque |
| `--seller-brand-800` | `#37217A` | `#E3DBFD` | texto sobre fundo violeta claro |
| `--seller-accent` | `#22C7A9` | `#3EDCC0` | destaque pontual: "novo", badges de sincronizado, marcador do ritmo do mês |
| `--seller-accent-soft` | `#E3FAF5` | `#0F2E2A` | fundo do destaque |
| `--seller-bg` | `#F7F6FB` | `#120D22` | fundo da página |
| `--seller-surface` | `#FFFFFF` | `#1A1330` | cards, menu, barra superior |
| `--seller-surface-soft` | `#FAF9FE` | `#221A3D` | cards internos, linhas zebradas |
| `--seller-border` | `#E6E1F5` | `rgba(167,139,250,.16)` | bordas |
| `--seller-text` | `#1E1836` | `#EEEAFB` | texto principal |
| `--seller-muted` | `#6E6890` | `#A79FC4` | texto secundário |
| `--seller-hero-gradient` | `linear-gradient(135deg,#5F3BCB 0%,#7550E3 55%,#4F6BE8 100%)` | igual, com 85% de opacidade | faixa do cabeçalho, logo, botão principal do painel |

As cores de estado **não mudam** entre temas (verde = bom, âmbar = atenção, vermelho = problema), para que um alerta tenha o mesmo significado em todos os módulos.

**Regras de uso**
- O roxo é para **ação e identidade** (botões, links, item ativo, cabeçalho), não para pintar a tela inteira.
- O menta é **raro**: no máximo um ponto de destaque por bloco. Nunca para botões nem para indicar erro ou sucesso.
- Contraste mínimo AA: texto branco sobre `brand-500` e `brand-600`; texto `brand-800` sobre `brand-50`.
- Gráficos usam a escala violeta (`300` → `600`) com o menta como série de comparação.
- Os comparativos no hover seguem as cores de estado: variação positiva em verde e negativa em vermelho.

**Próximo passo de design:** montar um protótipo de 3 telas do Hub (painel, catálogo e pendências) no tema Violeta, claro e escuro, em desktop e 375 px, e comparar lado a lado com o ML azul antes de fechar os tokens.

### 12.6 Menu lateral e marca do Hub (padrão ML, em roxo)

O menu lateral é **o mesmo do Mercado Livre**, peça por peça. Só as cores seguem o tema Violeta.

**Estrutura (de cima para baixo)**
1. **Botão de recolher** no topo (desktop). No celular, o menu vira **gaveta** aberta pelo **☰ (sanduíche)** da barra superior, com fundo escurecido; toque fora ou Esc fecha.
2. **Cartão de marca:**
   - ícone da DACHBYTE na **versão roxa** (`/brand/dachbyte/hub/mark.svg`: mesmo desenho do Seller, com gradiente violeta `#5F3BCB` → lilás `#9C82F5` → menta `#22C7A9` e pontos `#B39CF6`);
   - título **DACHBYTE**;
   - subtítulo **Hub · Marketplaces** na cor de marca (no ML é "Seller · Mercado Livre" em laranja; no Hub, violeta `#7550E3`).
3. **Seletor de conta/empresa** (ex.: nome da empresa em caixa, com seta), igual ao do ML.
4. Rótulo **CATEGORIAS**.
5. **Categorias em card:**
   - ícone em quadradinho, título em negrito, dica de uma linha e seta (›) à direita;
   - ao abrir, a seta vira (⌄) e os subitens aparecem **dentro do card**, em linhas com borda;
   - o item ativo tem a **barrinha vertical à esquerda** na cor de marca;
   - só uma categoria aberta por vez; o estado fica salvo.
6. **Rodapé** com a frase do produto, ex.: "Catálogo, estoque, pedidos e preços de todos os canais em um só fluxo."
7. **Recolhido** (desktop): só os ícones das categorias, com o nome no hover.

**Cores do menu no tema Violeta**
| Parte | Claro | Escuro |
|---|---|---|
| Fundo do menu | `#FFFFFF` | `#1A1330` |
| Card da categoria | `#FFFFFF`, borda `#E6E1F5` | `#1A1330`, borda `rgba(167,139,250,.16)` |
| Quadradinho do ícone | fundo `#F4F1FE`, ícone `#5F3BCB` | fundo `#251C45`, ícone `#B4A0F8` |
| Categoria aberta / ativa | borda `#B39CF6`, fundo `#FAF9FE` | borda `#5C46A8`, fundo `#221A3D` |
| Barrinha do item ativo | `#7550E3` | `#9C82F5` |
| Título / dica | `#1E1836` / `#6E6890` | `#EEEAFB` / `#A79FC4` |

**Categorias do DACH Hub (ícones Tabler, o mesmo set do ML)**
| Ícone | Categoria | Dica | Subitens |
|---|---|---|---|
| `layout-dashboard` | Visão geral | Painel e saúde | Painel · Sincronização |
| `package` | Catálogo | Produtos e vínculos | Produtos · Pendências · Kits |
| `stack-2` | Estoque | Saldos e regras | Saldos · Movimentos · Inventário · Regras por canal |
| `receipt` | Pedidos *(Fase 3)* | Vendas e expedição | Pedidos · Expedição · Automações |
| `tag` | Preços *(Fase 2)* | Regras e margem | Regras · Simulador · Alterações |
| `upload` | Publicação *(Fase 4)* | Anúncios em lote | Criar anúncios · Aguardando correção · Mapeamentos |
| `messages` | Atendimento *(Fase 5)* | Perguntas e mensagens | Caixa de entrada · Respostas prontas · Automáticas |
| `user` | Conta | Acesso e integrações | Contas conectadas · Usuários · Plano e extrato · Integrações · Ajuda |

Categorias de fases ainda não entregues não aparecem no menu.

## 13. Inspirações de mercado: Magis5 e Base

Estudo completo em `docs/research/2026-11-06-magis5-e-base.md`, feito só com fontes públicas.

- **Onde o DACH Hub já é melhor:** observação antes de escrever, conferência de cada envio, detecção de outro sistema escrevendo estoque e pausa geral. Nenhum dos dois mostra isso em público.
- **Onde eles são mais fortes:** operação de pedido (checkout com bipagem, coletas, etiqueta unificada, NF-e) e automações evento → condição → ação (Base).
- **Entradas no roadmap:**
  - Fase 1+: painel com números clicáveis; pausar ou encerrar o anúncio que zera; alerta de estoque baixo.
  - Fase 2: relatório de prejuízo por pedido e precificação por margem, aproveitando o cálculo de margem dos módulos DACH.
  - Fase 3: pipeline de status do pedido, automações, checkout com bipagem e foto do pacote, coletas, etiqueta unificada.
  - Fase 4/5: clonar e replicar anúncios entre canais; reclamações e devoluções do ML.
  - Comercial: teste de 14 dias sem cartão e "auditoria" da conta a partir do modo observação.

---

## 14. Acesso ao DACH Hub: login único da DACHBYTE (decidido em 09/11/2026)

**Decisão:** o DACH Hub **não tem login próprio**. É mais um produto da DACHBYTE: mesma conta, mesma senha e mesma sessão dos módulos. O que permite assinar só o Hub, só os módulos ou os dois é a **liberação por produto** no hub de acessos, não o login. (A página `/hub/login` com sessão própria chegou a ser feita e foi retirada no mesmo dia.)

**Como funciona**
- Entrada pelo `/login` da DACHBYTE; depois do login, a pessoa escolhe o Hub na seleção de plataforma.
- Abrir o Hub sem estar logado leva ao `/login`.
- A cada acesso, o Hub pergunta ao hub de acessos se a empresa e o usuário podem usar o produto (`POST /v1/access/check`, módulo `dach_hub`, ação `ACCESS dach_hub`), com cache de 45 s. Quem não contratou volta para a seleção de plataforma (`?module=dach_hub_unavailable`). Hub de acessos fora do ar = não entra.
- `HUB_ALLOWED_TENANTS` fica como reserva enquanto o produto `dach_hub` não existe no hub de acessos; a equipe da plataforma (`HUB_PLATFORM_ADMIN_EMAILS`) sempre entra.
- "Sair" no Hub sai da DACHBYTE (sessão única).

**No hub de acessos (pendente, repositório `hub pagamento`):** cadastrar o produto `dach_hub` para liberar e contratar o Hub pelo portal.

**Seleção de plataforma (proposta, aguardando aprovação):**
- Início: só os produtos contratados, agrupados por categoria.
- Módulos: contratados (com plano) e disponíveis (para contratar).
- Categorias:
  - **Gestão multicanal**: DACH Hub (o gerenciador).
  - **Inteligência por marketplace**: Mercado Livre, Magalu, Shopee e MadeiraMadeira.
  - **Marketing**: DACH Ads.
- SKU Leader, Tracking e DavanttiLog deixam de ser oferecidos; o alcance da retirada para quem já usa está em aberto.

---

## 15. Gestor de anúncios (pedido de 09/11/2026)

**Objetivo:** como na Tray, o produto é controlado no DACH Hub. O seller muda preço, título, descrição, fotos e ficha no Hub, e a mudança vai para todos os anúncios vinculados nos canais. Absorve a Fase 2 (preço) e a parte "sincronismo pós-publicação" da Fase 4. Criar anúncios novos continua na Fase 4.

**Princípios (os mesmos do estoque)**
- Modo observação primeiro: o Hub mostra "o que mudaria" em cada anúncio antes de escrever.
- Sincronismo **por campo e por anúncio** (preço, título, descrição, fotos, ficha), liga/desliga, como na Tray.
- Toda escrita é conferida relendo o anúncio no canal; mudança feita por fora vira divergência (mesma tela da reconciliação).
- Escrita só nas empresas do piloto (`HUB_WRITE_TENANTS`), com pausa geral.

**Etapas**
1. **G1 — Produto mestre completo e importação do conteúdo:** título, descrição, fotos (ordem e capa), marca, modelo, EAN, dimensões e peso, garantia e atributos. Para não começar do zero, o Hub puxa o conteúdo dos anúncios já vinculados e o seller escolhe o anúncio "fonte" de cada produto.
2. **G2 — Preço:** preço do produto (de/por) e regra por conta e por anúncio: igual, acréscimo ou desconto em % ou R$, arredondamento, mínimo e máximo. Prévia "preço atual → novo" e envio com verificação nos três canais (ML `PUT /items/{id}`, Magalu preço do portfólio, Shopee `update_price`). Margem alvo e tabela de tarifas entram depois, reaproveitando as calculadoras de ML e Magalu.
3. **G3 — Conteúdo:** título, descrição, fotos e ficha para os anúncios vinculados, respeitando as travas de cada canal:
   - ML: título não muda em anúncio com venda; anúncio de catálogo não troca fotos nem título; descrição vai em `/items/{id}/description`.
   - Magalu: alteração de SKU pode passar por moderação; o Hub acompanha até aprovar ou recusar.
   - Shopee: foto precisa ser enviada antes pela API de upload de imagem; título e descrição pelo `update_item`.
4. **G4 — Divergências de preço e conteúdo:** releitura periódica; mudança feita no canal aparece para o seller escolher "manter a do canal" ou "voltar a do Hub".

**Dados:** `hub.item_media` (fotos do produto, ordem), `hub.item_content` (campos mestres e anúncio fonte), `hub.item_prices`, `hub.price_rules`, `hub.listing_sync_settings` (campo × anúncio), `hub.content_pushes` e `hub.price_pushes` (mesmo padrão de `stock_pushes`).

**Decisão em aberto:** onde guardar as fotos. O ML busca a foto por URL pública, então o Hub precisa servi-las por HTTPS. Opções: disco do servidor servido pelo próprio Hub (mais simples para começar) ou armazenamento de objetos (Cloudflare R2 ou S3, melhor para volume).

## 16. Análise por canal e custos da empresa (pedido de 09/11/2026)

Desenho completo em `2026-11-09-dach-hub-analise-e-custos-design.md`. Resumo:
- **Área "Análise"** com fórmulas aproveitadas do antigo Price: A1 vendas e mais vendidos por canal e conta (só dados do Hub), A2 margem por canal (custos + taxas reais), A3 Ads e caixa, A4 preço (junto do gestor de anúncios, §15).
- **Hub como fonte única do custo**: custo no item do Hub (SKU da empresa; vínculo por EAN, SKU ou manual), com histórico por data de vigência, extras por canal e alíquota por conta. Cada módulo pode ligar "Usar custos do DACH Hub" (primeira vinculação sempre manual, pela tela de Integrações do módulo, só para quem tem o Hub contratado); com o vínculo ativo, o custo só é editado no Hub e o módulo fica somente leitura. Sem Hub, o módulo segue com o próprio cadastro.
- Implantação gradual: publicar o Hub, custos e A2 no Hub, vínculo em um módulo piloto, depois os demais.
