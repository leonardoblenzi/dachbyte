# Filtro de margem Magalu com dados frescos

## Objetivo

Ao clicar em **Filtrar** na Margem de venda, obter uma fotografia atual da conta na Open API Magalu antes de mostrar Resumo e Margem por período. O loading usa o overlay já existente do Seller Magalu, com comportamento equivalente ao filtro de margem do Mercado Livre. Nenhum resultado antigo deve ser apresentado como se fosse a consulta recém-concluída.

## Abordagens consideradas

1. Atualizar somente os relatórios financeiros e ler pedidos da réplica local. É rápido, mas reproduz o defeito atual: há relatórios novos sem os pedidos correspondentes.
2. **Sincronizar pedidos e relatórios financeiros do período como uma operação de consulta, aguardar a consolidação e só então renderizar.** É a abordagem aprovada. Trabalha em lotes, informa progresso e mantém os resultados anteriores explicitamente identificados como desatualizados em caso de falha.
3. Fazer uma sincronização completa de 90 dias a cada filtro. É simples de reutilizar, porém desperdiça chamadas, aumenta a espera e não respeita o recorte escolhido.

## Fluxo

O clique em **Filtrar** captura conta, datas e filtros. O servidor valida a conta ativa, os escopos de pedidos, entregas e análise financeira e o limite de 90 dias. Inicia uma operação idempotente por conta e período: busca as páginas de pedidos do recorte, as entregas necessárias para identificar os itens e os relatórios financeiros em janelas de até 15 dias; persiste cada fonte na conta correta; consolida a leitura de margem usando a réplica atualizada. A consulta não escreve na Magalu.

O frontend mostra o loading desde o início, consulta o estado da operação até ela terminar, carrega margem e equilíbrio apenas após sucesso e então libera Resumo e Margem por período. O usuário vê etapas legíveis (pedidos, relatórios, consolidação), sem porcentagem fictícia de API. Uma nova tentativa para o mesmo período não deve criar trabalho duplicado simultâneo. Se conta ou filtros mudarem durante a espera, a resposta antiga não substitui a tela nova.

## Identificação e cálculo

Usar `order_items` quando disponíveis. Quando não vierem no detalhe do pedido, associar os `delivery_items` pelo pedido e pela conta para identificar SKU, nome e quantidade; não somar duas vezes um item visto em mais de uma entrega. Custo só entra no CMV quando o SKU e a quantidade estiverem confirmados e o custo unitário estiver cadastrado. Não presumir custo zero, relatório financeiro zero ou cobertura completa de itens a partir de uma entrega parcial. Pedidos incompletos ficam visíveis no GMV e na contagem, mas resultado e margem permanecem indisponíveis.

## Falhas e limites

Uma falha de pedidos, entregas ou relatórios interrompe a confirmação de dados frescos para o período. A interface encerra o loading, mostra a etapa e a mensagem do erro, oferece **Tentar novamente** e mantém os resultados anteriores sinalizados como desatualizados, sem transformá-los em zeros. Se a Open API retornar apenas parte do recorte, exibir estado parcial e não promover a consulta a concluída. A API pode ter atraso próprio: “fresco” significa consultado novamente naquele momento, não garantia de disponibilidade instantânea de todas as vendas.

## Verificação

Testar período com pedidos ainda ausentes da réplica e relatórios presentes; pedidos sem relatório; pedidos sem custo; itens apenas em entregas; entrega parcial ou duplicada; cancelados; página adicional; erro e retentativa; troca de conta/filtros durante o loading; dois cliques concorrentes; e consulta de 90 dias. Confirmar que a tela só libera os resultados após a consolidação, que não exibe dados antigos como atuais e que o cálculo nunca trata ausência como zero.
