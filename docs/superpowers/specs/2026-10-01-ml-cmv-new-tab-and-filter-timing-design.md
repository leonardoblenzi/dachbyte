# Atalho de custo no CMV em nova guia e diagnóstico do filtro de Margem ML

## Escopo aprovado

O atalho abaixo do CMV em **Margem por período** deve funcionar como link nativo do navegador. O usuário quer abrir o custo de um SKU em outra guia pelo menu de contexto, Ctrl+clique ou botão do meio. A aba interna `Custos por SKU` no topo continua como está. Ao abrir Margem, os últimos 7 dias ficam preenchidos, mas a consulta espera o primeiro clique em **Filtrar**. O trabalho de desempenho do servidor nesta entrega é diagnóstico; qualquer alteração no cálculo ou na concorrência da API depende de medição por fase.

## Navegação

- Para um pedido com exatamente um SKU sem custo, o texto compacto abaixo do CMV vira um `<a>` com `href` para a própria página de Margem e fragmento `#costs/sku/<SKU codificado>`.
- Clique primário sem modificadores preserva o fluxo atual: não recarrega a página, ativa `Custos por SKU` e filtra aquele SKU. Cliques modificados, botão do meio e menu de contexto usam o comportamento nativo do navegador.
- Para vários SKUs sem custo, o clique primário no atalho continua abrindo o seletor. Cada SKU no seletor passa a ser um link independente com o mesmo destino profundo e com clique primário integrado na página atual. Não há escolha automática de SKU. O atalho principal de múltiplos SKUs não promete abrir um SKU específico em nova guia.
- Um carregamento direto da URL com `#costs/sku/<SKU>` ativa a aba de custos, carrega a busca daquele SKU e não dispara antes a consulta pesada de Margem. Fragmentos ausentes ou inválidos mantêm a abertura padrão em Resumo.
- O SKU vai somente no fragmento, não na query ou no caminho enviados ao servidor. O valor é codificado na geração e decodificado com tratamento de erro na leitura. Elementos sem SKU continuam sem ação de cadastro.
- Ao navegar pelas abas superiores depois de um link profundo, a página limpa o fragmento de SKU para que um refresh não reabra uma busca que o usuário abandonou.

## Primeira consulta de Margem

- Manter a sugestão atual de `date_from` e `date_to` para os últimos 7 dias, sem disparar `loadMargin()` no `DOMContentLoaded`.
- Resumo, Margem por período e Equilíbrio mostram estado inicial de espera pela ação **Filtrar**, sem números de resultado ou mensagem permanente de carregamento.
- A primeira submissão do formulário faz uma única consulta com as datas e filtros que o usuário definiu. Atualizar continua forçando uma nova consulta quando já houver resultado; se ainda não houver, comporta-se como a primeira consulta.
- A aba Custos por SKU continua carregando sob demanda, inclusive por link profundo. Abri-la não inicia a consulta de Margem.
- Esta mudança elimina a consulta inicial desnecessária; não promete reduzir o tempo de uma consulta explícita de 31 dias.

## Diagnóstico do filtro

O HAR fornecido em 01/10/2026 contém três respostas `GET /ml/api/financeiro-ml/margin`:

| Recorte | Pedidos analisados | Tempo total | Espera por resposta | Corpo |
| --- | ---: | ---: | ---: | ---: |
| 7 dias, filtros gerais | 184 | 2,845 s | 2,838 s | 1,28 MB |
| 7 dias, custo ausente | 184 | 1,746 s | 1,742 s | 660 KB |
| 31 dias, custo ausente | 854 | 5,739 s | 5,735 s | 665 KB |

O tempo é predominantemente anterior ao primeiro byte; o download registrado é de poucos milissegundos. O código executa uma leitura de pedidos pagos, depois uma leitura de todos os pedidos e cálculos por pedido/anúncio. O HAR não separa o tempo dessas fases; portanto, não autoriza afirmar qual delas domina. A próxima otimização deve começar por tempos agregados por fase, sem IDs de pedido, SKUs, tokens ou payloads em logs, e só então escolher a mudança de menor risco. Não alterar limites, cache nem concorrência nesta entrega.

## Verificação

- Teste automatizado: atalho de um SKU e opções do seletor têm `href` profundo; clique primário é interceptado, enquanto clique modificado permanece nativo; entrada direta pelo fragmento abre custos sem consultar Margem.
- Teste automatizado: abertura normal deixa os últimos 7 dias preenchidos e não chama a API; o primeiro **Filtrar** chama a API uma vez e substitui os estados de espera por resultados.
- Regressão: filtros, gravação de custo e histórico continuam iguais; múltiplos SKUs exigem seleção explícita.
- Teste manual no navegador: clique normal, Ctrl+clique, botão do meio e menu de contexto, inclusive para um SKU escolhido no modal.
