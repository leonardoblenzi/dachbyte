# DACH Ads — Etapa 6 — Patch do projeto DACH

Este pacote é **incremental** e deve ser copiado por cima do projeto DACH que já contém as Etapas 1–5.

## Objetivo

Conectar o DACH Ads ao Hub externo como única fonte de identidade e autorização em produção, sem criar login, assinatura ou billing próprios dentro do Ads.

Fluxo esperado:

```text
/login
  -> Gateway DACH
  -> Hub autentica/resolve identidade
  -> suite_auth_token
  -> /go/ads
  -> Hub /v1/access/check (dach_ads)
  -> /ads/app
  -> Ads API valida JWT compartilhado
  -> Ads API revalida dach_ads no Hub
```

O DACH Ads permanece responsável apenas por seus dados de produto: workspaces, Google Ads, Meta Ads, analytics, regras FZ e findings.

## Pré-requisito obrigatório

**Aplique primeiro o pacote do Hub da Etapa 6 e execute a migration `056_dach_ads_product_access.sql`.**

Se o projeto DACH for publicado antes de o Hub conhecer `dach_ads`, o acesso será negado/indisponível por desenho (`fail closed`).

## Arquivos alterados

- `apps/ads/app.js`
- `apps/ads/application/ports/IdentityProvider.js`
- `apps/ads/config/env.js`
- `apps/ads/http/middleware/requireIdentity.js`
- `apps/ads/infrastructure/identity/createIdentityProvider.js`
- `apps/ads/infrastructure/identity/HubIdentityProvider.js`
- `apps/gateway/server.js`
- `apps/seller-ml/views/selecao-plataforma.html`
- `infra/env/ads.env.example`
- `package.json`
- `package-lock.json`
- `routes/suiteAuthRoutes.js`
- `tests/ads-foundation.test.js`
- `tests/ads-hub-stage6.test.js`

## 1. Copiar os arquivos

Copie o conteúdo deste ZIP por cima da raiz do projeto DACH, preservando os caminhos.

## 2. Dependência nova

A Etapa 6 usa `jsonwebtoken` dentro do `ads-api` para validar `suite_auth_token`.

Depois de copiar:

```bash
npm install
```

ou use o processo normal de build da VPS, que executa a instalação de dependências da imagem.

## 3. Configuração obrigatória do Ads

No arquivo real `infra/env/ads.env`, confirme:

```env
ADS_AUTH_MODE=hub
ADS_HUB_MODULE=dach_ads
SUITE_JWT_SECRET=O_MESMO_SEGREDO_USADO_PELO_GATEWAY
```

**Não gere um novo `SUITE_JWT_SECRET`.** O Ads deve validar exatamente o JWT emitido pelo Gateway.

O `ads-api` já carrega `infra/env/hub.env` pelo Compose. Esse arquivo deve continuar contendo as credenciais internas existentes do Hub:

```env
HUB_BASE_URL=https://SEU_HUB
HUB_INTERNAL_TOKEN=SEU_TOKEN_INTERNO
```

Não coloque tokens Google/Meta no Hub.

## 4. Rebuild/recreate

Como houve dependência nova e alteração no Gateway/Ads, faça rebuild:

```bash
docker compose --env-file infra/env/compose.env \
  -f infra/compose.vps.yml \
  up -d --build --force-recreate gateway ads-api ads-worker
```

Se sua operação usa outro procedimento de deploy, preserve o mesmo princípio: reconstruir Gateway e imagem Ads.

## 5. Comportamento esperado

- usuário anônimo em `/ads/app` -> redirecionado para `/login`;
- usuário autenticado sem `dach_ads` -> acesso negado;
- usuário com produto instalado + permissão explícita -> acesso permitido;
- Hub indisponível -> Ads responde indisponível, sem liberar acesso por cache/JWT antigo;
- `/go/ads` passa a existir no Gateway;
- `dach_ads` passa a participar do login global e da seleção de produtos.

## 6. Não fazer agora

- não criar usuário/senha próprios no Ads;
- não criar cobrança no Ads;
- não duplicar plano/preço do Hub;
- não colocar `ADS_AUTH_MODE=development` em produção;
- não mover tokens Google/Meta para o Hub.

## Validação automatizada executada nesta entrega

```text
npm run ads:test           -> 27/27 aprovados
npm run test:architecture  -> 18/18 aprovados
```

Os testes reais de navegador/VPS serão executados na bateria final combinada, conforme combinado.
