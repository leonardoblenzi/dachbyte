# Inteligência SMART: verificação rápida e completa

## Objetivo

Tornar a análise SMART capaz de demonstrar quais campanhas e participações foram realmente verificadas, oferecendo dois modos de execução sem enfraquecer as regras atuais de segurança do otimizador:

- **Verificação rápida:** prioriza campanhas SMART ativas e conflitos com maior potencial de redução da contribuição do vendedor.
- **Verificação completa:** percorre todas as campanhas SMART relevantes e todas as páginas disponíveis, com retomada e comprovação de cobertura.

Os dois modos devem executar como jobs Bull no worker e compartilhar o mesmo motor de coleta, normalização e análise.

## Problemas atuais

A implementação atual pode encerrar uma varredura sem demonstrar cobertura integral:

- a paginação dos itens pode terminar quando uma página contém menos que o limite solicitado, mesmo que `paging.total` ainda indique registros pendentes;
- uma fonte complementar por status pode parar quando a página atual contém somente campanhas já conhecidas, sem examinar páginas posteriores;
- os tetos de páginas e campanhas não aparecem como cobertura parcial para o usuário;
- campanhas que falham são resumidas como avisos, sem uma rodada direcionada de recuperação;
- o resultado não compara registros esperados com registros únicos coletados;
- o indicador de itens analisados representa MLBs agrupados, não comprovação de todas as participações lidas.

## Decisão de arquitetura

Será usado um único motor de análise com uma estratégia configurável:

```json
{
  "mode": "quick | full",
  "accountKey": "conta-ml",
  "requestedBy": "usuario",
  "analysisId": "uuid"
}
```

Tanto a verificação rápida quanto a completa serão jobs em segundo plano. Não haverá análise longa dentro da requisição HTTP. O web apenas validará a solicitação, criará o job e devolverá sua identificação.

O motor compartilhado terá unidades separadas para:

1. descoberta de campanhas;
2. planejamento e priorização;
3. paginação e coleta;
4. checkpoints e cobertura;
5. normalização das participações;
6. análise de equivalência e rebate;
7. persistência do resultado.

## Modos de verificação

### Verificação rápida

A verificação rápida priorizará:

1. campanhas SMART com status ativo;
2. períodos que se sobrepõem;
3. campanhas com sinais de MLBs presentes em mais de uma SMART;
4. combinações com maior potencial de redução da contribuição do vendedor.

Ela terá orçamento operacional limitado por tempo, páginas e chamadas. O encerramento por orçamento é válido, mas o resultado deve permanecer explicitamente parcial. Campanhas ou participações não comprovadas nunca serão apresentadas como inexistentes.

A análise rápida poderá gerar oportunidades executáveis somente quando todos os dados dos dois lados da comparação tiverem cobertura comprovada.

### Verificação completa

A verificação completa percorrerá todas as campanhas SMART participantes, inclusive ativas, pendentes, agendadas ou equivalentes normalizadas como participação futura. Campanhas encerradas e itens apenas candidatos permanecem fora do escopo.

O job continuará até uma destas condições:

- cobertura integral comprovada;
- cancelamento solicitado pelo usuário;
- falha permanente após a política de repetição;
- proteção contra resposta inconsistente do Mercado Livre;
- teto operacional de segurança atingido.

As quatro últimas condições produzem resultado parcial ou inconclusivo, nunca conclusão integral.

## Descoberta de campanhas

A listagem sem filtro continuará como fonte principal. As consultas por status serão fontes complementares e todas deverão paginar independentemente.

Encontrar uma página composta apenas por campanhas duplicadas não encerra a fonte. A paginação somente termina quando o contrato de paginação da resposta indicar fim, o total tiver sido alcançado ou uma proteção de loop for acionada.

O resultado da descoberta registrará:

- fontes consultadas;
- páginas visitadas por fonte;
- campanhas únicas descobertas;
- total declarado por fonte, quando disponível;
- fontes completas, parciais e incompatíveis.

## Paginação de itens

A decisão de próxima página seguirá esta prioridade:

1. `search_after` ou token equivalente retornado pela API;
2. `paging.total`, offset e limite efetivamente retornado;
3. marcador explícito de próxima página;
4. ausência comprovada de continuação.

Uma página menor que o limite solicitado não prova o final quando o payload ainda declara registros pendentes.

O coletor manterá proteção contra:

- cursor repetido;
- página idêntica;
- offset sem avanço;
- total regressivo ou contraditório;
- registros duplicados entre páginas;
- mudança de estratégia de cursor para offset.

Ao detectar inconsistência que impeça provar o fim, a campanha será marcada como `inconclusive`, com o motivo técnico preservado para suporte.

## Checkpoints e retomada

Cada campanha manterá um checkpoint associado à conta, análise e modo, contendo no mínimo:

- campanha e status;
- estratégia de paginação;
- cursor ou offset seguinte;
- páginas processadas;
- chaves únicas coletadas;
- total esperado, quando disponível;
- tentativas e último erro;
- estado da cobertura;
- data da última atualização.

Reinício ou perda do worker deve retomar do último checkpoint consistente. A verificação completa também poderá continuar uma análise rápida, reutilizando somente páginas e participações ainda válidas. Dados vencidos deverão ser relidos.

## Estados de cobertura

Campanhas e resultados usarão estados explícitos:

- `complete`: o fim da paginação foi comprovado;
- `partial`: parte conhecida foi lida, mas o orçamento ou cancelamento interrompeu o trabalho;
- `inconclusive`: resposta incompatível, falha permanente ou inconsistência impediu comprovar a cobertura;
- `indeterminate`: a API não forneceu total e não foi possível obter outra evidência suficiente de integralidade.

Uma porcentagem somente será exibida quando numerador e denominador forem confiáveis. Caso contrário, a interface mostrará o estado textual, sem fabricar `100%`.

## Classificação dos resultados

Cada resultado será classificado individualmente:

- `verified`: dados suficientes e cobertura comprovada; pode ser candidato à otimização;
- `review`: cobertura comprovada, mas alguma regra de segurança ou equivalência não foi satisfeita;
- `inconclusive`: depende de campanha ou participação cuja cobertura não foi comprovada;
- `already_optimized`: cobertura comprovada e nenhuma troca vantajosa encontrada.

O otimizador aceitará apenas oportunidades `verified`. Resultados parciais, cancelados, indeterminados ou inconclusivos não poderão ser promovidos para execução automática.

As regras atuais permanecem válidas: equivalência da condição do comprador, cobertura integral do intervalo, status compatíveis, Offer IDs válidos, redução mínima da contribuição do vendedor e aumento mínimo da participação do Mercado Livre.

Antes e depois de cada remoção, a participação continuará sendo revalidada diretamente no Mercado Livre.

## Concorrência, limites e falhas

A coleta usará concorrência pequena e configurável entre campanhas. Toda chamada continuará passando pelo limitador distribuído por conta e pelo bloqueio compartilhado de `Retry-After`.

Falhas `429` respeitarão o tempo informado pelo Mercado Livre. Erros transitórios usarão backoff exponencial com jitter. Falhas permanentes serão registradas por campanha.

A repetição terá duas fases:

1. tentativas locais durante a leitura da página;
2. rodada final concentrada nas campanhas que permanecerem incompletas.

O modo completo terá política mais persistente que o rápido, mas ambos respeitarão tetos de segurança configuráveis. Alcançar um teto sempre será visível no resultado.

## Interface

A área de Inteligência apresentará dois comandos:

- **Verificação rápida** — “Prioriza campanhas ativas e conflitos com maior potencial.”
- **Verificação completa** — “Percorre todas as campanhas e pode levar vários minutos.”

O progresso do job deverá informar fase e cobertura, por exemplo:

```text
Descobrindo campanhas
Campanhas 42/84
Participações 8.450/18.430
Repetindo 2 campanhas com falha
Calculando oportunidades
```

O resumo final exibirá:

- campanhas encontradas;
- campanhas completamente verificadas;
- campanhas parciais ou inconclusivas;
- participações esperadas, quando conhecidas;
- participações únicas coletadas;
- estado ou percentual de cobertura;
- quantidade de oportunidades verificadas, revisões e inconclusivos.

A verificação rápida exibirá permanentemente que é uma análise priorizada. A interface permitirá continuar o mesmo trabalho como verificação completa.

Os resultados serão separados em quatro áreas: oportunidades verificadas, revisão manual, inconclusivos e já otimizados. Somente a primeira terá seleção para execução.

## Cancelamento e expiração

O cancelamento será verificado entre páginas e campanhas. Um job cancelado preservará o relatório parcial e seus checkpoints pelo período de retenção, mas nenhuma oportunidade dependente dessa execução poderá ser otimizada sem cobertura comprovada.

Resultados e checkpoints terão expiração explícita. Continuar uma análise antiga exigirá revalidar ou descartar os dados vencidos antes de usá-los.

## Observabilidade

Logs e metadados do job deverão registrar, sem tokens ou dados sensíveis:

- modo solicitado;
- conta técnica;
- campanhas e páginas descobertas;
- chamadas, repetições e `429`;
- estratégia de paginação usada;
- cursor repetido ou resposta contraditória;
- tempo por fase;
- motivo de toda campanha parcial ou inconclusiva.

O relatório XLSX deverá incluir uma aba de cobertura por campanha além das oportunidades encontradas.

## Créditos

A análise rápida ou completa não altera a regra de cobrança da otimização. A cotação continuará considerando apenas as oportunidades selecionadas, e a liquidação deverá cobrar somente otimizações confirmadas com sucesso.

Se futuramente a própria análise passar a ser uma operação cobrada, isso exigirá uma decisão comercial separada e não faz parte deste escopo.

## Testes de aceitação

A implementação deverá cobrir pelo menos:

1. paginação completa por cursor;
2. paginação por offset e total;
3. página menor que o limite com total ainda pendente;
4. cursor, offset ou página repetidos;
5. páginas contendo somente duplicados antes de páginas com campanhas novas;
6. campanha encontrada apenas em fonte complementar por status;
7. total ausente, regressivo ou incompatível;
8. `429` com `Retry-After`, erros `5xx` e falhas permanentes;
9. checkpoint e retomada após reinício;
10. cancelamento com relatório parcial;
11. diferença entre os planejamentos rápido e completo;
12. continuação da rápida para a completa;
13. classificação de cobertura completa, parcial, inconclusiva e indeterminada;
14. bloqueio de oportunidades que dependam de cobertura não comprovada;
15. concorrência e isolamento por conta;
16. revalidação antes e depois da remoção;
17. cobrança somente de otimizações confirmadas.

## Fora do escopo

- alterar as tolerâncias de equivalência ou os ganhos mínimos de rebate;
- otimizar campanhas que não sejam SMART;
- incluir itens apenas candidatos, sem participação;
- remover automaticamente resultados de revisão ou inconclusivos;
- cobrar créditos pela execução da análise;
- substituir os limites distribuídos de chamadas já existentes.

## Critérios de sucesso

A mudança será considerada pronta quando:

- os dois modos executarem pelo sistema de jobs;
- a paginação não encerrar prematuramente pelos casos conhecidos;
- toda conclusão declarar cobertura comprovada, parcial, inconclusiva ou indeterminada;
- nenhuma oportunidade sem cobertura comprovada puder ser executada;
- a análise completa puder retomar de checkpoint;
- a rápida puder ser continuada como completa;
- os indicadores da interface corresponderem aos metadados coletados;
- os testes novos e a regressão existente do módulo de promoções passarem.
