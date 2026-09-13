# DACHBYTE: staging na VPS Hostinger

## Validação desta entrega

Validados no Windows: contratos de arquitetura/Compose e sessão, testes de filas
ML, suíte Core/Business, sintaxe PowerShell e build Vite do Core. Os lockfiles de
raiz, Business, Core, Madeira e Tracking passaram em npm ci --dry-run.
Docker não está instalado no ambiente de desenvolvimento desta entrega.
Builds Linux das imagens, docker compose config, caddy validate, subida completa,
backup remoto e restauração permanecem pendentes na VPS/staging.
Não considerar a stack homologada até executar essas verificações.

## Entrega e requisitos

Esta stack executa gateway, seis produtos Seller, worker ML, portal Business,
Core, Stock, Chat web, Chat Python e Price em processos independentes.
Os Dockerfiles usam Node 24 e Python 3.12. O frontend Stock necessita Node >=22.
O host deve ser Linux com Docker Engine e Compose v2. A capacidade da VPS
precisa ser validada com builds e carga real; builds Next/React consomem memória
além da operação normal. Não execute todos os builds em paralelo num host pequeno.

Os comandos abaixo são executados na raiz do repositório na VPS. Nunca copie
node_modules ou ambientes Python do Windows para Linux. O Docker exclui segredos,
artefatos locais e caches do contexto de build.

## Hub compartilhado

Todos os containers de aplicação carregam `infra/env/hub.env` antes do arquivo
específico do serviço. O modelo está em `infra/env/hub.env.example`.
Durante o piloto atual, tanto DACH staging quanto DACH produção apontam para o
mesmo Hub da linha `payment`:

```env
HUB_BASE_URL=https://paymentcontrol.davantti-suite.workers.dev
HUB_INTERNAL_TOKEN=<segredo configurado no Worker paymentcontrol>
HUB_LOGIN_MODE=strict
HUB_AUTH_MODE=strict
HUB_ENFORCEMENT=strict
```

O token não entra no repositório. Depois de criar `hub.env`, valide a
configuração antes do primeiro boot:

```bash
test -s infra/env/hub.env
grep -E '^(HUB_BASE_URL|HUB_LOGIN_MODE|HUB_AUTH_MODE|HUB_ENFORCEMENT)=' infra/env/hub.env
docker compose --env-file infra/env/compose.env -f infra/compose.vps.yml config >/tmp/dachbyte-compose.yml
```

Essa configuração compartilha o estado de identidade, produtos, políticas,
acessos e pagamentos entre staging e produção. Portanto, qualquer teste de
inativação, instalação/remoção de módulo ou webhook altera o mesmo Hub. Até
separarmos o banco do Hub, use somente contas/empresas de teste no staging.

## Configuração inicial

1. Instalar Docker Engine e o plugin Compose pelo repositório oficial do sistema
   operacional. Criar acesso SSH por chave. Registrar IP, versão do SO e memória.
2. Clonar a branch dach em um diretório próprio de staging.
3. Copiar cada infra/env/*.env.example para o mesmo nome sem .example,
   sem sobrescrever arquivos já configurados. Restringir a leitura: chmod 600.
4. Preencher cada arquivo com credenciais de staging e variáveis das integrações.
   Os exemplos listam a base de inicialização; conferir também os contratos de
   cada produto para integrações opcionais, Hub, e-mail, OAuth e armazenamento.
5. Usar a mesma SUITE_JWT_SECRET nos produtos que validam a sessão compartilhada.
   Preservar as chaves de criptografia ao restaurar dados com tokens já cifrados.
6. Manter inicialmente DACHBYTE_BIND_IP=127.0.0.1 e
   DACHBYTE_SITE=http://localhost em infra/env/compose.env.
   Acesso de teste: ssh -L 8080:127.0.0.1:80 usuario@IP_DA_VPS.
   O endereço local passa a ser http://localhost:8080.

Para testar cookies Secure, OAuth e autenticação completa, usar um hostname de
staging com HTTPS: preencher DACHBYTE_SITE com esse hostname e bind 0.0.0.0.
Só Caddy publica 80/443. SSH é gerenciado pelo host. Os bancos não publicam portas.
Não trocar os callbacks de produção durante a validação de staging.

## Bancos e roles

PostgreSQL inicia apenas com o banco administrativo postgres. Antes dos produtos,
criar bancos e roles separados e restaurar uma cópia sanitizada dos schemas.
Não apontar os arquivos de staging para bancos de produção.

Mapear ML, Shopee, Tracking, Leader, Log, Madeira, Core, Stock, Chat e Price
individualmente. Gateway precisa de acesso aos bancos ML/Shopee para autenticação.
Tracking exige AVANTRACKING_DATABASE_URL distinta da DATABASE_URL geral.
Usar host postgres e sslmode=disable para conexões internas; manter SSL nas
conexões externas que o exigem.

Core exige VOLT_CORE_APP_DATABASE_URL com role de aplicação sem SUPERUSER nem
BYPASSRLS. Migrações usam credencial administrativa separada. Restaurar grants e
políticas RLS e executar o preflight do Core antes de liberar login. Não colocar
a senha administrativa do PostgreSQL nos containers web.

As migrações do Chat e Tracking não são executadas automaticamente nesta stack.
Restauração, grants e migrações explícitas precedem o start. Uma instância vazia
de PostgreSQL não é suficiente para os health checks funcionais.

## Construção e subida

```bash
docker compose --env-file infra/env/compose.env -f infra/compose.vps.yml config --quiet
docker compose --env-file infra/env/compose.env -f infra/compose.vps.yml up -d postgres redis
# Criar roles/bancos e restaurar os schemas de staging aqui.
COMPOSE_PARALLEL_LIMIT=1 docker compose --env-file infra/env/compose.env -f infra/compose.vps.yml build
docker compose --env-file infra/env/compose.env -f infra/compose.vps.yml up -d
docker compose --env-file infra/env/compose.env -f infra/compose.vps.yml ps
```

Validar o Caddyfile com caddy validate no container e executar
scripts/verify-vps-stack.ps1 contra a URL de staging (pode ser pelo Windows via
túnel SSH). Os healthz confirmam os processos; não substituem os testes de banco,
login e operações descritos abaixo. O health do Chat atual também não consulta
o banco: validar login e persistência explicitamente.

## Aceitação funcional

- Login do gateway e /go/* com cookies Secure no mesmo domínio; usuário sem
  permissão continua bloqueado.
- /business e links canônicos redirecionam aos módulos; conferir JS, CSS e logos.
- Core: health de banco, preflight, isolamento de duas empresas e operação CRUD.
- Stock: login, produto e movimentação; Price: health e login.
- Chat: login, upload, mensagem entre duas sessões e reconexão WebSocket.
- ML: enfileirar um job de teste, aguardar o worker e baixar seu resultado.
  O healthcheck do worker lê o heartbeat real de promoções no Redis.
- Reiniciar cada produto e confirmar que os demais continuam disponíveis.
- Reiniciar containers e confirmar persistência dos bancos, arquivos Chat e
  resultados ML. Verificar outros arquivos locais específicos das integrações
  antes de produção; volumes entregues cobrem PostgreSQL, Redis, Chat e results ML.
- Registrar consumo de RAM/CPU/disco e latências sob carga representativa.

## Backup externo e restauração

infra/compose.backup.yml adiciona um job manual com restic. Preencher backup.env
com bucket externo, chave exclusiva e senha de criptografia guardada fora da VPS.
Construir o job, inicializar o repositório uma única vez e executar:

```bash
docker compose --env-file infra/env/compose.env -f infra/compose.vps.yml -f infra/compose.backup.yml build backup
docker compose --env-file infra/env/compose.env -f infra/compose.vps.yml -f infra/compose.backup.yml run --rm --entrypoint restic backup init
docker compose --env-file infra/env/compose.env -f infra/compose.vps.yml -f infra/compose.backup.yml run --rm backup
```

O job exporta roles e cada banco de aplicação em formato pg_dump, verifica os
arquivos e envia com os uploads e resultados ML para o repositório cifrado.
Restic check valida a integridade do repositório, não a restauração SQL.
Retenção proposta: 7 diários, 4 semanais e 6 mensais; aplicar forget/prune apenas
após validar a política e um teste completo de restore.

Teste de restauração: em outro projeto Docker e volume PostgreSQL vazio,
restaurar um snapshot restic para diretório temporário. Revisar globals.sql
(roles administrativas podem já existir); restaurar roles/grants necessários.
Para cada arquivo N.dump, usar pg_restore --exit-on-error --create -d postgres.
databases.txt registra a ordem dos bancos. Restaurar uploads em outro volume.
Conferir contagens de tabelas, login, RLS e anexos; registrar duração e resultado.
Não executar restore sobre os volumes ativos.

Esses dumps não implementam PITR nem snapshot atômico entre vários bancos.
Para o corte, suspender gravações e filas antes do backup final e da cópia de
arquivos. Definir RPO/RTO, agenda, alertas de falha e política de WAL/PITR antes
de considerar a migração de produção concluída.

## Corte e rollback

Depois da aprovação do staging, planejar janela, backup final, restauração,
segredos, domínio e callbacks de cada integração. Guardar a revisão Git e as
imagens utilizadas. Atualizar DNS/proxy somente nessa janela.
Manter Render e Neon disponíveis. Para rollback inicial, restaurar o destino
anterior do domínio/proxy. Se já houver gravações na VPS, reconciliar esses dados
antes de reabrir o ambiente antigo; uma troca de DNS não devolve gravações.
Não apagar volumes nem desativar os serviços anteriores durante a janela.

## Referências

- https://docs.docker.com/engine/install/
- https://docs.docker.com/reference/compose-file/networks/
- https://caddyserver.com/docs/caddyfile/matchers
