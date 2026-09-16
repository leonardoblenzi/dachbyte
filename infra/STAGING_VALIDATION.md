# Business staging validation

Esta etapa prepara e valida a stack Business em staging na VPS. O comando `up` pode buildar/iniciar os containers; os gates nao importam bancos, nao executam migrations e nao fazem cutover de producao.

## 1. Arquivos necessarios

Na VPS, crie os `.env` reais a partir dos exemplos das etapas anteriores e, para os testes:

```bash
cp infra/env/staging-validation.env.example infra/env/staging-validation.env
```

Preencha uma conta de teste funcional para Chat, Core, Stock e Price. Para Core, use preferencialmente um usuario comum autorizado no Hub, nao o master local. O arquivo real fica ignorado pelo Git.

O `hub.env` tambem precisa estar preenchido, pois o gate chama `/v1/internal/auth/verify` diretamente para comprovar a integracao Hub -> Core.

## 2. Gates

```bash
cd infra

# Depois de concluir import/migrations da Etapa 4:
./business-staging-ops.sh up
./business-staging-ops.sh wait

./business-staging-ops.sh config
./business-staging-ops.sh status
./business-staging-ops.sh db
./business-staging-ops.sh public-smoke
./business-staging-ops.sh smoke
```

Ou, depois de conferir cada etapa individualmente:

```bash
./business-staging-ops.sh all
```

`up` nao executa import nem migrations; ele apenas constroi/inicia a stack Business de staging.

`all` deve terminar com exit code `0` antes do go-live.

## 3. O que o smoke completo verifica

- containers internos de Portal/Core/Chat/Chat API/Stock/Price;
- conexao real de Core, Chat, Stock e Price com PostgreSQL;
- interfaces canonicas `/business/<produto>`;
- aliases de interface legados `/core`, `/chat`, `/voltstock` e `/volt-price` retornando `308` para as rotas canonicas;
- APIs canonicas e APIs legadas;
- guards de autenticacao sem sessao;
- `version.json` do Chat;
- configuracao de recuperacao de senha/Brevo sem enviar e-mail;
- `Hub /v1/internal/auth/verify` com permissao para `volt_core`;
- login e sessao do Chat;
- WebSocket `wss://.../business/chat/api/messages/ws/{token}`;
- upload pequeno + download autenticado no Chat;
- login e sessao do Core;
- login/JWT do Stock;
- login/cookie canonico e legado do Price.

Com `STAGING_REQUIRE_ISOLATION_TESTS=true` (padrao), `STAGING_CHAT_B_USER`/`PASSWORD` precisam apontar para uma conta Chat de outra empresa. O gate exige que a conta A nao consiga listar arquivos dessa empresa.

Da mesma forma, `STAGING_CORE_B_USER` e `STAGING_CORE_B_PASSWORD` precisam apontar para outra empresa. O teste tenta acessar o workspace da empresa B usando a sessao da conta A e exige bloqueio `403/404`.

## 4. Upload de 10 MiB

O teste de limite e opt-in porque o arquivo aceito e persistido no staging durante o ciclo normal de retencao do Chat.

Ative uma vez antes do corte:

```env
STAGING_TEST_CHAT_LARGE_UPLOAD=true
```

O gate exige:

- arquivo de exatamente 10 MiB aceito;
- arquivo de 10 MiB + 1 byte rejeitado pelo backend.

Isso tambem confirma que o Caddy nao esta impondo um limite menor do que o permitido pela aplicacao.

Depois do teste, volte a flag para `false`.

## 5. Desktop/R2

Enquanto ainda nao houver release interno de staging publicado, deixe:

```env
STAGING_REQUIRE_DESKTOP_RELEASE=false
```

Quando o instalador interno estiver publicado no R2, informe o manifesto do canal isolado e altere para `true`:

```env
STAGING_DESKTOP_MANIFEST_URL=https://SEU-R2/desktop/staging/releases/windows/latest.json
STAGING_EXPECTED_DESKTOP_CHANNEL=staging
STAGING_REQUIRE_DESKTOP_RELEASE=true
```

A validacao consulta o `latest.json` diretamente no R2 e falha se o manifesto pertencer ao canal de producao.

## 6. Testes manuais que continuam obrigatorios

Os itens abaixo dependem de comportamento de interface ou de uma acao deliberadamente disruptiva e nao sao executados pelo smoke automatizado:

1. abrir as quatro interfaces em navegador e fazer refresh em rotas internas;
2. trocar empresa no Core/Chat com contas que possuam multiplos vinculos;
3. confirmar visualmente permissoes de perfis diferentes;
4. abrir Chat em dois navegadores/usuarios e enviar mensagem em tempo real nos dois sentidos;
5. reiniciar `business-chat-api` e comprovar reconexao automatica do cliente;
6. recriar o container `business-chat-api` e confirmar que anexos anteriores continuam baixando;
7. solicitar recuperacao de senha de uma conta de teste real e confirmar recebimento no e-mail;
8. confirmar pelo Hub que o login/provisionamento esperado foi registrado;
9. revisar logs de Caddy e aplicacoes para garantir ausencia de senhas/tokens; o logger `legacy_routes` deve continuar isolado, guardar apenas `legacy_path`, remover query string/headers/IPs e substituir o token de WebSocket por `REDACTED` antes do log;
10. testar uma restauracao de backup em ambiente separado antes do corte final.

Registre data, commit/tag e resultado desses testes. Falha em qualquer item bloqueia a Etapa 6.

## Etapa 7 - rotas legadas

O smoke agora exige que interfaces antigas retornem `308` para `/business/<produto>` e que APIs antigas continuem respondendo sem redirect, com `Deprecation: true` e `X-Dachbyte-Canonical-Path`. Essas chamadas usam `X-Dachbyte-Validation-Probe: legacy-smoke`, e o Caddy as exclui do logger `legacy_routes` para nao gerar falso uso de compatibilidade.

Para inspecionar uso real depois de publicar:

```bash
./business-legacy-ops.sh report
```

Veja `LEGACY_DEPRECATION.md` antes de remover qualquer alias de API.
