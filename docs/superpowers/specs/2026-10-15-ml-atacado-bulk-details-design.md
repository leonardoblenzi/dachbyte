# Atacado: leitura de detalhes em `/items/bulk`

## Contexto

Na carga de ativos da Drossi, o job percorreu 1.794 IDs e carregou zero anúncios. Uma consulta de diagnóstico à API retornou linhas com `body.id` e os campos solicitados, mas sem `code` ou `status_code`. O filtro atual em `apps/seller-ml/services/atacadoService.js` exige `row.code === 200` e descarta todas essas linhas.

A documentação de Busca de itens do Mercado Livre orienta a migração para `/items/bulk`, o uso de `status_code` no lugar de `code` e o prefixo `body.` na seleção de campos. A mudança separada de Preços por Quantidade B2B já é atendida pelo fluxo de aplicação do Atacado e não integra esta correção.

## Escopo

Alterar somente o serviço e os testes do Atacado. Não alterar `services/meliBulk.js`, outros módulos, APIs de escrita de preços, créditos, migrations ou interfaces sem necessidade demonstrada.

## Comportamento

`fetchItemsDetails` deve aceitar uma linha quando o corpo contiver um ID solicitado e os dados de anúncio, mesmo se a projeção de atributos omitir o código de status. Se houver `code` ou `status_code` explícito, aceitar somente sucesso HTTP 200. Rejeitar corpos vazios, IDs não solicitados e entradas com erro explícito. Preservar o tratamento de erro HTTP da requisição inteira.

O job não deve relatar como carga concluída com zero itens quando uma varredura encontrou IDs, mas todos os detalhes foram rejeitados. Deve registrar falha de carga com contagem de detalhes ausentes; resultados parciais já recuperados permanecem consultáveis.

## Verificação

Criar primeiro testes comportamentais para: resposta `body` sem código; resposta com `status_code: 200`; erro explícito por item; ID não solicitado; e varredura com IDs mas zero detalhes aceitos. Confirmar que o teste da resposta sem código falha antes da implementação. Depois executar os testes focados do Atacado e verificações de sintaxe. Nenhuma chamada de escrita real ao Mercado Livre faz parte do teste.

## Fora do escopo

A migração de preços por quantidade absoluto para percentual, ajustes do normalizador compartilhado, mudanças em outros leitores de `/items/bulk`, deploy e reprocessamento automático do job anterior.
