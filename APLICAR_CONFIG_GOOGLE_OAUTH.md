# DACH Ads — Configuração OAuth Google (staging)

Este pacote separa os segredos do Google Ads do `ads.env` principal para não sobrescrever as senhas de banco já configuradas.

## Arquivos

- `infra/env/ads-google.env` — já preenchido com as credenciais OAuth do projeto Google Cloud enviado e uma nova chave AES-256 de 32 bytes para o vault de tokens. **Não versionar.**
- `infra/env/ads-google.env.example` — modelo seguro para Git.
- `infra/env/ads.env.example` — atualizado para deixar somente runtime/sync e apontar os segredos para o arquivo separado.
- `infra/compose.vps.yml` — `ads-api` e `ads-worker` agora carregam `ads-google.env` além de `ads.env` e `hub.env`.

## Aplicação

Copie os arquivos por cima da raiz do projeto. **Não substitua o seu `infra/env/ads.env` real**; este pacote não contém esse arquivo justamente para preservar suas credenciais do PostgreSQL.

Depois, na VPS:

```bash
docker compose --env-file infra/env/compose.env -f infra/compose.vps.yml up -d --force-recreate ads-api ads-worker
```

Não é necessário rebuild apenas por alteração de env/Compose, a menos que haja outras mudanças de código pendentes.

## Segurança

O arquivo real `infra/env/ads-google.env` já é coberto pelo `.gitignore` (`infra/env/*.env`). Faça backup seguro da `ADS_TOKEN_ENCRYPTION_KEY`: se ela for perdida depois de conectar contas, os tokens armazenados não poderão ser descriptografados.

Como o Client Secret foi compartilhado durante esta configuração, use esta credencial no staging agora e **gere/rotacione um Client Secret novo antes de produção**.
