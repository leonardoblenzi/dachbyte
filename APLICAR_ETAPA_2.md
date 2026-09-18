# DACH Ads — Etapa 2: Google Ads read-only

Esta etapa parte da **Etapa 1 + Etapa 1.1 Visual** já aplicadas.

## O que entra agora

- OAuth Google Ads com autorização offline;
- armazenamento de `access_token` e `refresh_token` criptografados com AES-256-GCM;
- descoberta de contas Google Ads diretas e contas abaixo de MCC;
- seleção explícita das contas anunciantes a sincronizar;
- worker assíncrono de coleta;
- backfill inicial de 90 dias (configurável);
- atualização recorrente da janela recente;
- modelo normalizado para campanhas, grupos, anúncios, palavras-chave, ações de conversão, métricas diárias e termos de pesquisa;
- tela Google Ads dentro do shell visual DACH Ads White/Dark;
- integração **somente leitura**. Nenhuma alteração de campanha é enviada ao Google nesta etapa.

## 1. Aplicar os arquivos

Copie o conteúdo deste ZIP sobre a raiz do projeto DACHBYTE, preservando as pastas.

Nenhum arquivo da Etapa 1/1.1 deve ser removido.

## 2. Configurar `infra/env/ads.env`

Use `infra/env/ads.env.example` como referência.

Além das variáveis já existentes, configure:

```env
DATABASE_URL=postgresql://dachbyte_ads_app:SENHA@postgres:5432/dachbyte_ads
ADS_WORKER_DATABASE_URL=postgresql://dachbyte_ads_worker:SENHA@postgres:5432/dachbyte_ads
REDIS_URL=redis://redis:6379
ADS_AUTH_MODE=hub

ADS_TOKEN_ENCRYPTION_KEY=CHAVE_DE_32_BYTES_EM_BASE64

GOOGLE_ADS_CLIENT_ID=
GOOGLE_ADS_CLIENT_SECRET=
GOOGLE_ADS_REDIRECT_URI=https://SEU_DOMINIO/ads/api/google/oauth/callback
GOOGLE_ADS_API_VERSION=v25

ADS_GOOGLE_INITIAL_LOOKBACK_DAYS=90
ADS_GOOGLE_RECENT_LOOKBACK_DAYS=14
ADS_GOOGLE_SYNC_INTERVAL_MINUTES=120
ADS_SYNC_WORKER_POLL_MS=10000
ADS_SYNC_JOB_LOCK_MINUTES=30
```

Gere a chave de criptografia uma única vez e guarde-a também no backup seguro de segredos:

```bash
openssl rand -base64 32
```

**Não troque essa chave depois de conectar contas sem executar uma rotação planejada**, pois ela é necessária para descriptografar os tokens já armazenados.

## 3. Google Cloud

No projeto Google Cloud usado pelo DACH Ads:

1. habilite a **Google Ads API**;
2. configure a tela de consentimento OAuth da aplicação;
3. crie credenciais OAuth do tipo **Web application**;
4. adicione exatamente a URI de retorno usada no ambiente:

```text
https://SEU_DOMINIO/ads/api/google/oauth/callback
```

5. coloque o Client ID e Client Secret em `ads.env`;
6. confirme que o projeto Google Cloud possui o nível de acesso necessário à Google Ads API.

### Developer token

Desde **09/09/2026**, o Google Ads API não usa mais developer token como fonte do nível de acesso. O acesso é associado ao projeto Google Cloud das credenciais OAuth. A variável `GOOGLE_ADS_DEVELOPER_TOKEN` continua opcional apenas por compatibilidade e pode ficar vazia.

### Versão da API

A etapa usa **v25**. Não reduza para v22: ela está em processo de sunset em outubro/2026.

## 4. Executar a migration 002

Na VPS:

```bash
docker compose --env-file infra/env/compose.env -f infra/compose.vps.yml --profile ops run --rm ads-migrate
```

O migrator aplica automaticamente somente migrations ainda não registradas em `schema_migrations`.

A migration `002_google_ads.sql` cria a camada read-only do Google Ads e mantém RLS nos dados de tenant.

## 5. Rebuild / restart

Depois da migration:

```bash
docker compose --env-file infra/env/compose.env -f infra/compose.vps.yml build ads-api ads-worker

docker compose --env-file infra/env/compose.env -f infra/compose.vps.yml up -d ads-api ads-worker
```

Verifique:

```bash
docker compose --env-file infra/env/compose.env -f infra/compose.vps.yml ps ads-api ads-worker
```

Health:

```text
/ads/healthz
```

## 6. Autenticação / Hub

O DACH Ads **continua sem login próprio**.

Em produção `ADS_AUTH_MODE=hub` permanece como fronteira obrigatória. Como a integração efetiva do Hub será feita em uma etapa posterior, não habilite `ADS_AUTH_MODE=development` na VPS de produção apenas para testar OAuth.

Para desenvolvimento local controlado, pode usar:

```env
NODE_ENV=development
ADS_AUTH_MODE=development
```

A Etapa Hub posteriormente conectará esta mesma interface sem alterar o domínio Google Ads.

## 7. Como funciona o fluxo

```text
Usuário DACH
   ↓
/ads/app/google
   ↓
Conectar Google Ads
   ↓
OAuth Google
   ↓
DACH grava tokens criptografados
   ↓
Descobre contas diretas + MCC
   ↓
Usuário seleciona contas anunciantes
   ↓
ads_sync_jobs
   ↓
ads-worker
   ↓
Google Ads API v25
   ↓
PostgreSQL DACH Ads
```

As contas MCC são usadas para descoberta e **não são selecionáveis como alvo de sincronização**.

## 8. Dados coletados nesta etapa

- campanhas;
- grupos de anúncios;
- anúncios (estrutura);
- palavras-chave e correspondência;
- ações de conversão;
- métricas diárias de conta/campanha/grupo/keyword;
- termos de pesquisa e suas métricas;
- status e histórico da sincronização.

Os dashboards analíticos completos entram na **Etapa 3**. Nesta etapa o objetivo é construir uma camada de dados confiável antes dos gráficos.

## 9. Segurança aplicada

- tokens nunca são enviados ao frontend;
- refresh token é criptografado em repouso;
- OAuth `state` é single-use e expira no Redis;
- API e worker usam roles PostgreSQL separadas;
- métricas e credenciais continuam protegidas por RLS;
- worker serializa a coleta por jobs para evitar bursts desnecessários contra a API;
- integração Google é read-only nesta etapa.

## 10. Testes

Execute:

```bash
npm run ads:test
npm run test:architecture
```

Validação realizada na entrega:

- `ads:test`: **10/10** aprovados;
- `test:architecture`: **18/18** aprovados.

## Próxima etapa

**Etapa 3 — Analytics Google Ads**

Usará as tabelas criadas agora para entregar:

- período 7/14/30 dias e personalizado;
- comparação com período anterior;
- investimento;
- impressões;
- cliques;
- CTR;
- CPC;
- conversões;
- CPA;
- valor de conversão;
- ROAS;
- análise por campanha;
- palavras-chave;
- termos de pesquisa;
- leitura de ações de conversão;
- base para os primeiros diagnósticos FZ.
