# Shopee SQL Runtime Migration Plan

Objetivo: remover o antigo ORM do runtime do modulo `shopee` sem alterar schema, sem recriar tabelas e sem perder dados do banco atual.

## Garantias desta abordagem

- o banco atual continua o mesmo
- as tabelas atuais continuam as mesmas
- a troca acontece apenas na camada de acesso a dados da aplicacao
- migrations e deploys ja estao em SQL direto no Neon
- cada etapa troca um bloco pequeno de runtime e valida antes da proxima

## Etapas

1. Infraestrutura SQL direta
- criar pool `pg` compartilhado
- adicionar repositories SQL para leituras e escritas simples
- migrar health, session/auth helpers, resolveShop e suporte

2. Autenticacao local e administracao
- migrar `authLocal.routes.js`
- migrar `admin.routes.js`
- migrar helpers de sessao e usuarios relacionados

3. Cadastros basicos
- migrar `TokenRepository.js`
- migrar `AuthController.js`
- migrar blocos simples de `ProductsController.js`, `OrdersController.js` e `CostsController.js`

4. Syncs e jobs
- migrar `ProductSyncService.js`
- migrar `OrderSyncService.js`
- migrar `AdsHourlySnapshotService.js`
- migrar `AdsAttributionService.js`

5. Analytics e consultas avancadas
- migrar `DashboardController.js`
- migrar `MetricsController.js`
- migrar `MarginController.js`
- migrar `GeoSalesController.js`
- migrar utilitarios com `groupBy`, `aggregate`, `upsert` e SQL raw

6. Remocao final
- manter `src/config/db.js` apenas como adapter SQL de compatibilidade onde ainda fizer sentido
- remover dependencias e arquivos legados do ORM antigo
- revisar scripts, docs e variaveis antigas

## Observacao operacional

A etapa concluida nao mexe em migrations legadas nem em dados ja existentes. O historico anterior permanece apenas como referencia para baseline do novo controle SQL em `_davantti_sql_migrations`.
