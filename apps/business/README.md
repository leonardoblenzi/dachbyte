# DACHBYTE Business

Suite operacional com produtos independentes por container na VPS.

## Produtos e containers

- `business-core`: Core, gestao operacional e extensoes por segmento.
- `business-chat`: frontend web/desktop do Chat.
- `business-chat-api`: FastAPI do Chat, Uvicorn com um worker.
- `business-stock`: Stock web/API.
- `business-price`: Price web/API.
- `business-portal`: portal Business.

O edge publico e o Caddy versionado em `infra/Caddyfile`. O deploy da VPS usa `infra/compose.vps.yml`; `app.js`/`server.js` permanecem apenas como compatibilidade do modelo agregado antigo e nao fazem parte do caminho normal do Chat API na VPS.

## Rotas canonicas

| Produto | Interface | API |
| --- | --- | --- |
| Core | `/business/core` | `/business/core/api` |
| Chat | `/business/chat` | `/business/chat/api` |
| Stock | `/business/stock` | `/business/stock/api` |
| Price | `/business/price` | `/business/price/api` |

As interfaces antigas `/core`, `/chat`, `/voltstock` e `/volt-price` redirecionam com HTTP 308 para as rotas canonicas. APIs antigas continuam temporariamente em proxy para compatibilidade; consulte `infra/LEGACY_DEPRECATION.md`.

## Banco

A arquitetura alvo usa PostgreSQL local na VPS. O provisionamento, import inicial e migrations ficam separados do startup da aplicacao:

```bash
cd infra
./business-db-ops.sh provision
./business-db-ops.sh import
./business-db-ops.sh migrate
./business-db-ops.sh verify
```

Nao habilite migration automatica no runtime de producao. Core, Stock e Price separam credenciais de runtime e migration; a aplicacao nao deve receber a role administrativa.

## Staging e producao

Staging:

```bash
cd infra
./business-staging-ops.sh config
./business-staging-ops.sh status
./business-staging-ops.sh db
./business-staging-ops.sh smoke
```

Producao:

```bash
./business-production-ops.sh preflight
./business-production-ops.sh prepare
./business-production-ops.sh cutover
./business-production-ops.sh smoke
```

O corte nao importa banco, nao executa migrations e nao publica desktop automaticamente.

## Chat desktop

O desktop possui canais separados de staging e production. Build/publicacao continuam no Windows e o updater permanece no R2, independente da VPS. Veja `chat/DESKTOP_RELEASE_CHANNELS.md`.

## Legado

O Caddy registra um access log JSON isolado para medir somente rotas antigas. Ele guarda apenas o path sanitizado (`legacy_path`), sem query string, headers ou IPs, e redige para `REDACTED` o token presente no caminho dos WebSockets do Chat:

```bash
cd infra
./business-legacy-ops.sh report
```

APIs legadas so devem ser removidas depois de uma janela de observacao representativa sem trafego e com retencao de logs suficiente.
