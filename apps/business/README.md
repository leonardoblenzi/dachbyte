# Davantti Business

Linha de produtos para gestao interna de empresas.

## Produtos

- `volt_core`: vendas, estoque, clientes, ordens de servico, relatorios e modulos por segmento.
- `volt_stock`: estoque operacional, enderecamento, bipagem, inventario e auditoria.
- `volt_chat`: workspace de chat, tickets, kanban e operacao interna.
- `volt-corp`: suite operacional. Deve manter os produtos irmaos no mesmo padrao visual e de navegacao.

## Servidor Volt Corp

O diretorio `business` e a entrada geral do Render para a marca Volt Corp.
Ele possui `server.js` e `app.js`, seguindo a ideia do servidor raiz da suite:

- `/` fica reservado para a landing institucional da Volt Corp.
- `/health` e `/healthz` validam o servico geral.
- `/core`, `/core/app` e `/api/core` sao entregues pelo produto `volt_core`.
- `/stock` direciona para `/voltstock`, que entrega a landing do `volt_stock`; telas internas protegidas exigem sessao.
- `/chat` entrega a landing e o frontend compilado do `volt_chat`; `/voltchat` e `/volt_chat` direcionam para `/chat`.
- `/voltstock/login` e `/chat/login` ficam como entradas diretas de autenticacao dos modulos.
- O `volt_chat` usa `/chat-api`, que encaminha HTTP e WebSocket para a API FastAPI interna do mesmo servico `volt-corp`.

No Render, o servico central da Volt Corp deve apontar para:

- Root Directory: `business`
- Build Command: `python3 -m venv .venv-voltchat && .venv-voltchat/bin/pip install -r volt_chat/backend/requirements.txt && npm install --workspaces=false --package-lock=false --no-save && npm run build`
- Start Command: `npm start`
- Health Check Path: `/health`

O `npm start` aplica as migrations do Volt Core e inicia a API FastAPI do VoltChat internamente em `127.0.0.1:8001`. O processo Node entrega o frontend em `/chat`, encaminha a API em `/chat-api` e tambem encaminha os upgrades WebSocket. Nao existe servico Render separado para o VoltChat.

No build central, o `volt_core` e obrigatorio. `volt_stock` e `volt_chat` podem ser marcados como obrigatorios no Render:

- `VOLT_STOCK_REQUIRED=true`
- `VOLT_CHAT_REQUIRED=true`

Para acelerar um deploy inicial somente com Volt Core, desative o build dos produtos opcionais:

- `VOLT_STOCK_BUILD=false`
- `VOLT_CHAT_BUILD=false`

O comando `npm run migrate` no diretorio `business` aplica as migrations do Volt Core. O backend do VoltChat aplica suas migrations idempotentes no startup com `AUTO_MIGRATE_DB=true`.

Configuracao do VoltChat dentro de `volt-corp`:

- `VOLT_CHAT_DATABASE_URL`: banco exclusivo do chat; obrigatorio em producao.
- `VOLT_CHAT_SECRET_KEY`: segredo JWT exclusivo do chat; obrigatorio em producao.
- `VOLT_CHAT_UPSTREAM_URL=http://127.0.0.1:8001`: destino interno do proxy.
- `VOLT_CHAT_PUBLIC_API_URL=/chat-api`
- `VOLT_CHAT_PUBLIC_WS_URL`: opcional; por padrao e calculada a partir do host atual.
- `VOLT_CHAT_DESKTOP_DOWNLOAD_URL`: URL HTTPS publica do instalador em armazenamento externo. Quando configurada, o site e a API redirecionam o download sem carregar o binario no Render.
- `VOLT_CHAT_DESKTOP_PACKAGE_URL`: URL HTTPS publica do ZIP com instalador, certificado e guia. O botao da landing page redireciona para esta URL.
- `VOLT_CHAT_PUBLIC_PATH` quando o modulo nao for servido em `/chat`

## Direcao

`business` centraliza produtos operacionais. Cada produto pode ter app, banco, modulos e deploy proprios, mas deve compartilhar conceitos de ecossistema quando fizer sentido: empresas, usuarios, planos, billing e identidade Davantti.
