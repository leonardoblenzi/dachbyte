# Fase E — fechamento de copy e golden path óptico

## Objetivo

Encerrar as duas pendências remanescentes da Fase E sem alterar outros módulos da suíte:

1. remover linguagem específica de ótica das telas compartilhadas pelo tenant Geral;
2. concluir no staging um golden path óptico com dados exclusivos de QA.

## Escopo de código

Somente arquivos sob `business/volt_core` podem ser alterados.

Os dois textos compartilhados passam a ser genéricos:

- descrição de Produtos: `Produtos, serviços, preços e estoque.`;
- tarefa de primeiro uso: `Informe o estoque dos produtos`.

Uma regressão automatizada deve ler o contrato do frontend e impedir que esses textos compartilhados voltem a mencionar armações, lentes ou outros termos exclusivos da vertical óptica. Conteúdo dentro da extensão óptica continua permitido.

Não há mudança de schema, migration, seed ou configuração comercial.

## Validação no staging

Depois do commit, push e deploy, os dados de QA serão cadastrados pelo fluxo normal do Volt Core na empresa óptica de teste:

- cliente identificado com prefixo `QA-FE`;
- armação e lente com SKUs `QA-FE` e estoque positivo;
- receita óptica vinculada ao cliente;
- venda curta ligando os itens à receita.

O teste deve validar venda, baixa de estoque, recebível/financeiro, criação de OP/OS e cancelamento pelo fluxo oficial. Os registros devem permanecer identificáveis como QA; nenhum dado real ou tenant de produção será usado.

## Critérios de aceite

- Tenant Geral não exibe linguagem óptica nas duas áreas compartilhadas.
- Tenant óptico mantém suas telas e recursos próprios.
- Regressão automatizada falha se os textos específicos retornarem ao Core compartilhado.
- Suíte e build do Volt Core passam.
- O diff final contém apenas `business/volt_core`.
- Golden path óptico é executado no staging após o deploy.
