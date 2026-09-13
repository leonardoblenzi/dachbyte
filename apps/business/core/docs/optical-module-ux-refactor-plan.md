# Plano Geral de Refatoracao UX do Modulo Otico

Este documento organiza um plano de refatoracao do modulo optico do Volt Core com foco na UX do operador.

Objetivo central:

- simplificar a rotina do balcao;
- remover etapas desnecessarias;
- reduzir mudancas de contexto entre telas;
- tornar o fluxo mais previsivel para quem vende, cadastra, recebe, movimenta estoque e acompanha a producao.

## Principio de produto

Para o operador, o modulo optico nao deve parecer um conjunto de telas isoladas.

Ele deve funcionar como uma operacao integrada:

1. identificar cliente;
2. montar itens da venda;
3. registrar o minimo tecnico necessario;
4. gerar producao sem retrabalho;
5. receber e acompanhar pendencias;
6. entregar com controle simples.

Tudo o que nao ajuda diretamente essa jornada deve sair da frente do operador.

## Leitura do estado atual

O frontend atual concentra muitas capacidades em `src/client/main.jsx`, com boa cobertura funcional, mas com muita fragmentacao de experiencia.

### O que funciona bem hoje

- o runtime ja entrega `workspace` unificado;
- o segmento optico ja influencia produtos, PDV, receitas, laboratorios e pedidos opticos;
- a venda optica ja cria pedido optico e OS automaticamente;
- o backend ja suporta configuracoes operacionais reais.

### O que esta gerando atrito

1. A operacao esta espalhada em varias abas e subabas.
2. Muitas telas existem mais como “painel demonstrativo” do que como ferramenta de rotina.
3. O modulo tem duplicidade entre cadastro, operacao e configuracao.
4. Parte da logica setorial aparece tarde demais para o operador.
5. O sistema expande capacidade, mas nao reduz decisao manual.

## Diagnostico por area

### 1. Clientes

Estado atual:

- `CustomersPage` divide em `Lista`, `Cadastro`, `Ficha` e `Credito`.
- A `Ficha` e o `Credito` usam o primeiro cliente da lista como referencia fixa.
- O cadastro existe separado da operacao de venda.

Problemas de UX:

- o operador precisa sair do fluxo de venda para resolver um cliente;
- a ficha nao e contextual;
- credito e cobranca aparecem como modulos separados cedo demais;
- o conceito de “segmento do cliente” existe, mas nao orienta nenhuma acao clara no balcao.

Direcao:

- transformar cliente em entidade de apoio rapido da venda;
- permitir cadastro resumido inline;
- mover ficha e credito para contexto do cliente selecionado;
- priorizar historico de compras, ultimo exame, pendencias e saldo em aberto.

### 2. Produtos e servicos

Estado atual:

- `ProductsPage` separa `Catalogo`, `Categorias`, `Marcas`, `Precos` e `Kits e servicos`.
- o catalogo e bom para busca, mas ainda e mais administrativo do que operacional;
- classificacao optica e forte, mas ainda depende de boa disciplina manual.

Problemas de UX:

- cadastro de produto ainda tem excesso de escolhas para quem so quer vender;
- categorias e marcas estao corretas, mas nao deveriam competir com o fluxo principal do operador;
- itens de lente, armacao, servico e acessorio ainda nao se traduzem em atalhos operacionais suficientes;
- `Kits e servicos` ainda nao participa de verdade do trabalho do balcao.

Direcao:

- tratar o cadastro como assistido por tipo de item;
- reforcar modelos prontos por natureza:
  - armacao
  - lente em estoque
  - lente sob encomenda
  - servico optico
  - acessorio
- reduzir campos visiveis conforme o tipo;
- facilitar o uso desses itens direto no PDV e na OS.

### 3. Estoque

Estado atual:

- `InventoryPage` divide em `Receber ou corrigir`, `Inventario`, `Alertas` e `Historico`.
- o fluxo de entrada/saida/ajuste existe, mas ainda e apresentado como formulario generico.

Problemas de UX:

- estoque ainda exige leitura administrativa em vez de acao operacional;
- “receber”, “saida” e “corrigir” sao tres modos importantes, mas poderiam nascer muito mais guiados;
- historico vira tela isolada, sem ajudar a resolver erro rapido;
- o operador de otica precisa entender reserva, saldo, item encomendado e item que nao baixa estoque.

Direcao:

- separar claramente:
  - entrada de mercadoria
  - saida sem venda
  - ajuste por contagem
- deixar o sistema explicar o efeito de cada acao;
- para itens opticos, mostrar natureza do item:
  - baixa estoque
  - nao baixa estoque
  - depende de laboratorio
- aproximar reposicao do catalogo e do alerta.

### 4. PDV e vendas

Estado atual:

- ja existe um PDV optico funcional;
- a venda optica agrega cliente, itens, receita, medidas, laboratorio e pagamentos;
- a revisao final ajuda, mas parte do custo mental continua com o operador.

Problemas de UX:

- busca e adicao de itens ainda podem ser mais rapidas;
- a tela ainda pede muita decisao manual;
- o resumo ainda nao traduz toda a consequencia operacional;
- a venda continua sendo o centro da experiencia, mas as telas vizinhas nao orbitam em torno dela.

Direcao:

- tratar a venda como centro do modulo;
- fazer clientes, produtos, estoque, recebiveis e producao servirem o PDV;
- transformar pendencias em desdobramentos claros da venda.

### 5. Receitas, OS e pedidos opticos

Estado atual:

- `ServiceOrdersPage` e `OpticalPrescriptionsPage` existem como areas especificas;
- pedidos opticos ja sao criados automaticamente pelo PDV;
- laboratorios tambem estao separados em tela propria.

Problemas de UX:

- parte do que aparece nessas telas ainda deveria ser “continuidade da venda”, nao “novo trabalho de navegacao”;
- receita, medidas e laboratorio ainda competem com a venda em vez de complementa-la;
- atualizacao de status de producao ainda e mais administrativa que assistida.

Direcao:

- transformar OS e pedido optico em fila de trabalho operacional;
- destacar pendencias reais:
  - receita faltando
  - medidas faltando
  - laboratorio faltando
  - prazo vencendo
  - pedido pronto para entrega
- fazer a tela de producao responder a “o que eu preciso resolver agora?”.

### 6. Financeiro, recebiveis e caixa

Estado atual:

- `ReceivablesPage`, `CashPage`, `FinancePage` e `PaymentsPage` estao separados;
- as capacidades sao corretas, mas ha fragmentacao conceitual;
- para o operador, parte disso e fluxo unico de fechamento e recebimento.

Problemas de UX:

- pagamento, recebivel, caixa e despesa aparecem em silos;
- `PaymentsPage` ainda parece mais configuracao do que rotina;
- ha muitas areas para uma mesma pergunta operacional:
  `recebi? entrou no caixa? ficou em aberto? precisa cobrar?`

Direcao:

- diferenciar dois niveis:
  - rotina do operador
  - gestao financeira
- na rotina:
  - pagamento da venda
  - recebimento de pendencias
  - caixa aberto/fechado
- na gestao:
  - recebiveis consolidados
  - despesas
  - previsao
  - conciliacao

### 7. Configuracao e setorial

Estado atual:

- `SettingsPage`, `ModulesPage`, onboarding de setor e configuracoes genericas convivem lado a lado;
- o segmento da empresa ja influencia bastante o comportamento;
- mas a exposicao da configuracao ainda e ampla demais para a rotina.

Problemas de UX:

- configuracoes operacionais, branding, campos customizados e modulos aparecem com o mesmo peso;
- muita configuracao que deveria ser de implantacao ainda compete com a area operacional;
- o setor “otica” ja muda o sistema, mas nao existe uma separacao clara entre:
  - configuracao da empresa
  - operacao do dia
  - expansoes administrativas

Direcao:

- criar uma camada clara de `implantacao e administracao`;
- esconder do operador o que e setorial, tecnico ou raramente usado;
- tratar parametros operacionais como regras de ambiente, nao como tarefa diaria.

## Proposta macro de arquitetura de experiencia

### Camada 1 - Operacao diaria

Essas sao as telas para quem atende, vende, recebe, ajusta e entrega:

1. Dashboard operacional
2. Vendas / PDV
3. Clientes
4. Produtos e servicos
5. Estoque
6. Producao optica
7. Caixa e recebimentos

### Camada 2 - Gestao

Para gerente, owner e financeiro:

1. Financeiro
2. Relatorios
3. Usuarios e permissoes
4. Auditoria

### Camada 3 - Implantacao e configuracao

Para owner, gerente ou master:

1. Empresa
2. Parametros operacionais
3. Segmento/template
4. Modulos e telas
5. Campos customizados
6. Branding

## Botoes, formularios e modo de uso

Sim, isso faz parte da refatoracao e deve ser tratado como camada propria da UX.

Hoje o modulo ainda mistura:

- botoes de acao operacional;
- botoes de configuracao;
- botoes de cadastro;
- acoes que parecem primarias, mas sao secundarias no fluxo;
- formularios longos para tarefas que deveriam ser rapidas.

Para o operador, o sistema deve ter um padrao claro de uso.

### Regras para botoes

1. Cada tela deve ter uma unica acao primaria dominante.

Exemplos:

- no PDV: `Concluir venda`;
- no estoque: `Registrar movimentacao`;
- na producao: `Atualizar etapa`;
- no recebimento: `Receber valor`.

2. Acoes secundarias devem apoiar, nao competir.

Exemplos:

- `Novo cliente`
- `Novo laboratorio`
- `Adicionar forma`
- `Ver historico`

3. Acoes destrutivas ou raras devem perder destaque visual.

Exemplos:

- desativar;
- excluir;
- cancelar;
- reverter.

4. Botoes administrativos nao devem dividir espaco com a rotina do balcao.

Exemplo:

- `Configurar`, `Editar template`, `Branding`, `Planos`, `Campos customizados` devem ficar fora do fluxo operacional.

### Regras para formularios

1. Formulario curto para tarefa rapida.

Se a acao e operacional, o formulario precisa pedir apenas o minimo necessario.

2. Campos devem aparecer por contexto.

Exemplo:

- lente em estoque nao precisa mostrar o mesmo conjunto de campos de uma lente sob encomenda;
- cliente avulso nao deve abrir ficha longa;
- ajuste de estoque so deve abrir motivo e observacao relevantes.

3. O sistema deve preencher defaults sempre que puder.

Exemplos:

- tipo de item;
- forma de pagamento mais comum;
- prazo do laboratorio;
- valores iniciais padrao;
- categoria sugerida.

4. O formulario deve explicar o efeito da acao.

Exemplos:

- `Vai baixar estoque`;
- `Vai gerar recebivel`;
- `Vai criar pedido optico`;
- `Vai deixar pendencia de receita`.

### Regras para modo de uso

1. O operador deve conseguir trabalhar por fluxo, nao por exploracao.

2. O sistema deve reduzir mudanca de contexto.

3. Tudo que puder ser resolvido inline deve ser resolvido inline.

4. O sistema deve privilegiar:

- selecao rapida;
- confirmacao objetiva;
- feedback imediato;
- continuidade da tarefa.

### Exemplos praticos que entram no escopo

1. Botoes de `Salvar`, `Continuar`, `Confirmar`, `Editar`, `Cancelar` e `Excluir` precisam ser rehierarquizados.
2. Modais de cliente, produto, laboratorio, recebivel e estoque precisam ser encurtados e guiados.
3. A navegação por abas deve ser revisada para nao obrigar o operador a “caçar” a proxima acao.
4. Atalhos operacionais devem ganhar mais destaque do que configuracoes raras.

## Plano de refatoracao por fases

### Fase 1 - Organizar a experiencia ao redor da operacao

Objetivo:

- reduzir dispersao;
- alinhar as telas ao trabalho real do operador.

Mudancas:

1. Reorganizar navegacao do modulo optico em tres grupos:
   - Operacao
   - Gestao
   - Configuracao
2. Trazer `ServiceOrdersPage` e `OpticalWorkflow` para mais perto de `SalesPage`.
3. Fazer `Recebiveis`, `Caixa` e `Pagamento` convergirem em uma experiencia de fechamento e cobranca.
4. Tirar o excesso de abas demonstrativas sem uso direto no balcao.

Arquivos principais:

- `src/client/main.jsx`

### Fase 2 - Simplificar clientes, produtos e estoque

Objetivo:

- acelerar cadastros e reduzir context switch.

Mudancas:

1. Clientes
   - cadastro rapido inline;
   - ficha contextual;
   - mostrar ultimo pedido optico, ultima receita e saldo em aberto.

2. Produtos
   - cadastro orientado por tipo de item;
   - menos campos simultaneos;
   - melhores defaults para empresa optica.

3. Estoque
   - entrada, saida e ajuste como fluxos distintos;
   - linguagem mais operacional;
   - destaque de item de estoque x item sob encomenda.

Arquivos principais:

- `src/client/main.jsx`
- `buildModalConfig` no mesmo arquivo

### Fase 3 - Consolidar PDV optico como centro do modulo

Objetivo:

- fazer o resto do sistema orbitar a venda.

Mudancas:

1. Melhor busca de itens no PDV.
2. Status explicito de venda optica.
3. Resumo operacional mais claro.
4. Validacao progressiva.
5. Sugestoes automáticas de laboratorio e prazo.
6. Presets de pagamento.

Arquivos principais:

- `OpticalSalesPdv`
- componentes auxiliares do PDV
- `styles.css`

### Fase 4 - Transformar producao em fila operacional

Objetivo:

- tornar OS e pedido optico resolutiveis sem excesso de navegacao.

Mudancas:

1. Priorizar filas por pendencia:
   - aguardando receita
   - aguardando medidas
   - aguardando laboratorio
   - pronto para enviar
   - pronto para entregar
2. Exibir prazo prometido, atraso e proximo passo.
3. Permitir acoes rapidas por linha.

Arquivos principais:

- `ServiceOrdersPage`
- `OpticalWorkflow`
- `OpticalLaboratories`

### Fase 5 - Separar rotina financeira de gestao financeira

Objetivo:

- deixar o operador focar no essencial.

Mudancas:

1. Caixa + recebimento como rotina operacional.
2. Recebiveis detalhados e despesas como camada gerencial.
3. Pagamentos como configuracao e apoio ao PDV, nao como tela concorrente da venda.

Arquivos principais:

- `PaymentsPage`
- `ReceivablesPage`
- `CashPage`
- `FinancePage`

### Fase 6 - Limpar configuracao e setorial

Objetivo:

- evitar que o operador veja opcao demais.

Mudancas:

1. Mover configuracoes de template, planos e branding para area administrativa.
2. Agrupar parametros operacionais em uma tela unica e objetiva.
3. Deixar o segmento optico configuravel sem aparecer como “decisao diaria”.

Arquivos principais:

- `SettingsPage`
- `ModulesPage`
- onboarding e navegacao do `AppShell`

## Priorizacao pratica

Se precisarmos escolher a melhor ordem para gerar valor rapido:

1. Reorganizar navegacao e papeis das telas.
2. Refatorar PDV optico.
3. Simplificar clientes, produtos e estoque.
4. Reestruturar producao optica.
5. Reunir rotina de caixa e recebimento.
6. Isolar configuracoes administrativas.

## Decisoes de UX recomendadas

1. O operador nao deve entrar em `Configuracoes` para conseguir vender.
2. O cliente deve ser criado ou encontrado sem sair do contexto da venda.
3. O produto deve ser cadastrado com assistencia por tipo.
4. Estoque deve usar linguagem de acao, nao de cadastro.
5. Pendencia optica deve aparecer como trabalho futuro claro, nao como ausencia de dado.
6. Financeiro operacional deve responder:
   - recebeu?
   - entrou no caixa?
   - ficou em aberto?
7. O setor optico deve influenciar defaults e comportamento sem exigir escolhas repetidas.

## O que pode sair da frente do operador

Estas areas devem perder protagonismo no fluxo diario:

- branding;
- planos de modulos;
- configuracao de telas;
- categorias e marcas como telas de primeira linha;
- previsao financeira detalhada;
- conciliacao, salvo para perfis especificos;
- campos personalizados em area operacional.

## Primeira entrega recomendada

Para uma primeira refatoracao com alto impacto:

1. Reorganizar a navegacao do modulo.
2. Evoluir o PDV optico.
3. Tornar clientes e produtos mais acionaveis dentro da venda.
4. Reescrever a experiencia de estoque como acao.
5. Transformar pedidos opticos em fila de trabalho.

## Conclusao

Hoje o modulo optico ja tem motor e cobertura funcional suficientes. O problema principal nao e falta de regra de negocio, e sim excesso de superficie de interface para o operador.

O plano ideal e refatorar o modulo como um sistema centrado em operacao:

- venda no centro;
- cadastro como apoio;
- estoque como efeito controlado;
- producao como fila clara;
- financeiro como continuidade simples;
- configuracao isolada do dia a dia.
