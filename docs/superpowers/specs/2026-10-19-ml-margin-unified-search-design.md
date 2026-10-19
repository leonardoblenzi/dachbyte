# Busca unificada na Margem de venda ML

## Objetivo

O campo Buscar das abas Resumo, Margem por período e Equilíbrio estimado aceita MLB, SKU, EAN ou parte do nome do produto. A consulta e a exportação XLSX aplicam o mesmo recorte. A aba Custos por SKU mantém seu filtro próprio.

## Regra de correspondência

- MLB completo: igualdade de identificador, ignorando maiúsculas/minúsculas. Pedidos do MLB continuam visíveis mesmo se o anúncio não estiver no snapshot atual; a busca continua restrita aos pedidos da conta autenticada.
- SKU: igualdade após a normalização já usada pelo serviço. Conferir o SKU da venda e as referências do anúncio/variação/catálogo. Uma busca por SKU não pode incluir outra variação do mesmo MLB.
- EAN/GTIN: igualdade do código normalizado, sem busca parcial. Resolver o código pelas informações de produto e variação que o Seller ML possui. Quando o EAN pertence a uma variação identificável, limitar as vendas a essa variação. Quando o vínculo EAN–MLB não estiver mais disponível, o pedido histórico não pode ser identificado por EAN; não inferir a partir de outro produto.
- Nome: trecho do título, sem diferenciar maiúsculas/minúsculas. Conferir título do anúncio e título gravado no pedido para incluir vendas históricas cujo anúncio não esteja no snapshot.

Um termo numérico que não se encaixa como EAN conhecido ainda pode ser um SKU numérico. Quando houver coincidências nas duas categorias, unir os resultados e eliminar pedidos duplicados. Um termo de uma palavra pode ser SKU e trecho de nome ao mesmo tempo; unir as correspondências. Não interpretar um trecho de MLB, SKU ou EAN como correspondência exata.

## Fluxo

1. O formulário envia `q` como hoje.
2. O serviço resolve identificadores do anúncio e, quando necessário, usa os campos da própria venda para selecionar itens dos pedidos. Nenhum resultado encontrado mantém o recorte vazio; não retorna a conta inteira.
3. `buildOrderFinancials` aplica o mesmo predicado aos pedidos pagos e aos pedidos por data de criação. Resumo, tabela por período e exportação derivam desses resultados.
4. O serviço calcula a estimativa de equilíbrio apenas para anúncios cujos detalhes estão disponíveis. Um pedido histórico pode aparecer em Margem por período mesmo sem linha em Equilíbrio estimado. A interface informa essa limitação sem chamar a busca de vazia.

## Limites e segurança

- Manter os filtros de período, status do pedido, custos e margem existentes.
- Respeitar o status do anúncio quando o usuário escolher um status específico. O fallback histórico de MLB/nome sem anúncio só se aplica com Status anúncio = Todos.
- Não ampliar a busca para outra conta nem retornar todos os pedidos quando não há correspondência.
- Falha na consulta direta ao Mercado Livre permanece erro explícito; resultado vazio não mascara erro de API.
- Não alterar banco, crédito, jobs ou rotas de outras telas.

## Verificação

Testes devem cobrir MLB histórico do HAR (`MLB6827582394`), SKU da venda e variação, EAN de anúncio/variação, nome parcial em título do anúncio e do pedido, nenhum resultado, status específico, isolamento de conta, resumo/tabela/exportação com o mesmo recorte e preservação dos demais filtros. O teste de EAN antigo sem vínculo verificará resultado vazio, sem inferência.
