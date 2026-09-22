# Corte controlado: `ml.auth_audit` particionada mensalmente

Este runbook move todo o histórico de `ml.auth_audit` para partições mensais. Ele é uma operação manual de produção: nenhum deploy, `up`, migration normal ou startup pode iniciá-la.

## Pré-requisitos obrigatórios

Não abra a janela enquanto qualquer item abaixo não estiver comprovado:

1. O Restic/R2 está configurado e `./business-db-ops.sh backup` concluiu sem erro.
2. Um restore do backup foi testado em banco isolado e o resultado foi registrado.
3. Há uma janela de manutenção aprovada, com comunicação aos usuários Seller/ML.
4. O preflight mediu espaço livre suficiente (estimativa da tabela mais 30%) e a imagem atual contém o CLI de corte.
5. A migration `072_auth_audit_partition_operations.sql` está aplicada.

Nunca execute nesta janela `docker compose down`, `VACUUM FULL`, limpeza/pruning de dados Docker ou `DROP TABLE` da legacy.

## Sequência da janela

No host VPS, a partir de `/opt/dachbyte/repository/infra`:

```bash
# Garanta que o CLI está na imagem, sem reiniciar serviços.
docker compose --env-file ./env/compose.env -f compose.vps.yml build seller-ml-web seller-ml-worker
./business-db-ops.sh backup
./business-db-ops.sh audit-partition-status

# Afirmações operacionais exigidas pelo preflight; preencha a capacidade medida em bytes.
AUTH_AUDIT_PARTITION_BACKUP_RESTORED=YES \
AUTH_AUDIT_PARTITION_MAINTENANCE_WINDOW=YES \
AUTH_AUDIT_PARTITION_CAPACITY_CONFIRMED=YES \
AUTH_AUDIT_PARTITION_AVAILABLE_BYTES=<bytes_livres_medidos> \
./business-db-ops.sh audit-partition-preflight
```

O status e o preflight são gates: não avance se algum checklist falhar. Para conferir comandos sem escrita, acrescente `--dry-run`, por exemplo `./business-db-ops.sh audit-partition-swap --dry-run` (a confirmação continua obrigatória para swap/rollback).

Depois do preflight aprovado, anuncie a manutenção, espere os jobs Seller/ML concluírem e pare somente os serviços que escrevem auditoria. PostgreSQL, Redis e proxy permanecem de pé:

```bash
docker compose --env-file ./env/compose.env -f compose.vps.yml stop seller-ml-web seller-ml-worker
AUTH_AUDIT_PARTITION_CONFIRM=COPY ./business-db-ops.sh audit-partition-copy
./business-db-ops.sh audit-partition-verify
AUTH_AUDIT_PARTITION_CONFIRM=SWAP ./business-db-ops.sh audit-partition-swap
docker compose --env-file ./env/compose.env -f compose.vps.yml up -d --no-build seller-ml-web seller-ml-worker
```

`copy`, `verify` e `swap` são gates independentes. Não pule `verify`; ele compara contagem, intervalos, checksums mensais, relações e formato da tabela antes da troca atômica.

## Smoke test e observação

Após iniciar web/worker, valide healthchecks, login do Seller/ML, leitura da auditoria no Master, escrita de um evento não sensível de teste e jobs comuns. Confirme também no status que a tabela ativa é particionada e que o ledger registra a operação.

Mantenha a tabela legacy por no mínimo 48 horas. Nesse período, observe erros, crescimento e consultas de auditoria. A retenção dinâmica continua usando `ml.auth_audit_retention_rules`; o scheduler primeiro executa a limpeza existente e mantém o drop de partição em `--dry-run` até futura aprovação operacional.

Somente após as 48 horas, smoke tests estáveis e um novo backup fresco com restore testado pode ser planejada uma mudança separada para remover a legacy. Não a remova nesta janela de corte.

## Rollback

Rollback só é possível enquanto a legacy existe. Primeiro inspecione:

```bash
./business-db-ops.sh audit-partition-status
AUTH_AUDIT_PARTITION_CONFIRM=ROLLBACK ./business-db-ops.sh audit-partition-rollback --dry-run
```

Se não houve escrita após o swap e o marker é inequívoco, execute:

```bash
AUTH_AUDIT_PARTITION_CONFIRM=ROLLBACK ./business-db-ops.sh audit-partition-rollback
```

Se houve escrita após o swap, o CLI recusa o rollback para evitar perda. Só um responsável que aceite explicitamente a perda dessas escritas pode usar `AUTH_AUDIT_PARTITION_ALLOW_DATA_LOSS=YES` junto da confirmação `ROLLBACK`; registre essa decisão e restaure os serviços após a operação.
