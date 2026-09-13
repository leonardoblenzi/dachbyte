"use strict";

const ExcelJS = require("exceljs");
const db = require("../db/db");
let lastCleanupAt = 0;

const AUDIT_EXPORT_TZ = "America/Sao_Paulo";

const DEFAULT_RETENTION_RULES = [
  {
    evento: "*",
    descricao: "Padrao para eventos sem regra especifica",
    retention_days: 90,
  },
  {
    evento: "login_success",
    descricao: "Login concluido com sucesso",
    retention_days: 90,
  },
  {
    evento: "login_failed",
    descricao: "Falha de login por credencial invalida",
    retention_days: 120,
  },
  {
    evento: "login_blocked",
    descricao: "Tentativa barrada por status ou politica",
    retention_days: 180,
  },
  {
    evento: "password_reset_requested",
    descricao: "Solicitacao de redefinicao de senha",
    retention_days: 180,
  },
  {
    evento: "password_reset_email",
    descricao: "Resultado do envio do email de reset",
    retention_days: 180,
  },
  {
    evento: "password_reset_completed",
    descricao: "Conclusao ou falha do reset de senha",
    retention_days: 365,
  },
  {
    evento: "invite_activated",
    descricao: "Conta ativada por convite",
    retention_days: 365,
  },
  {
    evento: "admin_audit_cleanup",
    descricao: "Execucao manual da limpeza de auditoria",
    retention_days: 365,
  },
  {
    evento: "admin_audit_retention_updated",
    descricao: "Edicao das regras de retencao",
    retention_days: 365,
  },
  {
    evento: "admin_job_settings_updated",
    descricao: "Atualizacao de configuracoes de automacoes",
    retention_days: 365,
  },
  {
    evento: "admin_patch_note_deleted",
    descricao: "Remocao de comunicado de patch notes",
    retention_days: 365,
  },
  {
    evento: "admin_patch_note_saved",
    descricao: "Criacao ou edicao de comunicado de patch notes",
    retention_days: 365,
  },
  {
    evento: "admin_patch_note_sent",
    descricao: "Envio de comunicado de patch notes aos usuarios",
    retention_days: 365,
  },
  {
    evento: "account_selected",
    descricao: "Selecao manual da conta ativa",
    retention_days: 120,
  },
  {
    evento: "account_selection_cleared",
    descricao: "Limpeza manual da conta ativa",
    retention_days: 120,
  },
  {
    evento: "promotion_job_processing_started",
    descricao: "Inicio de aplicacao em lote de promocao",
    retention_days: 365,
  },
  {
    evento: "promotion_item_processed",
    descricao: "Auditoria por anuncio processado em promocao",
    retention_days: 365,
  },
  {
    evento: "promotion_job_completed",
    descricao: "Conclusao de job de promocao",
    retention_days: 365,
  },
  {
    evento: "promotion_job_failed",
    descricao: "Falha ou pausa de seguranca em job de promocao",
    retention_days: 365,
  },
  {
    evento: "promotion_job_canceled",
    descricao: "Cancelamento confirmado de job de promocao",
    retention_days: 365,
  },
  {
    evento: "promotion_job_cancel_requested",
    descricao: "Solicitacao de cancelamento de job de promocao",
    retention_days: 365,
  },
  {
    evento: "promotion_job_resumed",
    descricao: "Retomada de job de promocao",
    retention_days: 365,
  },
  {
    evento: "promotion_item_quarantined",
    descricao: "Item de promocao colocado em quarentena",
    retention_days: 365,
  },
  {
    evento: "promotion_quarantine_remediation_completed",
    descricao: "Conclusao de remediacao de promocao",
    retention_days: 365,
  },
  {
    evento: "promotion_remediation_attempted",
    descricao: "Tentativa de remediacao de promocao",
    retention_days: 365,
  },
  {
    evento: "promotion_transient_retry_scheduled",
    descricao: "Retry automatico de promocao por falha transitoria",
    retention_days: 365,
  },
  {
    evento: "promotion_smart_analysis_requested",
    descricao: "Solicitacao de analise inteligente de campanhas Smart",
    retention_days: 365,
  },
  {
    evento: "promotion_smart_analysis_started",
    descricao: "Inicio da analise inteligente de campanhas Smart",
    retention_days: 365,
  },
  {
    evento: "promotion_smart_analysis_completed",
    descricao: "Conclusao da analise inteligente de campanhas Smart",
    retention_days: 365,
  },
  {
    evento: "promotion_smart_analysis_failed",
    descricao: "Falha da analise inteligente de campanhas Smart",
    retention_days: 365,
  },
  {
    evento: "promotion_smart_optimization_requested",
    descricao: "Solicitacao de otimizacao Smart por rebate",
    retention_days: 365,
  },
  {
    evento: "promotion_smart_optimization_started",
    descricao: "Inicio de otimizacao Smart por rebate",
    retention_days: 365,
  },
  {
    evento: "promotion_smart_optimization_item_processed",
    descricao: "Auditoria por anuncio na otimizacao Smart",
    retention_days: 365,
  },
  {
    evento: "promotion_smart_optimization_completed",
    descricao: "Conclusao de otimizacao Smart por rebate",
    retention_days: 365,
  },
  {
    evento: "promotion_smart_optimization_failed",
    descricao: "Falha em otimizacao Smart por rebate",
    retention_days: 365,
  },
  {
    evento: "promotion_smart_optimization_safety_paused",
    descricao: "Pausa de seguranca em otimizacao Smart",
    retention_days: 365,
  },
  {
    evento: "promotion_smart_optimization_canceled",
    descricao: "Cancelamento de otimizacao Smart",
    retention_days: 365,
  },
  {
    evento: "admin_backup_exported",
    descricao: "Exportacao de backup pelo painel administrativo",
    retention_days: 365,
  },
  {
    evento: "admin_backup_imported",
    descricao: "Importacao de backup pelo painel administrativo",
    retention_days: 365,
  },
  {
    evento: "admin_company_created",
    descricao: "Criacao de empresa no painel administrativo",
    retention_days: 365,
  },
  {
    evento: "admin_company_deleted",
    descricao: "Remocao de empresa no painel administrativo",
    retention_days: 365,
  },
  {
    evento: "admin_company_link_created",
    descricao: "Criacao de vinculo entre usuario e empresa",
    retention_days: 365,
  },
  {
    evento: "admin_company_link_deleted",
    descricao: "Remocao de vinculo entre usuario e empresa",
    retention_days: 365,
  },
  {
    evento: "admin_company_link_updated",
    descricao: "Edicao de vinculo entre usuario e empresa",
    retention_days: 365,
  },
  {
    evento: "admin_company_updated",
    descricao: "Atualizacao de empresa no painel administrativo",
    retention_days: 365,
  },
  {
    evento: "admin_meli_account_created",
    descricao: "Cadastro manual de conta Mercado Livre",
    retention_days: 365,
  },
  {
    evento: "admin_meli_account_deleted",
    descricao: "Remocao manual de conta Mercado Livre",
    retention_days: 365,
  },
  {
    evento: "admin_meli_account_revoked",
    descricao: "Revogacao manual de autorizacao de conta Mercado Livre",
    retention_days: 365,
  },
  {
    evento: "admin_meli_account_updated",
    descricao: "Atualizacao manual de conta Mercado Livre",
    retention_days: 365,
  },
  {
    evento: "admin_meli_token_deleted",
    descricao: "Remocao manual de token Mercado Livre",
    retention_days: 365,
  },
  {
    evento: "admin_migrations_run",
    descricao: "Execucao manual de migracoes pelo painel",
    retention_days: 365,
  },
  {
    evento: "admin_oauth_state_deleted",
    descricao: "Remocao manual de registro OAuth state",
    retention_days: 365,
  },
  {
    evento: "admin_oauth_states_cleanup",
    descricao: "Limpeza manual de registros OAuth state",
    retention_days: 365,
  },
  {
    evento: "admin_user_created",
    descricao: "Criacao de usuario no painel administrativo",
    retention_days: 365,
  },
  {
    evento: "admin_user_deleted",
    descricao: "Remocao de usuario no painel administrativo",
    retention_days: 365,
  },
  {
    evento: "admin_user_invite_resent",
    descricao: "Reenvio de convite de ativacao para usuario",
    retention_days: 365,
  },
  {
    evento: "admin_user_module_access_updated",
    descricao: "Atualizacao de acesso do usuario aos modulos",
    retention_days: 365,
  },
  {
    evento: "admin_user_updated",
    descricao: "Atualizacao de usuario no painel administrativo",
    retention_days: 365,
  },
  {
    evento: "admin_company_sector_created",
    descricao: "Criacao de setor da empresa no painel administrativo",
    retention_days: 365,
  },
  {
    evento: "admin_company_sector_deleted",
    descricao: "Remocao de setor da empresa no painel administrativo",
    retention_days: 365,
  },
  {
    evento: "admin_company_sector_updated",
    descricao: "Atualizacao de setor da empresa no painel administrativo",
    retention_days: 365,
  },
  {
    evento: "characteristics_apply_started",
    descricao: "Inicio da aplicacao em massa de caracteristicas",
    retention_days: 180,
  },
  {
    evento: "characteristics_job_started",
    descricao: "Inicio efetivo do job de caracteristicas",
    retention_days: 365,
  },
  {
    evento: "characteristics_item_processed",
    descricao: "Item processado no job de caracteristicas",
    retention_days: 365,
  },
  {
    evento: "characteristics_job_completed",
    descricao: "Conclusao do job de caracteristicas",
    retention_days: 365,
  },
  {
    evento: "characteristics_job_failed",
    descricao: "Falha no job de caracteristicas",
    retention_days: 365,
  },
  {
    evento: "characteristics_preview_requested",
    descricao: "Geracao de preview de caracteristicas em massa",
    retention_days: 120,
  },
  {
    evento: "dimensions_validation_bulk_started",
    descricao: "Inicio de validacao em lote de dimensoes",
    retention_days: 180,
  },
  {
    evento: "dimensions_validation_job_started",
    descricao: "Inicio efetivo do job de dimensoes",
    retention_days: 365,
  },
  {
    evento: "dimensions_validation_item_processed",
    descricao: "Item processado no job de dimensoes",
    retention_days: 365,
  },
  {
    evento: "dimensions_validation_job_completed",
    descricao: "Conclusao do job de dimensoes",
    retention_days: 365,
  },
  {
    evento: "dimensions_validation_job_failed",
    descricao: "Falha no job de dimensoes",
    retention_days: 365,
  },
  {
    evento: "dimensions_validation_job_canceled",
    descricao: "Cancelamento de job de validacao de dimensoes",
    retention_days: 180,
  },
  {
    evento: "dimensions_validation_results_downloaded",
    descricao: "Download de resultados da validacao de dimensoes",
    retention_days: 120,
  },
  {
    evento: "dimensions_validation_single_requested",
    descricao: "Validacao individual de dimensoes",
    retention_days: 180,
  },
  {
    evento: "listing_deleted_bulk_canceled",
    descricao: "Cancelamento de job de exclusao em lote",
    retention_days: 180,
  },
  {
    evento: "listing_activated_bulk_started",
    descricao: "Inicio de ativacao em lote de anuncios",
    retention_days: 180,
  },
  {
    evento: "listing_closed_bulk_started",
    descricao: "Inicio de encerramento em lote de anuncios",
    retention_days: 180,
  },
  {
    evento: "listing_management_cancel_request_received",
    descricao: "Requisicao de cancelamento recebida na Gestao de Anuncios",
    retention_days: 365,
  },
  {
    evento: "listing_management_item_processed",
    descricao: "Resultado individual de item na Gestao de Anuncios",
    retention_days: 365,
  },
  {
    evento: "listing_management_job_cancel_rejected",
    descricao: "Cancelamento recusado na Gestao de Anuncios",
    retention_days: 365,
  },
  {
    evento: "listing_management_job_cancel_requested",
    descricao: "Solicitacao de cancelamento na Gestao de Anuncios",
    retention_days: 365,
  },
  {
    evento: "listing_management_job_canceled",
    descricao: "Job cancelado na Gestao de Anuncios",
    retention_days: 365,
  },
  {
    evento: "listing_management_job_completed",
    descricao: "Conclusao de job na Gestao de Anuncios",
    retention_days: 365,
  },
  {
    evento: "listing_management_job_failed",
    descricao: "Falha de job na Gestao de Anuncios",
    retention_days: 365,
  },
  {
    evento: "listing_management_job_processing_started",
    descricao: "Inicio efetivo de processamento na Gestao de Anuncios",
    retention_days: 365,
  },
  {
    evento: "listing_management_results_downloaded",
    descricao: "Download de resultados da Gestao de Anuncios",
    retention_days: 365,
  },
  {
    evento: "listing_deleted_bulk_started",
    descricao: "Inicio de exclusao em lote de anuncios",
    retention_days: 180,
  },
  {
    evento: "listing_deleted_single",
    descricao: "Exclusao individual de anuncio",
    retention_days: 180,
  },
  {
    evento: "listing_pause_relisted_bulk_started",
    descricao: "Inicio de pausa e relistagem em lote de anuncios",
    retention_days: 180,
  },
  {
    evento: "listing_paused_bulk_started",
    descricao: "Inicio de pausa em lote de anuncios",
    retention_days: 180,
  },
  {
    evento: "listing_relisted_bulk_started",
    descricao: "Inicio de relistagem em lote de anuncios",
    retention_days: 180,
  },
  {
    evento: "listing_filter_job_canceled",
    descricao: "Cancelamento de job do filtro avancado de anuncios",
    retention_days: 180,
  },
  {
    evento: "listing_filter_job_started",
    descricao: "Inicio de job do filtro avancado de anuncios",
    retention_days: 180,
  },
  {
    evento: "listing_filter_results_downloaded",
    descricao: "Download de resultados do filtro avancado de anuncios",
    retention_days: 120,
  },
  {
    evento: "meli_account_selected",
    descricao: "Selecao da conta Mercado Livre ativa",
    retention_days: 120,
  },
  {
    evento: "meli_account_selection_cleared",
    descricao: "Limpeza da selecao da conta Mercado Livre ativa",
    retention_days: 120,
  },
  {
    evento: "meli_default_account_selected",
    descricao: "Definicao da conta Mercado Livre padrao do usuario",
    retention_days: 365,
  },
  {
    evento: "meli_oauth_callback",
    descricao: "Retorno do fluxo OAuth do Mercado Livre",
    retention_days: 180,
  },
  {
    evento: "meli_oauth_started",
    descricao: "Inicio do fluxo OAuth do Mercado Livre",
    retention_days: 180,
  },
  {
    evento: "model_mass_apply_started",
    descricao: "Inicio da aplicacao em massa de modelo",
    retention_days: 180,
  },
  {
    evento: "model_mass_job_started",
    descricao: "Inicio efetivo do job de modelo em massa",
    retention_days: 365,
  },
  {
    evento: "model_mass_item_processed",
    descricao: "Item processado no job de modelo em massa",
    retention_days: 365,
  },
  {
    evento: "model_mass_job_completed",
    descricao: "Conclusao do job de modelo em massa",
    retention_days: 365,
  },
  {
    evento: "model_mass_job_failed",
    descricao: "Falha no job de modelo em massa",
    retention_days: 365,
  },
  {
    evento: "model_mass_job_canceled",
    descricao: "Cancelamento de job de modelo em massa",
    retention_days: 180,
  },
  {
    evento: "model_mass_preview_requested",
    descricao: "Geracao de preview de modelo em massa",
    retention_days: 120,
  },
  {
    evento: "production_time_active_lookup_started",
    descricao: "Consulta de anuncios ativos para prazo de producao",
    retention_days: 120,
  },
  {
    evento: "production_time_bulk_started",
    descricao: "Inicio da alteracao em lote de prazo de producao",
    retention_days: 180,
  },
  {
    evento: "production_time_job_started",
    descricao: "Inicio efetivo do job de prazo de producao",
    retention_days: 365,
  },
  {
    evento: "production_time_item_processed",
    descricao: "Item processado no job de prazo de producao",
    retention_days: 365,
  },
  {
    evento: "production_time_job_completed",
    descricao: "Conclusao do job de prazo de producao",
    retention_days: 365,
  },
  {
    evento: "production_time_job_failed",
    descricao: "Falha no job de prazo de producao",
    retention_days: 365,
  },
  {
    evento: "production_time_job_canceled",
    descricao: "Cancelamento de job de prazo de producao",
    retention_days: 180,
  },
  {
    evento: "production_time_lookup_requested",
    descricao: "Consulta de itens para prazo de producao",
    retention_days: 120,
  },
  {
    evento: "production_time_single_updated",
    descricao: "Alteracao individual de prazo de producao",
    retention_days: 180,
  },
  {
    evento: "promotion_apply_manual",
    descricao: "Aplicacao manual de promocao",
    retention_days: 180,
  },
  {
    evento: "promotion_apply_mass_started",
    descricao: "Inicio da aplicacao em massa de promocao",
    retention_days: 180,
  },
  {
    evento: "promotion_apply_single_item",
    descricao: "Aplicacao de promocao em item unico",
    retention_days: 180,
  },
  {
    evento: "promotion_bulk_apply_started",
    descricao: "Inicio de job de aplicacao em lote de promocao",
    retention_days: 180,
  },
  {
    evento: "promotion_bulk_prepare",
    descricao: "Preparacao de lote para promocao",
    retention_days: 120,
  },
  {
    evento: "promotion_bulk_remove_started",
    descricao: "Inicio de remocao em lote de promocao",
    retention_days: 180,
  },
  {
    evento: "promotion_created",
    descricao: "Criacao de promocao",
    retention_days: 180,
  },
  {
    evento: "promotion_deleted",
    descricao: "Remocao de promocao",
    retention_days: 180,
  },
  {
    evento: "promotion_legacy_bulk_started",
    descricao: "Inicio de lote pela rota legada de criacao de promocao",
    retention_days: 180,
  },
  {
    evento: "promotion_legacy_job_downloaded",
    descricao: "Download de resultado pela rota legada de criacao de promocao",
    retention_days: 120,
  },
  {
    evento: "promotion_legacy_single_started",
    descricao: "Inicio de promocao individual pela rota legada",
    retention_days: 180,
  },
  {
    evento: "promotion_item_processed",
    descricao: "Resultado individual de item em operacao de promocao",
    retention_days: 365,
  },
  {
    evento: "promotion_job_cancel_rejected",
    descricao: "Cancelamento recusado em job de promocao",
    retention_days: 365,
  },
  {
    evento: "promotion_job_cancel_requested",
    descricao: "Solicitacao de cancelamento em job de promocao",
    retention_days: 365,
  },
  {
    evento: "promotion_job_canceled",
    descricao: "Job de promocao cancelado",
    retention_days: 365,
  },
  {
    evento: "promotion_job_completed",
    descricao: "Conclusao de job de promocao",
    retention_days: 365,
  },
  {
    evento: "promotion_job_failed",
    descricao: "Falha de job de promocao",
    retention_days: 365,
  },
  {
    evento: "promotion_job_processing_started",
    descricao: "Inicio efetivo de processamento em job de promocao",
    retention_days: 365,
  },
  {
    evento: "promotion_job_results_downloaded",
    descricao: "Download de resultados de job de promocao",
    retention_days: 365,
  },
  {
    evento: "promotion_remove_bulk_started",
    descricao: "Inicio de remocao em lote de promocao pela tela legada",
    retention_days: 180,
  },
  {
    evento: "promotion_remove_single_requested",
    descricao: "Remocao individual de promocao pela tela legada",
    retention_days: 180,
  },
  {
    evento: "promotion_selection_prepare",
    descricao: "Preparacao da selecao de itens para promocao",
    retention_days: 120,
  },
  {
    evento: "promotion_updated",
    descricao: "Atualizacao de promocao",
    retention_days: 180,
  },
  {
    evento: "stock_alert_analysis_requested",
    descricao: "Solicitacao de analise de alerta de estoque",
    retention_days: 120,
  },
  {
    evento: "stock_alert_job_started",
    descricao: "Inicio de job de alerta de estoque",
    retention_days: 180,
  },
  {
    evento: "stock_purchase_cleared",
    descricao: "Remocao da marcacao de compra de estoque",
    retention_days: 180,
  },
  {
    evento: "stock_purchase_marked",
    descricao: "Marcacao de compra de estoque",
    retention_days: 180,
  },
  {
    evento: "stock_watch_item_removed",
    descricao: "Remocao de item da observacao de estoque",
    retention_days: 180,
  },
  {
    evento: "strategic_group_created",
    descricao: "Criacao de grupo estrategico",
    retention_days: 365,
  },
  {
    evento: "strategic_group_updated",
    descricao: "Atualizacao de grupo estrategico",
    retention_days: 365,
  },
  {
    evento: "strategic_items_lookup",
    descricao: "Consulta de itens para analise estrategica",
    retention_days: 120,
  },
  {
    evento: "strategic_permissions_updated",
    descricao: "Atualizacao de permissoes do modulo estrategico",
    retention_days: 365,
  },
  {
    evento: "strategic_round_created",
    descricao: "Criacao de rodada estrategica",
    retention_days: 365,
  },
  {
    evento: "strategic_round_returned_to_task",
    descricao: "Retorno de rodada estrategica para tarefas",
    retention_days: 365,
  },
  {
    evento: "strategic_round_reviewed",
    descricao: "Revisao de rodada estrategica",
    retention_days: 365,
  },
  {
    evento: "strategic_task_batch_canceled",
    descricao: "Cancelamento de lote de tarefas estrategicas",
    retention_days: 365,
  },
  {
    evento: "strategic_task_batch_items_added",
    descricao: "Inclusao de itens em lote de tarefas estrategicas",
    retention_days: 365,
  },
  {
    evento: "strategic_task_batch_sector_claimed",
    descricao: "Assuncao de setor em lote de tarefas estrategicas",
    retention_days: 365,
  },
  {
    evento: "strategic_task_batch_updated",
    descricao: "Atualizacao de lote de tarefas estrategicas",
    retention_days: 365,
  },
  {
    evento: "strategic_task_completed",
    descricao: "Conclusao de tarefa estrategica",
    retention_days: 365,
  },
  {
    evento: "strategic_task_execution_recorded",
    descricao: "Registro de execucao de tarefa estrategica",
    retention_days: 365,
  },
  {
    evento: "strategic_task_materials_returned",
    descricao: "Registro de devolucao de materiais em tarefa estrategica",
    retention_days: 365,
  },
  {
    evento: "strategic_task_updated",
    descricao: "Atualizacao de tarefa estrategica",
    retention_days: 365,
  },
  {
    evento: "strategic_tasks_created",
    descricao: "Criacao de tarefas estrategicas",
    retention_days: 365,
  },
  {
    evento: "strategic_trello_cards_previewed",
    descricao: "Preview de cards Trello para tarefas estrategicas",
    retention_days: 120,
  },
  {
    evento: "strategic_watchlist_action_registered",
    descricao: "Registro de acao em item da watchlist estrategica",
    retention_days: 365,
  },
  {
    evento: "strategic_watchlist_added",
    descricao: "Inclusao de item na watchlist estrategica",
    retention_days: 365,
  },
  {
    evento: "strategic_watchlist_removed",
    descricao: "Remocao de item da watchlist estrategica",
    retention_days: 365,
  },
  {
    evento: "strategic_watchlist_task_created",
    descricao: "Criacao de tarefa a partir da watchlist estrategica",
    retention_days: 365,
  },
  {
    evento: "token_access_requested",
    descricao: "Solicitacao de leitura do token de acesso",
    retention_days: 180,
  },
  {
    evento: "token_initial_requested",
    descricao: "Solicitacao inicial de token",
    retention_days: 180,
  },
  {
    evento: "token_renew_requested",
    descricao: "Solicitacao de renovacao de token",
    retention_days: 180,
  },
  {
    evento: "wholesale_price_apply_started",
    descricao: "Inicio da aplicacao em massa de preco de atacado",
    retention_days: 180,
  },
  {
    evento: "wholesale_price_job_started",
    descricao: "Inicio do job de preco de atacado",
    retention_days: 180,
  },
  {
    evento: "wholesale_price_item_processed",
    descricao: "Item processado no job de preco de atacado",
    retention_days: 180,
  },
  {
    evento: "wholesale_price_job_completed",
    descricao: "Conclusao do job de preco de atacado",
    retention_days: 180,
  },
  {
    evento: "wholesale_price_job_failed",
    descricao: "Falha no job de preco de atacado",
    retention_days: 180,
  },
  {
    evento: "wholesale_price_job_canceled",
    descricao: "Cancelamento de job de preco de atacado",
    retention_days: 180,
  },
];

function fallbackRetentionDays() {
  const days = Number(process.env.AUTH_AUDIT_RETENTION_DAYS || 90);
  return Number.isFinite(days) && days > 0 ? days : 90;
}

function cleanupIntervalMs() {
  const hours = Number(process.env.AUTH_AUDIT_CLEANUP_INTERVAL_HOURS || 6);
  const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 6;
  return safeHours * 60 * 60 * 1000;
}

function getRequestIp(req) {
  const forwarded = String(req.headers?.["x-forwarded-for"] || "").trim();
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

function getRequestUserAgent(req) {
  return String(req.headers?.["user-agent"] || "").trim() || null;
}

function sanitizeRetentionRule(rule) {
  const evento = String(rule?.evento || "")
    .trim()
    .toLowerCase();
  const retentionDays = Number(rule?.retention_days);

  if (!evento) {
    throw new Error("Cada regra precisa informar o evento.");
  }

  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new Error(`Retencao invalida para o evento ${evento}.`);
  }

  return {
    evento,
    descricao: String(rule?.descricao || "").trim() || null,
    retention_days: Math.round(retentionDays),
  };
}

async function ensureDefaultRetentionRules() {
  for (const rule of DEFAULT_RETENTION_RULES) {
    await db.query(
      `insert into auth_audit_retention_rules (evento, descricao, retention_days)
       values ($1, $2, $3)
       on conflict (evento) do nothing`,
      [rule.evento, rule.descricao, rule.retention_days],
    );
  }
}

async function listRetentionRules() {
  await ensureDefaultRetentionRules();

  const { rows } = await db.query(
    `select evento, descricao, retention_days, created_at, updated_at
       from auth_audit_retention_rules
      order by case when evento = '*' then 0 else 1 end, evento asc`,
  );

  return rows;
}

async function updateRetentionRules(rules) {
  if (!Array.isArray(rules) || !rules.length) {
    throw new Error("Nenhuma regra de retencao foi informada.");
  }

  const normalized = rules.map(sanitizeRetentionRule);

  await db.withClient(async (client) => {
    await client.query("begin");
    try {
      for (const rule of normalized) {
        await client.query(
          `insert into auth_audit_retention_rules (
             evento,
             descricao,
             retention_days,
             created_at,
             updated_at
           )
           values ($1, $2, $3, now(), now())
           on conflict (evento)
           do update set
             descricao = excluded.descricao,
             retention_days = excluded.retention_days,
             updated_at = now()`,
          [rule.evento, rule.descricao, rule.retention_days],
        );
      }

      await client.query("commit");
    } catch (err) {
      try {
        await client.query("rollback");
      } catch {}
      throw err;
    }
  });

  return listRetentionRules();
}

function normalizeAuditIdentifiers(value, pattern) {
  const values = Array.isArray(value) ? value : [value];
  const normalized = values
    .flatMap((item) => String(item || "").split(/[\s,;]+/))
    .map((item) => item.trim().toUpperCase())
    .filter((item) => item && pattern.test(item));

  return [...new Set(normalized)].slice(0, 100);
}

function hasAuditFilterValue(value) {
  return (Array.isArray(value) ? value : [value]).some(
    (item) => String(item || "").trim() !== "",
  );
}

function auditDateHasTime(value) {
  return /[tT]\d{2}:\d{2}/.test(String(value || ""));
}

async function listAuthEvents(filters = {}, options = {}) {
  const exportAll = options?.exportAll === true;
  const page = exportAll ? 1 : Math.max(1, Number(filters.page) || 1);
  const limit = exportAll
    ? Math.min(50000, Math.max(1, Number(filters.limit) || 50000))
    : Math.min(100, Math.max(10, Number(filters.limit) || 25));
  const offset = exportAll ? 0 : (page - 1) * limit;
  const where = [];
  const params = [];
  let i = 1;

  const search = String(filters.search || "").trim().toLowerCase();
  const mlbIds = normalizeAuditIdentifiers(filters.mlb_ids, /^MLB\d+$/i);
  const promotionIds = normalizeAuditIdentifiers(
    filters.promotion_ids,
    /^(?:[A-Z]+-)?MLB[A-Z0-9_-]+$/i,
  );
  if (hasAuditFilterValue(filters.mlb_ids) && !mlbIds.length) {
    const error = new Error("Informe um MLB valido, por exemplo MLB4575877101.");
    error.statusCode = 400;
    throw error;
  }
  if (hasAuditFilterValue(filters.promotion_ids) && !promotionIds.length) {
    const error = new Error("Informe um ID de promocao valido, por exemplo P-MLB17679134, C-MLB4587012 ou LGH-MLB1000.");
    error.statusCode = 400;
    throw error;
  }
  const operationId = String(filters.operation_id || "").trim();
  const evento = String(filters.evento || "")
    .trim()
    .toLowerCase();
  const status = String(filters.status || "")
    .trim()
    .toLowerCase();
  const dateFrom = String(filters.date_from || "").trim();
  const dateTo = String(filters.date_to || "").trim();

  if (search) {
    where.push(
      `(lower(coalesce(a.email, '')) like $${i}
        or lower(coalesce(u.nome, '')) like $${i}
        or lower(coalesce(a.ip, '')) like $${i}
        or lower(coalesce(a.evento, '')) like $${i}
        or lower(coalesce(a.metadata::text, '')) like $${i})`,
    );
    params.push(`%${search}%`);
    i += 1;
  }

  if (mlbIds.length) {
    where.push(
      `((a.metadata ? 'mlb_id' and upper(a.metadata ->> 'mlb_id') = any($${i}::text[]))
        or (a.metadata ? 'item_id' and upper(a.metadata ->> 'item_id') = any($${i}::text[]))
        or upper(coalesce(a.metadata ->> 'mlb', '')) = any($${i}::text[])
        or upper(coalesce(a.metadata #>> '{params,mlbId}', '')) = any($${i}::text[])
        or upper(coalesce(a.metadata #>> '{params,itemId}', '')) = any($${i}::text[]))`,
    );
    params.push(mlbIds);
    i += 1;
  }

  if (promotionIds.length) {
    where.push(
      `((a.metadata ? 'promotion_id'
          and upper(a.metadata ->> 'promotion_id') = any($${i}::text[]))
        or upper(coalesce(a.metadata #>> '{params,promotionId}', '')) = any($${i}::text[]))`,
    );
    params.push(promotionIds);
    i += 1;
  }

  if (operationId) {
    where.push(`coalesce(a.metadata ->> 'operation_id', '') = $${i}`);
    params.push(operationId);
    i += 1;
  }

  if (evento) {
    where.push(`a.evento = $${i}`);
    params.push(evento);
    i += 1;
  }

  if (status) {
    where.push(`a.status = $${i}`);
    params.push(status);
    i += 1;
  }

  if (dateFrom) {
    where.push(`a.created_at >= $${i}::timestamptz`);
    params.push(dateFrom);
    i += 1;
  }

  if (dateTo) {
    where.push(
      auditDateHasTime(dateTo)
        ? `a.created_at < ($${i}::timestamptz + interval '1 minute')`
        : `a.created_at < ($${i}::date + interval '1 day')`,
    );
    params.push(dateTo);
    i += 1;
  }

  const whereSql = where.length ? `where ${where.join(" and ")}` : "";

  const totalResult = await db.query(
    `select count(*)::int as total
       from auth_audit a
       left join usuarios u on u.id = a.user_id
       ${whereSql}`,
    params,
  );

  const dataParams = [...params, limit, offset];
  const limitParam = i;
  const offsetParam = i + 1;

  const { rows } = await db.query(
    `select
       a.id,
       a.user_id,
       a.email,
       a.evento,
       a.status,
       a.ip,
       a.user_agent,
       a.metadata,
       a.created_at,
       u.nome as user_nome
     from auth_audit a
     left join usuarios u on u.id = a.user_id
     ${whereSql}
     order by a.created_at desc, a.id desc
     limit $${limitParam}
     offset $${offsetParam}`,
    dataParams,
  );

  return {
    page,
    limit,
    total: Number(totalResult.rows?.[0]?.total || 0),
    events: rows,
  };
}

function firstAuditValue(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return "";
}

function auditPromotionName(metadata = {}) {
  return firstAuditValue(
    metadata.promotion_name,
    metadata.campaign_name,
    metadata.promotion_title,
    metadata?.promotion?.name,
    metadata?.campaign?.name,
  );
}

function auditPromotionId(metadata = {}) {
  return firstAuditValue(
    metadata.promotion_id,
    metadata?.promotion?.id,
    metadata?.campaign?.id,
    metadata?.params?.promotionId,
  );
}

function auditMlb(metadata = {}) {
  return firstAuditValue(
    metadata.mlb_id,
    metadata.item_id,
    metadata.mlb,
    metadata?.params?.mlbId,
    metadata?.params?.itemId,
  );
}

const AUTH_AUDIT_EXPORT_COLUMNS = [
  { header: "quando", key: "quando", width: 24 },
  { header: "email", key: "email", width: 34 },
  { header: "usuario", key: "usuario", width: 28 },
  { header: "evento", key: "evento", width: 34 },
  { header: "status", key: "status", width: 14 },
  { header: "ip", key: "ip", width: 18 },
  { header: "conta", key: "conta", width: 24 },
  { header: "mlb", key: "mlb", width: 18 },
  { header: "promocao_id", key: "promocao_id", width: 24 },
  { header: "promocao_nome", key: "promocao_nome", width: 34 },
  { header: "promocao_tipo", key: "promocao_tipo", width: 20 },
  { header: "acao", key: "acao", width: 18 },
  { header: "origem_aplicacao", key: "origem_aplicacao", width: 22 },
  { header: "qtd_selecao", key: "qtd_selecao", width: 14 },
  { header: "selecao_pre_validada", key: "selecao_pre_validada", width: 22 },
  { header: "percentual_solicitado", key: "percentual_solicitado", width: 22 },
  { header: "percentual_estimado", key: "percentual_estimado", width: 22 },
  { header: "percentual_real_aplicado", key: "percentual_real_aplicado", width: 24 },
  { header: "atacado_qtd_faixas", key: "atacado_qtd_faixas", width: 18 },
  { header: "atacado_menor_percentual", key: "atacado_menor_percentual", width: 24 },
  { header: "atacado_maior_percentual", key: "atacado_maior_percentual", width: 24 },
  { header: "atacado_preco_base", key: "atacado_preco_base", width: 20 },
  { header: "atacado_faixas_json", key: "atacado_faixas_json", width: 46 },
  { header: "campo", key: "campo", width: 20 },
  { header: "valor_anterior", key: "valor_anterior", width: 28 },
  { header: "valor_solicitado", key: "valor_solicitado", width: 28 },
  { header: "valor_aplicado", key: "valor_aplicado", width: 28 },
  { header: "status_item", key: "status_item", width: 18 },
  { header: "atributos_solicitados_json", key: "atributos_solicitados_json", width: 46 },
  { header: "atributos_aplicados_json", key: "atributos_aplicados_json", width: 46 },
  { header: "job_id", key: "job_id", width: 16 },
  { header: "rota", key: "rota", width: 42 },
  { header: "metodo", key: "metodo", width: 12 },
  { header: "resposta_ml", key: "resposta_ml", width: 14 },
  { header: "mensagem", key: "mensagem", width: 50 },
  { header: "metadata_json", key: "metadata_json", width: 70 },
];

function serializeAuditCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function csvCell(value) {
  const text = String(serializeAuditCell(value));
  return `"${text.replaceAll('"', '""')}"`;
}

function formatAuditExportDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: AUDIT_EXPORT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function authAuditExportRecord(event) {
  const metadata =
    event?.metadata && typeof event.metadata === "object" ? event.metadata : {};
  return {
    quando: formatAuditExportDateTime(event.created_at),
    email: event.email,
    usuario: event.user_nome,
    evento: event.evento,
    status: event.status,
    ip: event.ip,
    conta: firstAuditValue(metadata.accountLabel, metadata.accountKey),
    mlb: auditMlb(metadata),
    promocao_id: auditPromotionId(metadata),
    promocao_nome: auditPromotionName(metadata),
    promocao_tipo: firstAuditValue(metadata.promotion_type, metadata?.promotion?.type),
    acao: metadata.action,
    origem_aplicacao: metadata.application_source,
    qtd_selecao: metadata.selection_count,
    selecao_pre_validada: metadata.prevalidated_selection,
    percentual_solicitado: firstAuditValue(
      metadata.requested_percent,
      metadata.defined_percent,
      metadata.filter_percent,
      metadata.percent_max,
      metadata.seller_manual_percent,
      metadata.deal_manual_percent,
    ),
    percentual_estimado: firstAuditValue(
      metadata.estimated_applied_percent,
      metadata.estimated_percent,
      metadata.pre_validation_percent,
    ),
    percentual_real_aplicado: firstAuditValue(
      metadata.real_applied_percent,
      metadata.applied_percent,
    ),
    atacado_qtd_faixas: metadata.wholesale_tier_count,
    atacado_menor_percentual: metadata.wholesale_min_discount_percent,
    atacado_maior_percentual: metadata.wholesale_max_discount_percent,
    atacado_preco_base: metadata.wholesale_base_price,
    atacado_faixas_json: metadata.wholesale_tiers,
    campo: metadata.field,
    valor_anterior: firstAuditValue(metadata.previous_value, metadata.previous_days),
    valor_solicitado: firstAuditValue(
      metadata.requested_value,
      metadata.requested_days,
      metadata.requested_attributes,
    ),
    valor_aplicado: firstAuditValue(
      metadata.applied_value,
      metadata.applied_days,
      metadata.applied_attributes,
    ),
    status_item: metadata.item_status,
    atributos_solicitados_json: metadata.requested_attributes,
    atributos_aplicados_json: metadata.applied_attributes,
    job_id: metadata.job_id,
    rota: metadata.route,
    metodo: metadata.method,
    resposta_ml: metadata.ml_status,
    mensagem: firstAuditValue(metadata.message, metadata.error, metadata.notes),
    metadata_json: metadata,
  };
}

async function listAuthEventsForExport(filters = {}) {
  return listAuthEvents(
    {
      ...filters,
      page: 1,
      limit: filters.limit || filters.export_limit || 50000,
    },
    { exportAll: true },
  );
}

async function exportAuthEventsCsv(filters = {}) {
  const { events, total } = await listAuthEventsForExport(filters);

  const headers = AUTH_AUDIT_EXPORT_COLUMNS.map((column) => column.header);
  const lines = [headers.map(csvCell).join(";")];
  for (const event of events) {
    const record = authAuditExportRecord(event);
    const row = AUTH_AUDIT_EXPORT_COLUMNS.map((column) => record[column.key]);
    lines.push(row.map(csvCell).join(";"));
  }

  return {
    total,
    exported: events.length,
    csv: lines.join("\n"),
  };
}

function styleAuditExportSheet(sheet) {
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: AUTH_AUDIT_EXPORT_COLUMNS.length },
  };
  sheet.getRow(1).height = 24;
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF183153" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });

  const percentColumns = [
    "percentual_solicitado",
    "percentual_estimado",
    "percentual_real_aplicado",
    "atacado_menor_percentual",
    "atacado_maior_percentual",
  ];
  for (const key of percentColumns) {
    sheet.getColumn(key).numFmt = '0.00"%"';
  }

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.alignment = { vertical: "top", wrapText: true };
    const status = String(row.getCell("status").value || "").toLowerCase();
    const fill = status === "success"
      ? "FFE7F6EC"
      : status === "error"
        ? "FFFDE8E8"
        : status === "warn"
          ? "FFFFF3CD"
          : "FFFFFFFF";
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
      cell.alignment = { vertical: "top", wrapText: true };
    });
  });
}

async function exportAuthEventsXlsx(filters = {}) {
  const { events, total } = await listAuthEventsForExport(filters);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "DACHBYTE Seller";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Auditoria", {
    properties: { defaultRowHeight: 18 },
  });
  sheet.columns = AUTH_AUDIT_EXPORT_COLUMNS;

  for (const event of events) {
    const record = authAuditExportRecord(event);
    const row = {};
    for (const column of AUTH_AUDIT_EXPORT_COLUMNS) {
      row[column.key] = serializeAuditCell(record[column.key]);
    }
    sheet.addRow(row);
  }

  styleAuditExportSheet(sheet);

  return {
    total,
    exported: events.length,
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
  };
}

async function cleanupAuthAudit(options = {}) {
  const force = options?.force === true;
  const now = Date.now();
  if (!force && now - lastCleanupAt < cleanupIntervalMs()) {
    return {
      deletedTotal: 0,
      deletedByEvent: [],
      skipped: true,
    };
  }

  await ensureDefaultRetentionRules();

  const rules = await listRetentionRules();
  const defaultRule =
    rules.find((rule) => rule.evento === "*")?.retention_days ||
    fallbackRetentionDays();
  const specificRules = rules.filter((rule) => rule.evento !== "*");

  let deletedTotal = 0;
  const deletedByEvent = [];

  for (const rule of specificRules) {
    const result = await db.query(
      `with deleted as (
         delete from auth_audit
          where evento = $1
            and created_at < now() - make_interval(days => $2::int)
          returning 1
       )
       select count(*)::int as count from deleted`,
      [rule.evento, rule.retention_days],
    );

    const deleted = Number(result.rows?.[0]?.count || 0);
    deletedTotal += deleted;
    deletedByEvent.push({
      evento: rule.evento,
      retention_days: Number(rule.retention_days),
      deleted,
    });
  }

  const excludedEvents = specificRules.map((rule) => rule.evento);
  const defaultSql = excludedEvents.length
    ? `and evento <> all($1::text[])`
    : "";
  const defaultParams = excludedEvents.length
    ? [excludedEvents, defaultRule]
    : [defaultRule];

  const defaultResult = await db.query(
    `with deleted as (
       delete from auth_audit
        where created_at < now() - make_interval(days => $${
          excludedEvents.length ? 2 : 1
        }::int)
        ${defaultSql}
        returning 1
     )
     select count(*)::int as count from deleted`,
    defaultParams,
  );

  const defaultDeleted = Number(defaultResult.rows?.[0]?.count || 0);
  deletedTotal += defaultDeleted;
  deletedByEvent.push({
    evento: "*",
    retention_days: Number(defaultRule),
    deleted: defaultDeleted,
  });

  lastCleanupAt = now;

  return {
    deletedTotal,
    deletedByEvent,
    skipped: false,
  };
}

async function recordAuthEvent({
  userId = null,
  email = null,
  evento,
  status = "info",
  ip = null,
  userAgent = null,
  metadata = null,
}) {
  await db.query(
    `insert into auth_audit (user_id, email, evento, status, ip, user_agent, metadata)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      userId,
      email,
      String(evento || "").trim().toLowerCase(),
      String(status || "info").trim().toLowerCase(),
      ip,
      userAgent,
      metadata ? JSON.stringify(metadata) : null,
    ],
  );
}

module.exports = {
  DEFAULT_RETENTION_RULES,
  cleanupAuthAudit,
  ensureDefaultRetentionRules,
  exportAuthEventsCsv,
  exportAuthEventsXlsx,
  getRequestIp,
  getRequestUserAgent,
  listAuthEvents,
  listRetentionRules,
  normalizeAuditIdentifiers,
  recordAuthEvent,
  updateRetentionRules,
};
