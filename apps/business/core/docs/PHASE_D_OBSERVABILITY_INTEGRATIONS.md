# Fase D — Observabilidade e motor de integrações

## Observabilidade

O runtime agora propaga `requestId`, `companyId` e `userId` por `AsyncLocalStorage` e emite logs JSON estruturados. Requests 5xx, requests lentos e queries lentas têm eventos próprios. O conteúdo de SQL e parâmetros não é escrito em log; somente operação/tabela/duração. Tokens, Authorization, cookies, passwords/API keys e credenciais embutidas em URLs são redigidos automaticamente nos logs estruturados.

- `VOLT_CORE_SLOW_REQUEST_MS`: limiar de request lento (default 1000 ms).
- `VOLT_CORE_SLOW_QUERY_MS`: limiar de query lenta (default 750 ms).
- `GET /api/core/master/observability`: visão detalhada para master, com métricas do processo, pool, worker e filas/dead-letter.
- `/health` continua deliberadamente mínimo e não expõe métricas internas.

## Motor assíncrono

A migration `016_observability_integration_engine.sql` cria:

- `integration_accounts`: contas externas; **não armazena segredo**, apenas `credential_ref`.
- `integration_mappings`: mapeamento Volt ↔ ID externo.
- `integration_jobs`: fila durável com `queued`, `processing`, `retrying`, `completed`, `dead_letter` e `canceled`.
- `integration_job_attempts`: histórico de tentativas.
- `integration_webhook_events`: deduplicação e rastreio de webhook.
- `integration_outbox_events`: outbox transacional dos eventos do domínio.

Todas as tabelas são protegidas por RLS/FORCE RLS.

O worker usa `FOR UPDATE SKIP LOCKED`, portanto múltiplas instâncias podem consumir a fila sem pegar o mesmo registro. Jobs presos por queda do processo voltam para retry após o lease expirar. A varredura de leases ocorre em cadência separada (`VOLT_CORE_JOB_RECOVERY_MS`) para não consultar o banco desnecessariamente em todo poll.

Retries usam backoff exponencial e jobs não-retryable ou que atingem `max_attempts` vão para `dead_letter`. Dead letters podem ser reenfileiradas manualmente via API autenticada. Não existe endpoint HTTP genérico para criar jobs arbitrários; conectores registram handlers conhecidos e enfileiram trabalho pelo serviço interno.

## Outbox

Os eventos já gravados pelo Core (`sale.created`, `sale.canceled`, `stock.moved`, `receivable.created`, etc.) são espelhados para a outbox no mesmo contexto transacional nos fluxos críticos. Conectores futuros registram subscribers por tipo de evento. Subscribers devem criar jobs idempotentes, porque uma entrega pode ser repetida após falha do processo.

## Webhooks

A rota pública existe em `/api/core/webhooks/:provider`, porém **nenhum provedor é aceito por padrão**. Um connector precisa registrar um adapter contendo obrigatoriamente:

1. `resolveAccount` — identifica a conta externa sem estabelecer contexto tenant; conectores podem usar `resolveIntegrationAccountGlobally(provider, externalAccountId)`, que retorna no máximo a conta ativa correspondente;
2. `verify` — valida assinatura/autenticidade usando o corpo bruto e a conta resolvida;
3. `normalize` — produz `externalEventId`, `eventType`, `payload` e `jobType`.

O tenant só é estabelecido **depois** de `verify === true`. Se o mesmo ID externo estiver vinculado a mais de uma empresa, o resolver global falha com `INTEGRATION_ACCOUNT_AMBIGUOUS` em vez de escolher um tenant arbitrariamente.

Sem adapter registrado, o endpoint retorna `WEBHOOK_PROVIDER_NOT_REGISTERED`. Headers sensíveis não são persistidos.

## Credenciais

`integration_accounts.config` rejeita chaves com nomes de token, senha, segredo, API key, access key etc. Use `credentialRef`. Existe resolver `env:NOME_DA_VARIAVEL`; conectores podem registrar outros resolvers (secret manager, vault, OAuth store) sem mudar o schema.

## Validação de staging

Depois de migration/test/build, execute:

```bash
npm run validate:phase-d
```

O diagnóstico usa uma empresa ativa (ou `VOLT_CORE_PHASE_D_COMPANY_ID`) e valida:

- job concluído;
- dead-letter não-retryable;
- retry manual e recuperação;
- dispatch de outbox;
- deduplicação de webhook;
- sanitização de headers.

Os registros do probe são removidos no `finally`.

## Execução do worker

Por padrão o web service inicia o worker embutido. Em escala maior, configure `VOLT_CORE_WORKER_DISABLED=true` no web e execute um processo separado com:

```bash
npm run worker:integrations
```

O `SKIP LOCKED` permite mais de um worker simultâneo. O histórico concluído é podado periodicamente; defaults: 30 dias para jobs/outbox concluídos e webhooks processados. Dead letters não são removidas automaticamente.
