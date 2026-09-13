# Sprint 2 — Pedidos e conciliação

## Implementado no código

- Carga histórica inicial limitada a 90 dias quando nenhum período é informado.
- Carga incremental baseada no último checkpoint, com sobreposição de um dia para tolerar alterações tardias.
- Execuções persistidas em `sync_runs`, com status, páginas, registros, erro e duração.
- Uma única execução ativa por tenant/conexão/recurso.
- Upsert idempotente por `(tenant_id, source_channel, source_order_id)`.
- Normalização separada do payload redigido da Tray.
- Matching automático somente com marketplace e ID explícitos no pedido Tray.
- Referências fracas vão para revisão humana; matches ambíguos não são aceitos automaticamente.
- Confidence e razão do match persistidos.
- Fila/tela de pedidos não conciliados.
- Vínculo e desvínculo manual com audit log.
- Estado da última sincronização exposto na tela de Pedidos.

## Pendente de validação externa

- Aplicar `002_orders_sync.sql` usando `DB_VOLTPRICE_DIRECT` no Neon de staging.
- Validar paginação, campos `modified` e todos os status com a conta Tray real.
- Confirmar política histórica desejada por tenant além da janela inicial de 90 dias.
- Testar concorrência e reprocessamento contra dados reais.
- Evoluir matching por SKU + valor + data somente após existir base oficial de pedidos ML/Shopee; casos ambíguos continuarão em revisão.
