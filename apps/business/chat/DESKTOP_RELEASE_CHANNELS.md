# VoltChat desktop: staging e producao

O desktop agora possui dois canais isolados. O canal `staging` existe para validar a VPS antes de qualquer publicacao oficial. Ele nao compartilha identidade do aplicativo, pasta de dados local nem `latest.json` com a instalacao de producao.

## Configuracao na maquina Windows de build

Na pasta `sordchat-frontend`, copie `.env.desktop.example` para `.env.desktop` e preencha a URL publica do R2. As credenciais de escrita (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` e `R2_BUCKET_NAME`) continuam vindo do ambiente/processo ou dos `.env` ja usados pelos scripts do backend e nao devem ser versionadas. As URLs de staging ja possuem defaults para `https://staging.dachbyte.tech/business/chat/` e `/business/chat/api`.

As URLs de producao sao obrigatorias no build oficial. O script nao gera um instalador oficial se `VOLTCHAT_PRODUCTION_WEB_URL` ou `VOLTCHAT_PRODUCTION_API_URL` estiverem vazias.

## Build interno de staging

```powershell
npm run desktop:staging:dist
```

Artefatos:

- aplicativo: `VoltChat Staging`
- appId: `com.voltcorp.app.staging`
- diretorio: `dist-desktop-staging`
- instalador: `VoltChat-Staging-Setup-<versao>.exe`
- updater: `<R2_PUBLIC_BASE_URL>/<R2_STAGING_RELEASE_PREFIX>/windows/latest.json`
- prefixo R2 default: `desktop/staging/releases`

Para publicar somente no canal interno:

```powershell
npm run desktop:staging:publish
```

ou:

```powershell
npm run desktop:staging:release
```

Isso nunca altera `desktop/releases/windows/latest.json`.

## Build oficial

Confirme primeiro as URLs definitivas em `.env.desktop`:

```env
VOLTCHAT_PRODUCTION_WEB_URL=https://SEU-DOMINIO/business/chat/
VOLTCHAT_PRODUCTION_API_URL=https://SEU-DOMINIO/business/chat/api
```

Gere o instalador:

```powershell
npm run desktop:production:dist
```

A publicacao oficial e bloqueada por padrao. Depois do gate final:

```env
CONFIRM_DESKTOP_PRODUCTION_PUBLISH=YES
```

entao:

```powershell
npm run desktop:production:publish
```

O canal oficial usa `R2_RELEASE_PREFIX`, default `desktop/releases`.

## Isolamento

O build de staging usa outra identidade do instalador e a pasta de dados `%APPDATA%\\VoltChat Staging`. Assim ele nao reaproveita cookies, sessao criptografada, cache Chromium ou dados locais do VoltChat oficial.

O Electron tambem embute `electron/runtime-config.json`, contendo canal, URL web e URL da API escolhidas no momento do build. Em runtime, somente variaveis de ambiente explicitamente configuradas podem sobrescrever esses valores.
