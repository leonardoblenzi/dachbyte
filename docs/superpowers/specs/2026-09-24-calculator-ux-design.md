# Ajustes de interação da Calculadora ML

## Objetivo

Tornar a Calculadora uma simulação imediata e visualmente coerente com a tela
Margem de venda, sem mudar as fórmulas nem permitir qualquer escrita no ML.

## Decisões aprovadas

- No modo manual, Clássico e Premium são as únicas escolhas de comissão. Sem
  uma categoria *selecionada* e preço de venda acima de zero, Clássico usa a
  estimativa de 11,5% e Premium a de 16,5%. Os campos de comissão ficam
  bloqueados; a tarifa fixa é opcional e começa em R$ 0.
- A categoria manual deixa de ser um campo livre: o usuário digita o título ou
  produto e escolhe uma sugestão retornada pelo preditor de categorias do ML.
  A seleção armazena o `category_id` e o nome exibido da categoria.
- Quando existirem `category_id`, preço de venda positivo e o tipo de anúncio,
  a aplicação consulta `listing_prices` do Mercado Livre. O percentual e a
  tarifa fixa retornados passam a ser a fonte do cálculo; o selo muda de
  "Comissão estimada" para "Comissão Mercado Livre".
- Ao editar preço, categoria ou tipo, a tela volta imediatamente para a
  estimativa e agenda uma nova consulta oficial. Se a consulta falhar, o
  cálculo continua com a estimativa e mostra uma mensagem não bloqueante.
- Ao carregar um anúncio, o tipo vindo do ML fica selecionado e bloqueado.
- Mercado Envios é a modalidade inicial de frete. Somente o campo da modalidade
  selecionada aparece e participa do cálculo.
- Alterações válidas recalculam automaticamente após um debounce curto. O botão
  de cálculo é removido e Limpar permanece.
- A página usa o mesmo `container`, tokens de cor, tipografia e superfícies da
  Margem de venda nos temas claro e escuro.

## Segurança e desempenho

O cálculo automático não altera preço ou estoque. Enquanto os dados mínimos não
estiverem preenchidos, a interface apenas mantém o estado de orientação. O
debounce evita chamadas consecutivas à API; uma nova mudança invalida a chamada
anterior antes de agendar outra.

## Integração oficial do Mercado Livre

- Sugestões: `GET /sites/MLB/domain_discovery/search?q={texto}&limit=3`. A
  documentação recomenda o preditor por título e até três opções para a
  experiência de vendedor. A interface só aceita uma opção da lista, nunca um
  ID digitado livremente.
- Comissão: `GET /sites/MLB/listing_prices?category_id={id}&price={preco}&currency_id=BRL&listing_type_id={tipo}`. Quando a simulação dispuser de
  logística/modo de envio, eles também devem ser enviados, pois o `fixed_fee`
  depende desses parâmetros na estrutura atual de custos.
- A resposta utiliza `sale_fee_details.percentage_fee` e
  `sale_fee_details.fixed_fee`. O percentual no MLB pode variar além de
  categoria e tipo de anúncio; por isso 11,5% e 16,5% são apenas estimativas
  de ausência de dados, nunca valores oficiais fixos.
- Anúncios carregados por MLB continuam fora desse fluxo: tipo e custos
  recebidos do anúncio permanecem bloqueados.

Fontes: [Categorização de produtos](https://developers.mercadolivre.com.br/pt_br/categorizacao-de-produtos) e [Custos por vender](https://developers.mercadolivre.com.br/pt_br/comissao-por-vender).
