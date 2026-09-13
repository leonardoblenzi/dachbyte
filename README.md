
# DACHBYTE

A arquitetura atual está em [README-VPS.md](README-VPS.md).
Para preparar a VPS Hostinger, consulte o
[runbook de staging](docs/operations/dachbyte-vps-staging-runbook.md).
O inventário abaixo é histórico e usa caminhos anteriores à reorganização em apps/.

```
davanttiSuite
├─ ml
│  ├─ app.js
│  ├─ CHANGES.diff
│  ├─ config
│  │  ├─ accounts.js
│  │  └─ config.js
│  ├─ controllers
│  │  ├─ AnaliseAnuncioController.js
│  │  ├─ CriarPromocaoController.js
│  │  ├─ DashboardController.js
│  │  ├─ EditarAnuncioController.js
│  │  ├─ EstrategicosController.js
│  │  ├─ ExcluirAnuncioController.js
│  │  ├─ FullController.js
│  │  ├─ HtmlController.js
│  │  ├─ ItemsController.js
│  │  ├─ JardinagemController.js
│  │  ├─ keywordAnalyticsController.js
│  │  ├─ pesquisaDescricaoController.js
│  │  ├─ PrazoProducaoController.js
│  │  ├─ PromocoesController.js
│  │  ├─ PublicidadeController.js
│  │  ├─ RemoverPromocaoController.js
│  │  ├─ TokenController.js
│  │  └─ ValidarDimensoesController.js
│  ├─ data
│  │  ├─ estrategicos
│  │  │  └─ estrategicos_drossi.json
│  │  ├─ estrategicos_drossi.json
│  │  ├─ full_stock.json
│  │  └─ logs
│  │     └─ full_operations.log
│  ├─ db
│  │  ├─ 001_create_usuarios.sql
│  │  ├─ 002_create_empresas.sql
│  │  ├─ 003_create_empresa_usuarios.sql
│  │  ├─ 004_create_meli_contas.sql
│  │  ├─ 005_create_meli_tokens.sql
│  │  ├─ 006_create_oauth_states.sql
│  │  ├─ 007_unique_meli_user_global.sql
│  │  ├─ 008_add_admin_master_to_usuarios_nivel.sql
│  │  ├─ 009_create_schema_migrations.sql
│  │  ├─ 010_consolidar_migracoes.sql
│  │  ├─ 011_create_anuncios_estrategicos.sql
│  │  ├─ 012_add_columns_anuncios_estrategicos.sql
│  │  ├─ 013_create_anuncios_full.sql
│  │  ├─ 014_add_metrics_full_40d.sql
│  │  ├─ db.js
│  │  ├─ doc.txt
│  │  └─ migrate.js
│  ├─ index.js
│  ├─ lib
│  │  └─ redisClient.js
│  ├─ mapa_funcoes.txt
│  ├─ middleware
│  │  ├─ authMiddleware.js
│  │  ├─ ensureAccount.js
│  │  ├─ ensureAuth.js
│  │  ├─ ensurePermission.js
│  │  └─ jwtAuth.js
│  ├─ package-lock.json
│  ├─ package.json
│  ├─ public
│  │  ├─ css
│  │  │  ├─ admin-migracoes.css
│  │  │  ├─ admin-usuarios.css
│  │  │  ├─ analise-ia.css
│  │  │  ├─ criar-promocao.css
│  │  │  ├─ curva-abc.css
│  │  │  ├─ dashboard.css
│  │  │  ├─ editar-anuncio.css
│  │  │  ├─ estrategicos.css
│  │  │  ├─ excluir-anuncio.css
│  │  │  ├─ filtro-anuncios.css
│  │  │  ├─ full.css
│  │  │  ├─ jardinagem.css
│  │  │  ├─ keyword-analytics.css
│  │  │  ├─ login.css
│  │  │  ├─ pesquisa-descricao.css
│  │  │  ├─ prazo.css
│  │  │  ├─ promo-jobs.css
│  │  │  ├─ publicidade.css
│  │  │  ├─ remover-promocao.css
│  │  │  ├─ selecao-plataforma.css
│  │  │  └─ select-conta.css
│  │  ├─ img
│  │  │  └─ davantti.png
│  │  └─ js
│  │     ├─ account-bar.js
│  │     ├─ admin-backup.js
│  │     ├─ admin-empresas.js
│  │     ├─ admin-meli-contas.js
│  │     ├─ admin-meli-tokens.js
│  │     ├─ admin-migracoes.js
│  │     ├─ admin-oauth-states.js
│  │     ├─ admin-usuarios.js
│  │     ├─ admin-vinculos.js
│  │     ├─ analise-ia.js
│  │     ├─ criar-promocao.js
│  │     ├─ dashboard.js
│  │     ├─ editar-anuncio.js
│  │     ├─ estrategicos.js
│  │     ├─ excluir-anuncio.js
│  │     ├─ exclusao-bulk.js
│  │     ├─ filtro-anuncios.js
│  │     ├─ full.js
│  │     ├─ ia-analytics-curva-abc.js
│  │     ├─ jardinagem-bulk.js
│  │     ├─ jardinagem.js
│  │     ├─ jobs-panel.js
│  │     ├─ keyword-analytics.js
│  │     ├─ pesquisa-descricao.js
│  │     ├─ prazo-bulk.js
│  │     ├─ prazo.js
│  │     ├─ promo-bulk.js
│  │     ├─ publicidade.js
│  │     ├─ remocao-bulk.js
│  │     ├─ remover-promocao.js
│  │     ├─ select-conta.js
│  │     └─ validar-dimensoes.js
│  ├─ README.md
│  ├─ render.yaml
│  ├─ results
│  │  ├─ 10_filtro_metadata.json
│  │  ├─ 10_filtro_resultados.json
│  │  ├─ 11_filtro_metadata.json
│  │  ├─ 11_filtro_resultados.json
│  │  ├─ 1_filtro_metadata.json
│  │  ├─ 1_filtro_resultados.json
│  │  ├─ 2_filtro_metadata.json
│  │  ├─ 2_filtro_resultados.json
│  │  ├─ 3_filtro_metadata.json
│  │  ├─ 3_filtro_resultados.json
│  │  ├─ 4_filtro_metadata.json
│  │  ├─ 4_filtro_resultados.json
│  │  ├─ 5_filtro_metadata.json
│  │  ├─ 5_filtro_resultados.json
│  │  ├─ 6_filtro_metadata.json
│  │  ├─ 6_filtro_resultados.json
│  │  ├─ 7_filtro_metadata.json
│  │  ├─ 7_filtro_resultados.json
│  │  ├─ 8_filtro_metadata.json
│  │  ├─ 8_filtro_resultados.json
│  │  ├─ 9_filtro_metadata.json
│  │  ├─ 9_filtro_resultados.json
│  │  ├─ job_1756141867517_5l1xtles5_metadata.json
│  │  └─ job_1756141867517_5l1xtles5_resultados.jsonl
│  ├─ routes
│  │  ├─ accountRoutes.js
│  │  ├─ adminBackupRoutes.js
│  │  ├─ adminEmpresasRoutes.js
│  │  ├─ adminMeliContasRoutes.js
│  │  ├─ adminMeliTokensRoutes.js
│  │  ├─ adminMigracoesRoutes.js
│  │  ├─ adminOAuthStatesRoutes.js
│  │  ├─ adminUsuariosRoutes.js
│  │  ├─ adminVinculosRoutes.js
│  │  ├─ AnaliseAnuncioRoutes.js
│  │  ├─ analytics-abc-Routes.js
│  │  ├─ analytics-filtro-anuncios-routes.js
│  │  ├─ authRoutes.js
│  │  ├─ criarPromocaoRoutes.js
│  │  ├─ dashboardRoutes.js
│  │  ├─ editarAnuncioRoutes.js
│  │  ├─ estrategicosRoutes.js
│  │  ├─ excluirAnuncioRoutes.js
│  │  ├─ fullRoutes.js
│  │  ├─ htmlRoutes.js
│  │  ├─ itemsRoutes.js
│  │  ├─ jardinagemRoutes.js
│  │  ├─ keywordAnalyticsRoutes.js
│  │  ├─ meliOAuthRoutes.js
│  │  ├─ pesquisaDescricaoRoutes.js
│  │  ├─ prazoProducaoRoutes.js
│  │  ├─ promocoesRoutes.js
│  │  ├─ publicidadeRoutes.js
│  │  ├─ removerPromocaoRoutes.js
│  │  ├─ tokenRoutes.js
│  │  └─ validarDimensoesRoutes.js
│  ├─ services
│  │  ├─ adsService.js
│  │  ├─ analiseAnuncioService.js
│  │  ├─ criarPromocaoService.js
│  │  ├─ csvManager.js
│  │  ├─ dashboardService.js
│  │  ├─ editarAnuncioService.js
│  │  ├─ estrategicosStore.js
│  │  ├─ excluirAnuncioService.js
│  │  ├─ filtroAnunciosQueueService.js
│  │  ├─ fullRepository.js
│  │  ├─ fullService.js
│  │  ├─ geminiInsightsService.js
│  │  ├─ itemsService.js
│  │  ├─ jardinagemService.js
│  │  ├─ keywordAnalyticsService.js
│  │  ├─ ml-auth.js
│  │  ├─ pesquisaDescricaoService.js
│  │  ├─ prazoProducaoQueueService.js
│  │  ├─ prazoProducaoService.js
│  │  ├─ productAdsService.js
│  │  ├─ promoBulkRemoveAdapter.js
│  │  ├─ promoJobsService.js
│  │  ├─ promoSelectionStore.js
│  │  ├─ queueService.js
│  │  ├─ removerPromocaoService.js
│  │  ├─ sellerPromotionsService.js
│  │  ├─ simpleCache.js
│  │  ├─ tokenService.js
│  │  ├─ validarDimensoesJobService.js
│  │  └─ validarDimensoesService.js
│  ├─ test-controller.js
│  ├─ utils
│  │  └─ helper.js
│  └─ views
│     ├─ admin-backup.html
│     ├─ admin-empresas.html
│     ├─ admin-meli-contas.html
│     ├─ admin-meli-tokens.html
│     ├─ admin-migracoes.html
│     ├─ admin-oauth-states.html
│     ├─ admin-usuarios.html
│     ├─ admin-vinculos.html
│     ├─ analise-ia.html
│     ├─ cadastro.html
│     ├─ criar-promocao.html
│     ├─ dashboard.html
│     ├─ editar-anuncio.html
│     ├─ estrategicos.html
│     ├─ excluir-anuncio.html
│     ├─ filtro-anuncios.html
│     ├─ full.html
│     ├─ ia-analytics
│     │  └─ curva-abc.html
│     ├─ jardinagem.html
│     ├─ keyword-analytics.html
│     ├─ login.html
│     ├─ nao-autorizado.html
│     ├─ pesquisa-descricao.html
│     ├─ prazo.html
│     ├─ publicidade.html
│     ├─ remover-promocao.html
│     ├─ selecao-plataforma.html
│     ├─ select-conta.html
│     ├─ validar-dimensoes.html
│     └─ vincular-conta.html
├─ package-lock.json
├─ package.json
├─ server.js
└─ shopee
   ├─ .prettierignore
   ├─ package-lock.json
   ├─ package.json
   ├─ prisma
   │  ├─ migrations
   │  │  ├─ 20251223124254_auth_tokens
   │  │  │  └─ migration.sql
   │  │  ├─ 20251223184759_add_orders
   │  │  │  └─ migration.sql
   │  │  ├─ 20251223192700_add_products
   │  │  │  └─ migration.sql
   │  │  ├─ 20251224130942_add_product_image_image_id
   │  │  │  └─ migration.sql
   │  │  ├─ 20251224132717_add_product_rating_fields
   │  │  │  └─ migration.sql
   │  │  ├─ 20251224140452_add_product_rating
   │  │  │  └─ migration.sql
   │  │  ├─ 20251229110856_add_product_shopee_create_time
   │  │  │  └─ migration.sql
   │  │  ├─ 20251229114741_add_product_itemsku_create_time
   │  │  │  └─ migration.sql
   │  │  ├─ 20251229120714_add_product_attributes
   │  │  │  └─ migration.sql
   │  │  ├─ 20251229121612_add_product_extra_fields
   │  │  │  └─ migration.sql
   │  │  ├─ 20251229142831_add_accounts_users_sessions
   │  │  │  └─ migration.sql
   │  │  ├─ 20251230130146_add_user_name
   │  │  │  └─ migration.sql
   │  │  ├─ 20260106143820_ads_campaign_groups
   │  │  │  └─ migration.sql
   │  │  ├─ 20260113193406_add_order_address_change_alert
   │  │  │  └─ migration.sql
   │  │  ├─ 20260114160718_add_order_geo_address
   │  │  │  └─ migration.sql
   │  │  ├─ 20260114185919_fix_geo
   │  │  │  └─ migration.sql
   │  │  ├─ 20260114204912_add_gmv_cents
   │  │  │  └─ migration.sql
   │  │  └─ migration_lock.toml
   ├─ public
   │  ├─ app.js
   │  ├─ css
   │  │  ├─ ads.css
   │  │  ├─ dashboard.css
   │  │  └─ geo-sales.css
   │  ├─ index.html
   │  ├─ js
   │  │  └─ ads.js
   │  ├─ json
   │  │  └─ Geo.json
   │  ├─ login.css
   │  ├─ login.html
   │  ├─ login.js
   │  └─ styles.css
   ├─ README.md
   └─ src
      ├─ app.js
      ├─ config
      │  ├─ addressFingerprint.js
      │  ├─ db.js
      │  ├─ env.js
      │  ├─ queue.js
      │  ├─ redis.js
      │  ├─ shopee.js
      │  └─ shopeeAds.js
      ├─ controllers
      │  ├─ AdsCampaignGroupsController.js
      │  ├─ AdsController.js
      │  ├─ AuthController.js
      │  ├─ DashboardController.js
      │  ├─ DebugController.js
      │  ├─ DebugShopeeController.js
      │  ├─ GeoSalesController.js
      │  ├─ HealthController.js
      │  ├─ OrderAddressAlertsController.js
      │  ├─ OrdersController.js
      │  ├─ OrderSyncController.js
      │  ├─ ProductsController.js
      │  ├─ ProductSyncController.js
      │  └─ WebhookController.js
      ├─ jobs
      │  ├─ orderSync.job.js
      │  └─ productSync.job.js
      ├─ lib
      │  └─ api.js
      ├─ middlewares
      │  ├─ debugToken.js
      │  ├─ errorHandler.js
      │  ├─ requestLogger.js
      │  ├─ resolveShopParam.js
      │  ├─ sessionAuth.js
      │  └─ uploadImages.js
      ├─ public
      │  └─ json
      │     └─ Geo.json
      ├─ repositories
      │  ├─ AlertRepository.js
      │  ├─ OrderRepository.js
      │  ├─ ProductRepository.js
      │  └─ TokenRepository.js
      ├─ routes
      │  ├─ admin.routes.js
      │  ├─ ads.routes.js
      │  ├─ auth.routes.js
      │  ├─ authLocal.routes.js
      │  ├─ debug.routes.js
      │  ├─ health.routes.js
      │  ├─ index.js
      │  ├─ orders.routes.js
      │  ├─ products.routes.js
      │  ├─ session.routes.js
      │  └─ webhooks.routes.js
      ├─ scripts
      │  ├─ buildGeoJson.js
      │  └─ resolveFalseAddressAlerts.js
      ├─ server.js
      ├─ services
      │  ├─ AddressChangeAlertService.js
      │  ├─ AlertService.js
      │  ├─ OrderSyncService.js
      │  ├─ ProductSyncService.js
      │  ├─ ShopeeAdsService.js
      │  ├─ ShopeeAmsService.js
      │  ├─ ShopeeAuthedHttp.js
      │  ├─ ShopeeAuthService.js
      │  ├─ ShopeeHttp.js
      │  ├─ ShopeeMediaService.js
      │  ├─ ShopeeOrderService.js
      │  ├─ ShopeeProductService.js
      │  └─ ShopeeProductWriteService.js
      ├─ utils
      │  ├─ asyncHandler.js
      │  ├─ crypto.js
      │  ├─ hash.js
      │  ├─ resolveShop.js
      │  └─ time.js
      └─ webhooks
         ├─ shopeePushParser.js
         └─ shopeePushVerifier.js

```
