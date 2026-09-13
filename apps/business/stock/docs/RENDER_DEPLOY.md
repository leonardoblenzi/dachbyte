# Deploy no Render

Repositorio: `https://github.com/aRFialho/VoltStock.git`

## Banco

O banco deve ser Neon PostgreSQL. As migrations e seeds ja foram validadas localmente com:

```bash
npm.cmd run db:seed
```

Em novos ambientes, rode antes do primeiro deploy da API:

```bash
npm install
npm run db:migrate
npm run db:seed
```

Nunca coloque a URL real do banco no Git. Use variaveis de ambiente no Render.

## Blueprint

O arquivo `render.yaml` define:

- `voltstock-api`: API Fastify.
- `voltstock-web`: Web Next.js.
- `voltstock-worker`: worker placeholder para filas/jobs.
- `voltstock-cron`: cron placeholder para rotinas periodicas.

## Variaveis da API

Configure no servico `voltstock-api`:

```text
NODE_ENV=production
DATABASE_URL=<Neon PostgreSQL URL com sslmode=require>
JWT_SECRET=<segredo forte>
JWT_REFRESH_SECRET=<outro segredo forte>
QR_HMAC_SECRET=<segredo forte para QR>
CORS_ORIGINS=https://<dominio-do-web-render>
API_PUBLIC_URL=https://<dominio-da-api-render>
WEB_PUBLIC_URL=https://<dominio-do-web-render>
```

## Variaveis do Web

Configure no servico `voltstock-web`:

```text
NODE_ENV=production
NEXT_PUBLIC_API_URL=https://<dominio-da-api-render>
```

## Ordem recomendada

1. Criar Blueprint no Render apontando para o GitHub.
2. Configurar `DATABASE_URL` e segredos da API.
3. Configurar `NEXT_PUBLIC_API_URL` no Web.
4. Deploy da API.
5. Deploy do Web.
6. Testar `/health` na API.
7. Testar login em `/login` no Web.

Login bootstrap:

```text
admin@voltstock.com
Stock@172839
```

Troque a senha antes de liberar qualquer acesso externo.
