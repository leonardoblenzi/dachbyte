# Guia Visual do ML

## Objetivo

Este guia define a direcao visual alvo do modulo `ml` para tirar o produto da aparencia de prototipo e levar para uma suite operacional B2B mais consistente, profissional e densa.

O foco nao e "deixar bonito". O foco e:

- reduzir ruido visual
- aumentar sensacao de produto maduro
- unificar componentes
- dar prioridade a leitura, acao e estado

---

## Diagnostico Atual

Hoje o `ml` mistura 4 linguagens visuais:

1. Dashboard com cara de landing interna
- muitos cards grandes
- muitos selos, pills, destaques e icones
- excesso de espaco consumido por blocos de resumo

2. Telas operacionais mais solidas
- `atacado` e partes de `criar-promocao` ja se aproximam de um painel profissional
- tabela e filtros com mais protagonismo

3. Telas legadas utilitarias
- `remover-promocao`, `prazo` e outras telas mais antigas ainda tem cara de formulario tecnico sem sistema visual forte

4. Telas hibridas
- `analise-ia` mistura Bootstrap com estilo proprio
- isso reforca a sensacao de produto montado em fases diferentes

---

## Direcao Visual Alvo

O `ml` deve parecer uma:

> Suite operacional premium, interna ou B2B, focada em produtividade e confianca.

Nao deve parecer:

- landing page
- painel "gamer"
- UI cheia de destaque visual
- conjunto de microsistemas sem unificacao

### Principios

1. Informacao acima de decoracao
- dado, filtro e acao devem ter mais peso que card, gradiente e ornamento

2. Sobriedade com identidade
- manter azul ML como cor principal de acao
- manter amarelo ML concentrado em branding e pontos muito especificos

3. Densidade controlada
- menos espaco desperdicado
- mais conteudo por area util

4. Consistencia acima de criatividade local
- cada tela nao deve "inventar um produto novo"

5. Menos elementos competindo
- menos badges
- menos icones
- menos sombras
- menos variacoes de botao

---

## O Que Cortar

### Icones e emojis

Reduzir fortemente:

- emojis em titulos
- emojis em cards
- emojis em botoes principais
- icones decorativos sem funcao

Uso recomendado:

- icones apenas em acoes onde aceleram leitura
- nunca depender de icone para comunicar hierarquia

### Cards exagerados

Evitar:

- cards muito altos
- cards com pouca informacao e muito preenchimento
- cards com efeito de "marketing"

### Badges em excesso

Evitar:

- status em quase todo titulo
- pill para tudo
- chip repetido quando a informacao ja esta no contexto

### Sombras pesadas e gradientes em excesso

Usar:

- sombra discreta
- gradiente apenas quando houver funcao clara

---

## Sistema Base Recomendado

## Paleta

### Cores principais

- `--bg-page`: cinza muito claro neutro
- `--bg-panel`: branco
- `--border-subtle`: cinza claro
- `--text-strong`: quase preto
- `--text-muted`: cinza medio
- `--action-primary`: azul ML
- `--action-primary-hover`: azul ML mais escuro

### Cores semanticas

- sucesso: verde discreto
- aviso: ambar contido
- erro: vermelho limpo

### Restricao importante

Amarelo ML:

- pode continuar no topo/header por identidade
- nao deve virar cor de interface espalhada em cards, paines e destaques

---

## Tipografia

### Escala recomendada

- titulo de pagina: 28-32
- titulo de secao: 20-22
- titulo de painel: 16-18
- texto base: 14-15
- texto auxiliar: 12-13

### Pesos

Usar principalmente:

- 400
- 500
- 600
- 700

Evitar:

- 800/900 como padrao

### Regra

Peso forte deve sinalizar:

- titulo
- CTA principal
- numero importante

Nao deve ser o default da tela inteira.

---

## Layout

### Estrutura recomendada

1. Header global
- conta atual
- status
- trocar conta

2. Navegacao principal
- tabs discretas
- menos visual de pill recreativo

3. Shell da pagina
- titulo
- subtitulo curto
- acoes de pagina

4. Conteudo principal
- paines claros
- filtros
- tabela
- jobs/resultados

### Espacamento

Adotar escala fixa:

- 8
- 12
- 16
- 20
- 24
- 32

Evitar espacamentos arbitrarios tela a tela.

---

## Componentes

## Botoes

Padronizar para 4 familias:

1. Primario
- azul
- usado para acao principal da tela

2. Secundario
- fundo neutro
- usado para acao auxiliar

3. Ghost
- quase sem fundo
- usado para suporte/navegacao local

4. Destrutivo
- vermelho
- usado so para remocao/exclusao

### Regras

- altura consistente
- menos sombra
- menos cantos exageradamente arredondados
- sem emoji no texto

## Inputs

Padronizar:

- altura
- raio
- borda
- foco azul
- labels sempre acima

## Badges e status

Usar com parcimonia.

Quando existir badge:

- tamanho pequeno
- sem competir com titulo
- reservado para estado real do sistema

## Paines

Todo bloco de conteudo deve seguir:

- fundo branco
- borda suave
- raio moderado
- sombra minima

Nao usar diferentes estilos de painel para cada tela sem motivo funcional.

## Tabelas

As tabelas devem ser o centro da experiencia operacional.

Regras:

- cabecalho limpo
- pouco contraste
- mais densidade
- acoes por linha discretas
- zebra opcional muito suave
- status dentro da tabela com formato consistente

---

## Direcao por Tipo de Tela

## 1. Dashboard

Problema atual:

- muito card grande
- muito elemento chamando atencao
- cara de homepage e nao de cockpit

Direcao:

- transformar em painel executivo
- menos cards
- mais blocos compactos
- usar 1 area de KPI, 1 area de tendencia, 1 area de atalhos

O dashboard deve responder rapidamente:

- como a conta esta hoje
- qual o risco/oportunidade do dia
- para onde eu vou agora

## 2. Hub de ferramentas

Problema atual:

- cards grandes demais
- informacao repetida
- excesso de status "Ativo/Novo"

Direcao:

- virar catalogo operacional
- cards menores
- menos descricao longa
- mais agrupamento por funcao

## 3. Telas de operacao em massa

Exemplos:

- criar promocao
- remover promocao
- atacado
- prazo
- gestao de anuncios
- modelo em massa

Direcao:

- mesmo shell visual
- mesmo topo local
- mesmo estilo de filtros
- mesmo estilo de jobs
- mesma tabela

Essas telas devem parecer irmas.

## 4. Telas analiticas

Exemplos:

- analise-ia
- curva abc

Direcao:

- menos mistura com Bootstrap
- manter cards e modulos, mas com mesma tipografia e mesmos tokens do resto

---

## Ordem Recomendada de Refatoracao

### Fase 1 - Fundacao visual

1. consolidar tokens em uma base comum
2. padronizar botoes
3. padronizar inputs
4. padronizar painel/card
5. padronizar tabela
6. padronizar badges/status

### Fase 2 - Telas de maior impacto

1. `dashboard`
2. `criar-promocao`
3. `atacado`
4. `remover-promocao`

### Fase 3 - Harmonizacao do ecossistema

1. `prazo`
2. `modelo-massa`
3. `analise-ia`
4. demais telas

---

## Referencia Interna Atual

Se fosse escolher a melhor base atual para evoluir:

- estruturalmente: `atacado`
- operacionalmente: `criar-promocao`
- identidade global: topo + tabs do `dashboard`

O alvo ideal e juntar:

- a sobriedade do `atacado`
- a potencia operacional do `criar-promocao`
- a navegacao global do `dashboard`

---

## Regras Objetivas para Revisar Qualquer Nova Tela

Antes de aprovar uma tela do `ml`, validar:

1. Ela usa no maximo 1 CTA primario visivel por area?
2. Ela evita emoji em titulo e botoes principais?
3. Ela parece parte do mesmo produto que `atacado` e `criar-promocao`?
4. O foco visual esta em dado e fluxo, nao em decoracao?
5. A tabela ou bloco principal aparece rapido, sem muito "hero"?
6. Os status usam o mesmo padrao semantico do restante?
7. A quantidade de cards pode ser reduzida sem perder informacao?

Se a resposta for "nao" para varias dessas perguntas, a tela provavelmente esta voltando para o estilo de prototipo.

---

## Meta Final

O `ml` deve transmitir:

- confianca
- velocidade
- maturidade
- controle operacional

E nao:

- excesso de recursos
- entusiasmo visual
- "cada tela foi feita em uma epoca"

