# Volt Stock

Plataforma SaaS multitenant para controle de estoque visual com mapa 2D/3D, QR Code, bipagem inteligente, auditoria e operação web/desktop/Android.

Esta base segue a documentação em `Volt_Stock_Documentacao_Completa_Atualizada.docx` e mantém o banco por scripts SQL diretos, sem Prisma.

## Estrutura

- `apps/api`: API Node.js + TypeScript + Fastify.
- `apps/web`: Web app Next.js + React + TypeScript.
- `apps/desktop`: placeholder técnico para Tauri + React.
- `apps/mobile`: placeholder técnico para React Native/Expo.
- `database/migrations`: migrations SQL versionadas.
- `database/seeds`: seeds SQL, incluindo admin master inicial.
- `packages/shared`: contratos, permissões e schemas compartilhados.
- `scripts/run-sql.mjs`: executor direto de migrations/seeds via `pg`.

## Login base

- E-mail: `admin@voltstock.com`
- Senha inicial: `Stock@172839`

Use este login apenas para bootstrap e altere a senha em produção.

## Comandos

```bash
npm.cmd install
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run dev
```

No PowerShell desta máquina, use `npm.cmd` porque `npm.ps1` está bloqueado pela política de execução.

## Segurança e banco

- Todas as tabelas operacionais usam `tenant_id`.
- Migrations SQL habilitam `pgcrypto`, `citext` e políticas RLS por tenant.
- A API define `app.current_tenant_id` e `app.current_user_id` em transações.
- QR Codes usam UUID + assinatura HMAC e não expõem IDs sequenciais.
- Senhas são validadas no PostgreSQL com `crypt(...)` do `pgcrypto`.
