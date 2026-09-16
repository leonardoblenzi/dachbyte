# DACHBYTE Chat

Chat corporativo com frontend React/Electron e API FastAPI separada.

## Arquitetura VPS

- Web: container `business-chat`.
- API: container `business-chat-api`.
- Uvicorn: **um worker** enquanto WebSocket e jobs permanecerem em memoria.
- Banco: PostgreSQL local da VPS.
- Uploads: banco/volume persistente no primeiro corte.
- Updater desktop: Cloudflare R2, independente da VPS.

Rotas publicas canonicas:

```text
/business/chat
/business/chat/api
```

WebSocket usa o mesmo host da API canonica, por exemplo:

```text
wss://DOMINIO/business/chat/api/messages/ws/<token>
```

`/chat`, `/chat-api` e `/business/chat-api` existem somente como compatibilidade. A interface `/chat/*` redireciona para `/business/chat/*`; APIs antigas continuam em proxy e recebem headers de deprecacao.

## Variaveis importantes

O backend ativo consome os nomes reais abaixo:

```env
ENVIRONMENT=production
DATABASE_URL=postgresql://...
SECRET_KEY=...
VOLT_CHAT_ADMIN_PASSWORD=...
AUTO_MIGRATE_DB=false
AUTO_SEED_USERS=false
```

Em producao nao existem defaults seguros para segredo/admin. O bootstrap cria o admin somente quando ele ainda nao existe e nunca deve sobrescrever senha ou privilegios de uma conta existente.

O frontend e compilado com:

```env
VOLT_CHAT_PUBLIC_PATH=/business/chat
VOLT_CHAT_PUBLIC_API_URL=/business/chat/api
```

## Banco e migrations

As migrations ficam em `backend/db/migrations`. Na VPS elas sao executadas pelo job one-shot da infraestrutura, depois de snapshot/backup; o startup normal da API nao deve ser usado como mecanismo principal de migration.

Consulte `infra/DB_MIGRATION_VPS.md`.

## Desktop

Use os comandos/canais definidos em `DESKTOP_RELEASE_CHANNELS.md`.

Staging e production possuem appId, dados locais e prefixos R2 diferentes para impedir que uma versao interna atualize ou sobrescreva o desktop oficial.

## Releases e updater

O manifesto oficial permanece em R2 e nao depende do servidor web. Clientes antigos que ainda consultem endpoints de compatibilidade devem continuar funcionando durante a janela de deprecacao.

## Validacao

O gate de staging/producao verifica login, WebSocket, reconexao, upload/download, recuperacao de senha, Hub e compatibilidade das rotas. Veja `infra/STAGING_VALIDATION.md`.
