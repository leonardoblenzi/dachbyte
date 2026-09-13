# VoltPrice

VoltPrice e um modulo do webservice VoltCorp/DavanttiSuite. Ele e montado pelo `apps/business/app.js` em `/volt-price` e usa o mesmo processo Render existente. Nao possui `render.yaml` proprio.

## Referencia visual e invariantes

O arquivo `apps/business/price/voltprice-prototype.html` e a referencia visual do modulo. Em producao, o VoltPrice usa dados reais das APIs e nao fabrica dados para reproduzir o prototipo. Esta fase altera somente a apresentacao: o comportamento das integracoes de provedores, incluindo autenticacao e OAuth, permanece inalterado.

## Estado desta implementacao

Fundacao pronta para producao controlada:

- login proprio do VoltPrice, independente de VoltCore/VoltChat/VoltStock;
- multi-tenant por empresa;
- RBAC por usuario/tenant;
- Admin Master com acesso assistido auditado;
- login por e-mail e senha, sem selecao de empresa ou MFA no fluxo de runtime;
- sessoes opacas no servidor em cookie HttpOnly/Secure;
- CSRF nas mutacoes;
- rate limit de login;
- PostgreSQL/Neon com RLS e `tenant_id` obrigatorio nas tabelas operacionais;
- audit log append-only;
- criptografia AES-256-GCM para tokens OAuth;
- minimizacao/redacao de PII antes de persistir payloads externos;
- Tray OAuth + refresh automatico + importacao paginada de pedidos por status e periodo;
- Mercado Livre OAuth PKCE + refresh token rotativo com lock transacional;
- Mercado Livre: fees por order via order/sale_fee, shipment e billing/provisoes;
- Shopee Open Platform V2: OAuth, assinatura HMAC, refresh e escrow por order_sn;
- cache de consultas de fees para reduzir polling desnecessario;
- tabela de Comissoes somente informativa e editavel, deliberadamente fora de Profit/Pricing;
- dominios Products, Profit, Pricing, Market, Ads, Cash, Audit, Actions e Reports com persistencia/API real e sem seed de dados ficticios.
- marketing com fontes multicanal, importacao idempotente/versionada, ROAS/ACOS/TACOS e custos de cupons, moedas e afiliados integrados ao Profit.
- Market com histórico competitivo, matching revisável, faixas de preço, rupturas e sinais persistidos para o Decision Engine.

## Montagem no webservice

`apps/business/app.js` monta:

- UI: `/volt-price`
- API: `/volt-price/api/*`
- health: `/volt-price/health`

O Render executa `npm run migrate:all` no pre-deploy. O script dedicado `npm run migrate:volt-price` usa `DB_VOLTPRICE_DIRECT`; o runtime usa a conexao pooled `DB_VOLTPRICE`. `business/start.js` nao executa DDL.

Para executar somente a migration VoltPrice com uma conexao direta, a partir da raiz do repositorio:

```sh
DB_VOLTPRICE_DIRECT="postgresql://..." node apps/business/price/db/migrate.js
```

## Primeiro deploy

1. Copie as variaveis de `.env.example` para o ambiente do Render.
2. Configure `DB_VOLTPRICE` com a URL pooled do Neon e `DB_VOLTPRICE_DIRECT` com a URL direta de migration.
3. Defina `VOLT_PRICE_ENCRYPTION_KEY` com 32 bytes aleatorios.
4. Configure as credenciais do app Tray existente, Mercado Livre e Shopee. Para Shopee, `VOLT_PRICE_SHOPEE_PARTNER_ID` e `VOLT_PRICE_SHOPEE_PARTNER_KEY` sao obrigatorias.
5. Configure `VOLT_PRICE_PUBLIC_BASE_URL` com a URL publica real do webservice.
6. Para criar o primeiro Admin Master, ative temporariamente `VOLT_PRICE_BOOTSTRAP_MASTER_ENABLED=true`, defina `VOLT_PRICE_BOOTSTRAP_MASTER_EMAIL` e uma `VOLT_PRICE_BOOTSTRAP_MASTER_PASSWORD` forte (minimo de 16 caracteres em producao).
7. Faça o deploy. A migration cria o schema `volt_price`.
8. Entre no Admin Master com e-mail e senha, crie a primeira empresa e owner. O owner recebe uma senha temporaria e precisa troca-la no primeiro acesso.
9. Depois do bootstrap, recomenda-se desligar `VOLT_PRICE_BOOTSTRAP_MASTER_ENABLED` e manter o usuario criado no banco.

## Login, primeiro acesso e provisionamento

O login do VoltPrice envia somente `email` e `password` para `POST /volt-price/api/auth/login`. Um usuario regular deve ter exatamente uma associacao ativa; uma conta legada com mais de uma associacao ativa e rejeitada no login.

Quando a sessao informa `passwordChangeRequired`, o aplicativo mostra somente o formulario de primeiro acesso. A pessoa informa a senha temporaria, a nova senha e sua confirmacao. O navegador atualiza o CSRF em `GET /volt-price/api/auth/csrf` e envia `currentPassword` e `newPassword` para `POST /volt-price/api/auth/change-password`. A resposta substitui a sessao e libera o shell normal do aplicativo.

O Admin Master provisiona um usuario regular por `POST /volt-price/api/admin/tenants/:tenantId/users`, com CSRF valido e o contrato:

```json
{
  "email": "pessoa@empresa.com",
  "fullName": "Nome da Pessoa",
  "role": "analyst",
  "temporaryPassword": "senha temporaria forte"
}
```

Os perfis permitidos sao `admin`, `finance`, `pricing`, `marketing`, `analyst` e `viewer`. A resposta bem-sucedida e `201`, marca `mustChangePassword: true`, invalida sessoes anteriores e nao retorna a senha temporaria. A conta provisionada recebe apenas a empresa indicada; uma associacao ativa em outra empresa e rejeitada.

### Console do Admin Master

Em **Admin Master**, selecione **Gerenciar usuarios** na empresa desejada. A tela consulta `GET /volt-price/api/admin/tenants/:tenantId/users` e mostra somente nome, e-mail, perfil, status e indicacao de primeiro acesso. Informe nome, e-mail, perfil e uma senha temporaria para criar um usuario; entregue a senha temporaria manualmente por um canal seguro. O VoltPrice nao envia e-mail automaticamente, e a pessoa deve trocar essa senha no primeiro acesso.

Para um usuario operacional existente, selecione **Redefinir senha** e informe uma nova senha temporaria. A confirmacao esclarece que a redefinicao encerra as sessoes atuais. A senha nunca aparece em listas, auditoria ou mensagens de sucesso.

Colunas e configuracoes TOTP legadas podem continuar no banco durante a transicao, mas nao fazem parte do fluxo de autenticacao em runtime. Elas so podem ser removidas por uma migration de limpeza separada e aprovada.

## Banco e isolamento

As tabelas tenant-owned usam PostgreSQL Row Level Security com `FORCE ROW LEVEL SECURITY`.

Cada operacao tenant executa dentro de uma transacao:

```sql
BEGIN;
SELECT set_config('app.vp_tenant_id', '<tenant uuid>', true);
SELECT set_config('app.vp_user_id', '<user uuid>', true);
SELECT set_config('app.vp_platform_admin', 'false', true);
-- queries
COMMIT;
```

O contexto e transaction-local para funcionar corretamente mesmo em conexao Neon pooled/PgBouncer.

## Tray

A Tray e a fonte principal de pedidos do fluxo inicial.

Fluxo:

1. usuario informa o dominio da loja;
2. VoltPrice cria OAuth state de uso unico;
3. usuario autoriza o app Tray;
4. callback troca `code` por access/refresh tokens;
5. tokens sao criptografados;
6. refresh ocorre automaticamente antes da expiracao;
7. `/orders` e paginado ate acabar, com filtros de status e periodo;
8. `/orders/:id/complete` pode enriquecer um pedido especifico.

Por segurança, a URL da loja e o `api_address` retornado pela Tray precisam usar HTTPS. Endereços locais e redes privadas permanecem bloqueados.

### Conectar Tray por OAuth

No Render, configure somente `VOLT_PRICE_TRAY_CONSUMER_KEY`, `VOLT_PRICE_TRAY_CONSUMER_SECRET` e `VOLT_PRICE_PUBLIC_BASE_URL`. Não cadastre Consumer Key, Consumer Secret, access token ou refresh token na interface ou no banco manualmente.

No console do aplicativo Tray, registre exatamente o callback:

```text
${VOLT_PRICE_PUBLIC_BASE_URL}/volt-price/api/integrations/tray/callback
```

Depois do deploy, entre na empresa correta, abra **Integrações**, informe a URL HTTPS verificada da loja e selecione **Autorizar na Tray**. Ao concluir o consentimento, o VoltPrice retorna para a tela de Integrações e informa o estado da conexão. O navegador não exibe nem envia token; o refresh renova automaticamente a conexão antes da expiração enquanto o refresh token for válido.

Use a URL HTTPS oficial da loja. Em caso de falha ou consentimento negado, recomece a autorização pela interface; não copie URL de callback, código de autorização ou tokens para tickets, chats ou commits.

## Mercado Livre

OAuth usa Authorization Code + PKCE. O refresh e protegido por `SELECT ... FOR UPDATE`, pois o Mercado Livre documenta que o refresh token e de uso unico e que somente o ultimo refresh token emitido permanece valido.

### Cadastro do app e ambiente Render

No app Mercado Livre, cadastre o callback HTTPS exato abaixo (substitua somente o dominio pelo valor publico real de `VOLT_PRICE_PUBLIC_BASE_URL`):

```text
https://SEU_DOMINIO/volt-price/api/integrations/meli/callback
```

No Render, configure estes tres valores sem aspas e sem expor valores em logs, issues ou commits:

- `VOLT_PRICE_PUBLIC_BASE_URL`: URL publica HTTPS do webservice, sem barra final;
- `VOLT_PRICE_MELI_CLIENT_ID`: Client ID do app Mercado Livre;
- `VOLT_PRICE_MELI_CLIENT_SECRET`: Client Secret do mesmo app.

O app deve ser cadastrado e autorizado pela conta principal vendedora do Mercado Livre. Para operar varias contas, conecte cada conta vendedora pelo seu proprio fluxo OAuth dentro do tenant correto. Cada conexao preserva seus tokens criptografados e sua identificacao de conta; nao existe conta padrao e uma conta nao e reutilizada para consultar pedidos ou taxas de outra.

Não cadastre access token, refresh token ou senha manualmente: o VoltPrice obtem e renova os tokens exclusivamente pelo fluxo OAuth.

Consulta financeira de pedido agrega:

- `/orders/{order_id}` -> `order_items[].sale_fee` e `payments[].marketplace_fee`;
- `/billing/integration/group/ML/order/details?order_ids=...` -> provisoes/faturamento por order;
- `/orders/{order_id}/discounts` -> descontos;
- `/shipments/{shipment_id}` -> custo de envio quando disponivel.

O endpoint de billing e cacheado localmente para evitar chamadas repetidas. O usuario pode forcar nova consulta tecnicamente via `force=true`, mas a UI comum usa cache.

## Shopee

O conector implementa o padrao de assinatura HMAC da Open Platform V2, token exchange, refresh, chamadas shop-level, sincronizacao incremental de pedidos e consulta de escrow por `order_sn`. Cada empresa pode autorizar varias lojas Shopee, identificadas pelo `shop_id`; a renovacao, sincronizacao e desconexao sempre operam sobre a loja selecionada.

### Configuracao no Render

Declare no ambiente seguro do mesmo webservice que monta o VoltPrice:

```ini
VOLT_PRICE_PUBLIC_BASE_URL=https://seu-webservice.onrender.com
VOLT_PRICE_SHOPEE_PARTNER_ID=<partner_id_do_app>
VOLT_PRICE_SHOPEE_PARTNER_KEY=<partner_key_do_app>
```

O callback a cadastrar no console do app Shopee e exatamente:

```text
${VOLT_PRICE_PUBLIC_BASE_URL}/volt-price/api/integrations/shopee/callback
```

Os valores abaixo sao opcionais e ja possuem os defaults mostrados em `.env.example`. Altere-os somente se o console autenticado da Shopee indicar outra regiao ou rota para o app:

- `VOLT_PRICE_SHOPEE_API_BASE`
- `VOLT_PRICE_SHOPEE_AUTH_PARTNER_PATH`
- `VOLT_PRICE_SHOPEE_TOKEN_PATH`
- `VOLT_PRICE_SHOPEE_REFRESH_PATH`
- `VOLT_PRICE_SHOPEE_ESCROW_PATH`
- `VOLT_PRICE_SHOPEE_ORDER_LIST_PATH`
- `VOLT_PRICE_SHOPEE_ORDER_DETAIL_PATH`

Mantenha o pre-deploy existente com `npm run migrate:all` (ou execute `npm run migrate:volt-price` com `DB_VOLTPRICE_DIRECT` ao operar somente o modulo). O runtime usa `DB_VOLTPRICE` pooled; nao execute DDL pelo processo de start.

### Autorizacao e operacao multi-loja

1. No console da Shopee, habilite para o app as permissoes/escopos necessarios para autorizacao, pedidos e financeiro/escrow e registre o callback acima em HTTPS.
2. No VoltPrice, entre na empresa correta e acesse **Integracoes**. Selecione **Adicionar loja Shopee** e conclua o consentimento da primeira loja.
3. Repita **Adicionar loja Shopee** para cada conta/loja da mesma empresa. Nao reutilize tokens manualmente: cada consentimento grava uma conexao separada pelo `shop_id`.
4. Em **Pedidos**, escolha a loja Shopee antes de sincronizar. Para consultar taxas, o pedido deve estar vinculado a uma loja Shopee conectada; use o UUID interno do pedido, nunca o `order_sn` na URL.
5. Use **Renovar agora** ou **Desconectar** na linha da loja desejada. O refresh automatico continua sendo executado para conexoes ativas.

Os tokens nunca sao exibidos pela interface. Em falha, expiracao de refresh ou permissao recusada, desconecte/autorize novamente apenas a loja afetada.

ATENCAO: o portal publico oficial da Shopee bloqueou leitura automatizada durante a validacao deste pacote. Por isso os paths V2 estao isolados em variaveis de ambiente. Antes de producao, confirme no console autenticado do seu app Shopee os paths, regioes e permissoes habilitados e ajuste as variaveis sem alterar o codigo.

## Vinculo pedido Tray -> marketplace

O sistema tenta inferir o marketplace/order id a partir do pedido Tray. Quando a Tray nao entregar metadado suficiente, a tela permite vincular manualmente:

- `meli` + order id Mercado Livre;
- `shopee` + order_sn Shopee.

O vinculo e auditado.

## Comissoes

`commission_references` e uma base apenas visual/informativa. Nao participa automaticamente dos calculos de Profit ou Pricing.

Permite:

- percentual minimo/maximo;
- tarifa fixa;
- taxas extras em JSON;
- categoria;
- vigencia;
- fonte;
- ultima verificacao;
- notas;
- regra global ou especifica do tenant.

## Segurança operacional

- nunca envie `.env` ao Git;
- nunca grave Client Secret/Partner Key no frontend;
- rotacione `VOLT_PRICE_ENCRYPTION_KEY` por procedimento controlado, pois trocar a chave sem recriptografar tokens os torna ilegíveis;
- use HTTPS em todos os callbacks;
- mantenha `NODE_ENV=production` no Render;
- o runtime de autenticacao usa somente e-mail e senha; TOTP legado nao deve ser reativado sem uma mudanca de seguranca aprovada;
- use acesso assistido com motivo, nunca compartilhamento de senha de cliente;
- o audit log nao aceita UPDATE/DELETE;
- payloads persistidos de integrações passam por redacao de dados sensiveis;
- mantenha backups/PITR do Neon conforme seu plano e politica de retencao.

## Fontes oficiais usadas no conector

Tray Developers: https://developers.tray.com.br/

Mercado Livre Developers:
- https://developers.mercadolivre.com.br/pt_br/gerenciamento-perguntas-respostas/autenticacao-e-autorizacao
- https://developers.mercadolivre.com.br/pt_br/imovel-consulta-de-usuarios/gerenciamento-de-vendas
- https://developers.mercadolivre.com.br/pt_br/gerenciamento-de-vendas/provisoes
- https://developers.mercadolivre.com.br/pt_br/guia-para-imoveis/boas-praticas-para-o-consumo-das-apis-de-relatorios-de-faturamento
- https://developers.mercadolivre.com.br/pt_br/publicacao-de-produtos/gestao-de-identidades-e-acessos-oauth-e-tokens

Shopee Open Platform: https://open.shopee.com/
