# Tray — mapa de funções (referência para o DACH Hub)

Levantamento feito em 06/11/2026 no painel real da loja D'Rossi (plano **Ultra**, loja 475075), navegando tela por tela, só leitura. Dados de clientes foram omitidos de propósito.

> **Efeito colateral do levantamento:** no Hub Magalu da Tray, o botão "Importar anúncios" disparou uma importação dos anúncios do Magalu para a Tray (tela passou a mostrar "Importando anúncios, aguarde..."). Não altera o Magalu; pode gerar itens em "Aguardando correção / anúncio não relacionado".

---

## 1. Visão geral da arquitetura da Tray

A Tray é uma **loja virtual com um catálogo mestre**, cercada por três camadas de canais:

| Camada | Como funciona | Canais |
|---|---|---|
| **Mercado Livre nativo** | Módulo antigo e muito completo (`/mvc/adm/meli/...`), com multi-conta ("apelidos") | Mercado Livre (D'Rossi: 4 apelidos — DROSSI INTERIORES, DIPLANY, ROSSI DECOR, DMOV) |
| **Hub da Tray** (`hub-app`, app 4553) | App novo e único para vários canais: anúncios, contas, preço, categorias, atributos, frete, pedidos pendentes, etiquetas. O mesmo hub também serve a Bagy | Magalu, Shopee, TikTok Shop, Temu, Amazon, Centauro, Dafiti, MadeiraMadeira, Shein, Uniclube (e logos de AliExpress, Americanas/B2W, Carrefour, Casas Bahia/Via, Elo7, GPA, Kabum, Leroy, Mobly, Netshoes, Olist, Renner, WebContinental) |
| **Integrações antigas/apps** | Apps separados por canal | Americanas, Casas Bahia, Netshoes (app 1), Renner/Camicado, Leroy Merlin, MadeiraMadeira, Mobly, Colombo, KaBuM! |

A D'Rossi ainda usa por fora **Hub2b, ANYMARKET, Bling ERP, Intelipost, Kangu e Jadlog**, ou seja, nenhum sistema sozinho cobre toda a operação. O app **Davantti** (DACHBYTE) também aparece instalado.

Números da loja no Hub: Magalu com 10.012 anúncios ativos, 425 pausados e 87 aguardando correção; Shopee com 1.337 ativos, 2.108 pausados e 176 aguardando correção.

Plano Ultra: produtos e usuários ilimitados (49.666 produtos, 49 usuários), comissão sobre vendas em marketplaces de até 0,4%.

---

## 2. Catálogo mestre (Produtos)

**Cadastro do produto**
- Identificação: código, referência, EAN/GTIN/UPC, marca, modelo, garantia, itens inclusos e mensagem adicional.
- Conteúdo: nome (200 caracteres), imagens e vídeo com requisitos, descrição rica.
- IA: gerar descrição, gerar SEO, listar características e "otimizar descrição para IAs".
- Preço: preço de venda, preço de custo, preço promocional com período, "preço sob consulta".
- Estoque: estoque, unidade, estoque mínimo com notificação de estoque baixo, prazo de disponibilidade e ação quando o estoque acaba.
- Logística: peso e dimensões da embalagem (base do frete); produto físico ou digital.
- Variações (opções) com recurso de cores.
- **Características da categoria**: na D'Rossi são 101, incluindo atributos específicos de canal ("Altura Amazon", "Altura Mobly", "AssemblyRequired"). O cadastro mestre já guarda os atributos que cada marketplace exige.
- Status "ativo", que vale para a loja, os marketplaces e as integrações ao mesmo tempo; "exibir na loja" é separado.
- Organização: categoria principal e adicionais, selos (destaque, lançamento, adicional), SEO.
- Painel lateral do produto: estoque atual, quantidade vendida, últimos 10 pedidos (90 dias), histórico de alterações e atalho para "Anúncios do Mercado Livre" daquele produto.

**Gestão do catálogo**
- **Lista de produtos**:
  - filtros por código, nome, status, categoria, faixa de preço, estoque e atributos;
  - colunas de preço, estoque, vendas, custo, EAN, disponibilidade e peso/dimensões;
  - edição rápida na própria lista e histórico de exclusões.
- **Kits**: o estoque do kit é calculado a partir dos itens que o compõem; a lista mostra preço, estoque e quantidade vendida.
- **Categorias** (árvore): cada categoria define o formulário de características dos seus produtos, tem regras de imposto (B2B), termo de aceite, SEO e descrição com IA.
- **Características**, **Marcas**, **Informações adicionais** (com prazo adicional de entrega) e **Guia de tamanhos**.
- **Atualização em lote**:
  - abas Valores, Promoções, Categorias, Estoque, Selos, Frete grátis, Restrições, Parcelamentos e Logs;
  - em preços: base de venda, custo em R$ ou custo em US$; multiplicador ou acréscimo em % ou R$; aplicar nas variações e nas promoções; arredondamento; faixa de preço; filtro de produtos.
- **Relatórios**: produtos cadastrados, projeção de vendas por produto, mais vendidos, mais cancelados e marcas mais vendidas.

---

## 3. Hub de marketplaces (`hub-app`)

**Por canal**
- **Contas**: até 10 contas por canal; status de conexão; regra de preço por conta; histórico de alterações e de exclusões.
- **Regra de precificação** (por conta, e sobrescrevível por anúncio):
  1. Manter o preço sincronizado com a loja? Sim (atualiza sempre) ou não (gerencia manualmente no canal).
  2. Como precificar? Igual à loja, ou com acréscimo/desconto.
  3. **Calculadora de preços**: base de cálculo mais margem adicional em R$ ou %. Exemplo real na Shopee: "preço de venda + R$ 4,00".
- **Relacionamento de categorias**: categoria da loja ligada à categoria do canal (192 categorias na D'Rossi, com filtro de relacionadas e não relacionadas).
- **Relacionamento de características**: atributo do canal ligado à característica da loja.
- **Frete e envio** por conta: quais formas de envio usar e "palavras restritas" para excluir formas de envio.

**Anúncios**
- **Publicados**:
  - KPIs de ativos e pausados;
  - filtros por código da loja, código do canal, nome, status (ativo, pausado, em revisão, conta removida, excluído do canal, em reativação), conta, estoque e faixa de preço no canal;
  - a linha mostra lado a lado **preço, promoção, período e estoque no canal × na loja**, a regra de preço aplicada e o status;
  - ações: editar regra de preço, histórico de alteração e mais ações.
- **Em processamento**: anúncios criando ou aguardando aprovação do canal.
- **Aguardando correção**, com contadores por motivo:
  - anúncio não relacionado a produto;
  - falha ao criar;
  - infrações no canal.

  Ações: corrigir, excluir e relacionar. Há indícios de **correção automática com IA** ("ai-auto-fix").
- **Criar anúncio** (publicação em massa a partir do catálogo):
  1. escolher a conta;
  2. selecionar produtos "aptos para anunciar" (filtros e filtros personalizados, até 1.000 de uma vez);
  3. revisar os anúncios;
  4. "Publicar anúncios".
- **Revisão de catálogo**: sugere catálogos já existentes no canal para o produto, completa a ficha técnica e checa restrições antes de publicar.
- **Relacionamento inteligente** (smart-relations: encontrados, erro, manual): casa automaticamente anúncios importados com produtos da loja.
- **Importar / Exportar anúncios**, **sincronização de preço**, **campanhas de preço** (rota existe, mas não está habilitada para esta loja) e **wizard** de ativação do canal (autenticação, importação, conclusão).

**Pedidos**
- **Pedidos não inclusos** ("vendas pendentes"): vendas cujo anúncio não está relacionado a um produto não viram pedido nem baixam estoque até alguém relacionar.
- **Geração de etiquetas de marketplaces** em lote, a partir dos pedidos selecionados.

---

## 4. Mercado Livre nativo (módulo mais completo)

**Atalhos**: vendas aguardando produto, perguntas, mensagens não lidas, reclamações abertas, anúncios incompletos (ficha técnica), perdendo relevância, ativos e com falha.

**Anúncios**
- **Lista**:
  - agrupada por família de anúncio (modelo "user products");
  - colunas de qualidade, experiência de compra, preço/tipo e status;
  - filtros de status (14 situações), tipo (Premium, Clássico, Grátis) e estoque (igual à loja, fixo, Fulfillment);
  - filtro de ficha técnica: catálogo, moderação, compatibilidades, desconto, ganhando ou perdendo catálogo, imagem de baixa relevância, perdendo relevância, sincronização pausada;
  - filtro de aplicação de preço;
  - ações: editar, desvincular, multiplicar e exportar CSV.
- **Editar anúncio**:
  - qualidade (% e objetivos) e produto vinculado;
  - **regra de preço**: fixo, igual à loja, acréscimo ou desconto em % ou R$, com base no custo ou na venda;
  - somar automaticamente o custo de envio do ML;
  - **preço de atacado** (até 5 faixas, para PJ);
  - estoque igual à loja ou fixo;
  - tipo do anúncio com a comissão exibida (ex.: 16,5%);
  - ficha técnica completa, embalagem, formas de entrega e template de descrição;
  - **sincronismo após publicação**, escolhendo o que sincroniza: descrição, fotos/vídeo, ficha técnica, preço, estoque/disponibilidade.
- **Variações relacionadas**: variação da loja ligada à variação do ML, por categoria.
- **Importar e relacionar** anúncios existentes, **Multiplicar** (alterando frete e preço, ou entre apelidos) e **Templates** (de descrição e de configuração).
- **Central de Promoções** por apelido: Oferta Relâmpago, Assessorada, Campanhas Inteligentes, Preços Competitivos, Flexível do Vendedor, Cupom da loja e Cupom exclusivo.
- **Problemas**: anúncios moderados e pausados.

**Atendimento**
- Perguntas: filtros e "Responda rápido".
- Categorias de perguntas e respostas pré-cadastradas.
- Mensagens pós-venda: em andamento ou arquivadas, até 3.500 caracteres.
- **Mensagens automáticas por evento do pedido**: incluído, pendente, pagamento capturado, NF gravada, rastreio inserido; com variáveis e por tipo de envio.
- **Reclamações**: por tipo e status, com prazos, interações, anexos e "escrever para o ML".
- Clientes bloqueados.
- Relatórios de perguntas por dia e por atendente.

**Logística e configurações**
- Configurações gerais:
  - integração de estoque;
  - autoconfirmação de pedidos;
  - relacionamento automático por nome;
  - pausar o anúncio quando o produto fica indisponível;
  - frete grátis como desconto;
  - garantia padrão;
  - preservar o preço fixo.
- Envio:
  - centro de distribuição do ML ligado ao CD da loja (MultiCD);
  - Flex/Turbo;
  - frete dinâmico;
  - **capacidade de expedição** (janelas por dia da semana e por apelido);
  - envios em pontos facultativos;
  - transportadoras ME1;
  - acompanhamento de entrega ME1.

---

## 5. Pedidos (central única)

- **Lista de pedidos**:
  - KPIs no topo; exportar; pedido manual; confirmar pagamento;
  - **40 filtros**: canal de venda, código do pedido no marketplace, apelido do ML, prazo máximo de envio, status de pagamento e de envio, nota fiscal, cupom, UTM, parceiro, pedido impresso, entre outros;
  - o prazo "Enviar até" aparece na lista.
- **Status personalizáveis** (41 na D'Rossi, padrão e personalizados, incluindo status por canal, como os da MadeiraMadeira e os de NF do ML).
- **Regras e fluxos (automação)**:
  - condições: status, canal, forma de frete, forma de pagamento, pagamento confirmado, rastreio presente;
  - ações: trocar status e enviar e-mail ao cliente ou à equipe, com variáveis.
- **Detalhe do pedido**:
  - linha do tempo, cliente com pedidos anteriores, afiliado, UTM;
  - edição de itens, desconto e frete;
  - **dados fiscais** (XML DANFE, número, série, chave, URL);
  - pagamentos com comprovante;
  - envio com endereço, forma de envio e rastreio;
  - observações internas;
  - históricos do pedido, do gateway e de cancelamento.
- **Pedidos a enviar** (expedição): preencher rastreio em lote e "Enviar" (notifica o cliente); exportar para o Endereçador Correios e para o SIGEP.
- **Clientes** unificados: compradores de marketplace entram com o e-mail mascarado do canal.
- **Relatórios**: vendas, **canal de vendas**, formas de pagamento, resultado econômico por categoria, extrato de pedidos cobrados, pedidos excluídos, produtos por pedido; também clientes, por local e por ticket médio.

---

## 6. Demais áreas

- **Marketing**:
  - cupons, descontos, promoção em lote, oferta relâmpago por hora, brindes;
  - carrinhos abandonados, avise-me, avaliações, fidelidade, cashback, afiliados, lista de presentes;
  - e-mail e WhatsApp marketing, Live Shop;
  - Google/Meta/TikTok Ads, Facebook/Instagram Shop, feed XML;
  - relatórios de visitas, conversão, buscas com e sem resultado e campanhas.
- **Configurações**:
  - usuários com **matriz de permissões** (visualizar, adicionar, editar, excluir, exportar por área), 2FA e histórico;
  - frete (integração externa, tabelas por CEP, taxas e adicionais por forma de envio);
  - **impostos** (alíquotas por estado, fórmulas, aplicação por tipo de cliente);
  - notificações por área, SEO, domínios, e-mails, layout e textos.
- **Ecossistema próprio**: Pagamentos (Vindi, antifraude), Tray Envios (etiquetas), Emissor de NF-e (não ativado na D'Rossi), PDV (loja física), loja de temas e mais de 2.000 apps.

---

## 7. O que isso ensina para o DACH Hub

| Lição | Por quê | DACHBYTE hoje |
|---|---|---|
| **O catálogo mestre é o centro** e carrega atributos por canal | Na Tray, publicar, preço, estoque e pedidos dependem do produto da loja | Falta: cada módulo tem o seu catálogo |
| **Relacionamento anúncio ↔ produto** com fila de pendências e casamento automático | "Não relacionado" trava pedido e estoque; a Tray tem relacionamento inteligente, pedidos não inclusos e aguardando correção | Falta |
| **Regra de preço em cascata**: conta → anúncio, com sincronizar sim/não e base + margem | Simples para o lojista e cobre 90% dos casos | Parcial: ML tem ferramentas de preço; sem regra unificada |
| **Sincronismo seletivo por anúncio** (o que sincroniza) | Evita sobrescrever ajustes feitos no canal | Falta |
| **Mapeamentos explícitos**: categoria, atributo, variação e frete por conta | É onde a publicação multicanal quebra | Parcial: só no ML (características, dimensões) |
| **Publicação em massa** (até 1.000) com revisão e sugestão de catálogo | Ganho de escala | Parcial: ML tem cadastro e modelo em massa |
| **Central de pedidos com 40 filtros, status personalizáveis e automação** | É o dia a dia da operação | Falta a central única; Magalu já tem NF-e e finalização |
| **Expedição**: rastreio em lote, etiquetas, capacidade de expedição | A D'Rossi usa Intelipost, Kangu e Jadlog por fora | Falta |
| **Atendimento**: respostas prontas, responda rápido, mensagens automáticas por evento, reclamações com prazo | O módulo ML da Tray é forte aqui | Parcial |
| **Promoções do canal sem sair do painel** | Já é padrão de mercado | Tem no ML e no Magalu |
| **Onde a Tray é fraca** | Relatórios operacionais, não estratégicos; nenhuma margem por pedido ou por canal no Hub; a loja ainda precisa de Hub2b, ANYMARKET e Bling | **Vantagem da DACHBYTE**: margem por pedido, custos, curva ABC, ritmo do mês, estoque em risco |

**Conclusão:** o DACH Hub não precisa copiar a loja virtual da Tray. Ele precisa de:
- **catálogo mestre** com atributos por canal;
- **relacionamento** entre anúncio e produto, com fila de pendências;
- **regra de preço** em cascata (conta → anúncio);
- **estoque central** com regras por canal;
- **central de pedidos** com automação.

Em cima disso entra a inteligência de margem e decisão que a DACHBYTE já tem e a Tray não tem.
