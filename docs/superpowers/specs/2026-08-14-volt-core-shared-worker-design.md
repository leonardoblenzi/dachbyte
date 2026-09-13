# Volt Core Shared Worker Design

## Contexto

O webservice `business` hospeda no mesmo container o gateway Express, Volt Core, VoltPrice, Volt Stock (Fastify + Next) e um subprocesso Python/Uvicorn para o Volt Chat. O worker de integrações do Core roda embutido nesse processo Node.

O falso `integration.outbox.completed` já foi corrigido na `voltdev`: uma fila vazia retorna `null` e encerra o lote. Ainda assim, o worker consulta jobs e outbox a cada três segundos quando está ocioso. Isso gera carga constante de banco e rede sem oferecer benefício enquanto não há integrações externas ativas.

## Objetivos

- Manter o worker no webservice atual sem polling agressivo quando a fila estiver vazia.
- Retomar processamento rapidamente quando existir trabalho.
- Falhar no startup diante de configuração numérica inválida, em vez de criar timer com `NaN`.
- Controlar access logs HTTP sem ocultar warnings e erros operacionais.
- Garantir que o Volt Chat use exatamente um worker Uvicorn enquanto o estado WebSocket estiver em memória.
- Preservar compatibilidade com as variáveis existentes e com o comando `worker:integrations`.

## Fora de escopo

- Criar um Background Worker pago no Render.
- Migrar a fila para Redis, `LISTEN/NOTIFY` ou outro broker.
- Separar Volt Chat ou Volt Stock em outro webservice.
- Alterar migrations ou o schema da fila.
- Reduzir pools de banco sem telemetria de espera por conexão.
- Corrigir textos da Fase E; eles serão tratados como uma mudança pequena e independente depois deste runtime.

## Alternativas consideradas

### Apenas aumentar o intervalo fixo

É uma mitigação imediata e pode ser feita por variável de ambiente, mas impõe a mesma latência mesmo quando existe backlog. Não resolve valores inválidos nem o ruído dos access logs.

### Desativar o worker no webservice

Remove toda carga ociosa, porém jobs e eventos acumulam até existir um worker separado. Background Workers não estão disponíveis no plano gratuito do Render, portanto esta não é a opção padrão do staging atual.

### Timer adaptativo no processo atual

É a opção escolhida. Mantém uma única instância do worker, usa intervalo curto enquanto processa trabalho e aumenta progressivamente o intervalo quando a fila está vazia. Não exige infraestrutura nova e preserva a fila durável.

## Desenho do scheduler

O worker trocará `setInterval` por um `setTimeout` autoagendado. Apenas um timer poderá existir por instância.

- Intervalo ativo: `VOLT_CORE_JOB_POLL_MS`, padrão de 3 segundos, mantido por compatibilidade.
- Intervalo ocioso máximo: `VOLT_CORE_WORKER_IDLE_MAX_MS`, padrão de 60 segundos.
- Fator de backoff: `VOLT_CORE_WORKER_IDLE_BACKOFF_FACTOR`, padrão `2`.
- Jitter: `VOLT_CORE_WORKER_JITTER_RATIO`, padrão `0.15`.
- Quando `runOnce()` processar pelo menos um job ou evento, o próximo ciclo usa o intervalo ativo.
- Quando o ciclo estiver vazio, o intervalo dobra até o máximo ocioso.
- Quando ocorrer erro, o próximo ciclo usa o intervalo ativo para preservar a recuperação existente; retries continuam obedecendo `available_at`.
- `wake()` cancela o timer ocioso e agenda um ciclo imediato, sem iniciar execução paralela.
- Enqueues que controlam a própria transação chamam `wake()` somente depois do commit.
- Enqueues feitos por uma transação externa não sinalizam antes do commit; o safety poll no máximo ocioso continua sendo a garantia.
- `stop()` cancela o timeout e aguarda o ciclo em andamento, como hoje.

O status do worker passará a expor `nextRunAt`, `currentPollMs` e `idleCycles`. Isso permite confirmar o backoff sem depender de volume de logs.

## Configuração segura

Uma função única validará números inteiros e decimais com limites explícitos. Valor ausente usa o padrão; valor presente e inválido interrompe o startup com código `WORKER_CONFIG_INVALID`.

Limites:

- intervalo ativo: 500 ms a 5 min;
- intervalo ocioso máximo: do intervalo ativo até 15 min;
- fator: 1 a 10;
- jitter: 0 a 0,5;
- batch de jobs/outbox: 1 a 1.000;
- lease e recovery: mínimo existente de 30 segundos;
- maintenance: mínimo existente de uma hora.

O valor calculado nunca poderá ser `NaN`, infinito ou negativo.

## Access logs

O middleware HTTP ganhará `VOLT_CORE_HTTP_LOG_MODE`:

- `all`: comportamento atual; registra todos os `/api/*` em `info`.
- `slow-errors`: padrão de produção; registra requests lentos em `warn` e respostas 5xx em `error`.
- `errors`: registra somente 5xx.
- `off`: não registra requests, mas não altera logs de banco, worker ou integrações.

Métricas de requests continuarão sendo registradas em todos os modos. `VOLT_CORE_LOG_LEVEL` continua funcionando como filtro global.

Eventos reais do outbox continuam registrando IDs. Completion sem subscribers será `debug`, porque não houve integração externa; a métrica permanece registrada.

## Volt Chat

O comando Uvicorn receberá `--workers 1` explicitamente. `WEB_CONCURRENCY` poderá continuar definido no Render, mas não multiplicará subprocessos Python, pools, schedulers e estado WebSocket.

O Start Command recomendado para o root `business` é `node start.js`, evitando manter o processo `npm` como pai.

## Falhas e encerramento

- Um erro de processamento atualiza `lastError`, registra log e agenda nova tentativa.
- O guard `running` continua bloqueando sobreposição.
- `wake()` durante uma execução registra apenas a necessidade de executar novamente ao término.
- `SIGTERM` cancela o próximo timeout e aguarda até dez segundos pelo trabalho corrente.
- Recovery e maintenance continuam com a periodicidade atual nesta etapa; advisory lock será uma evolução separada antes de escalar para múltiplas instâncias.

## Estratégia de testes

Os testes usarão timers injetados, relógio e função aleatória determinísticos.

1. Configuração inválida falha com `WORKER_CONFIG_INVALID`.
2. Ciclo vazio aumenta o intervalo até o teto.
3. Ciclo com trabalho volta ao intervalo ativo.
4. Jitter permanece dentro do limite configurado.
5. `wake()` não cria execução concorrente e reduz a espera ociosa.
6. `stop()` cancela o timeout pendente.
7. `slow-errors` não registra 2xx/304 e mantém slow/5xx.
8. Completion sem subscribers não gera `info`.
9. O entrypoint do Volt Chat contém `--workers 1`.
10. As regressões existentes de fila vazia e evento real continuam passando.

Validação final:

- teste isolado do worker;
- `npm test` no Volt Core;
- testes do `business`;
- `npm run build` no Volt Core e no `business`;
- `git diff --check`;
- staging por pelo menos três ciclos ativos e dois minutos ociosos;
- fila vazia sem falso completion;
- um evento real finalizado uma vez;
- RSS/CPU observados no Render por duas a seis horas.

## Relação com a Fase E

Os testes da Fase E encontraram duas falhas de apresentação no tenant Geral:

- Dashboard: `Informe o estoque das armacoes` deve ser `Informe o estoque dos produtos`.
- Produtos: `Armacoes, lentes, acessorios, servicos, precos e estoque.` deve usar texto genérico.

O isolamento funcional passou: menu, formulário e PDV do Geral não exibiram campos ópticos. O golden path óptico atual ficou incompleto porque o SKU de lente de QA utilizado anteriormente não existe mais. Isso exige dados de QA estáveis — uma armação, uma lente, um cliente e uma receita identificados por prefixo — e não uma mudança na regra comercial.
