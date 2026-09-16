# Business - deprecacao de rotas legadas

As URLs publicas canonicas sao:

| Produto | Interface | API |
| --- | --- | --- |
| Core | `/business/core` | `/business/core/api` |
| Chat | `/business/chat` | `/business/chat/api` |
| Stock | `/business/stock` | `/business/stock/api` |
| Price | `/business/price` | `/business/price/api` |

## Estado da compatibilidade

Interfaces antigas usam redirect permanente `308` preservando o restante do caminho e a query string:

- `/core/*` -> `/business/core/*`
- `/chat/*` -> `/business/chat/*`
- `/voltstock/*` -> `/business/stock/*`
- `/volt-price/*` -> `/business/price/*`
- `/voltchat/*` e `/volt_chat/*` -> `/business/chat/*`
- `/stock/*` -> `/business/stock/*`

As rotas de API antigas **nao redirecionam**. Elas continuam fazendo proxy para preservar clientes HTTP, OAuth, WebSocket e desktops antigos:

- `/api/core/*`
- `/chat-api/*`
- `/business/chat-api/*`
- `/voltstock/api/*`
- `/volt-price/api/*`

Essas respostas incluem:

```text
Deprecation: true
X-Dachbyte-Legacy-Route: true
X-Dachbyte-Canonical-Path: /business/<produto>/api
Link: </business/<produto>/api>; rel="successor-version"
```

`/volt-price/health`, `/version.json` e alguns assets globais antigos permanecem como compatibilidade temporaria e tambem sao marcados como legados.

## Medir uso antes de remover APIs

O Caddy grava em stdout um access log JSON dedicado somente às rotas legadas. O logger guarda apenas o **path original sanitizado** em `legacy_path`: query string, headers e IPs de request sao removidos, e o token presente no caminho do WebSocket do Chat e substituido por `REDACTED`. Os smoke tests usam `X-Dachbyte-Validation-Probe: legacy-smoke` e sao excluidos desse logger para nao contaminar as metricas. Para resumir os ultimos 7 dias:

```bash
cd infra
LEGACY_LOG_SINCE=168h ./business-legacy-ops.sh report
```

Para bloquear a retirada enquanto houver qualquer chamada de API legada no periodo:

```bash
LEGACY_LOG_SINCE=168h ./business-legacy-ops.sh api-retirement-gate
```

O gate retorna erro se encontrar trafego em uma API antiga.

**Importante:** zero hits so e evidencia valida se a retencao dos logs cobrir todo o periodo observado. Reinicio/remocao do container Caddy ou politica curta de logs pode apagar historico. Antes de remover as APIs, use uma janela representativa para todos os clientes ativos e confirme que desktops oficiais e integracoes externas ja estao nos caminhos canonicos.

## Validacao estatica

```bash
./business-legacy-ops.sh verify
```

Esse comando garante que:

- APIs canonicas continuam antes das interfaces correspondentes;
- APIs legadas continuam como proxy e nao redirect;
- interfaces legadas usam `308`;
- headers de deprecacao permanecem presentes;
- access log JSON de legado continua habilitado e sanitizado.

O mesmo gate faz parte de `business-staging-ops.sh config` e `business-production-ops.sh preflight`.

## Remocao definitiva

A remocao das APIs legadas deve ser um change separado depois do periodo de observacao. Nao remova aliases internos dos produtos enquanto Caddy ainda encaminhar chamadas de compatibilidade para eles. Depois de zero uso confirmado, a ordem recomendada e:

1. remover APIs legadas do Caddy;
2. rodar smoke completo;
3. remover aliases internos de Core/Stock/Price se nao houver outro consumidor;
4. remover `/version.json` e assets globais antigos somente depois de confirmar que nenhum desktop antigo depende deles.
