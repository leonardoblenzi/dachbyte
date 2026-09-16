# Business - corte final de producao

Este procedimento assume que as Etapas 1-5 ja foram aplicadas, que o PostgreSQL local da VPS foi provisionado/importado e que as migrations ja foram executadas conscientemente pela Etapa 4.

O cutover NAO importa banco, NAO executa migrations e NAO publica desktop automaticamente.

## 1. Preparar arquivos locais da VPS

```bash
cd infra
cp env/production-cutover.env.example env/production-cutover.env
cp env/production-validation.env.example env/production-validation.env
```

Defina o hostname final HTTPS em ambos. Ajuste tambem `env/compose.env` para que:

```env
DACHBYTE_SITE=https://SEU-DOMINIO
DACHBYTE_BIND_IP=0.0.0.0
```

`DACHBYTE_SITE` deve ser exatamente a mesma origem de `PRODUCTION_BASE_URL`. O preflight bloqueia hostname de staging, bind local e divergencias entre esses arquivos.

Em `production-cutover.env`, mantenha inicialmente:

```env
CONFIRM_PRODUCTION_CUTOVER=NO
CONFIRM_PRODUCTION_ROLLBACK=NO
```

## 2. Preflight

```bash
./business-production-ops.sh preflight
```

O comando valida Compose e roles/bancos. Nao reinicia aplicacoes.

## 3. Preparar a release

```bash
./business-production-ops.sh prepare
```

A preparacao executa, nesta ordem:

1. verificacao de bancos/roles;
2. snapshot dos quatro bancos Business;
3. preservacao das imagens Docker atuais com tags `rollback-<timestamp>`;
4. build das novas imagens Business;
5. registro dos IDs exatos das imagens preparadas;
6. nenhum restart de producao.

Se qualquer uma dessas tags for rebuildada entre `prepare` e `cutover`, o corte e bloqueado.

O estado de rollback fica em `infra/.cutover/`. Os snapshots ficam em `infra/backups/migration/`.


## Desktop interno antes do corte

Antes de autorizar `CONFIRM_PRODUCTION_CUTOVER=YES`, gere e instale o canal interno de staging no Windows:

```powershell
npm run desktop:staging:release
```

Valide nele login, WebSocket, upload/download, reconexao e consulta do `latest.json` do canal `staging`. O staging possui appId, dados locais e prefixo R2 separados do desktop oficial.

## 4. Autorizar o corte

Somente depois do staging passar, altere:

```env
CONFIRM_PRODUCTION_CUTOVER=YES
```

Execute:

```bash
./business-production-ops.sh cutover
```

O comando sobe as imagens previamente preparadas com `--no-build`, aguarda healthchecks e executa um smoke publico nas rotas canonicas e legadas.

## 5. Gate final

Primeiro:

```bash
./business-production-ops.sh public-smoke
```

Depois, configure contas de teste em `env/production-validation.env`, habilite os gates desejados e rode:

```bash
./business-production-ops.sh smoke
```

O runner e o mesmo validado em staging, mas aceita variaveis `VALIDATION_*` e aponta para o dominio de producao.

## 6. Rollback de codigo

Se o erro estiver no codigo/imagem e o schema novo continuar compativel:

```env
CONFIRM_PRODUCTION_ROLLBACK=YES
```

```bash
./business-production-ops.sh rollback-code
```

Esse comando apenas recoloca as imagens Docker preservadas e reinicia os servicos. Ele NAO restaura banco automaticamente.

Se uma migration for incompativel com a versao anterior, interrompa o rollback automatico de codigo e restaure o snapshot correto de forma controlada antes de reabrir trafego. Lembre que restaurar um snapshot anterior pode descartar gravacoes realizadas depois dele; reconcilie esse intervalo antes de qualquer restore em producao.

Use:

```bash
./business-production-ops.sh show-rollback
```

para ver as imagens preservadas e o identificador do corte.

## 7. Desktop oficial

Somente depois do gate de producao passar:

1. congele `VOLTCHAT_PRODUCTION_WEB_URL` e `VOLTCHAT_PRODUCTION_API_URL`;
2. gere `desktop:production:dist`;
3. valide assinatura e instalacao em uma maquina de teste;
4. defina `CONFIRM_DESKTOP_PRODUCTION_PUBLISH=YES`;
5. publique o canal oficial R2 com `desktop:production:publish`.

O desktop staging continua isolado por appId, dados locais e prefixo R2 e pode permanecer instalado para diagnostico interno.

## 8. Observar e retirar legado

Depois que o corte estiver estavel, as interfaces antigas ja convergem por HTTP 308 para as URLs canonicas. APIs antigas continuam em proxy para preservar clientes e integracoes.

Monitore o uso:

```bash
LEGACY_LOG_SINCE=168h ./business-legacy-ops.sh report
```

E use o gate antes de qualquer retirada de API:

```bash
LEGACY_LOG_SINCE=168h ./business-legacy-ops.sh api-retirement-gate
```

Nao remova uma API somente porque o gate retornou zero se a retencao dos logs nao cobrir a janela completa. O procedimento detalhado esta em `LEGACY_DEPRECATION.md`.
