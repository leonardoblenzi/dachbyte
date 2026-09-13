# Orquestração de jobs de promoções — 2026-08-19

Base: `ml(20260819-184904).zip`

## 10 correções implementadas

1. **Idempotência forte server-side**
   - fingerprint por conta + campanha + tipo + ação + configuração + seleção;
   - solicitações equivalentes reutilizam o job já aberto.

2. **Lock por conta + campanha**
   - a mesma campanha não pode ter duas operações mutantes concorrentes na mesma conta;
   - duplicatas antigas ainda em espera são reconciliadas no startup do worker.

3. **Trava imediata no frontend**
   - botões de aplicação ficam desabilitados enquanto o backend cria/reutiliza o job;
   - feedback `Criando job...`.

4. **Reuso de job em duplicidade**
   - o backend retorna o job existente (`reused=true`) em vez de criar outro;
   - o frontend informa o número do job mantido.

5. **Fairness por conta**
   - padrão: no máximo 2 jobs de promoções ativos por conta;
   - uma conta não monopoliza todos os slots globais.

6. **Fila visualmente diferente de processamento**
   - painel ganhou seção `NA FILA`;
   - queued mostra `Na fila`, espera, posição na fila da conta e saúde do worker;
   - jobs grandes que cedem o slot aparecem como `Revezando`, sem saltar para concluídos.

7. **Cancelamento imediato de queued/delayed**
   - o X remove o job da fila antes de ele tocar a API do Mercado Livre;
   - um tombstone auditável mantém o cancelamento visível no painel.

8. **Lifecycle de remediação**
   - `remediation_pending > 0` vira `review_pending`;
   - o processo não fica terminal enquanto houver remediação pendente.

9. **Heartbeat/watchdog do worker**
   - heartbeat periódico no Redis;
   - painel diferencia fila cheia de worker sem heartbeat;
   - job ativo sem atualização além da janela recebe alerta.

10. **Chunking cooperativo/checkpoint**
    - novos jobs grandes com seleção preparada/processamento por MLB são divididos em fatias;
    - padrão: 50 itens por fatia;
    - após cada fatia o mesmo job salva checkpoint, libera o slot e volta ao revezamento;
    - counters, resultados, auditoria e XLSX permanecem no mesmo job.

## Defaults

Não é obrigatório criar variáveis de ambiente. Os defaults são:

- `PROMO_MAX_ACTIVE_JOBS_PER_ACCOUNT=2`
- `PROMO_JOB_CHUNK_SIZE=50`
- `PROMO_JOB_YIELD_DELAY_MS=1500`
- `PROMO_WORKER_HEARTBEAT_MS=5000`
- `PROMO_WORKER_STALE_MS=30000`
- `PROMO_ACTIVE_STALE_MS=300000`

## Deploy

1. Extraia este patch na raiz de `ml/`, preservando as pastas.
2. Reinicie **web + worker**.
3. O restart do worker é obrigatório para a reconciliação inicial da fila.

## Jobs já existentes

- duplicatas em `waiting/delayed` são canceladas com segurança e apenas um job da campanha é mantido;
- jobs ativos não são removidos no meio de uma chamada ao Mercado Livre;
- ao serem retomados após restart, o lock de campanha impede que duplicatas continuem mutando a mesma campanha em paralelo;
- novos jobs já entram com idempotência, fairness e chunking.
