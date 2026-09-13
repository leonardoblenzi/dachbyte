# Arquitetura DACHBYTE e migração segura

Este documento define a estrutura alvo da suíte DACHBYTE e a forma de chegar até ela sem interromper inicialização, sessões, integrações ou deploys existentes.

## Estrutura alvo

```text
apps/
  seller/
    mercado-livre/        # origem: ml/
    shopee/               # origem: shopee/
    madeira/              # origem: MadeiraMadeira/
    tracking/             # origem: avantracking/
    log/                  # origem: davanttilog/
    leader/               # origem: LeaderSku/
  business/
    core/                 # origem: business/volt_core/
    stock/                # origem: business/volt_stock/
    chat/                 # origem: business/volt_chat/
    price/                # origem: business/volt-price/

platform/
  gateway/                # servidor raiz, mounts, redirecionamentos e health checks
  auth/                   # Hub, sessões, permissões e SSO
  support/                # SAC, widget e e-mails transacionais
  branding/               # DACHBYTE, assets, tokens e configuração de marca
  shared/                 # banco, logs, cache, e-mail e utilitários de infraestrutura

packages/
  design-system/          # componentes e tokens reutilizáveis
  contracts/              # tipos, payloads e contratos entre aplicações
  config/                 # configuração sem segredos, por ambiente e produto

infrastructure/
  render/                 # manifestos e instruções de serviços
  docker/                 # composições locais
  migrations/             # migrations aditivas e versionadas

extensions/               # extensão Chrome e assets específicos
docs/                     # produto, operação e arquitetura
```

`apps/` contém produto e regra de negócio. `platform/` concentra capacidades compartilhadas. `packages/` contém código reutilizável que não pode depender de um app. A primeira fase pode criar esses diretórios sem mover código de produção.

## Entrypoints legados que permanecem

Até a migração ser validada em produção, estes caminhos continuam existindo e funcionando:

| Caminho/identificador atual | Motivo para preservar |
| --- | --- |
| `server.js` | Processo principal, mounts e health checks atuais. |
| `render.yaml` e comandos de deploy | Serviços remotos podem referenciá-los diretamente. |
| `ml/`, `shopee/`, `MadeiraMadeira/`, `avantracking/`, `davanttilog/`, `LeaderSku/` | Imports, scripts, assets e URLs legadas. |
| `business/volt_core/`, `business/volt_stock/`, `business/volt_chat/`, `business/volt-price/` | Inicialização independente, builds e deploys Business. |
| rotas, cookies, callbacks OAuth, schemas e nomes de tabelas atuais | São contratos externos e dados persistidos. |
| `appId` e namespaces locais do Chat desktop | Alterá-los cria instalação paralela e pode perder sessão. |

Nomes públicos passam a ser DACHBYTE. Nomes técnicos legados só mudam com migration aditiva, telemetria e rollback testado.

## Domínio, OAuth e cookies (sem domínio DACHBYTE ainda)

[`platform/config/domainMigration.js`](../../platform/config/domainMigration.js) registra o plano canônico de modo **inerte**: sem domínio comprado, não há origem canônica, callback novo, redirect, alteração de cookie, variável de ambiente ou e-mail ativo. Os servidores atuais não o importam.

[`platform/compatibility/legacySurfaceRegistry.js`](../../platform/compatibility/legacySurfaceRegistry.js) é o inventário versionado das rotas, cookies e callbacks OAuth que ainda são contratos públicos. O teste `tests/legacy-surface-compatibility.test.js` impede que sejam removidos por acidente enquanto o plano estiver em `pre-canonical-domain`. Ele é uma proteção de regressão, não altera o runtime.

Quando houver domínio, a configuração apenas descreve as origens permitidas e as URLs públicas `/seller` e `/business`. A ativação real deve ser uma release separada e seguir esta sequência: DNS/TLS; cadastro dos callbacks novos junto aos provedores; validação simultânea de callbacks novo e legado; leitura dupla de cookies; escrita dupla; preferência canônica; e, após telemetria, aposentadoria do legado. Nunca gerar callbacks concatenando entrada de requisição nem remover um callback/cookie legado na mesma release que introduz o novo.

## Regra do adaptador

Não mover um entrypoint sem deixar uma ponte compatível no local antigo.

```js
// Exemplo conceitual: ml/index.js permanece no caminho atual.
module.exports = require('../../apps/seller/mercado-livre');
```

Regras obrigatórias:

- O caminho antigo preserva a mesma interface de import, comando e variáveis de ambiente.
- O adaptador não contém regra de negócio; apenas encaminha para a nova localização.
- URLs antigas permanecem acessíveis ou redirecionam preservando `path` e `query`.
- Cookies, payloads, IDs de entitlement e nomes de banco não são renomeados nesta etapa.
- Cada adaptador tem teste de boot e uma data/critério explícito para remoção.

## Sequência de movimentação

1. Criar `platform/branding`, `platform/auth`, `platform/support` e `packages/design-system`; migrar somente código compartilhado sem alterar entrypoints.
2. Migrar Mercado Livre para `apps/seller/mercado-livre`, pois é a principal integração com o gateway. Manter `ml/` como adaptador.
3. Migrar Shopee e MadeiraMadeira, um produto por release, mantendo seus diretórios como adaptadores.
4. Migrar Tracking, Log e Leader após confirmar jobs, workers, banco e integrações logísticas.
5. Migrar Business em releases separados: Core, Stock, Chat e Price. Cada um conserva build, start e paths antigos até a validação.
6. Atualizar scripts, workspace e manifestos de deploy para apontar aos novos caminhos somente depois que os adaptadores estiverem estáveis.
7. Remover uma ponte apenas após período definido de observação, zero referências em deploy/configuração e plano de retorno validado.

Não misturar mudança estrutural com alteração de schema, troca de domínio, OAuth ou novas permissões na mesma release.

## Critérios obrigatórios para limpeza pós-telemetria

Uma rota, cookie, callback OAuth ou adaptador legado só pode ser marcado como `retired` em uma versão posterior do registry quando todos os itens abaixo estiverem documentados no PR/release:

- domínio canônico DACHBYTE com DNS e TLS estáveis; os callbacks novos estão cadastrados e testados com cada provedor;
- período de observação acordado concluído (mínimo de 30 dias ou um ciclo completo de renovação de sessão, o que for maior), com tráfego, autenticação, OAuth e erros monitorados;
- telemetria demonstra ausência de acessos ao alias/cookie/callback legado por todo o período, ou há plano de migração explícito para os consumidores restantes;
- leitura dupla de cookie foi validada; a remoção da escrita antiga ocorreu antes da remoção da leitura;
- todos os manifests de deploy, extensões, desktop, webhooks, documentação e variáveis de ambiente foram pesquisados e não dependem mais da superfície antiga;
- smoke tests do fluxo de login, logout, retorno OAuth, URL com query string e rollback foram executados em staging;
- owner responsável, janela de rollback e versão anterior disponível foram registrados. Nenhuma limpeza remove dados, tabelas ou migrations históricas.

O registry deve subir de versão quando houver mudança intencional. O commit deve explicar a evidência de cada item removido; não basta apagar a asserção de teste.

## Checklist por release

Antes do deploy:

- [ ] Confirmar que o adaptador mantém os imports e comandos atuais.
- [ ] Executar lint/testes do produto e teste de sintaxe dos entrypoints alterados.
- [ ] Validar boot local pelo caminho antigo e pelo novo caminho interno.
- [ ] Validar login/logout, sessão, autorização e rotas de retorno.
- [ ] Validar health check, logs e workers associados.
- [ ] Validar rotas públicas antigas com query string e URLs canônicas novas.
- [ ] Verificar OAuth/webhooks do produto, se existirem.
- [ ] Confirmar que migrations são aditivas e reversíveis.
- [ ] Registrar commit, versão e owner do rollout.

Após o deploy:

- [ ] Monitorar taxa de erro, autenticação, callback OAuth e filas por período combinado.
- [ ] Confirmar que assets, landing e shell renderizam sem 404.
- [ ] Confirmar que o deploy anterior continua disponível para retorno.

## Rollback

O rollback deve restaurar o entrypoint ou manifesto anterior, sem apagar dados nem executar rollback destrutivo de banco. Adaptadores tornam isso possível: o caminho legado continua estável enquanto a implementação pode voltar para a origem anterior.

Se houver falha, pausar novas movimentações, restaurar o deploy anterior, manter redirects/cookies compatíveis e coletar logs. Corrigir em uma nova alteração; não usar `git reset --hard` em branch compartilhada nem renomear/remover tabelas como resposta a incidente.
