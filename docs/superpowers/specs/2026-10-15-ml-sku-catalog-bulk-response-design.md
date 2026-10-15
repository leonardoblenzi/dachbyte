# Correção da sincronização de Custos por SKU do Mercado Livre

O endpoint `/items/bulk` pode retornar entradas com `body.id` e sem `code`.
O sincronizador atual descarta essas entradas e conclui com zero SKUs.

Aceitar entradas com `body.id` quando não houver código explícito de erro.
Continuar rejeitando entradas com código diferente de 200. Conferir que cada
ID descoberto teve um detalhe válido; respostas parciais ou vazias falham o job
antes de reconstruir o catálogo. Anúncios sem SKU não entram na base de custos,
mas incrementam `no_sku_items`. A aba exibirá a contagem de SKUs e de anúncios
sem SKU a partir da última sincronização.

Testes cobrirão os formatos com `code: 200`, `status_code: 200`, apenas `body`,
erros explícitos e resposta vazia. Nenhuma migration ou mudança de créditos.
