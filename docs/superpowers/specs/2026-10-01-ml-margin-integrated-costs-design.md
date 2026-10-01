# Custos por SKU integrado à Margem ML

## Objetivo

Transformar **Custos por SKU** na quarta aba de **Margem de Venda Mercado Livre**, para que a manutenção de custos faça parte do mesmo fluxo de auditoria de vendas, CMV e precificação.

## Navegação

- O menu lateral de Precificação exibe somente **Margem de venda**.
- A página de Margem passa a ter quatro abas: **Resumo**, **Margem por período**, **Equilíbrio estimado** e **Custos por SKU**.
- A rota antiga `/financeiro/custos-mercado-livre`, seu item de menu e sua permissão específica são removidos. Não haverá redirecionamento nem compatibilidade com URLs antigas.

## Aba Custos por SKU

- A quarta aba preserva toda a funcionalidade atual: alíquota, sincronização, importação e exportação XLSX, KPIs, monitor de alterações, insights, ranking de atenção, filtros, paginação, histórico e salvamento de custo.
- A implementação reaproveita a mesma API e os mesmos comportamentos de custo existentes; não haverá um segundo fluxo de persistência.
- A aba de Equilíbrio continua exibindo o editor compacto por SKU já existente.

## Atalho da Margem por período

- Abaixo do CMV, somente pedidos com item(ns) sem custo exibem um link discreto:
  - um item: `1 item sem custo · Cadastrar`;
  - vários itens: `N itens sem custo · Ver custos`.
- Para um único SKU pendente, o atalho seleciona a aba **Custos por SKU**, configura a busca por SKU e carrega o registro correspondente.
- Para mais de um SKU pendente, o atalho abre uma lista pequena com título, SKU e quantidade de cada item sem custo; ao escolher um, abre a aba já filtrada naquele SKU.
- Itens cuja venda não tenha SKU utilizável ficam identificados na lista e não oferecem salvamento até que o SKU seja corrigido na origem.

## Escopo e segurança

- Não muda cálculos de margem, CMV, Equilíbrio, serviços, endpoints de custo ou banco.
- A remoção da rota e permissão foi aprovada porque não há usuários de produção além do proprietário.
- Filtros do formulário de Margem não devem alterar os filtros próprios da aba Custos por SKU.

## Validação

- Cobrir as quatro abas e a ausência do item Custos por SKU no menu.
- Cobrir o atalho de uma pendência e a lista de múltiplas pendências.
- Cobrir que a busca interna da aba recebe o SKU escolhido.
- Reexecutar os testes existentes de custo, margem, histórico e precificação.
