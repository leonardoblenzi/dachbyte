# DACH Ads — Etapa 1: Fundação

Copie o conteúdo desta pasta sobre a raiz do projeto DACHBYTE, preservando os caminhos.

## O que entra nesta etapa

- novo bounded context `apps/ads`;
- landing pública `/ads`;
- app protegido `/ads/app`, já dependente de uma porta de identidade Hub-ready;
- modo de identidade de desenvolvimento bloqueado automaticamente em produção;
- worker separado com heartbeat Redis;
- banco `dachbyte_ads` com roles separadas de migration, app e worker;
- migration inicial multi-tenant com RLS;
- serviços `ads-api`, `ads-worker` e `ads-migrate` no Compose;
- rota `/ads` no Caddy;
- Ads no header e em “Explorar produtos” das landings compartilhadas Seller/Business;
- branding público `Dach Ads`;
- testes de arquitetura/fundação.

## Arquivos de ambiente

Crie, a partir dos exemplos:

- `infra/env/ads.env`
- `infra/env/ads-migrate.env`

E adicione as novas variáveis/senhas de Ads ao seu `infra/env/postgres.env` com base no `postgres.env.example` atualizado.

Não use `ADS_AUTH_MODE=development` em produção. Nesta etapa o app autenticado fica deliberadamente bloqueado em produção até a integração com o Hub.

## Provisionamento local/VPS

Depois de configurar as senhas:

```bash
docker compose --env-file infra/env/compose.env -f infra/compose.vps.yml --profile ops run --rm postgres-provision
docker compose --env-file infra/env/compose.env -f infra/compose.vps.yml --profile ops run --rm ads-migrate
docker compose --env-file infra/env/compose.env -f infra/compose.vps.yml up -d --build ads-api ads-worker caddy
```

Antes de executar em produção, valide o `docker compose config` usando seus arquivos `.env` reais.

## Validações executadas nesta entrega

- `node --check` nos novos processos e no shell de landing;
- testes específicos de Ads + landing + branding + VPS: 22/22 aprovados;
- `npm run test:architecture`: 18/18 aprovados;
- parse de `infra/compose.vps.yml`: aprovado;
- `bash -n infra/postgres/provision-business.sh`: aprovado;
- consistência do `package-lock.json` via npm offline: aprovada.

## Próxima etapa

Etapa 2: Google Ads — OAuth, vault de credenciais, descoberta de MCC/contas, sincronização por worker, campanhas, palavras-chave, termos de pesquisa, métricas diárias e primeiro dashboard real.
