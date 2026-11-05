# Homologação do app Shopee novo (Sandbox)

Instância **temporária** do `seller-shopee` para a revisão (Go Live) do app
criado na conta nova do Shopee Open Platform. Enquanto o app está em
"Developing", só as credenciais de teste funcionam, e apenas no Sandbox da
Shopee. Esta instância usa essas credenciais para que o avaliador da Shopee
veja o produto funcionando com uma loja de teste.

| Item | Produção (`seller-shopee`) | Homologação (`seller-shopee-homolog`) |
| --- | --- | --- |
| Endereço | `<site>/shopee` | `https://homolog.dachbyte.tech/shopee` |
| API Shopee | produção | `openplatform.sandbox.test-stable.shopee.sg` |
| Partner ID | app atual | **Test Partner ID** do app novo |
| Banco | banco Shopee atual | `shopee_homolog` (vazio, só estrutura) |
| Redis | `redis:6379` | `redis:6379/7` |
| Hub | assinatura e créditos | desligado (login local) |

Nada aqui toca dados, lojas ou tokens de produção.

## 1. Shopee Open Platform (conta nova)

1. **Console > App Management > App List**: abra o app novo (status
   *Developing*) e copie **Test Partner ID** e **Test Key**.
2. Em **Test Redirect URL Domain**, informe `homolog.dachbyte.tech`.
3. **Console > Test Account – Sandbox v2**: crie uma conta do tipo **Shop**,
   loja **local** do Brasil. Guarde o login e a senha gerados (só valem no
   Sandbox).
4. **Login Seller Center** (ao lado da loja): cadastre alguns produtos.
5. **Console > Test Order > Create Test Order**: gere pedidos (loja, itens e
   frete). Aguarde ~5 minutos para aparecerem.
6. Para ter pedidos em estados diferentes: no Seller Center de teste use
   *Arrange Shipment* (aba **To Ship**), depois **Pickup** e **Deliver** em
   *Test Order*.

## 2. DNS

Registro `A` de `homolog.dachbyte.tech` apontando para o IP da VPS. O Caddy
emite o certificado HTTPS sozinho (TLS 1.2+). Crie o DNS **antes** de publicar
o `Caddyfile`, senão o Caddy fica tentando emitir o certificado.

A Shopee exige HTTPS com TLS 1.2+ e nota de segurança **"A"**. Depois de subir
(passo 5), confira o domínio de produção e o de homologação em
<https://www.ssllabs.com/ssltest/>.

Para usar outro host, defina `SHOPEE_HOMOLOG_SITE` no ambiente do Caddy e ajuste
as URLs do `.env` e do Console.

## 3. Banco de dados

Na VPS, a partir da raiz do repositório:

```bash
COMPOSE="docker compose --env-file infra/env/compose.env -f infra/compose.vps.yml"

# Role e database próprios (troque a senha).
$COMPOSE exec -T postgres psql -U dachbyte_admin -d postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE shopee_homolog LOGIN PASSWORD 'TROCAR';
CREATE DATABASE shopee_homolog OWNER shopee_homolog;
SQL
```

Copie **apenas a estrutura** do banco Shopee atual (sem dados). Use a
`SHOPEE_DATABASE_URL` de `infra/env/seller-shopee.env` como origem:

```bash
ORIGEM='<SHOPEE_DATABASE_URL de produção>'
$COMPOSE exec -T postgres pg_dump "$ORIGEM" --schema-only --no-owner --no-privileges \
  | $COMPOSE exec -T postgres psql -U shopee_homolog -d shopee_homolog -v ON_ERROR_STOP=1
```

Confira que está vazio:

```bash
$COMPOSE exec -T postgres psql -U shopee_homolog -d shopee_homolog \
  -c 'SELECT (SELECT count(*) FROM "Shop") AS lojas, (SELECT count(*) FROM "User") AS usuarios;'
```

## 4. Variáveis

```bash
cp infra/env/seller-shopee-homolog.env.example infra/env/seller-shopee-homolog.env
```

Preencha `SHOPEE_DATABASE_URL` (senha do passo 3), `SHOPEE_PARTNER_ID` e
`SHOPEE_PARTNER_KEY` (Test Partner ID e Test Key) e `SESSION_SECRET`
(`openssl rand -hex 32`). **Nunca** use o Partner ID, a chave ou o banco de
produção aqui.

## 5. Subir

A imagem é a mesma do `seller-shopee`; não precisa de build novo se ela já
existir.

```bash
$COMPOSE --profile shopee-homolog up -d seller-shopee-homolog
$COMPOSE exec caddy caddy reload --config /etc/caddy/Caddyfile
$COMPOSE --profile shopee-homolog ps seller-shopee-homolog
curl -fsS https://homolog.dachbyte.tech/shopee/health
```

## 6. Usuários

O seed cria um `SUPER_ADMIN` (para vocês) numa conta chamada `Legacy`:

```bash
$COMPOSE --profile shopee-homolog run --rm -T \
  -e MASTER_ADMIN_EMAIL='<seu email>' -e SUPER_ADMIN_PASSWORD='<senha forte>' \
  seller-shopee-homolog node apps/seller-shopee/scripts/seed-admin.js
```

Renomeie a conta e crie o usuário do avaliador como `ADMIN` da mesma conta
(vê todas as telas da conta, sem a administração global). Gere o hash da senha
com o próprio bcrypt da imagem:

```bash
HASH=$($COMPOSE --profile shopee-homolog run --rm -T --no-deps seller-shopee-homolog \
  node -e "const b=require(require.resolve('bcrypt',{paths:['/app/apps/seller-shopee']}));b.hash(process.argv[1],10).then(h=>console.log(h))" \
  '<senha do avaliador>')
echo "$HASH"   # deve começar com $2b$

$COMPOSE exec -T postgres psql -U shopee_homolog -d shopee_homolog -v ON_ERROR_STOP=1 \
  -v hash="$HASH" <<'SQL'
UPDATE "Account" SET name = 'DACHBYTE Homologação', "updatedAt" = NOW() WHERE name = 'Legacy';
INSERT INTO "User" (email, name, "passwordHash", role, "accountId", status,
                    "activatedAt", "passwordChangedAt", "createdAt", "updatedAt")
SELECT 'shopee.review@dachbyte.tech', 'Shopee Review', :'hash', 'ADMIN', id, 'ACTIVE',
       NOW(), NOW(), NOW(), NOW()
FROM "Account" WHERE name = 'DACHBYTE Homologação'
ON CONFLICT (email) DO UPDATE SET "passwordHash" = EXCLUDED."passwordHash", status = 'ACTIVE';
SQL
```

## 7. Conectar a loja de teste

1. Entre em `https://homolog.dachbyte.tech/shopee/login` com o usuário do
   avaliador e use **conectar loja**.
2. Na tela de autorização da Shopee, entre com o **login da loja de teste**
   (não com a conta real; a conta real dá "Account/Password Verification
   Failed"). Se pedir código de verificação, use `123456`.
3. Confirme a autorização e, no seletor de validade, escolha **365 dias**
   (o padrão pode ser curto e expirar durante a revisão).
4. A Shopee volta para `/shopee/auth/callback?code=...&shop_id=...` e o
   sistema troca o código pelo token. A loja aparece conectada em
   `/shopee/?tab=auth`.
5. Rode a sincronização de produtos e pedidos.

O botão usa o link de autorização legado (`/api/v2/shop/auth_partner` no host
do Sandbox), que a documentação ainda mostra para o Sandbox. Se ele não abrir a
tela de autorização, use o **link fixo do Sandbox Brasil** (estando logado na
homologação, no mesmo navegador). O callback aceita esse link: ele só exige a
sessão, o `code` e o `shop_id`.

```
https://open.sandbox.test-stable.shopee.com.br/auth?partner_id=<Test Partner ID>&auth_type=seller&redirect_uri=https%3A%2F%2Fhomolog.dachbyte.tech%2Fshopee%2Fauth%2Fcallback&response_type=code
```

Erro "The domain of redirect_uri is not consistent with the Redirect URL Domain
declared in console": o **Test Redirect URL Domain** do app não está como
`homolog.dachbyte.tech`.

## 8. Formulário de Go Live

| Campo | Valor |
| --- | --- |
| Live version of your business product's URL | URL de produção do produto |
| Test Username / Test Password | usuário do avaliador (passo 6) |
| Brief Introduction | o que o produto faz + "a conta de teste roda no Sandbox da Shopee, em `homolog.dachbyte.tech`, porque este app ainda não está liberado em produção" + as telas que o Sandbox não atende (abaixo) |
| Client UI screenshot | print da homologação com a loja de teste conectada |
| Test / Live Redirect URL Domain | `homolog.dachbyte.tech` / domínio de produção |
| IP Address Whitelist / IT Assets | IP público da VPS (e dos bancos, se forem externos) |

### O que o Sandbox atende

Segundo o guia *Sandbox Testing V2*, as APIs atendidas são **Product, Global
Product, Media Space, Order, Logistics, First Mile, Shop e Merchant**, além de
push de teste. Ficam de fora, entre outras: **Payment, Ads, Discount, Voucher,
Add-On Deal, Flash Sale, Returns e Account Health**.

Efeito no sistema:

| Tela | No Sandbox |
| --- | --- |
| Produtos, estoque, preço, imagens, clonagem | funciona |
| Pedidos, pacotes, logística, painel de vendas | funciona |
| Receita, margem e financeiro por pedido | vazio (escrow vem da API Payment; o sync de pedidos segue sem erro) |
| Ads, Boost, descontos, Flash Sale, brindes, saúde da conta | erro da Shopee |

Cite isso na descrição do Go Live, por exemplo: "As telas de Ads, promoções e
financeiro dependem de APIs que o Sandbox não oferece e funcionam apenas em
produção."

Para pedir mais APIs no Sandbox, a própria documentação orienta abrir um
ticket com o caso de uso.

## 9. Remover depois da aprovação

```bash
$COMPOSE --profile shopee-homolog stop seller-shopee-homolog
$COMPOSE --profile shopee-homolog rm -f seller-shopee-homolog
$COMPOSE exec -T postgres psql -U dachbyte_admin -d postgres \
  -c 'DROP DATABASE shopee_homolog;' -c 'DROP ROLE shopee_homolog;'
$COMPOSE exec -T redis redis-cli -n 7 FLUSHDB
rm infra/env/seller-shopee-homolog.env
```

Depois remova o serviço `seller-shopee-homolog` do compose, o bloco do
`Caddyfile` e o registro DNS.
