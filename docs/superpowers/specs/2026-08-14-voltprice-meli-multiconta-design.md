# VoltPrice — Mercado Livre multi-conta e canal Tray

## Objetivo

Conectar múltiplas contas do Mercado Livre por empresa no VoltPrice, com OAuth
2.0, PKCE, renovação automática de tokens e escolha segura da conta usada em
cada pedido. Pedidos importados da Tray devem mostrar o canal de venda
informado pela Tray mesmo quando a conta daquele marketplace ainda não está
conectada.

## Escopo

- Uma empresa pode ter diversas conexões `meli`, cada uma identificada pelo
  `user_id` devolvido pelo Mercado Livre.
- O OAuth do Mercado Livre reutiliza o fluxo atual de authorization code com
  PKCE. A aplicação nunca recebe senha do vendedor nem token inserido pelo
  usuário.
- A tela de Integrações lista cada conta ML individualmente e permite adicionar,
  renovar ou desconectar uma conta específica.
- A sincronização Tray normaliza o canal (`meli`, `shopee` e demais valores
  conhecidos) e, quando disponível no payload, o identificador da conta/seller
  de marketplace que originou o pedido.
- A listagem de pedidos exibe o nome do canal independentemente de haver
  integração ativa. Para ML, também exibe a conta identificada ou o estado
  `conta não identificada`.
- Uma consulta a APIs do ML só pode usar a conexão cujo `external_account_id`
  corresponde à conta indicada no pedido. Sem correspondência, a ação é
  indisponível e orienta o usuário a conectar ou vincular a conta correta.

## Fluxo OAuth e armazenamento

1. Um usuário com permissão para administrar integrações seleciona **Adicionar
   conta Mercado Livre**.
2. O backend cria estado OAuth de vida curta e um par PKCE; o navegador é
   redirecionado ao Mercado Livre.
3. No callback, o backend consome o estado uma única vez, troca o `code` pelos
   tokens e persiste a conexão usando o `user_id` retornado pelo ML como conta
   externa.
4. Se a mesma conta for autorizada novamente, seus tokens são atualizados. Uma
   conta diferente cria uma segunda conexão da mesma empresa.
5. Access e refresh tokens são criptografados no banco. A renovação ocorre
   antes da expiração e uma única repetição é tentada após resposta 401. Como o
   refresh token ML é de uso único, a resposta de refresh sempre substitui o
   token anterior na mesma transação.
6. Erros no callback redirecionam de volta à tela de Integrações com mensagem
   segura; detalhes de token, código OAuth e resposta externa não são expostos.

## Correspondência de pedido e conta

O sincronizador Tray preserva o payload original redigido e extrai, quando
presente, o canal, ID externo do pedido e conta/seller do marketplace. A
precedência será: identificador explícito da conta no payload de marketplace,
campos ML específicos e, por último, ausência de conta identificada.

Não há conta ML padrão. Se a Tray não trouxer um identificador confiável, o
pedido continua visível com `Mercado Livre · conta não identificada`, mas as
operações remotas do ML não são executadas. O usuário pode fazer uma vinculação
manual explícita; essa decisão não é substituída por sincronizações futuras.

## Modelo de dados

- `integration_connections` já permite múltiplas conexões por tenant e canal,
  pois sua chave externa é o ID da conta ML. O callback deve consultar o perfil
  autorizado quando possível para guardar um nome de exibição seguro, além do
  ID.
- `orders` receberá um campo de identificador de conta de marketplace. Ele
  guarda o `user_id`/seller extraído da Tray ou escolhido manualmente; não
  armazena tokens nem credenciais. A vinculação manual terá origem marcada para
  impedir que uma sincronização posterior a sobrescreva.
- O endpoint de taxa recebe o pedido interno, resolve a conexão pelo
  identificador de conta persistido e recusa a operação se não houver uma única
  conexão correspondente no tenant.

## Interface

- **Integrações:** cartões/linhas separados para todas as contas ML, mostrando
  nome público quando disponível, identificador da conta, estado e ações por
  conexão. O botão principal adiciona outra conta, sem substituir as existentes.
- **Pedidos:** o canal tem rótulo legível (`Mercado Livre`, em vez de `meli`) e
  mostra a conta associada. Uma conta não conectada ou não identificada aparece
  como estado operacional, não como ausência de canal.
- **Taxas ML:** fica habilitado apenas se houver ID de pedido de marketplace e
  conexão ML correspondente. Caso contrário, exibe orientação para conectar ou
  vincular a conta, sem realizar requisição à API externa.

## Configuração necessária

No painel de desenvolvedores do Mercado Livre, criar/configurar um aplicativo
com o redirect URI HTTPS exato do ambiente:

`https://volt-staging.onrender.com/volt-price/api/integrations/meli/callback`

No Render, configurar apenas:

```ini
VOLT_PRICE_MELI_CLIENT_ID=<APP_ID>
VOLT_PRICE_MELI_CLIENT_SECRET=<SECRET_KEY>
VOLT_PRICE_PUBLIC_BASE_URL=https://volt-staging.onrender.com
```

O vendedor autoriza com a conta principal do Mercado Livre, não com uma conta
operadora. Não se cadastram access token, refresh token ou senha manualmente.

## Erros e segurança

- Callback inválido, expirado ou recusado retorna à plataforma sem dados
  sensíveis na URL ou na mensagem.
- Tokens e respostas brutas são redigidos antes de auditoria e armazenamento
  auxiliar; as conexões listadas pela API nunca incluem tokens.
- Toda operação de conexão, desconexão, refresh, sincronização e consulta de
  taxa permanece limitada ao tenant do usuário e às permissões existentes.
- Uma falha de refresh marca somente a conexão afetada para reautorização; não
  desconecta nem bloqueia as demais contas ML da empresa.

## Testes de aceitação

1. Autorizar quatro contas ML distintas para um único tenant resulta em quatro
   conexões independentes, sem expor tokens.
2. Reautorizar uma das quatro atualiza apenas aquela conta.
3. Um pedido Tray com canal ML é apresentado como Mercado Livre sem exigir
   integração ML.
4. Um pedido Tray com conta ML identificada consulta taxas somente pela conexão
   de mesmo `user_id`.
5. Um pedido sem conta ML identificada não faz consulta automática nem escolhe
   uma conexão padrão.
6. Refresh automático troca access e refresh token da conexão correta e uma
   falha não afeta as outras.
