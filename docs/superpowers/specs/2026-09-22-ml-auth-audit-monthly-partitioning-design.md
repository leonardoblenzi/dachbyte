# Particionamento mensal da auditoria ML

## Objetivo

Migrar toda a tabela `ml.auth_audit` para particionamento mensal por `created_at`, preservando o histórico atual, os filtros administrativos, as regras de retenção editáveis no painel e as relações de empresa e conta. A operação deve permitir descartar meses integralmente vencidos com liberação física previsível de espaço, sem `VACUUM FULL`.

## Decisões aprovadas

- Estratégia: tabela nova, cópia integral, validação, troca atômica e retenção temporária da tabela legada.
- Escopo: migrar todo o histórico existente, não apenas eventos novos.
- Operação: janela de manutenção programada para Seller/ML.
- Retenção: regras continuam em `ml.auth_audit_retention_rules` e são editadas no painel Master; não haverá classificação ou prazo hardcoded no código.
- Política de uso pretendida no painel: eventos críticos por 90 dias, navegação por 30 dias e ruído operacional detalhado por 7 dias. A consolidação de detalhes de jobs é uma iniciativa separada e não é pré-requisito para a troca de tabela.
- Segurança: backup externo Restic/R2 inicializado, snapshot executado e restauração verificada são pré-requisitos da janela. Um dump local pode complementar, mas não substitui o backup externo.

## Arquitetura alvo

`ml.auth_audit` passará a ser uma tabela particionada por faixa mensal de `created_at`. Cada partição terá nomes `ml.auth_audit_YYYY_MM`. A tabela pai manterá o contrato de leitura e escrita usado por `authAuditService`, rotas administrativas e exclusão de empresa; as aplicações continuarão consultando `auth_audit` sem mudança de endpoint.

A chave primária da tabela particionada será composta por `(created_at, id)`, pois PostgreSQL exige que uma chave única de uma tabela particionada inclua a chave de partição. `id` continuará gerado por sequência global para manter ordenação e referências operacionais. Não há FK conhecida apontando para `auth_audit`; a pré-validação deve confirmar isso antes da troca.

A tabela pai terá uma partição `ml.auth_audit_default` para impedir falha de auditoria quando uma data inesperada não tiver faixa criada. O trabalho de manutenção criará partições mensais antecipadamente e moverá linhas da default para a partição correta quando necessário.

Cada partição mensal deverá manter os índices necessários para o contrato atual:

- `created_at`;
- `user_id`;
- `evento`;
- `(empresa_id, created_at desc)`;
- `(meli_conta_id, created_at desc)`;
- os índices de identificadores JSONB já existentes e usados pelos filtros administrativos.

As FKs atuais de `user_id`, `empresa_id` e `meli_conta_id`, inclusive os comportamentos `ON DELETE`, devem ser preservadas no pai novo antes da cópia.

## Migração completa por janela

### Pré-requisitos

1. Configurar `infra/env/backup.env` com o repositório Restic/R2, senha e credenciais restritas ao bucket.
2. Inicializar o repositório Restic e executar `./business-db-ops.sh backup` com sucesso.
3. Testar restauração em destino isolado e registrar evidência.
4. Medir espaço livre suficiente para coexistirem tabela atual, tabela nova, índices e WAL durante a cópia. A VPS atual possui margem, mas a medição deve ser repetida imediatamente antes da janela.
5. Confirmar que não há FK de outra tabela para `ml.auth_audit` e inventariar triggers, grants, índices e sequence atuais.

### Fase de preparação

1. Criar `ml.auth_audit_partitioned_new` particionada por `RANGE (created_at)`, com colunas, defaults, FKs e checks equivalentes à tabela atual.
2. Criar partições mensais desde o mês do evento mais antigo até 18 meses futuros, além da partição default.
3. Criar os índices de cada partição antes da cópia quando isso for vantajoso para a carga, ou em fase posterior quando a medição demonstrar que a cópia é mais eficiente assim. A decisão operacional será documentada no runbook.
4. Criar uma sequência para `id`, garantir que a tabela nova use a sequência e que ela seja ajustada ao maior `id` copiado.

### Janela de manutenção

1. Colocar as rotas Seller/ML em manutenção e parar `seller-ml-web` e `seller-ml-worker` após garantir que não existam jobs críticos ativos.
2. Revalidar backup, espaço livre, contagem total de `auth_audit` e intervalo de datas.
3. Copiar os eventos para a tabela nova em lotes mensais, preservando `id`, `created_at`, `metadata`, escopo relacional e todos os valores originais.
4. Validar por mês e globalmente: contagem, mínimo/máximo de `id`, mínimo/máximo de data, total por evento e totais de empresa/conta nulos versus preenchidos.
5. Dentro de uma única transação curta, renomear a tabela atual para `ml.auth_audit_legacy_YYYYMMDD`, renomear a nova para `ml.auth_audit`, ajustar sequence/defaults, grants e relações dependentes, e validar as partições anexadas.
6. Subir `seller-ml-web` e `seller-ml-worker`, aguardar healthchecks e executar smoke tests de login, consulta de auditoria, filtros, exportação, regras de retenção e exclusão de empresa em ambiente de QA.

### Pós-migração e rollback

A tabela legada ficará intacta por 48 horas, não receberá novas escritas e servirá como reversão rápida. Se qualquer validação falhar antes de a aplicação voltar ao ar, a transação de troca será desfeita. Se uma falha crítica ocorrer depois da troca, a janela de rollback interrompe os serviços, renomeia as tabelas de volta e restaura o último backup se houver divergência de escrita.

Depois de 48 horas de operação validada e de uma nova execução de backup, a tabela legada poderá ser removida. A remoção libera os arquivos físicos dela; não será usado `VACUUM FULL` na tabela particionada.

## Manutenção mensal

Um job operacional mensal executará:

1. criação das partições dos próximos 18 meses;
2. verificação da partição default e migração de linhas dela para a faixa mensal correta;
3. execução da limpeza já existente segundo `ml.auth_audit_retention_rules`;
4. avaliação de cada partição antiga: ela só será descartada se não existir nenhuma linha cuja regra configurada ainda a mantenha válida;
5. registro de métricas: linhas removidas, partições criadas/descartadas, tamanho por partição e espaço do banco.

O descarte não assumirá um limite fixo de 90 dias. Como o Master pode configurar prazos por evento, a checagem usará as regras efetivas de cada linha e a regra curinga antes de descartar uma partição inteira.

## Critérios de sucesso

- Todas as linhas de `auth_audit` existentes antes da janela estão presentes na tabela particionada e mantêm valores idênticos.
- Os filtros, exportações, exclusão de empresa e novas gravações funcionam sem mudança de contrato.
- Uma partição de teste vencida pode ser descartada sem `VACUUM FULL` e o espaço físico correspondente é liberado.
- A partição default não acumula linhas inesperadas sem alerta operacional.
- O rollback é exercitado em ambiente isolado antes da janela produtiva.

## Fora de escopo desta migração

- Alterar os prazos no painel Master.
- Resumir logs detalhados de jobs após sete dias.
- Limpar cache, imagens ou volumes Docker.
- Alterar retenção de dados fora de `ml.auth_audit`.
