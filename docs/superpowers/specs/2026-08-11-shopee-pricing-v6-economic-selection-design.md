# Motor V6: selecao economica e pre-visualizacao persistente

## Objetivo

Fazer com que o Motor de Precificacao Inteligente V6 recomende o menor preco de venda que respeite a margem minima configurada e preserve o melhor repasse liquido quando uma mudanca de faixa de taxa tornar um preco menor mais rentavel. A simulacao completa deve permanecer salva para a loja ate que o usuario solicite uma atualizacao. A tela tambem deve permitir simular livremente um preco de venda para visualizar o repasse e a margem.

## Escopo

- A previa V6 completa passa a ser persistente por loja, selecao, filtros e versao de configuracao, sem expiracao automatica.
- O usuario pode invalidar a previa com a acao explicita `Atualizar dados`; alteracoes de filtros, selecao ou configuracoes tambem exigem uma nova previa.
- A recomendacao avalia todos os pontos economicos relevantes das regras configuradas: limites de comissao e taxa fixa, inicios e tetos de cupons, custos variaveis, campanhas e acabamentos psicologicos.
- Um preco e elegivel somente se sua margem percentual for igual ou superior a margem minima configurada.
- A prioridade de escolha e: menor preco elegivel; em preco igual, maior repasse liquido; em pontos de ruptura onde um preco menor entrega mais repasse do que um preco maior, o menor preco vence.
- O simulador livre calcula, para um valor digitado, cada componente de taxa, custo, repasse liquido e margem percentual, sem criar job ou alterar preco na Shopee.

## Arquitetura

### Previa persistente

`PricingV6Snapshot` recebe uma chave de reutilizacao deterministica composta de loja, versao das configuracoes, selecao e filtros normalizados. O servico procura uma previa correspondente antes de recalcular; sem expiracao, ela permanece reutilizavel. A atualizacao explicita invalida a chave e gera uma nova previa. Dados de produto continuam sendo lidos exclusivamente do banco Shopee local; nenhuma leitura adicional da API Shopee e feita para carregar a grade.

### Recomendacao por faixas

O motor substitui o conjunto incompleto de candidatos por geracao deterministica em torno dos limites onde o custo efetivo pode mudar. Para cada intervalo, avalia o limite, o primeiro valor apos o limite, o piso calculado para a margem minima e os acabamentos psicologicos proximos. Cada candidato usa o mesmo `buildBreakdown`, de forma que comissao, taxa fixa, cupom, custo variavel e campanha sejam considerados uma unica vez. A escolha final usa a prioridade economica definida acima e retorna tambem o repasse liquido calculado.

### Simulador livre

O endpoint V6 recebe o valor de venda em reais ou centavos e devolve apenas o `breakdown` calculado com os custos e configuracoes do produto selecionado. A interface disponibiliza o controle ao lado de `Preco sugerido`, mostra valor informado, taxas, custos, repasse liquido e margem, e trata entradas invalidas sem disparar chamadas a Shopee.

## Estados e erros

- Sem custo configurado: a recomendacao continua marcada como `missing_cost`; o simulador pode explicar que a margem nao e confiavel sem CMV.
- Nenhum preco elegivel: o motor retorna `unpriceable` com motivo explicito e nao cria job aplicavel.
- Previa persistida com versao de configuracao diferente: nao e reutilizada.
- Atualizacao manual: descarta apenas a previa correspondente a loja, sem alterar produtos, configuracoes ou jobs existentes.
- Simulador: invalido ou preco menor/igual a zero retorna erro de validacao, sem persistencia e sem efeitos externos.

## Testes

- Regressao que prova que um preco menor apos uma troca de faixa vence quando tem maior repasse liquido e respeita a margem minima.
- Limites exatos de taxa, cupom e acabamento psicologico continuam elegiveis.
- A previa e reutilizada sem TTL e e invalidada por atualizacao explicita ou mudanca de versao de configuracao.
- O simulador livre devolve a mesma decomposicao do motor para o preco informado, incluindo repasse liquido e margem percentual.
- A suite V6 inteira e a verificacao de schema permanecem verdes.
