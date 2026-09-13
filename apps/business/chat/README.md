# Volt Corp

Workspace para comunicacao, tarefas e suporte interno, com web app, API FastAPI, banco Neon/Postgres e build desktop via Electron.

## Rodando localmente

Backend:

```powershell
cd backend
python -m pip install -r requirements.txt
python start_server.py
```

Frontend:

```powershell
cd sordchat-frontend
npm install
npm start
```

Acesse `http://127.0.0.1:3000`.

## Assistente de execucao

O assistente recebe comandos em linguagem natural pela rota `/assistant/requests` e executa operacoes no banco da empresa ativa. Atualmente ele:

- cria tickets individuais ou grupais, com multiplos responsaveis e setores;
- cria tarefas no Kanban e, quando varias pessoas sao citadas, gera uma tarefa atribuida para cada uma;
- identifica prioridade, setor, responsavel e prazos como hoje, amanha, depois de amanha e proxima semana;
- valida usuarios e setores dentro da empresa, registra auditoria e envia notificacoes aos responsaveis;
- recusa comandos desconhecidos, pessoas inexistentes e operacoes destrutivas ainda nao suportadas, sem criar itens por engano.

Exemplos: `Abra um ticket grupal urgente para TI e Financeiro e atribua para Ana e Carlos` e `Crie uma tarefa para Ana revisar contratos ate amanha`.

## Credenciais demo

- `admin` / `admin123`
- `coordenador` / `coord123`
- `usuario` / `user123`

## Neon sem Prisma

Configure `DATABASE_URL` com a connection string do Neon. Depois rode:

```powershell
cd backend
$env:DATABASE_URL="postgresql://USER:PASSWORD@HOST/neondb?sslmode=require"
python scripts/deploy_db.py
python scripts/seed_default_users.py
```

As migrations SQL ficam em `backend/db/migrations` e sao aplicadas diretamente no banco pela tabela `schema_migrations`.

## Render

O VoltChat faz parte do servico `volt-corp` definido no `render.yaml` da raiz. O frontend e servido em `https://www.voltcorporation.com.br/chat/`; API, downloads e WebSocket usam `https://www.voltcorporation.com.br/chat-api`. Nao ha blueprint nem servico Render separado para este modulo.

Variaveis do servico `volt-corp`:

- `VOLT_CHAT_DATABASE_URL`: connection string do Neon com SSL para o banco do chat; obrigatoria em producao.
- `VOLT_CHAT_SECRET_KEY`: segredo JWT exclusivo do chat; obrigatorio em producao.
- `VOLT_CHAT_UPSTREAM_URL=http://127.0.0.1:8001`: destino interno, nunca uma URL publica.
- `VOLT_CHAT_PUBLIC_API_URL=/chat-api`.
- `VOLT_CHAT_DESKTOP_DOWNLOAD_URL`: URL HTTPS publica do instalador externo; evita servir o binario pelo banco e pela RAM do Render.
- `AUTO_MIGRATE_DB=true`: aplica migrations idempotentes no startup.

## Desktop

Preparar certificado interno gratuito para assinar o `.exe`:

```powershell
cd sordchat-frontend
npm run desktop:cert:setup
```

Esse comando cria ou reutiliza um certificado autoassinado em `Cert:\CurrentUser\My`,
exporta o certificado publico para `electron/certificates` e confia nele na maquina
do build. A chave privada nao entra no instalador.

Gerar pasta empacotada:

```powershell
cd sordchat-frontend
npm run desktop:pack
```

Gerar instalador Windows:

```powershell
cd sordchat-frontend
npm run desktop:dist
```

O instalador sai em `sordchat-frontend/dist-desktop`.

O instalador inclui esse certificado publico e tenta registra-lo automaticamente
em `LocalMachine\Root` e `LocalMachine\TrustedPublisher` durante a instalacao
elevada. Isso faz as proximas versoes assinadas pelo mesmo certificado serem
aceitas pela maquina.

Para uma maquina cliente aceitar as assinaturas internas antes da primeira
instalacao, copie estes dois arquivos para a mesma pasta:

- `dist-desktop/certificates/VoltCorp-Internal-Code-Signing.cer`
- `scripts/install-internal-certificate.ps1`

Depois rode como administrador nessa maquina:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-internal-certificate.ps1
```

Como e um certificado interno autoassinado, isso nao compra reputacao publica do
Microsoft SmartScreen; para remover esse tipo de alerta fora de um ambiente
controlado, so com certificado publico/EV e historico de reputacao.

Publicar o instalador no Neon para download pela propria API:

```powershell
cd backend
python scripts/publish_desktop_release.py ..\sordchat-frontend\dist-desktop\VoltChat-Setup-0.1.3.exe
```

Depois de publicado, a landing e o atualizador usam `https://www.voltcorporation.com.br/chat-api/downloads/desktop/latest`.

## Observacoes

- `backend/sordchat_fixed.py` e o backend ativo para deploy.
- Uploads locais funcionam, mas em Render o filesystem e efemero. Para producao, o proximo passo e mover anexos para S3/R2/Supabase Storage.
- O Kanban ainda esta local no frontend; persistencia em banco deve entrar em uma proxima migration/API.
