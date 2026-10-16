# Padronização de jobs e créditos do Seller ML

## Objetivo e limites

Padronizar a confirmação de créditos em toda operação paga e a apresentação no painel Processos para operações em lote. Preços, chaves de operação, modelo de consumo por conta e critérios existentes de `billable_units` permanecem inalterados. O Filtro de Anúncios continua com a regra de cobrança atual; a hipótese de cobrar apenas enriquecimento fica fora deste escopo.

Uma operação individual paga, como clonar um anúncio, continua cobrando créditos com confirmação prévia e resultado visível, mas não vira job no painel. Consultas e navegação sem operação cobrável não criam reserva. Cargas somente leitura, como Carregar ativos do Atacado, continuam sem cobrança.

## Inventário de telas

| Tela | Operação paga | Job no painel |
| --- | --- | --- |
| Atacado | Aplicar preços em lote | Sim, já existe; usar como referência de apresentação |
| Gestão de anúncios | Ativar, pausar, encerrar, republicar e excluir em lote | Sim, já existe |
| Clonar anúncio | Clonar um anúncio | Não; é individual |
| Filtro de anúncios | Executar consulta processada/exportação conforme regra atual | Sim, já existe |
| Criar promoções | Validar, aplicar/reaplicar em lote; SMART | Sim para os lotes existentes |
| Remover promoções | Remover em lote, cobrado por remoções bem-sucedidas com `promotions.remove` | Sim, já existe |
| Modelo em massa | Validar/aplicar em lote | Sim, já existe |
| Características | Validar/aplicar em lote | Sim, já existe |
| Validar dimensões | Analisar/aplicar em lote | Sim, já existe |
| Prazo de produção | Consultar/aplicar em lote | Sim para os lotes existentes; consulta individual não vira job |
| Estoque | Varredura e atualização em lote | Sim, já existe |
| Margem de venda, Custos por SKU | Sincronização manual do catálogo | Sim; já usa Bull, mas ainda precisa aparecer no painel compartilhado. Leitura da margem não cria job cobrável |

## Confirmação antes da execução

As telas usam o componente compartilhado de confirmação de créditos. A cotação do Hub apresenta a quantidade alvo, crédito estimado e saldo disponível para `prepaid_credits`. Se o consumo for `unlimited`, apresenta consumo ilimitado e nenhum débito. Saldo insuficiente ou cotação indisponível impedem o início de operação paga em modo de cobrança real. A confirmação não reserva: o backend faz uma única reserva idempotente no início efetivo da operação, mantendo o fluxo existente de cada serviço.

Para operações em que a quantidade só é conhecida após descoberta no backend, a interface não inventa valor exato: apresenta estimativa mínima ou informa que o valor será confirmado antes da reserva, conforme o contrato existente. Se não houver confirmação suficiente para autorizar uma operação de débito real, a operação não inicia.

## Contrato de acompanhamento

O adaptador compartilhado do painel conserva `processed`, `success/applied`, `skipped`, `errors`, `total`, estado terminal e ação de relatório sem assumir que `processed` equivale a sucesso. A descrição específica da tela traduz `success` para aplicado, validado, encontrado ou atualizado, conforme a operação. Falha parcial não é sucesso total. Reload da página recupera jobs ativos do backend; cancelamento preserva o resultado parcial e liquida/libera conforme o trabalho efetivo.

Cada job cobrável expõe ao painel uma síntese de liquidação: `pending`, `confirmed` ou `unconfirmed`, com créditos reservados, gastos e liberados. Valores gastos/liberados vêm da resposta confirmada do Hub, convertidos pela `credit_unit_scale`; não são estimados por proporção de itens. Se a liquidação falhar ou retornar sem confirmação, o painel orienta consultar o extrato e não afirma um débito. Jobs antigos sem metadados de liquidação continuam legíveis, sem valores reconstruídos artificialmente.

As operações individuais pagas mostram o resultado de crédito na própria tela, não no painel Processos. O extrato da carteira continua sendo a fonte contábil autoritativa.

## Implementação e validação

Reutilizar `credit-operation-modal.js`, `jobs-panel-adapters.js` e `jobs-panel.js` sem criar uma segunda infraestrutura de filas ou de carteira. Adaptar cada tela ao contrato comum em incrementos verificáveis, começando pelos fluxos em lote já existentes, depois pela clonagem individual e pela sincronização manual de custos. Evitar refatoração não relacionada.

Testes por fluxo cobrem: conta ilimitada, saldo suficiente/insuficiente, falha da cotação, uma reserva idempotente, sucesso parcial, cancelamento, falha de liquidação, escala de créditos, reload do painel e ausência de cobrança em leitura simples. Rodar suites específicas de cada operação, `test:credits`, `test:jobs-panel` e verificações de sintaxe. Nenhuma migration, mudança de preço, alteração de saldo ou ativação global de enforcement faz parte deste trabalho.
