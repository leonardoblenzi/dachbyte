# Exclusão completa de empresa no Master ML

## Objetivo

Fazer com que a ação **Excluir em cascata** do painel Master ML remova, em uma única transação, a empresa, seus dados relacionais e toda auditoria que possa ser atribuída com segurança a ela. A operação deve preservar usuários compartilhados e produzir um comprovante administrativo mínimo, permanente e somente leitura.

Este trabalho fica restrito ao fluxo de exclusão de empresa no Master. A política global de retenção e o particionamento da auditoria não fazem parte deste escopo.

## Situação atual

O endpoint `DELETE /api/admin/empresas/:id` calcula usuários e contas ML, exclui usuários exclusivos e, por fim, exclui a empresa. As tabelas relacionais ligadas por chaves estrangeiras usam cascata, mas `auth_audit` não possui vínculo relacional com empresa ou conta ML:

- `user_id` usa `ON DELETE SET NULL`;
- conta e empresa aparecem apenas dentro de `metadata` JSON;
- a prévia não conta registros de auditoria;
- o middleware grava `admin_company_deleted` depois que a resposta termina, podendo recriar um registro ligado à empresa já removida.

O resultado atual é uma exclusão funcional dos cadastros, mas com auditorias órfãs e sem comprovante estruturado da operação.

## Decisões de produto

- A limpeza ocorre apenas quando um `admin_master` usa a exclusão em cascata de empresa.
- O modal exibe previamente a quantidade de registros de auditoria que será removida.
- Usuários que pertencem exclusivamente à empresa são excluídos, juntamente com seus eventos de identidade.
- Usuários compartilhados são mantidos. Seus eventos genéricos de identidade também são mantidos, pois não podem ser atribuídos com segurança a uma única empresa.
- Eventos de usuários compartilhados vinculados a contas ML da empresa excluída são removidos.
- Um comprovante mínimo é gravado em tabela própria e não pode ser editado ou excluído pelo painel.
- O painel Master ganha um histórico paginado de exclusões.

## Identificação das auditorias da empresa

Antes de qualquer exclusão, o servidor captura e bloqueia a empresa, seus IDs de contas ML e seus usuários. Um registro de `auth_audit` pertence à empresa quando ao menos um dos critérios abaixo é verdadeiro:

1. `meli_conta_id` relacional aponta para uma conta da empresa;
2. `empresa_id` relacional aponta para a empresa;
3. para registros legados, `metadata.meli_conta_id`, `metadata.accountKey` ou `metadata.account_key` corresponde a uma conta da empresa;
4. para registros legados, `metadata.empresa_id` ou `metadata.company_id` corresponde à empresa;
5. `user_id` corresponde a um usuário que pertence exclusivamente à empresa.

O mesmo predicado de identificação será usado na prévia e na exclusão. Isso evita que o modal prometa uma quantidade diferente da efetivamente removida.

## Modelo de dados

### Auditoria

`auth_audit` recebe duas colunas opcionais:

- `empresa_id bigint`;
- `meli_conta_id bigint`.

Ambas terão índices. Os novos eventos preencherão essas colunas a partir do contexto explícito ou da conta ML presente nos metadados. O conteúdo JSON continuará existindo para detalhes do evento, mas deixará de ser a única forma de estabelecer propriedade.

Os registros existentes serão retroalimentados quando os metadados contiverem identificadores numéricos válidos e ainda existentes. A rotina de exclusão continuará reconhecendo o formato legado para cobrir linhas que não puderem ser retroalimentadas.

### Comprovante de exclusão

Será criada `company_deletion_receipts`, sem chave estrangeira para `empresas`, com:

- identificador próprio e `request_id` único;
- ID, nome e `tenant_global_id` da empresa removida;
- ID e e-mail do operador Master;
- data e status da exclusão;
- quantidades de usuários excluídos e desvinculados;
- quantidade de contas ML removidas;
- quantidade de auditorias removidas.

O comprovante não guarda tokens, IPs, user agents, payloads do Mercado Livre nem detalhes dos eventos apagados.

## Fluxo transacional

1. Validar o operador como `admin_master` e o pedido como exclusão em cascata.
2. Abrir transação e bloquear a linha da empresa com `FOR UPDATE`.
3. Capturar o snapshot da empresa, contas ML, usuários exclusivos e usuários compartilhados.
4. Calcular novamente o impacto usando o mesmo predicado da prévia.
5. Excluir as auditorias atribuíveis à empresa antes de apagar usuários ou contas.
6. Excluir usuários exclusivos; usuários compartilhados serão apenas desvinculados pela cascata da empresa.
7. Excluir a empresa e deixar as chaves estrangeiras removerem os demais dados relacionais.
8. Gravar o comprovante mínimo com as contagens reais retornadas pelas operações.
9. Confirmar a transação.

Qualquer erro provoca `ROLLBACK`; nesse caso, empresa, usuários, auditorias e comprovante permanecem no estado anterior.

O middleware genérico `admin_company_deleted` não será usado para uma exclusão concluída. O comprovante será a fonte canônica desse evento, evitando recriar auditoria da empresa após o commit. Tentativas rejeitadas ou falhas técnicas podem continuar sendo registradas como eventos administrativos, pois a empresa não foi removida.

## Concorrência e jobs

A exclusão bloqueia a empresa enquanto calcula e remove os dados. Eventos gravados durante a transação serão alcançados pela exclusão antes do commit. Após a remoção das contas, novos eventos que apresentem uma conta inexistente não devem criar vínculo órfão.

O fluxo verificará jobs ativos das contas antes de excluir. A operação será bloqueada enquanto houver processamento que ainda possa alterar o Mercado Livre. O Master receberá uma mensagem clara para cancelar ou aguardar esses jobs. A exclusão não tentará interromper silenciosamente uma operação externa em andamento.

## Interface Master

O modal de impacto continuará listando usuários excluídos, usuários mantidos e contas ML. Ele também exibirá:

- registros de auditoria que serão apagados;
- jobs ativos que impedem a exclusão, se houver;
- aviso de que será criado um comprovante administrativo mínimo.

A tela de empresas receberá a seção **Histórico de exclusões**, exclusiva para `admin_master`, com busca por empresa, filtro por período e operador, paginação e visualização somente leitura. Cada linha mostrará empresa, data, operador, contagens, status e `request_id`.

## API

- `GET /api/admin/empresas/:id/delete-preview` passa a retornar contagem de auditorias e bloqueios por jobs ativos.
- `DELETE /api/admin/empresas/:id` usa o serviço transacional de exclusão e devolve as contagens reais e o `request_id` do comprovante.
- `GET /api/admin/empresas/deletion-receipts` lista comprovantes com paginação e filtros permitidos.
- Não haverá endpoint de alteração ou exclusão de comprovantes.

## Organização do código

A regra de impacto e exclusão será extraída da rota para um serviço dedicado. A rota ficará responsável por autenticação, validação HTTP e serialização; o serviço será responsável pelo predicado de auditoria, transação, contagens e comprovante. A interface consumirá apenas os contratos da API.

## Testes e validação

Os testes devem demonstrar:

- auditoria de conta ML removida mesmo quando o usuário é compartilhado;
- eventos de identidade removidos para usuário exclusivo;
- eventos genéricos preservados para usuário compartilhado;
- reconhecimento dos campos legados no JSON;
- igualdade entre contagem da prévia e quantidade excluída;
- rollback integral quando uma etapa falha;
- bloqueio com jobs ativos;
- criação de exatamente um comprovante, sem payload sensível;
- ausência de novo `admin_company_deleted` em `auth_audit` após sucesso;
- histórico Master paginado e inacessível para usuários não Master.

Depois dos testes automatizados, a implantação seguirá com backup do banco, migration, deploy do Seller ML e validação da prévia. A primeira exclusão real será feita pelo Master com uma das empresas já encerradas, conferindo antes e depois as contagens de empresa, contas, usuários, auditoria e comprovante.

## Fora de escopo

- alterar retenção geral de `auth_audit`;
- particionar a tabela de auditoria;
- apagar ou reformular filas históricas que já estejam concluídas;
- mudar o fluxo de exclusão individual de usuários ou contas ML;
- aplicar a mesma política a outros módulos da suíte.
