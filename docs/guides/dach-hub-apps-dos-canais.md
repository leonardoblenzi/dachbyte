# DACH Hub: criar os apps no Mercado Livre, Magalu e Shopee

Guia passo a passo para criar os apps próprios do DACH Hub nos três canais e configurar o servidor.
Os apps do Hub são separados dos módulos DACH ML, DACH Magalu e DACH Shopee: cada seller conecta a conta de novo no Hub.

Documentação conferida em 06/11/2026. Os painéis dos canais mudam com frequência: se um campo tiver outro nome, siga o sentido descrito aqui.

## Valores usados em todos os canais

O Hub roda em `https://dachbyte.tech/hub` (variável `HUB_PUBLIC_BASE_URL`). As URLs saem dela:

| Canal | URL de retorno (redirect) | URL de avisos (webhook) |
|---|---|---|
| Mercado Livre | `https://dachbyte.tech/hub/auth/mercadolivre/callback` | `https://dachbyte.tech/hub/webhooks/mercadolivre` |
| Magalu | `https://dachbyte.tech/hub/auth/magalu/callback` | `https://dachbyte.tech/hub/webhooks/magalu` (o Hub assina sozinho, por conta) |
| Shopee | `https://dachbyte.tech/hub/auth/shopee/callback` (na Shopee vai só o domínio: `dachbyte.tech`) | `https://dachbyte.tech/hub/webhooks/shopee` |

Antes de começar, tenha prontos:

- Logo do DACH Hub (PNG quadrado).
- Descrição curta (até 150 caracteres), por exemplo: "DACH Hub: estoque, pedidos, expedição e etiquetas de vários marketplaces num só lugar."
- Página pública de **Termos de uso** e de **Política de privacidade** (o Magalu exige as duas URLs; a Shopee pede a URL do produto em produção).
- IP fixo do servidor do Hub (a Shopee exige a lista de IPs).

---

## 1. Mercado Livre

### Bloqueio: uma aplicação por conta no Brasil

No Brasil, o Mercado Livre só deixa criar **uma** aplicação por conta, depois de validar os dados do titular. Se a conta usada pela DACHBYTE já tem o app do DACH ML, ela não cria outro. Caminhos:

1. **Conta separada para o Hub** (recomendado): uma conta do Mercado Livre em outro CNPJ da empresa (filial, por exemplo), usada só como "dona" do app do Hub. Não precisa vender nada nela.
2. **Pedir ao suporte do Mercado Livre** uma aplicação adicional na mesma conta (pelo DevCenter, explicando que é outro produto). Não há prazo garantido.
3. **Usar o app do DACH ML para o Hub também** (cofre de tokens compartilhado). Contraria a decisão de manter o Hub independente e exige cuidado: o refresh token do ML é de uso único, então os dois sistemas não podem renovar o mesmo token sem coordenação. Só faz sentido no projeto futuro de "conexão única".

### Passo a passo

1. Entre com a conta escolhida em https://developers.mercadolivre.com.br e abra **Minhas aplicações → Criar nova aplicação**.
2. Preencha:
   - **Nome:** `DACH Hub` (o nome precisa ser único no ML; se estiver em uso, `DACH Hub DACHBYTE`).
   - **Nome curto** e **descrição** (até 150 caracteres) e o **logo**.
   - **URIs de redirect:** `https://dachbyte.tech/hub/auth/mercadolivre/callback`
   - **PKCE:** deixe desligado (o Hub não usa).
3. **Escopos:** marque **leitura**, **escrita** e **acesso offline** (sem o offline o ML não devolve o refresh token e a conta cai a cada 6 horas).
4. **Tópicos de notificação:** marque **Orders** (`orders_v2`). Itens e mensagens não são usados pelo Hub hoje.
5. **URL de retorno de notificações:** `https://dachbyte.tech/hub/webhooks/mercadolivre`
6. Salve. Anote o **Client ID** (App ID) e a **Secret Key**.
   - O Hub confere que cada aviso traz o `application_id` do app; avisos de outro app são recusados.
   - A troca de secret pode ser agendada no painel. Ao trocar, atualize `HUB_ML_CLIENT_SECRET` no servidor no mesmo dia.

Variáveis: `HUB_ML_APP_ID` (Client ID) e `HUB_ML_CLIENT_SECRET` (Secret Key).

---

## 2. Magalu

No Magalu, o app ("client") é criado pela linha de comando **IDM CLI** do ID Magalu, e não por um painel.

### Criar o client

1. Baixe o IDM CLI da página de releases indicada em https://developers.magalu.com (Primeiros Passos → criação de client) e instale.
2. Rode `idm login` e entre com a conta Magalu da DACHBYTE. Na tela de consentimento, aceite **Criar client** e **Atualizar client**. A senha é digitada por você no navegador; nenhum sistema deve digitá-la.
3. Crie o client (um comando só; ajuste as URLs de termos e privacidade):

```bash
idm client create --name "DACH Hub" --description "DACH Hub: estoque, pedidos, expedição e etiquetas multicanal" --terms-of-use "https://dachbyte.tech/termos" --privacy-term "https://dachbyte.tech/privacidade" --redirect-uris "https://dachbyte.tech/hub/auth/magalu/callback" --audience "https://api.magalu.com https://services.magalu.com" --scopes "open:portfolio-skus-seller:read open:portfolio-prices-seller:read open:portfolio-stocks-seller:read open:order-order-seller:read open:order-delivery-seller:read open:portfolio-stocks-seller:write open:portfolio-prices-seller:write open:order-logistics-seller:read open:order-logistics-seller:write" --scopes-default "open:portfolio-skus-seller:read open:portfolio-prices-seller:read open:portfolio-stocks-seller:read open:order-order-seller:read open:order-delivery-seller:read open:portfolio-stocks-seller:write open:portfolio-prices-seller:write open:order-logistics-seller:read open:order-logistics-seller:write" --access-token-exp 7200 --always-require-login false
```

4. O comando devolve o **UUID** do client, o **client_id** e o **client_secret**. Guarde os três (o UUID serve para `idm client update` depois).

O que cada escopo libera no Hub:

| Escopo | Uso |
|---|---|
| `open:portfolio-skus-seller:read` | importar anúncios (SKUs) |
| `open:portfolio-prices-seller:read` / `:write` | ler e, no futuro, gravar preço |
| `open:portfolio-stocks-seller:read` / `:write` | ler e gravar estoque |
| `open:order-order-seller:read` | pedidos |
| `open:order-delivery-seller:read` | entregas do pedido |
| `open:order-logistics-seller:read` / `:write` | etiquetas do Magalu Entregas |

Variáveis: `HUB_MAGALU_CLIENT_ID`, `HUB_MAGALU_CLIENT_SECRET` e, só se quiser mudar a lista acima, `HUB_MAGALU_SCOPES` (separados por espaço).

### Avisos de pedido (webhooks): automáticos, por conta

No Magalu, cada seller assina os avisos com o próprio token (`PUT /v1/onboarding/signup`), e cada assinatura recebe um segredo próprio (`whsec_…`), mostrado uma única vez. Por isso **não há segredo de webhook para configurar no servidor**:

- Ao conectar uma conta Magalu, o Hub assina o tópico `orders_order` apontando para `https://dachbyte.tech/hub/webhooks/magalu` e guarda o segredo cifrado na conta.
- Cada aviso é conferido com o segredo da conta que ele cita (`tenant_id`), pela assinatura `X-Signature-256` sobre `X-Timestamp.corpo`, com tolerância de 5 minutos.
- Se a assinatura falhar (por exemplo, o Magalu recusar o tópico para o client), a conexão continua: a tela **Contas conectadas** mostra "Avisos de pedido com falha" e o botão **Assinar de novo**. Enquanto isso, os pedidos chegam pela leitura periódica, a cada 10 minutos.
- Assinar de novo troca o segredo; o Magalu ainda aceita o anterior por 1 hora.
- A documentação do Magalu não informa escopo próprio para a assinatura. Se o primeiro teste falhar com 403, peça ao suporte do Magalu a liberação do tópico `orders_order` para o client do Hub.

---

## 3. Shopee

### Conta de desenvolvedor

1. Crie o login em https://open.shopee.com e solicite o perfil de desenvolvedor. No Brasil há dois tipos; o Hub atende lojas de terceiros, então o tipo é **Third-party Partner (ISV)**.
2. Preencha os dados da empresa e envie. A Shopee analisa antes de liberar a criação de apps.

### Criar o app

1. No Console (https://open.shopee.com/console/app), crie o app com a categoria **ERP System**.
   - A categoria **não muda depois** e define quais APIs o app enxerga. ERP System cobre produto, estoque, pedido e logística, que é o que o Hub usa.
   - "Seller In-House System" é para quem integra só a própria loja: não serve para o Hub.
2. O app nasce em **Developing**, com **Partner ID** e **Partner Key de teste (Sandbox)**. A Partner Key de produção é outra e só aparece depois do Go Live.

### Testes no Sandbox (opcional, recomendado)

- Crie uma conta e uma loja de teste no Sandbox V2 e autorize a loja no app de teste.
- No servidor de testes, use `HUB_SHOPEE_API_BASE=https://openplatform.sandbox.test-stable.shopee.sg` com o Partner ID e a Partner Key de teste.
- Em **Push Mechanism** do Sandbox dá para cadastrar uma Test Callback URL e usar **Push Test Data**.

### Go Live (produção)

Na tela de Go Live, preencha:

- **URL do produto em produção:** `https://dachbyte.tech/hub`
- **Usuário e senha de teste** da solução: crie um usuário de demonstração no Hub só para a análise da Shopee (nunca uma conta real).
- **Descrição** e **captura de tela** do Hub.
- **Live Redirect URL Domain:** `dachbyte.tech` (e **Test Redirect URL Domain** com o domínio de testes, se houver). O Hub monta o retorno em `https://dachbyte.tech/hub/auth/shopee/callback`.
- **IP Address Whitelist:** o IP do servidor do Hub (um por linha) e marque **Enable IP Address Whitelist**. É obrigatório; depois de ligado, só esses IPs chamam a API. Se o servidor mudar de IP, atualize aqui antes.
- **Declaração da infraestrutura:** IP do servidor de banco e de outros servidores usados.
- Sem a lista de IPs, nome, telefone e endereço do comprador chegam mascarados.

Depois da aprovação, pegue a **Partner Key de produção** e use `HUB_SHOPEE_API_BASE=https://partner.shopeemobile.com` (é o padrão; pode deixar a variável vazia).

### Avisos (Push Mechanism)

1. No Console, abra **Push Mechanism** e escolha o app.
2. **Callback URL:** `https://dachbyte.tech/hub/webhooks/shopee`
3. Ligue o push de **status do pedido** (`order_status_push`, código 3). É o único que o Hub processa hoje; os outros podem ficar desligados.
4. Faça a validação pedida pelo Console (a Shopee manda um POST para a URL) e salve.

O Hub confere o cabeçalho `Authorization` de cada push (HMAC-SHA256 da URL + `|` + corpo, com a Partner Key) e responde 2xx.

### Autorização das lojas

- Apps ERP System não têm o botão "Authorize" no Console: o seller autoriza pelo botão **Conectar Shopee** do Hub.
- A autorização vale no máximo **365 dias**. Depois disso a conta aparece como "Reconectar" e o seller autoriza de novo.

Variáveis: `HUB_SHOPEE_PARTNER_ID`, `HUB_SHOPEE_PARTNER_KEY` e `HUB_SHOPEE_API_BASE` (só para Sandbox).

---

## 4. Servidor do Hub

### Variáveis de ambiente

| Variável | Para quê |
|---|---|
| `HUB_DATABASE_URL` | Postgres (schema `hub`). Sem ela, usa `DATABASE_URL`. |
| `SUITE_JWT_SECRET` | Mesmo segredo do login da suíte DACHBYTE. |
| `HUB_ALLOWED_TENANTS` | Empresas liberadas no Hub (separadas por vírgula). |
| `HUB_WRITE_TENANTS` | Empresas que podem gravar estoque nos canais (piloto). Fora da lista, só observação. |
| `HUB_PLATFORM_ADMIN_EMAILS` | E-mails dos administradores da plataforma. |
| `HUB_TOKEN_ENCRYPTION_KEY` | Chave que cifra tokens e segredos de avisos. Gere uma longa e aleatória e **não troque** depois: trocar invalida todas as conexões. |
| `HUB_PUBLIC_BASE_URL` | `https://dachbyte.tech/hub` (base das URLs de retorno e de avisos). |
| `HUB_REDIS_URL` | Redis das filas (sem ela, usa `REDIS_URL`; sem nenhuma, roda tudo no processo web, só para testes). |
| `HUB_ML_APP_ID`, `HUB_ML_CLIENT_SECRET` | App do Mercado Livre. |
| `HUB_MAGALU_CLIENT_ID`, `HUB_MAGALU_CLIENT_SECRET`, `HUB_MAGALU_SCOPES` | Client do Magalu (escopos opcionais). |
| `HUB_SHOPEE_PARTNER_ID`, `HUB_SHOPEE_PARTNER_KEY`, `HUB_SHOPEE_API_BASE` | App da Shopee (base só para Sandbox). |

A variável `HUB_MAGALU_WEBHOOK_SECRET` deixou de existir: o segredo agora é por conta e fica no banco.

### Subir

1. Rodar as migrations (001 a 010): `npm run migrate` em `apps/seller-hub`.
2. Subir o processo web (`npm start`) e o worker (`npm run worker`), os dois com Redis.
3. Conferir que `https://dachbyte.tech/hub/webhooks/{canal}` está público (sem login) e com HTTPS.
4. Liberar o IP do servidor na Shopee antes de conectar a primeira loja.

### Checklist do primeiro teste

- [ ] Conectar uma conta de cada canal pelo Hub (Contas conectadas).
- [ ] Magalu: a conta mostra "Avisos de pedido ativos desde …".
- [ ] Fazer ou esperar uma venda e ver o pedido chegar em segundos (aviso) ou em até 10 minutos (leitura periódica).
- [ ] Shopee: no Console, o Push Mechanism mostra entregas sem erro.
- [ ] Mercado Livre: em Minhas aplicações, as notificações aparecem como entregues.
