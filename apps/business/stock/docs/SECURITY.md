# Segurança

## Decisoes aplicadas

- Banco por migrations SQL diretas em `database/migrations`, sem Prisma.
- `tenant_id` em tabelas operacionais e politicas RLS usando `app.current_tenant_id`.
- API define contexto de tenant por transacao com `set_config`.
- Login usa hash de senha via `pgcrypto` (`crypt`/`gen_salt`) no PostgreSQL.
- QR interno usa UUID + assinatura HMAC e nao expoe ID sequencial.
- Operacoes criticas criam `audit_logs`.
- Listagens implementadas com paginacao.
- O seed do admin master grava hash, nao senha em texto puro no banco.

## Audit npm

As vulnerabilidades criticas iniciais vinham de `@fastify/jwt`/`fast-jwt` e foram removidas atualizando `@fastify/jwt` para `10.1.0`.

Risco residual atual:

- `next@15.5.19` declara internamente `postcss@8.4.31`, que o `npm audit` marca como vulnerabilidade moderada.
- `postcss@8.5.10` foi instalado diretamente no workspace web, mas o pacote interno do Next continua fixado em `8.4.31`.
- Nao apliquei `npm audit fix --force` porque o npm sugere downgrade major para `next@9.3.3`, inadequado e inseguro para esta base.

Mitigacao operacional:

- Nao aceitar CSS arbitrario de usuario em templates, etiquetas ou campos customizaveis.
- Monitorar nova versao do Next que atualize a dependencia interna de `postcss`.
- Reexecutar `npm.cmd audit` antes de deploy.
