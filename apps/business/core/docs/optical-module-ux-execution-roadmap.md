# Roadmap Tecnico de Execucao da Refatoracao UX do Modulo Otico

Este roadmap traduz o plano geral em ordem de implementacao dentro do frontend atual, com foco principal em `src/client/main.jsx`.

## Objetivo

Executar a refatoracao do modulo optico sem reescrever o produto inteiro de uma vez.

A estrategia e:

1. reorganizar a experiencia primeiro;
2. simplificar os fluxos centrais do operador;
3. consolidar os fluxos adjacentes;
4. so depois limpar o que sobrar de legado e sobreposicao.

## Mapa tecnico atual

Os pontos centrais do frontend hoje sao:

- `AppShell` em `src/client/main.jsx:796`
- `mapWorkspaceToAppData` em `src/client/main.jsx:474`
- `handleActionSubmit` em `src/client/main.jsx:1057`
- `PageContent` em `src/client/main.jsx:2220`
- `SalesPage` e `OpticalSalesPdv` em `src/client/main.jsx:2646` e `:2664`
- `CustomersPage` em `src/client/main.jsx:3028`
- `ProductsPage` em `src/client/main.jsx:3117`
- `InventoryPage` em `src/client/main.jsx:3287`
- `ReceivablesPage` em `src/client/main.jsx:3449`
- `CashPage` em `src/client/main.jsx:3548`
- `FinancePage` em `src/client/main.jsx:3725`
- `ServiceOrdersPage` em `src/client/main.jsx:3809`
- `OpticalPrescriptionsPage` em `src/client/main.jsx:3893`
- `SettingsPage` em `src/client/main.jsx:4272`
- `ModulesPage` em `src/client/main.jsx:4666`
- `buildModalConfig` em `src/client/main.jsx:5128`

Arquivos auxiliares de peso:

- `src/client/styles.css`

## Estrategia de execucao

### Regra 1

Cada fase deve entregar valor real ao operador, mesmo se as fases seguintes ainda nao existirem.

### Regra 2

Nao alterar o contrato do backend sem necessidade. O foco inicial e UX, navegacao, defaults, assistencia e consolidacao da interface.

### Regra 3

Quando um fluxo novo estabilizar, remover a versao concorrente ou deixar explicitamente obsoleta para evitar duplicidade mental e tecnica.

### Regra 4

Botao, formulario e hierarquia de acao fazem parte da entrega tecnica, nao sao acabamento visual para depois.

Em cada fase precisamos revisar:

- qual e a acao primaria da tela;
- quais acoes devem ficar secundarias;
- quais acoes devem virar dropdown, menu de linha ou confirmacao;
- quais formularios podem ser encurtados;
- quais campos podem nascer preenchidos.

## Camada transversal de interacao

Esta refatoracao tambem cobre explicitamente o modo de uso do sistema.

### O que revisar em toda tela

1. Botao primario
   - deve existir apenas um foco principal por tela ou por bloco operacional.
2. Botoes secundarios
   - devem apoiar o fluxo, nao disputar atencao.
3. Acoes destrutivas
   - devem perder destaque e exigir intencao clara.
4. Formularios
   - devem pedir o minimo necessario para concluir a tarefa.
5. Defaults
   - devem ser usados agressivamente para reduzir digitacao.
6. Feedback
   - o sistema deve explicar o efeito da acao antes ou logo depois da confirmacao.

### Componentes onde isso pesa mais

- `OpticalSalesPdv`
- `CustomerRegister`
- `ProductCatalog`
- `InventoryMove`
- `ReceivablesActions`
- `CashSession`
- `buildModalConfig`
- `ActionModal`
- `styles.css`

## Fase 0 - Preparacao estrutural

Objetivo:

- preparar o frontend para a refatoracao sem mudar ainda o comportamento principal.

Entregaveis:

1. Criar pequenas funcoes auxiliares internas para reduzir logica espalhada:
   - detectar venda optica
   - detectar item de estoque
   - detectar item sob encomenda
   - montar resumo operacional da venda
   - agrupar pendencias opticas
2. Normalizar nomes de grupos de navegacao e meta informacional.
3. Isolar dados de UX que hoje estao hardcoded dentro de componentes grandes.
4. Criar um criterio simples de hierarquia de botoes e formularios para reaplicar nas fases seguintes.

Componentes afetados:

- `AppShell`
- `PageContent`
- `SalesPage`
- `OpticalSalesPdv`
- `buildModalConfig`

Critério de pronto:

- o comportamento visual ainda quase nao muda;
- o codigo fica mais pronto para as fases seguintes;
- nao aumenta complexidade perceptivel para o usuario.

## Fase 1 - Reorganizar a navegacao do modulo

Objetivo:

- separar operacao diaria, gestao e configuracao.

Problema atual:

- telas de rotina e telas administrativas convivem com o mesmo peso na navegacao.

Entregaveis:

1. Reorganizar os grupos da navegacao lateral.
2. Ajustar `pageMeta` e ordem de leitura do menu.
3. Aproximar `ServiceOrdersPage` e `OpticalPrescriptionsPage` da area operacional.
4. Reduzir destaque de `ModulesPage`, `BrandingSettings`, planos e configuracoes raras.

Componentes afetados:

- `AppShell`
- `PageContent`
- configuracao de grupos de navegacao e paginas

Dependencias:

- nenhuma dependencia forte de backend.

Critério de pronto:

- um operador novo entende por onde comeca;
- um gerente encontra operacao e configuracao em grupos diferentes;
- a navegacao do modulo optico parece um sistema de trabalho e nao um showroom.

## Fase 2 - Refatorar o PDV optico

Objetivo:

- transformar a venda no centro real do modulo.

Entregaveis:

1. Melhor busca de itens no `OpticalSalesPdv`:
   - busca por nome, SKU e EAN;
   - filtros rapidos por natureza do item;
   - melhores descricoes no resultado.
2. Estado explicito de `venda comum` x `venda com pedido optico`.
3. Resumo lateral operacional:
   - venda
   - baixa de estoque
   - geracao de OS
   - geracao de pedido optico
   - pendencias criadas
4. Validacao progressiva:
   - cliente obrigatorio quando houver item optico;
   - alerta de pagamento incompleto;
   - alerta de receita, medidas e laboratorio pendentes.
5. Sugestao automatica de data prometida com base no laboratorio.
6. Presets de pagamento.
7. Hierarquizar botoes do fluxo:
   - acao primaria unica;
   - acoes auxiliares discretas;
   - remocao de competencia visual entre `Adicionar`, `Novo`, `Revisar` e `Confirmar`.

Componentes afetados:

- `SalesPage`
- `OpticalSalesPdv`
- `OptionalSaleSection`
- `InlinePrescription`
- `OpticalPrescriptionStep`
- `OpticalMeasurementsStep`
- `OpticalLaboratoryStep`
- `styles.css`

Dependencias:

- nenhuma dependencia forte de backend, desde que o payload final de venda seja preservado.

Critério de pronto:

- o operador consegue montar e concluir uma venda optica com menos mudanca de contexto;
- a tela explica melhor o que o sistema vai fazer;
- o fluxo nao depende de memorizar regra de negocio escondida.

## Fase 3 - Simplificar clientes no contexto da venda

Objetivo:

- fazer cliente servir a operacao, nao competir com ela.

Entregaveis:

1. Transformar `CustomersPage` em experiencia mais contextual:
   - lista principal
   - ficha contextual do cliente selecionado
   - credito e pendencias vinculados ao cliente selecionado
2. Reduzir protagonismo da aba `Cadastro` como fluxo separado.
3. Melhorar integracao com venda:
   - criar cliente rapido;
   - voltar para o PDV com selecao mantida;
   - mostrar ultimo pedido, ultima receita e saldo.
4. Encurtar o formulario de cliente para modo operacional e deixar o cadastro completo como camada secundaria.

Componentes afetados:

- `CustomersPage`
- `CustomerList`
- `CustomerRegister`
- `CustomerProfile`
- `CustomerCredit`
- `ActionModal`
- `buildModalConfig`

Dependencias:

- idealmente reaproveitar o modal atual de cliente;
- depende de manter refresh de workspace consistente apos cadastro.

Critério de pronto:

- o operador nao precisa navegar por quatro abas para resolver um cliente;
- o cliente certo aparece com contexto util;
- o cadastro deixa de ser uma tarefa paralela longa.

## Fase 4 - Simplificar produtos e servicos

Objetivo:

- acelerar o cadastro e deixar a classificacao optica trabalhar a favor do operador.

Entregaveis:

1. Refatorar `buildModalConfig.product` para enfatizar assistencia por tipo de item.
2. Reduzir campos simultaneos.
3. Melhorar defaults para empresa optica:
   - armacao
   - lente em estoque
   - lente encomendada
   - servico optico
   - acessorio
4. Enriquecer `ProductCatalog` com indicadores mais uteis para balcao.
5. Reduzir peso de categorias, marcas e kits como primeira experiencia do operador.
6. Reorganizar botoes e formularios do cadastro de item para trabalhar por tipo, e nao por formulario longo unico.

Componentes afetados:

- `ProductsPage`
- `ProductCatalog`
- `ProductCategories`
- `ProductBrands`
- `ProductPricing`
- `ProductKits`
- `buildModalConfig`
- `styles.css`

Dependencias:

- nenhuma mudanca obrigatoria no backend.

Critério de pronto:

- cadastrar item optico fica mais rapido;
- a classificacao optica fica mais consistente;
- o catalogo ajuda mais a vender e menos apenas a administrar.

## Fase 5 - Reescrever a experiencia de estoque como acao

Objetivo:

- trocar linguagem administrativa por linguagem operacional.

Entregaveis:

1. Separar claramente os fluxos:
   - entrada de mercadoria
   - saida sem venda
   - ajuste por contagem
2. Explicar o impacto da acao antes de confirmar.
3. Melhorar `InventoryBalance` com foco em leitura de trabalho:
   - item critico
   - item sob encomenda
   - item sem controle de estoque
4. Aproximar alertas e reposicao da rotina.
5. Transformar a escolha de `entrada`, `saida` e `ajuste` em fluxo realmente guiado, com botoes mais claros e formularios menores.

Componentes afetados:

- `InventoryPage`
- `InventoryMove`
- `InventoryBalance`
- `InventoryAlerts`
- `InventoryHistory`
- `buildModalConfig`
- `styles.css`

Dependencias:

- pode usar regras ja existentes em `settings.requireInventoryAdjustmentReason`.

Critério de pronto:

- o operador entende qual acao tomar sem ler regra abstrata;
- o estoque reflete a natureza real dos itens opticos;
- o fluxo de ajuste gera menos erro humano.

## Fase 6 - Transformar producao optica em fila de trabalho

Objetivo:

- fazer OS e pedidos opticos responderem ao que precisa ser resolvido agora.

Entregaveis:

1. Reestruturar `ServiceOrdersPage` e `OpticalWorkflow` como fila operacional.
2. Criar agrupamentos visuais por pendencia:
   - aguardando receita
   - aguardando medidas
   - aguardando laboratorio
   - pronto para producao
   - pronto para entrega
3. Exibir prazo prometido, atraso e proximo passo.
4. Melhorar acao rapida de atualizacao de status.
5. Reduzir duplicidade entre visualizar OS e acompanhar pedido optico.
6. Reforcar botoes de acao rapida na fila, evitando que cada atualizacao obrigue o operador a abrir um fluxo pesado.

Componentes afetados:

- `ServiceOrdersPage`
- `OpticalPrescriptionsPage`
- `OpticalForm`
- `OpticalWorkflow`
- `OpticalLaboratories`
- `styles.css`

Dependencias:

- usa os dados que ja chegam no `workspace`.

Critério de pronto:

- a producao deixa de ser uma lista passiva;
- as pendencias viram fila de resolucao;
- entrega e acompanhamento ficam mais evidentes.

## Fase 7 - Consolidar rotina financeira do operador

Objetivo:

- reduzir a fragmentacao entre pagamento, recebimento, caixa e contas.

Entregaveis:

1. Reposicionar `PaymentsPage` como apoio de configuracao, nao como tela operacional principal.
2. Aproximar `ReceivablesPage` e `CashPage` da rotina:
   - receber
   - depositar cheque
   - fechar caixa
   - conferir movimento
3. Deixar `FinancePage` mais gerencial e menos concorrente da rotina do operador.
4. Mapear melhor a pergunta operacional:
   - entrou no caixa?
   - ficou em aberto?
   - precisa cobrar?
5. Reorganizar a hierarquia dos botoes de `Receber`, `Depositar`, `Fechar caixa`, `Pagar`, `Cancelar` e `Conferir`.

Componentes afetados:

- `PaymentsPage`
- `PaymentMethods`
- `ReceivablesPage`
- `ReceivablesAgenda`
- `ReceivablesChecks`
- `ReceivablesActions`
- `CashPage`
- `CashSession`
- `CashConference`
- `FinancePage`

Dependencias:

- nenhuma dependencia estrutural forte, mas exige cuidado com nomenclatura e hierarquia de tela.

Critério de pronto:

- o operador entende mais rapido a diferenca entre venda recebida, recebivel pendente e caixa;
- o gerente ainda encontra a camada financeira mais ampla.

## Fase 8 - Isolar configuracao administrativa

Objetivo:

- tirar configuracoes raras da frente do operador.

Entregaveis:

1. Reduzir superficie operacional de `SettingsPage`.
2. Agrupar parametros operacionais em uma tela objetiva.
3. Empurrar branding, planos e telas para camada administrativa.
4. Reduzir o peso de `ModulesPage` para perfis que so operam.
5. Alinhar onboarding setorial e configuracao de template ao contexto de implantacao.
6. Reduzir botoes de configuracao visiveis na rotina diaria do operador.

Componentes afetados:

- `SettingsPage`
- `CompanySettings`
- `FieldsSettings`
- `RulesSettings`
- `BrandingSettings`
- `ModulesPage`
- `ModulesActive`
- `ModulesScreens`
- `ModulesPlans`
- `AppShell`

Dependencias:

- depende da nova navegacao da Fase 1.

Critério de pronto:

- um operador comum nao precisa acessar configuracao para trabalhar;
- um owner encontra parametros e templates em um lugar mais coerente.

## Fase 9 - Limpeza e remocao de sobreposicao

Objetivo:

- consolidar a nova arquitetura sem legado concorrente.

Entregaveis:

1. Remover fluxos ou componentes claramente obsoletos.
2. Reaproveitar so o que ainda tiver valor.
3. Revisar microcopy geral do modulo optico.
4. Revisar `styles.css` para eliminar classes mortas da experiencia antiga.

Componentes candidatos:

- blocos redundantes de preview ou telas demonstrativas sem uso real
- microcopy antiga que ainda fale como painel demonstrativo em vez de rotina operacional

Critério de pronto:

- um unico caminho claro por tarefa;
- menos logica concorrente no arquivo;
- manutencao futura mais segura.

## Ordem recomendada de implementacao real

### Bloco 1

- Fase 0
- Fase 1
- Fase 2

Motivo:

- gera impacto direto no coracao da operacao.

### Bloco 2

- Fase 3
- Fase 4
- Fase 5

Motivo:

- organiza os dados que alimentam a venda e a producao.

### Bloco 3

- Fase 6
- Fase 7
- Fase 8
- Fase 9

Motivo:

- consolida fila de trabalho, camada financeira e limpeza administrativa.

## Sugestao de PRs ou entregas parciais

### PR 1

- reorganizacao da navegacao
- preparacao estrutural
- pequenos ajustes de nomenclatura

### PR 2

- refatoracao do PDV optico

### PR 3

- clientes e produtos

### PR 4

- estoque e producao optica

### PR 5

- caixa, recebiveis e financeiro operacional

### PR 6

- configuracao, modulos e limpeza final

## Riscos tecnicos

1. `main.jsx` esta muito concentrado e qualquer mudanca grande aumenta risco de regressao visual.
2. Parte do estado ainda e remontada a partir de `workspace`, entao precisamos preservar coerencia entre UI local e refresh do runtime.
3. `handleActionSubmit` concentra muitas mutacoes e pode virar gargalo de regressao.
4. `buildModalConfig` hoje sustenta boa parte do cadastro; simplificar demais sem cuidado pode quebrar fluxos existentes.

## Mitigacoes

1. Implementar por fases pequenas.
2. Preservar payloads enviados ao backend.
3. Validar cada fase em empresa `general` e `optical`.
4. Sempre que possivel, preferir extrair pequenos helpers antes de reescrever blocos inteiros.

## Definicao de sucesso

A refatoracao sera bem sucedida quando:

- a venda optica for o fluxo dominante e mais simples do modulo;
- cliente, item, estoque e producao servirem a venda em vez de competir com ela;
- o operador precisar navegar menos;
- a configuracao administrativa ficar mais escondida do dia a dia;
- o modulo parecer uma operacao integrada, nao uma colecao de telas.
