# DACH Ads — Etapa 4: Meta Ads read-only

Esta entrega deve ser aplicada **sobre o projeto que já contém as Etapas 1, 1.1, 2 e 3**.

## O que entra

- OAuth Meta;
- descoberta de Business Portfolios;
- descoberta e seleção de contas de anúncio;
- armazenamento criptografado do token Meta no mesmo Token Vault do DACH Ads;
- sincronização assíncrona de campanhas, conjuntos, anúncios e criativos;
- Insights diários em nível de conta, campanha, conjunto e anúncio;
- preservação das `actions` da Meta por tipo;
- tela Meta Ads dentro do shell DACH Ads;
- worker compartilhado Google + Meta com alternância entre providers;
- migration `003_meta_ads.sql`.

## Decisão importante sobre conversões Meta

A Meta pode retornar várias `actions` para a mesma entrega (lead, purchase, messaging, landing page view etc.).

A Etapa 4 **não soma tudo e chama de conversão**. Os eventos são persistidos em `ads_meta_action_metrics_daily` por `action_type`.

Na Etapa 5, o DACH Ads poderá definir qual resultado deve ser tratado como conversão principal para cada workspace/conta antes de comparar Meta x Google.

## Variáveis novas

Adicione ao `infra/env/ads.env` quando for configurar a Meta:

```env
META_APP_ID=
META_APP_SECRET=
META_REDIRECT_URI=https://staging.dachbyte.tech/ads/api/meta/oauth/callback
META_GRAPH_API_VERSION=v26.0
META_OAUTH_SCOPES=ads_read,business_management
META_OAUTH_STATE_TTL_SECONDS=600
ADS_META_INITIAL_LOOKBACK_DAYS=90
ADS_META_RECENT_LOOKBACK_DAYS=14
ADS_META_SYNC_INTERVAL_MINUTES=120
```

Não é necessário preencher agora para aplicar a etapa. Enquanto estiver vazio, a tela Meta mostrará `Configuração pendente` e o restante do DACH Ads continua funcionando.

`ADS_TOKEN_ENCRYPTION_KEY` é a mesma chave já criada para Google. **Não gere outra chave**, ou os tokens Google já persistidos deixariam de ser descriptografáveis.

## Meta Developers — quando formos configurar

Criaremos um app Meta e cadastraremos como callback:

```text
https://staging.dachbyte.tech/ads/api/meta/oauth/callback
```

A integração desta etapa é read-only e pede:

```text
ads_read
business_management
```

Não solicita `ads_management`.

A versão padrão implementada é Graph API `v26.0`, configurável por env.

## Banco

Execute o migrator normalmente. Ele detecta a migration nova:

```bash
docker compose --env-file infra/env/compose.env \
  -f infra/compose.vps.yml \
  --profile ops run --rm ads-migrate
```

A migration cria/estende:

- colunas Meta em `ads_metrics_daily` (`reach`, `frequency`, clicks específicos etc.);
- `ads_meta_businesses`;
- `ads_meta_creatives`;
- `ads_meta_action_metrics_daily`;
- RLS de tenant nas novas tabelas.

## Containers

Como há código novo no API e no worker, faça rebuild quando aplicar na VPS:

```bash
docker compose --env-file infra/env/compose.env \
  -f infra/compose.vps.yml \
  up -d --build ads-api ads-worker
```

## Testes automatizados desta entrega

Na geração do pacote:

```text
npm run ads:test          19/19 OK
npm run test:architecture 18/18 OK
node -c novos JS          OK
```

Os testes reais de OAuth, Business, contas e Insights ficarão para a bateria final que será executada depois de concluirmos todas as etapas, conforme combinado.
