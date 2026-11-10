# Conexão única do Mercado Livre (módulo ML + DACH Hub)

Status: aprovado. Etapas 1 a 3 implementadas em 09-10/11/2026; etapa 4 (publicação) pendente.

## Objetivo

Uma conta do Mercado Livre é autorizada **uma vez** no app da DACHBYTE (`ML_APP_ID`). As chaves ficam guardadas e são renovadas num só lugar. Cada produto (módulo DACH ML, DACH Hub) **ativa** as contas que quiser, dentro do limite do próprio plano, sem nova autorização.

Exemplo: o cliente tem o Hub com 4 contas. Assina o módulo ML com plano de 1 conta, entra em Integrações do módulo, vê as 4 contas já conectadas e ativa 1. As outras 3 continuam só no Hub.

## O que o levantamento encontrou

### Módulo ML (`apps/seller-ml`)

- **Cofre de chaves pronto e robusto.** `meli_contas` + `meli_tokens` (schema `ml`), cifradas com AES-256-GCM. A renovação acontece sob demanda, com trava por processo, trava no Postgres (advisory lock) e releitura do token que outro processo acabou de renovar (`services/tokenService.js`, `services/tokenRefreshLock.js`). É o lugar certo para ser o dono das chaves.
- **Conta ligada à empresa.** `meli_contas.empresa_id` → `empresas.tenant_global_id` (a empresa do hub de acessos). Um vendedor do ML só pode estar em uma empresa (índice único global em `meli_user_id`).
- **Cobrança já é por conta.** `meli_contas.billing_status` / `can_operate`; contas novas entram como "aguardando assinatura". Depois da autorização, o módulo registra a conta como recurso `ml` no hub de acessos (`hubResourceRelinkService`).
- **Não existe API interna** que entregue chaves ou contas a outro serviço.
- **Rotinas automáticas rodam em todas as contas `ativa`**, de todas as empresas, sem olhar o contrato: fotos de reputação e histórico de preço (a cada 6 h), ranking mensal.
- **`invalid_grant` não é tratado:** a conta continua `ativa` mesmo com a autorização perdida.
- A autorização só é iniciada por um usuário com sessão do módulo ML, e essa sessão só existe para quem tem o módulo `ml` liberado no hub de acessos. Um cliente só com o Hub não consegue iniciar a autorização hoje.

### DACH Hub (`apps/seller-hub`)

- Todo acesso às APIs passa por um ponto só: `TokenManager.getAccessToken(accountId)` (`src/modules/accounts/service.js`). Trocar a origem da chave para o Mercado Livre é uma mudança localizada.
- O Hub busca pedidos sozinho de tempos em tempos (`poll-all`, `reconcile-all`). Não depende dos avisos (webhooks) do ML, que continuam indo para o módulo.
- Em produção ainda não há nenhuma conta do ML conectada no Hub (app não configurado), então não há migração de dados.

## Desenho

### 1. O módulo ML vira o dono da conexão

Nova API interna no `seller-ml`, só na rede interna dos containers, com chave própria (`SELLER_CONNECTIONS_TOKEN`, Bearer). Não passa pelo Caddy.

| Rota | Faz |
|---|---|
| `GET /internal/connections?tenant=<id>` | Lista as contas conectadas da empresa: id ML, apelido, situação, produtos em que está ativa. |
| `POST /internal/connections/authorize` | Recebe `tenant`, `user`, `product`, `return_to`; devolve a URL de autorização do ML. O `state` guarda a empresa, o produto de origem e o endereço de volta. |
| `POST /internal/connections/token` | Recebe `tenant` + `meli_user_id`; devolve chave válida e validade, usando a mesma renovação com trava de hoje. Confere que a conta é da empresa. |
| `POST /internal/connections/activate` / `deactivate` | Liga ou desliga a conta num produto (`ml` ou `dach_hub`). |

A volta da autorização continua no endereço que já está cadastrado no app (`/ml/api/meli/oauth/callback`). Para autorizações iniciadas pelo Hub, o módulo grava a conta e manda o navegador de volta para `/hub/contas`. **Não é preciso cadastrar URI nova no Mercado Livre.**

### 2. Ativação por produto

Nova tabela no schema `ml`:

```
meli_conta_produtos (meli_conta_id, produto 'ml' | 'dach_hub', ativado_em, ativado_por)
```

- Contas existentes recebem `ml` (migração de dados), para nada mudar para quem já usa o módulo.
- **Módulo ML:** telas e rotinas automáticas consideram só contas com `ml`. O registro como recurso `ml` no hub de acessos (cobrança) acontece **na ativação**, não mais na autorização.
- **Integrações do módulo ML:** nova seção "Contas já conectadas na DACHBYTE", com "Ativar neste módulo".
- **Hub:** o limite do plano conta só as contas ativas no Hub (como hoje).

### 3. Hub usa a conexão do módulo

- `hub.channel_accounts` ganha `connection_source` (`own` | `dachbyte`). Contas do ML ficam `dachbyte`, sem chaves guardadas no Hub.
- `TokenManager.getAccessToken` pede a chave a `/internal/connections/token` quando a conta é `dachbyte`.
- **Tela Contas do Hub, cartão Mercado Livre:**
  - "Conectar nova conta": chama `authorize`, autoriza no ML e volta ao Hub já ativa no Hub.
  - "Importar contas da DACHBYTE": lista as contas que a empresa já tem no módulo ML e ainda não estão no Hub; ativar respeita o limite.
- O link de autorização para terceiros (15 min, uso único) segue o mesmo caminho, passando o token do link no `state`.
- Shopee e Magalu continuam com a conexão própria do Hub por enquanto; o mesmo modelo vale para eles depois.

### 4. Quem pode conectar

O hub de acessos decide: autorizar pela API interna exige o produto de origem liberado para a empresa e o usuário (`ml` ou `dach_hub`). O Hub já checa o próprio acesso antes de chamar.

### 5. Correções que entram junto

- Rotinas de reputação, histórico de preço e ranking filtram por contas ativas no `ml`. Sem isso, contas só do Hub gastariam servidor e cota do ML.
- `invalid_grant` na renovação marca a conta como `erro` (pede reconexão) nos dois produtos, em vez de ficar falhando em silêncio.

### 6. Avisos dos marketplaces (webhooks) com repasse

Cada app de marketplace só tem um endereço de avisos, e ele pertence ao dono da conexão. O dono recebe todos os avisos e **repassa** a cada produto em que a conta está ativa:

1. O ML avisa `/ml/api/meli/webhooks/notifications` (endereço atual, nada muda no app).
2. O módulo ML responde 200 na hora (o ML exige resposta rápida) e põe o aviso na fila.
3. Pelo `user_id` do aviso, acha a conta e os produtos ativos. Tópicos de interesse do Hub (`orders_v2`, `shipments`) vão para o Hub por chamada interna (`POST /hub/internal/notifications/mercadolivre`, Bearer próprio). Avisos de contas não ativas no Hub não são repassados.
4. O Hub trata como já trata hoje o aviso direto: busca o pedido na API com a chave pedida ao dono e atualiza a tela.
5. A busca a cada 10 min e a conferência a cada 3 h continuam como rede de segurança, caso um aviso se perca.

No painel do app ML é preciso **marcar o tópico Orders (`orders_v2`)** e, se quiser expedição, Shipments. O módulo ML hoje processa só `public_offers`/`public_candidates`; os demais tópicos passam a ser repassados.

O mesmo vale para os outros canais: o dono da conexão de cada canal é quem recebe e repassa. Shopee e Magalu precisam do próprio levantamento (a Shopee também tem um endereço de avisos por app; no Magalu a assinatura é por conta).

## Decisões tomadas (09/11/2026)

- **Formato padrão para todos os canais:** todo dono de conexão responde às mesmas chamadas (listar, autorizar, dar chave, ativar). Dono hoje: o módulo de cada canal (ML, Shopee, Magalu). Marketplace novo sem módulo: o Hub é o dono. Quem consome só pede a chave e nunca renova.
- **Onde conectar:** pelo Hub ou pelo módulo; a conta fica ativa só onde foi conectada e aparece como disponível no outro.
- **Limite:** o Hub tem limite de contas por plano. O módulo ML não tem limite de quantidade: cobra por conta ativada (cada conta ativada no ML é um plano pago).
- **Remover de um produto:** só desativa nele. Sem nenhum produto, a conexão fica guardada 30 dias e depois as chaves são apagadas; botão "Desconectar da DACHBYTE" apaga na hora.
- **Quem pode:** dono e administradores da empresa.
- **Uma conta do ML em duas empresas:** continua bloqueado.
- **Pedidos sempre atualizados no Hub:** por repasse de avisos (seção 6), com a busca periódica como segurança.

## Riscos e cuidados

- **Dependência:** se o `seller-ml` cair, o Hub fica sem chave do ML até ele voltar. As rotinas do Hub já tentam de novo; a tela mostra "conexão indisponível".
- **Segurança:** a chave do ML trafega só na rede interna, com Bearer próprio e conferência de empresa em toda chamada. Nada disso vai para o navegador.
- **Cobrança:** mover o registro de recurso `ml` da autorização para a ativação precisa preservar quem já está registrado hoje (todas as contas atuais recebem `ml`, então nada muda para elas).
- **Admin master** do módulo ML continua enxergando tudo, como hoje.

## Etapas

1. `seller-ml`: tabela de ativação + migração, API interna, autorização iniciada por outro produto, filtro nas rotinas, tratamento de `invalid_grant`. Testes.
2. `seller-hub`: `connection_source`, `TokenManager` delegando, cartão do ML com "Conectar" e "Importar", link de terceiros pelo novo caminho. Testes.
3. `seller-ml`: seção "Contas já conectadas na DACHBYTE" em Integrações.
4. Infra: `SELLER_CONNECTIONS_TOKEN` nos dois envs, deploy, teste com uma conta real.

## Etapa 1 entregue (módulo ML)

- Migração `080_meli_conta_produtos.sql`: tabela de ativação, contas atuais em `ml`, gatilho que ativa conta nova no produto de origem (`set_config('ml.connection_product', ...)`), `oauth_states` aceita autorização sem usuário do módulo (`produto`, `origem_usuario_global_id`).
- API interna `/ml/internal/connections` (`GET /accounts`, `POST /authorize`, `/token`, `/activate`, `/deactivate`), Bearer `SELLER_CONNECTIONS_TOKEN`. Pela API só se ativa `dach_hub`; ativar o ML continua pelas telas do módulo (cobrança). O Caddy responde 404 para `/ml/internal/*` e `/hub/internal/*`.
- Callback: autorização pedida pelo Hub volta para `/hub/...?conectado=mercadolivre&conta=<id>` sem cobrança, cookie ou conta padrão do ML.
- Telas, extensão, rotinas (reputação, histórico de preço, ranking), medição de faixa e avisos de promoção do ML consideram só contas ativas em `ml`. Admin master continua vendo tudo.
- Desvincular no ML (tela e retirada pelo hub de acessos): se o Hub usa a conta, só tira o `ml`; chaves e conexão ficam.
- Renovação com `invalid_grant` marca a conta como `erro` (reconectar).
- Repasse de avisos `orders_v2`/`orders`/`shipments` ao Hub (`HUB_ML_NOTIFICATIONS_URL`), conferindo app e caminho do recurso.
- Ainda não feito: limpeza das chaves 30 dias depois de a conta ficar sem produto; seção "Contas já conectadas na DACHBYTE" nas Integrações do ML (etapa 3).

## Etapa 2 entregue (DACH Hub)

- Migração `012_dachbyte_connections.sql`: `channel_accounts.connection_source` (`own` | `dachbyte`). Conta `dachbyte` não guarda chave no Hub.
- `src/platform/dachbyteConnections.js`: cliente da API interna (`HUB_ML_CONNECTIONS_URL` + `SELLER_CONNECTIONS_TOKEN`). Sem os dois, o ML continua no modo antigo (app próprio).
- `TokenManager`: conta `dachbyte` pede a chave ao módulo e guarda em memória até 5 min antes de vencer; recusa do módulo por autorização perdida marca a conta "Reconectar"; queda do módulo não marca.
- Contas: "Conectar Mercado Livre" autoriza pelo módulo e volta a `/hub/contas`; ao abrir Contas, o Hub traz as contas ativas no Hub e lista as "Já conectadas na DACHBYTE" com "Usar no Hub" (ocupa vaga, sem nova autorização); desconectar tira o `dach_hub` no módulo antes (se o módulo estiver fora, não desconecta).
- Link de autorização: volta por `/hub/conectar/<token>/concluido`, confere no módulo que a conta está ativa no Hub para a empresa do link.
- Avisos: `POST /hub/internal/notifications/mercadolivre` (Bearer) entra na mesma fila dos avisos diretos.

## Etapa 3 entregue (módulo ML)

- `GET /api/meli/contas-dachbyte`: contas da empresa conectadas na DACHBYTE e fora do módulo ML (ex.: só no Hub), com a situação da conexão.
- `POST /api/meli/contas-dachbyte/:id/ativar` (usuário que edita): confirma o recurso `ml` no hub de acessos antes de ativar, depois ativa `ml`, define conta padrão/cookie e enfileira a medição da faixa, igual a uma conta nova. Conta com autorização expirada pede "Vincular nova conta".
- Painel "Contas já conectadas na DACHBYTE" na seleção de contas (`/select-conta`) e na tela de vincular (`/vincular-conta`).
- Migração `081_meli_account_activated_audit.sql`: retenção do evento `meli_account_activated`.
