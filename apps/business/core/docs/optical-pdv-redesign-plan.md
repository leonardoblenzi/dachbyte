# Plano de Redesign do PDV Optico

Este documento transforma a analise da UX atual em um plano objetivo de execucao para o PDV optico do Volt Core.

## Objetivo

Reduzir o esforco do operador no balcao e tornar a venda optica mais guiada, rapida e previsivel, sem perder a flexibilidade do motor atual.

Resultado esperado:

- menos cliques para montar uma venda;
- menos decisoes manuais no fluxo de receita, medidas e laboratorio;
- mais clareza sobre o que o sistema vai criar ao confirmar a venda;
- menos erros descobertos apenas no fim da operacao.

## Estado atual

O fluxo ativo de venda optica esta concentrado em:

- `OpticalSalesPdv` em `src/client/main.jsx`;
- `OptionalSaleSection` e `InlinePrescription` no mesmo arquivo;
- `OpticalPrescriptionStep`, `OpticalMeasurementsStep` e `OpticalLaboratoryStep` como blocos reutilizaveis;
- `handleActionSubmit` como ponte entre frontend e runtime;
- `ActionModal` e `buildModalConfig` como suporte para cadastros auxiliares.

Pontos fortes atuais:

- o fluxo ja entende quando a venda vira optica;
- o motor permite receita agora, receita existente ou pendencia;
- a venda ja cria pedido optico e OS automaticamente;
- pagamento misto ja esta pronto no frontend.

Gargalos atuais:

- busca e adicao de itens ainda e lenta para balcao;
- a tela muda de comportamento sem explicar ao operador;
- pendencias opticas ficam difusas;
- laboratorio e promessa de entrega ainda sao muito manuais;
- validacoes criticas aparecem tarde demais;
- o fluxo legado foi substituido pelo PDV otico modularizado.

## Direcao de UX

O PDV optico deve funcionar como um fluxo assistido.

Em vez de o operador montar tudo manualmente e descobrir problemas no final, a tela deve:

- identificar o tipo da venda logo no inicio;
- conduzir o usuario por blocos na ordem operacional;
- sugerir valores e estados padrao;
- avisar imediatamente o que falta;
- explicar com clareza o que sera criado ao confirmar.

## Estrutura recomendada

Manter o fluxo principal em uma unica tela, mas organizado em cinco blocos operacionais:

1. Cliente
2. Itens
3. Receita e medidas
4. Producao e entrega
5. Pagamento e confirmacao

Essa estrutura preserva a flexibilidade da versao atual, mas reduz a carga cognitiva.

## Prioridade de implementacao

### Fase 1 - Quick wins de alto impacto

1. Melhorar a adicao de produtos no PDV optico

Problema:

- hoje o operador depende de `select` e filtro por categoria.

Mudanca:

- trocar o seletor principal por busca digitavel;
- permitir localizar por nome, SKU e EAN;
- destacar categorias rapidas: `Armacoes`, `Lentes`, `Servicos`, `Acessorios`;
- mostrar detalhes mais uteis no resultado: nome, sku, categoria, tipo optico, preco e status de estoque.

Componentes para mexer primeiro:

- `OpticalSalesPdv` em `src/client/main.jsx`;
- estilos ligados a `.optical-product-adder`, `.optical-cart` e `.sale-category-filter` em `src/client/styles.css`.

2. Explicitar quando a venda se torna optica

Problema:

- a tela detecta venda optica automaticamente, mas nao explica isso com clareza.

Mudanca:

- criar um banner ou pill de status: `Venda comum` ou `Venda com pedido optico`;
- quando o modo optico ativar, explicar o motivo:
  `Esta venda inclui armacao, lente ou item classificado como optico. O sistema criara pedido optico e OS.`

Componentes para mexer:

- `OpticalSalesPdv`;
- estilos do resumo lateral e novo bloco de status.

3. Melhorar o resumo operacional

Problema:

- o resumo mostra totais e modos, mas nao deixa claro o efeito da venda.

Mudanca:

- adicionar checklist dinamico:
  - `Criar venda`
  - `Baixar estoque`
  - `Criar pedido optico`
  - `Criar ordem de servico`
  - `Gerar pendencia de receita`
  - `Gerar pendencia de medidas`
  - `Gerar pendencia de laboratorio`

Componentes para mexer:

- `OpticalSalesPdv`;
- modal de revisao final no mesmo componente;
- estilos de `.pending-summary` e `.sale-review`.

4. Validacao progressiva

Problema:

- varias validacoes so aparecem em `openReview()` e `finish()`.

Mudanca:

- exibir alerta de cliente obrigatorio assim que item optico entrar no carrinho;
- exibir alerta de pagamento incompleto em tempo real;
- avisar quando nao houver receita, medida ou laboratorio definidos, mesmo antes da revisao final.

Componentes para mexer:

- `OpticalSalesPdv`;
- funcoes `openReview` e `finish`.

### Fase 2 - Fluidez do fluxo optico

5. Melhorar o bloco de receita

Problema:

- a receita existente hoje oferece pouco contexto para escolha.

Mudanca:

- enriquecer opcoes do select com data, medico e resumo de OD/OE;
- destacar a receita mais recente;
- mostrar preview curto da receita escolhida;
- quando `existing`, limpar ou ocultar campos de receita nova de forma mais clara.

Componentes:

- `OpticalSalesPdv`;
- `OpticalPrescriptionStep`;
- `InlinePrescription`.

6. Melhorar o bloco de medidas

Problema:

- os campos sao corretos, mas secos e sem apoio.

Mudanca:

- adicionar placeholders e microcopy;
- alertar medidas improvaveis;
- permitir copiar `DP total` como base;
- destacar quais medidas sao mais relevantes para laboratorio.

Componentes:

- `OpticalMeasurementsStep`;
- estilos de `.optical-fields-grid` e `.inline-alert`.

7. Tornar laboratorio e prazo mais inteligentes

Problema:

- o sistema mostra o prazo do laboratorio, mas nao usa isso para sugerir entrega.

Mudanca:

- ao selecionar laboratorio, sugerir `promisedDate` com base em `defaultLeadDays`;
- alertar quando a promessa estiver antes do prazo padrao;
- deixar explicito quando o pedido vai nascer com pendencia de laboratorio.

Componentes:

- `OpticalLaboratoryStep`;
- `OpticalSalesPdv`;
- apoio em `handleActionSubmit` apenas se precisarmos padronizar payload futuro.

### Fase 3 - Aceleradores de balcao

8. Presets de pagamento

Problema:

- pagamento misto funciona, mas exige digitacao demais.

Mudanca:

- adicionar botoes de preenchimento rapido:
  - `100% Pix`
  - `100% Dinheiro`
  - `Entrada + restante no crediario`
  - `2x cartao`
  - `Sinal agora`

Componentes:

- `OpticalSalesPdv`;
- estilos de `.mixed-payments`, `.payment-heading` e novo grupo de presets.

9. Atalhos de cadastro dentro do fluxo

Problema:

- o operador pode travar se faltar cliente, laboratorio ou produto.

Mudanca:

- manter atalhos de `Novo cliente`;
- adicionar atalho de `Novo laboratorio`;
- quando faltar classificacao optica no catalogo, sugerir ajuste direto no produto.

Componentes:

- `OpticalSalesPdv`;
- `ActionModal`;
- `buildModalConfig`.

### Fase 4 - Consolidacao tecnica

10. Unificar o conceito e aposentar o legado

Problema resolvido:

- o fluxo antigo deixou de dividir responsabilidade com a experiencia principal.

Mudanca:

- escolher definitivamente o fluxo `sheet` como experiencia principal;
- reaproveitar do legado apenas o que fizer sentido;
- remover o que sobrar quando o novo PDV estiver estavel.

Componentes:

- `OpticalSalesPdv`;
- `OpticalSalesPdvView`;
- `opticalSaleState`.

## Ordem exata para mexer no codigo

### Passo 1

Editar `OpticalSalesPdv` em `src/client/main.jsx`.

Primeiras mudancas:

- adicionar busca real para itens;
- criar status claro de `venda comum` x `venda optica`;
- melhorar resumo lateral com checklist operacional;
- mover parte das validacoes para feedback em tempo real.

Esse e o maior ganho por menor custo.

### Passo 2

Editar `OpticalPrescriptionStep`, `InlinePrescription`, `OpticalMeasurementsStep` e `OpticalLaboratoryStep`.

Objetivo:

- enriquecer contexto, microcopy, sugestoes e alertas;
- tornar o bloco tecnico mais legivel para o balconista.

### Passo 3

Editar `src/client/styles.css`.

Objetivo:

- suportar busca melhor de itens;
- reforcar hierarquia visual dos blocos;
- deixar pendencias e acoes importantes mais visiveis;
- melhorar responsividade do resumo e das secoes opticas.

### Passo 4

Revisar `handleActionSubmit` em `src/client/main.jsx`.

Objetivo:

- garantir que novas sugestoes e presets de UI continuem gerando payload consistente;
- centralizar pequenos normalizadores de dados se necessario.

### Passo 5

Revisar `ActionModal` e `buildModalConfig`.

Objetivo:

- agilizar criacao de cliente, laboratorio e produto sem sair do fluxo de venda;
- padronizar defaults mais inteligentes para empresa optica.

## Decisoes de produto recomendadas

Antes de implementar tudo, vale assumir estas regras:

1. Item optico no carrinho ativa modo optico explicitamente.
2. Venda optica sempre exige cliente identificado.
3. Receita, medidas e laboratorio podem ser pendencias, mas isso deve ficar visivel.
4. Data prometida deve nascer sugerida, nao vazia, quando houver laboratorio com prazo padrao.
5. O resumo da venda deve descrever efeitos operacionais, nao apenas valores.

## Escopo recomendado para a primeira entrega

Se a ideia for entregar valor rapido, a primeira versao do redesign deve incluir apenas:

- busca melhor de itens;
- banner de modo optico;
- resumo operacional;
- alertas progressivos;
- sugestao de data prometida por laboratorio;
- presets de pagamento.

Isso ja melhora bastante a rotina sem exigir uma reescrita completa do fluxo.

## Riscos e cuidados

- nao quebrar o payload atual do backend em `createSale`;
- manter o comportamento de pendencias opticas do motor;
- preservar o suporte a venda com servico e produto no mesmo pedido;
- testar empresas `general` e `optical`, porque o componente de vendas atende os dois cenarios.

## Conclusao

O principal problema hoje nao esta no motor, mas na friccao da operacao no balcao.

O melhor investimento e evoluir o `OpticalSalesPdv` atual em vez de abrir um terceiro fluxo. A tela ja tem os dados e o motor por tras; o que falta e transformar a experiencia em uma venda assistida, mais rapida e mais explicativa.
