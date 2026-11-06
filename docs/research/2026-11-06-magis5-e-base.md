# Magis5 e Base: funções e inspirações para o DACH Hub

Levantamento feito em 06/11/2026 **só com fontes públicas**: sites oficiais, central de ajuda pública do Magis5 (ajuda.magis5.com.br), páginas de apps na Nuvemshop e na Loja Integrada, notícias e a página de planos do Base. Ninguém da DACHBYTE tem acesso aos sistemas: o que não aparece nas fontes está marcado como "não informado".

> **Sobre o "base44":** o base44 (base44.com) não é hub de marketplaces. É um criador de aplicativos com IA (gera apps a partir de texto), comprado pela Wix em 2025. Não tem catálogo, estoque nem pedidos de marketplace. O hub com nome parecido é o **Base** (base.com, antigo BaseLinker), coberto na seção 3. Se a intenção era o base44 mesmo, a seção 4 diz onde ele poderia ajudar.

---

## 1. Resumo

| | Magis5 | Base (ex-BaseLinker) |
|---|---|---|
| **O que é** | Hub de marketplaces + ERP próprio + faturador de NF-e, brasileiro | Plataforma de gestão multicanal, polonesa, com operação no Brasil |
| **Dono** | Sankhya (compra anunciada em 16/04/2026; mantém marca e fundadores) | Independente |
| **Tamanho** | R$ 10 bi de GMV em 2025; ~110 pessoas; clientes com mais de 1 milhão de pedidos num dia; mais de 60 integrações | Mais de 30 mil empresas; 2 mil+ integrações (408 marketplaces, 394 transportadoras, 1.158 ERPs) |
| **Preço público** | Não informado ("a partir de R$ 54/mês" aparece só na loja de apps da Loja Integrada) | Não informado; 2 planos (Business, Enterprise), teste de 14 dias sem cartão |
| **Forte em** | Operação de expedição (checkout com bipagem, coletas, etiqueta unificada), NF-e, multi-CNPJ, precificação por margem, relatório de prejuízo | Motor de automações (evento → condição → ação), status personalizados, assistente de embalagem com foto, quantidade de integrações |

---

## 2. Magis5 — mapa de funções

Fonte principal: índice da central de ajuda pública (Magis5 HUB: ~200 artigos; Magis5 ERP: módulo separado).

### 2.1 Painel (Dashboard)
- **Anúncios:** pausados recentemente, estoque baixo (menos de 10), pendentes de preço (kit sem divisão de percentuais), infrações do marketplace. Cada número abre o relatório correspondente.
- **Pedidos:** hoje, mês, pendentes de importação, de preço, de expedição e de endereço.
- **Status de pedido por marketplace** (pipeline explícito):
  Pendência (anúncio não importado) → Processando → Sem Estoque (estoque mudado direto no marketplace) → Ag. Estoque → Ag. Logística → Ag. Separação → Ag. Faturamento (problema na NF) → Faturado → Ag. Envio (coleta) → Enviado → Entregue / Não entregue; Cancelado.
- **Faturamento** do dia e do mês e ticket médio; **atendimento** (perguntas e mensagens do ML); **boletim de novidades** (avisos dos marketplaces).
- "Nova Dashboard Intelligence" (BI) e o app **Magis5 Analytics**.

### 2.2 Produtos e anúncios
- Publicação em massa, por importação e "novos anúncios de um produto"; canais: ML, Shopee, Amazon, Magalu, Shein, TikTok Shop, Kwai, AliExpress, Netshoes, Casas Bahia, Americanas, Leroy Merlin.
- **Clonar produto, duplicar anúncios entre marketplaces, copiar anúncios no ML.**
- **Vincular SKU a anúncio** e **relacionar a anúncio existente** (catálogo/Buy Box); catálogo do ML; qualidade de catálogo da Amazon.
- **Kit Virtual** (ML e Shopee) e produto Kit composto. Um kit só vende se todos os componentes têm estoque.
- **Estoque mínimo / margem de segurança**, preço por variação, multiestoque, crossdocking.
- Edição em massa (imagens, descrição, dimensões); mapeamento de categorias e atributos; compatibilidade de autopeças; tabela de medidas do ML.
- Do ML especificamente: Central de Promoções, horário de despacho, infrações, qualidade do anúncio, Flex.
- Relatórios: anúncios pausados no Full, produtos com "estoque infinito", produtos que compõem kits, produtos sem anúncio.

### 2.3 Estoque
- **Monitoramento de estoque:** relatório que mostra cada movimentação e a diferença em relação ao marketplace ("para transparência": quando o estoque foi enviado).
- **Multiorigem do ML:** baixa por prioridade de depósito (prioridade 1 primeiro e, faltando, o próximo).
- Atualização de estoque pelo faturador e retorno de estoque do Bling (callback).

### 2.4 Pedidos
- Liberar pedidos em "Ag. Logística", "Combine a entrega", "Frete a combinar"; **tirar pedidos de pendência** (anúncio não importado) e **reprocessar pedidos**.
- Casos especiais: Envio Agora (ML), receita médica (ML), Full.
- **Amostras do TikTok** faturadas pelo ERP (Omie, Bling, Sankhya) ou pelo faturador.
- Logística: Mandaê, Melhor Envio, Intelipost, Frete Rápido, Correios.
- Relatórios: itens mais vendidos (por SKU e por anúncio), aguardando pagamento, sem estoque.

### 2.5 Expedição (o ponto mais forte)
- **Checkout com leitor de código de barras** em 4 modos:
  - por pedido: bipa item a item; botões para "sem código", "falha de leitura" e "falta de estoque";
  - por produto: bipa o EAN/SKU e o sistema acha o pedido;
  - por etiqueta: busca por pedido, chave da NF, rastreio ou número da nota;
  - por usuário.
- **Bloco de Separação** e **picking list**.
- **Coletas:** registro da coleta e "Embarque Coleta" (fecha cada coleta; útil com vários marketplaces/coletas no dia).
- **Etiquetas:** fila de impressão, reimpressão e **etiqueta unificada** (NF + etiqueta num documento; Shopee, ML e TikTok). Também evita pedido duplicado.
- Relatórios de envio (Correios, PLP).

### 2.6 Financeiro
- **Relatório por prejuízo:** pedidos que deram prejuízo. Total líquido = venda − comissão − frete − taxas; lucro bruto = líquido − custo (do ERP na importação). Comissões vêm direto do ML e da Shopee; nos demais canais vêm de uma tabela de margens e custos, com média de frete grátis onde o canal não informa (Americanas, Magalu).
- Relatório financeiro por pedido; cobrança por boleto.

### 2.7 Precificação
- **Automática por margens e custos:** custo do ERP + custos operacionais + margem desejada + comissão do marketplace (por categoria) + peso com embalagem (taxas por peso). Regra por produto ou por anúncio (a do anúncio vence).
- App **Preço Certo**; gestão de preços do ML; relatórios de precificação.

### 2.8 Atendimento e pós-venda
- Perguntas e mensagens do ML respondidas no Hub.
- **Reclamações e devoluções do ML:** filtros, confirmar reembolso, pedir mediação.
- No ERP: devolução de venda, vale-troca e NF-e de devolução (prazo de 24h).

### 2.9 Multi-CNPJ e "fullcommerce"
- Um login opera vários clientes (CNPJs), e **cada cliente vê só os próprios canais, lojas e pedidos** ("multiusuário anônimo").
- Estoque **centralizado** (um CD para vários clientes) ou **independente**; multiorigem e vários depósitos.
- Vários faturadores; expedição de todos os CNPJs num painel, com filtro por CNPJ.

### 2.10 ERP, fiscal e apps
- ERP próprio: cadastros, compras (entrada de XML, sugestão de compra, inventário), vendas (NF-e, PDV, orçamentos), financeiro (DRE, contas, centros de custo), relatórios e comissões.
- Integra Bling, Omie, Sankhya e "qualquer ERP com API pública"; certificado digital, série, inutilização, carta de correção, Reforma Tributária.
- **Apps pagos à parte:** Auditoria de XML, Preço Certo, Gerador de foto de kit, Magis5 Analytics.
- Relacionamento: gerente de conta exclusivo, Universidade Magis5 (centenas de aulas), selos Platinum ML e Magalu Diamante.

---

## 3. Base (ex-BaseLinker) — mapa de funções

- **Catálogo** com "depósito virtual"; importação de anúncios; anúncios com vídeo, kits e kits com variações.
- **Sincronização** de pedidos, estoque e preço em tempo real; **encerra o anúncio quando o estoque zera**.
- **Pedidos de todos os canais** (marketplace, loja, telefone, balcão) num painel; **status personalizados** (dezenas, agrupáveis).
- **Automações: evento → condição → ação.**
  - Eventos: mudança de status, eventos personalizados (atalho de teclado, botão, leitura de código de barras).
  - Ações: mudar status, enviar e-mail/SMS por modelo, emitir nota, criar envio em massa, imprimir etiqueta e documentos direto na impressora, avisar o rastreio, responder ocorrências de transporte (avaria, extravio).
  - Exemplo: marcou "embalado" → imprime etiqueta e nota sozinho.
  - Cada pedido mostra o histórico das automações executadas.
- **Assistente Pick&Pack:** guia a embalagem com leitor de código de barras, **avisa erro** e **tira foto do pacote embalado** (prova em disputa).
- **Repricer** de marketplace (Enterprise), WMS avançado, pedidos de compra, **Base Connect** (dropshipping e B2B), Base Caller (mostra o pedido ao receber ligação), Analytics e IA.
- **Planos:**
  - Business: integrações, produtos e anúncios ilimitados; equipe ilimitada; dados guardados por 24 meses.
  - Enterprise: SLA de 99,9%, gerente dedicado, integrações sob medida e repricer. Quem passa do volume do Business é movido para o Enterprise.
- Vendas: calculadora de benefícios e auditoria gratuita da conta.

---

## 4. base44 (criador de apps com IA)

- Gera aplicativos a partir de texto. Pertence à Wix desde junho de 2025 e tem SDK, CLI, integração com Zapier e MCP.
- **Não serve como base do DACH Hub:** a lógica crítica (ledger, envio com conferência, OAuth com refresh de uso único) precisa do nosso código e dos nossos testes.
- **Onde poderia ajudar:** protótipos rápidos de telas internas ou de ferramentas de apoio (calculadora de economia para vendas, formulário de onboarding), fora do produto.

---

## 5. Comparação com o DACH Hub

Legenda: ✅ já tem · 🟡 parcial · ⬜ não tem (fase prevista no roadmap)

| Função | Magis5 | Base | DACH Hub hoje | Onde entra |
|---|---|---|---|---|
| Catálogo mestre + vínculo SKU/EAN + pendências | ✅ | ✅ | ✅ (sugestão por título) | — |
| Kits / kit virtual | ✅ | ✅ | ✅ (sem kit dentro de kit) | — |
| Estoque central com histórico (ledger) | 🟡 (relatório de monitoramento) | 🟡 | ✅ (cada número com origem) | — |
| Regras: reserva, trava mínima, %, teto | 🟡 (estoque mínimo/margem) | ⬜ | ✅ (por conta e por anúncio) | — |
| Modo observação ("o que mudaria") | ⬜ | ⬜ | ✅ | **diferencial** |
| Envio conferido relendo o canal | ⬜ (não informado) | ⬜ (não informado) | ✅ (conferido/divergente) | **diferencial** |
| Estoque mudado por fora (outro sistema) | 🟡 (status "Sem Estoque") | ⬜ | ✅ (conferência, recorrência, trava de ativação) | **diferencial** |
| Pausa geral | ⬜ | ⬜ | ✅ | **diferencial** |
| Multiorigem / vários depósitos com prioridade | ✅ | ✅ (WMS) | 🟡 (tabela de locais; ML multiorigem bloqueado) | Fase 1+ |
| Pipeline de status do pedido | ✅ | ✅ (personalizável) | 🟡 (aberto/cancelado + baixa) | **Fase 3** |
| Automações evento → condição → ação | ⬜ | ✅ | ⬜ | **Fase 3** |
| Checkout com bipagem, separação, coletas | ✅ | ✅ (Pick&Pack com foto) | ⬜ | **Fase 3** |
| NF-e (faturador) e etiqueta unificada | ✅ | ✅ (emissor) | ⬜ | **Fase 3** |
| Precificação por margem e comissão | ✅ | ✅ (repricer) | ⬜ (o DACH ML já calcula margem) | **Fase 2** |
| Relatório de prejuízo por pedido | ✅ | 🟡 (Analytics) | ⬜ (o DACH ML/Magalu já têm margem) | **Fase 2** |
| Publicar, clonar e replicar anúncios entre canais | ✅ | ✅ | ⬜ | **Fase 4** |
| Perguntas, mensagens, reclamações e devoluções | ✅ (ML) | ✅ | ⬜ | **Fase 5** |
| Multi-CNPJ / agência com acesso segmentado | ✅ | 🟡 (várias contas) | 🟡 (várias contas por canal; uma empresa por login) | Novo: **modo agência** |
| ERP próprio | ✅ | 🟡 | ⬜ (não é objetivo) | Integrar Bling/Tiny/Omie |
| Integrações | 60+ | 2.000+ | 3 marketplaces; catálogo de canais pronto para lojas virtuais | Fase 5 |
| Educação e relacionamento | Universidade, gerente de conta | Academy, ativação assistida | ⬜ | Comercial |

**Leitura:**
- No **núcleo de estoque**, o DACH Hub já vai além do que os dois mostram em público: observação antes de escrever, conferência de cada envio, detecção de outro sistema escrevendo e pausa geral. Isso resolve a dor vista na D'Rossi (Tray, ANYMARKET e Hub2b brigando).
- Os dois são muito mais fortes na **operação de pedido**: expedição, nota e etiqueta, automações.
- A **margem** é onde a DACHBYTE já tem vantagem (DACH ML e DACH Magalu calculam margem por pedido). O Magis5 cobra o "Relatório de prejuízo" e o "Preço Certo" como diferencial.

---

## 6. O que trazer para o DACH Hub (prioridade)

### Agora (ajustes pequenos na Fase 1)
1. **Painel com números clicáveis**, no estilo do Magis5: anúncios com estoque baixo, sem estoque informado, vendas sem vínculo, divergências e envios com falha. Cada número leva à tela filtrada (a Saúde das contas já tem os dados).
2. **Encerrar ou pausar anúncio quando o estoque zerar** como opção de regra da conta (lição da Tray e do Base). Hoje o Hub envia 0, e alguns canais penalizam anúncio ativo zerado.
3. **"Estoque baixo"** como alerta configurável por conta (hoje o limite é fixo em 10 no Magis5).

### Fase 2 (preço e margem)
4. **Relatório de prejuízo por pedido**, reaproveitando o cálculo de margem dos módulos DACH: comissão real do ML e da Shopee, tabela de custos nos demais canais e média de frete grátis onde o canal não informa.
5. **Precificação por margem** (custo + custos operacionais + margem + comissão por categoria + peso), com regra por produto e por anúncio, como já fazemos com as regras de estoque.

### Fase 3 (central de pedidos)
6. **Pipeline de status do pedido** igual ao do Magis5 (pendência, sem estoque, ag. separação, ag. faturamento, faturado, ag. envio, enviado, entregue).
7. **Automações evento → condição → ação** no estilo do Base, com histórico no cartão do pedido. Exemplo: "embalado → imprime etiqueta e nota".
8. **Checkout com bipagem** (por pedido, por produto, por etiqueta), **coletas** e **etiqueta unificada**.
9. **Foto do pacote no checkout** (Base): prova em reclamação de "veio errado ou faltando".

### Fase 4 e 5
10. **Clonar e replicar anúncios entre canais** e "relacionar a anúncio existente" (catálogo e Buy Box).
11. **Reclamações e devoluções do ML** com reembolso e mediação, junto do atendimento unificado.

### Novo item para o roadmap
12. **Modo agência / multi-CNPJ:** um login opera várias empresas, e cada cliente vê só o que é dele. Estoque centralizado (CD compartilhado) ou independente. O modelo de tenant do Hub já isola as empresas; falta o "operador de várias empresas" com permissões por cliente. Esse público (fullcommerce) costuma ter muitos pedidos, o que combina com a cobrança por % de vendas.

### Comercial
13. **Teste grátis de 14 dias sem cartão** e **auditoria gratuita da conta** (Base). Para o Hub, a auditoria seria um relatório do modo observação: "seu estoque mudou fora do controle X vezes nesta semana".
14. **Conteúdo e educação** (Universidade Magis5, Base Academy): trilha curta "como sair de dois sistemas escrevendo estoque para um só".

---

## 7. Fontes

- Magis5: [site](https://www.magis5.com.br/), [página do Hub](https://magis5.com.br/magis5-hub-centralize-suas-vendas-marketplaces/), [central de ajuda](https://ajuda.magis5.com.br/magis5-hub), [Dashboard](https://ajuda.magis5.com.br/quais-as-fun%C3%A7%C3%B5es-dispon%C3%ADveis-no-dashboard-da-magis5), [checkout](https://ajuda.magis5.com.br/checkout), [precificação por margens e custos](https://ajuda.magis5.com.br/produtos/precifica%C3%A7%C3%A3o-autom%C3%A1tica/configura%C3%A7%C3%A3o-margens-e-custos), [relatório por prejuízo](https://ajuda.magis5.com.br/como-gerar-relatorio-financeiro-por-prejuizo), [monitoramento de estoque](https://ajuda.magis5.com.br/como-funciona-o-relat%C3%B3rio-de-monitoramento-de-estoque-magis5), [reclamações e devoluções do ML](https://ajuda.magis5.com.br/como-responder-reclamacao-e-devolucao-do-mercado-livre-no-magis5), [multi-CNPJ (Portal ERP)](https://portalerp.com/br/noticia/magis5-lanca-solucao-para-gestao-de-multiplos-cnpjs-em-marketplaces), [etiqueta unificada (Mundo Logística)](https://mundologistica.com.br/noticias/magis5-solucao-etiqueta-unificada-vendedores), [compra pela Sankhya (InfoMoney)](https://www.infomoney.com.br/?p=3295257), [app na Nuvemshop](https://www.nuvemshop.com.br/loja-aplicativos-nuvem/magis5), [app na Loja Integrada](https://lojaintegrada.com.br/loja-aplicativos/magis5).
- Base: [site](https://base.com/pt-BR/), [automação](https://base.com/pt-BR/funcionalidades/automacao/), [planos](https://base.com/pt-BR/planos/), [sobre a BaseLinker](https://base.com/pt-BR/ajuda/knowledgebase/sobre-a-baselinker/).
- base44: [site](https://base44.com), [análise (Jetadmin)](https://www.jetadmin.io/blog/base44-review/amp/), [documentação](https://docs.base44.com/sdk-getting-started/overview).
