# Filtro de MLB e SKU na Margem de venda ML

## Objetivo

O campo Buscar da tela Margem de venda deve restringir Resumo, Margem por período e Equilíbrio estimado ao anúncio consultado. As datas continuam delimitando os pedidos; não delimitam a busca do anúncio.

## Comportamento

- Um MLB completo é resolvido diretamente na conta Mercado Livre, sem depender do limite da leitura inicial do catálogo. Um MLB de outra conta não entra no resultado.
- Um SKU exato é pesquisado diretamente na conta e pode corresponder a mais de um MLB ou variação. Todos os anúncios correspondentes participam do recorte, preservando a identificação por variação quando disponível.
- A busca parcial por título ou categoria continua usando o catálogo inicialmente lido. Quando essa leitura é parcial, a tela mantém o aviso de cobertura parcial; não promete busca global por texto.
- A ausência de correspondências produz listas e totais vazios em todas as abas abrangidas. Uma lista vazia de IDs nunca significa “sem filtro” quando Buscar foi preenchido.
- Uma correspondência sem pedidos no período permanece visível nas visões de anúncio e estimativa, mas Resumo e Margem por período mostram ausência de vendas no período.
- O XLSX usa o mesmo recorte da tela, pois exporta a partir da mesma consulta.
- Custos por SKU conserva seu filtro próprio; o campo Buscar da Margem não aparece nessa aba.

## Fluxo técnico

O serviço de margem classifica a busca entre MLB completo, SKU exato e texto livre. Para MLB/SKU, resolve IDs com as consultas diretas já usadas pelo módulo, valida a propriedade da conta e carrega detalhes dos anúncios encontrados. Aplica em seguida os filtros de status/catálogo e o limite de processamento, registrando truncamento quando necessário. A consulta financeira recebe um filtro explícito (inclusive conjunto vazio) para pedidos pagos e para todos os pedidos do período. As linhas de anúncio, estimativas e agregados usam o mesmo conjunto resolvido.

## Falhas e limites

Falha na consulta direta deve ser comunicada como erro, não convertida em “nenhum resultado” nem em todos os pedidos. A leitura de pedidos ainda pode ser parcial pelo limite existente; o aviso atual permanece. Busca parcial por texto pode continuar parcial pelo limite do catálogo.

## Verificação

Testes de regressão devem cobrir MLB fora do snapshot, SKU fora do snapshot, zero correspondências, anúncio de outra conta, múltiplos MLBs do mesmo SKU, ausência de vendas no período e consistência entre as três abas e exportação. A UI deve preservar o termo enviado e informar claramente quando não houver resultados.
