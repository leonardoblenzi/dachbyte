# Fase E — conclusão do fluxo óptico

## Objetivo

Encerrar a Fase E sem reverter a paginação server-side do Workspace V2. O fluxo deve permitir vincular receitas a qualquer cliente e garantir que uma venda óptica produza, exiba e cancele seus artefatos operacionais.

## Escopo

- Apenas `business/volt_core` na branch `voltdev`.
- Sem migrations.
- Nenhuma alteração em ML, Shopee, Stock ou Chat.

## Problemas observados

1. O modal **Nova receita óptica** obtém as opções a partir da página atual de `data.customers`. Com paginação, clientes fora dos primeiros resultados não podem ser selecionados.
2. A venda óptica confirma criação de pedido óptico e OS, mas a tela de OS não exibiu a OS esperada durante o golden path. A criação, a resposta paginada e o mapper precisam ser verificados como uma cadeia única.

## Design

### Cliente da receita

O campo de cliente da Receita será um autocomplete reutilizável com busca server-side. A pesquisa consultará o recurso paginado `customers` por nome, CPF/CNPJ, telefone ou e-mail e selecionará um registro por `customerId`.

A receita óptica exigirá cliente cadastrado: não haverá fallback para cliente avulso. Quando aberta a partir da ficha de um cliente, a seleção virá previamente preenchida e bloqueada apenas enquanto o contexto da ficha estiver ativo.

O catálogo geral continuará paginado; nenhum carregamento global de clientes será restaurado.

### Venda óptica, OP e OS

Antes da mudança de comportamento, será criado um teste de integração que percorre a transação real de venda óptica. Ele deverá provar os seguintes contratos:

- venda com cliente, armação e lente cria exatamente um pedido óptico e uma OS;
- ambos carregam `company_id`, `sale_id`, `customer_id` e a relação entre OP e OS;
- o endpoint paginado `service-orders` devolve a OS criada, com a etapa inicial adequada;
- o mapper do cliente transforma a resposta em uma linha visível no quadro e na produção;
- o cancelamento oficial altera OP e OS para `canceled`, cancela o recebível e restaura o estoque.

O defeito será corrigido na primeira fronteira que violar esse contrato (hook de criação, endpoint ou mapper), sem duplicar criação de OP/OS nem introduzir fluxo assíncrono fora da transação da venda.

## Erros e integridade

- Falha ao pesquisar clientes deixa o campo em estado de erro recuperável e não permite gravar uma receita sem `customerId` válido.
- Falha ao criar OP/OS faz a venda inteira falhar e reverter, pois os artefatos permanecem na mesma transação.
- O cancelamento é idempotente para artefatos já cancelados e preserva auditoria/workflow.

## Verificação

Automatizada:

- cliente além da primeira página é selecionável na Receita e persiste o `customerId`;
- golden path óptico cria OP/OS, expõe a OS no recurso paginado e cancela todos os efeitos;
- suíte Volt Core e build continuam passando.

Manual no staging:

1. criar ou localizar cliente fora da primeira página;
2. salvar Receita vinculada a ele;
3. criar venda óptica com armação e lente;
4. validar OP/OS, estoque e recebível;
5. cancelar a venda e validar os estornos e estados finais.
