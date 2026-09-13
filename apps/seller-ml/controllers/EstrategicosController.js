"use strict";

const service = require("../services/estrategicosService");
const companyAccess = require("../services/companyAccessService");

function pickAccessToken(req) {
  const token = req?.ml?.accessToken;
  if (!token) {
    const error = new Error("Token ML ausente em req.ml.accessToken.");
    error.statusCode = 401;
    throw error;
  }
  return token;
}

function accountContext(res) {
  return {
    accountKey: res.locals?.accountKey || res.locals?.mlCreds?.meli_conta_id || null,
    accountLabel: res.locals?.accountLabel || null,
    mlCreds: res.locals?.mlCreds || {},
    empresaId: res.locals?.empresaId || null,
  };
}
function currentUserId(req) {
  const raw = req.user?.uid ?? req.user?.id ?? req.user?.user_id ?? null;
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}
function currentUserSnapshot(req) {
  const id = currentUserId(req);
  const email = String(req.user?.email || "").trim() || null;
  const name = String(req.user?.nome || req.user?.name || req.user?.full_name || req.user?.display_name || "").trim() || email || (id ? `Usuario ${id}` : "Usuario");
  return { id, name, email };
}
async function currentTaskActor(req, res) {
  const userId = currentUserId(req);
  const empresaId = Number(res.locals?.empresaId);
  const isAdmin = await companyAccess.isAdminUserFresh(req);
  const sectors = isAdmin ? [] : await companyAccess.listUserSectors(empresaId, userId);
  return { userId, isAdmin, sectors };
}

async function list(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.listDashboard({
      accountKey: ctx.accountKey,
      page: req.query?.page || 1,
      limit: req.query?.limit || 25,
      groupId: req.query?.group_id || req.query?.groupId || null,
      taskBatchId: req.query?.batch_id || req.query?.task_batch_id || req.query?.taskBatchId || null,
      taskTag: req.query?.tag || req.query?.task_tag || req.query?.taskTag || null,
      impact: req.query?.impact || null,
      analysisFrom: req.query?.analysis_from || req.query?.analysisFrom || null,
      analysisTo: req.query?.analysis_to || req.query?.analysisTo || null,
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Falha ao carregar estrategicos." });
  }
}

async function history(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.listRoundHistory({
      accountKey: ctx.accountKey,
      mlb: req.params?.mlb,
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao carregar historico do anuncio." });
  }
}

async function lookup(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.lookupItems({
      accessToken: pickAccessToken(req),
      mlCreds: ctx.mlCreds,
      accountKey: ctx.accountKey,
      accountLabel: ctx.accountLabel,
      query: req.body?.query || req.body?.items || "",
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao buscar MLBs." });
  }
}

async function create(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.createRounds({
      accessToken: pickAccessToken(req),
      mlCreds: ctx.mlCreds,
      accountKey: ctx.accountKey,
      accountLabel: ctx.accountLabel,
      empresaId: ctx.empresaId,
      query: req.body?.query || "",
      items: req.body?.items || [],
      changeFlags: req.body?.change_flags || req.body?.changeFlags || {},
      changeNotes: req.body?.change_notes || req.body?.changeNotes || "",
      groupId: req.body?.group_id || req.body?.groupId || null,
      alterationDate: req.body?.alteration_date || req.body?.alterationDate || null,
      windowDays: req.body?.window_days || req.body?.windowDays || 7,
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao registrar alteracao estrategica." });
  }
}

async function listTasks(req, res) {
  try {
    const prioritizeParam = String(req.query?.prioritize_my_pending ?? req.query?.prioritizeMyPending ?? "1").trim().toLowerCase();
    const prioritizeMyPending = !["0", "false", "off", "no"].includes(prioritizeParam);
    const ctx = accountContext(res);
    const actor = await currentTaskActor(req, res);
    const payload = await service.listTasks({
      accountKey: ctx.accountKey,
      page: req.query?.page || 1,
      limit: req.query?.limit || 25,
      status: req.query?.status || "open",
      priority: req.query?.priority || "",
      groupId: req.query?.group_id || req.query?.groupId || null,
      sector: req.query?.sector || req.query?.setor || "",
      tag: req.query?.tag || req.query?.task_tag || req.query?.taskTag || "",
      scope: req.query?.scope || "",
      actor,
      createdFrom: req.query?.created_from || req.query?.createdFrom || null,
      createdTo: req.query?.created_to || req.query?.createdTo || null,
      analysisFrom: req.query?.analysis_from || req.query?.analysisFrom || null,
      analysisTo: req.query?.analysis_to || req.query?.analysisTo || null,
      dueFrom: req.query?.due_from || req.query?.dueFrom || null,
      dueTo: req.query?.due_to || req.query?.dueTo || null,
      batchId: req.query?.batch_id || req.query?.batchId || "",
      batchName: req.query?.batch_name || req.query?.batchName || "",
      query: req.query?.q || req.query?.query || "",
      prioritizeMyPending,
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Falha ao carregar pendencias." });
  }
}

async function listTaskBatches(req, res) {
  try {
    const ctx = accountContext(res);
    const actor = await currentTaskActor(req, res);
    const payload = await service.listTaskBatches({
      accountKey: ctx.accountKey,
      status: req.query?.status || "open",
      priority: req.query?.priority || "",
      groupId: req.query?.group_id || req.query?.groupId || null,
      sector: req.query?.sector || req.query?.setor || "",
      tag: req.query?.tag || req.query?.task_tag || req.query?.taskTag || "",
      scope: req.query?.scope || "",
      actor,
      createdFrom: req.query?.created_from || req.query?.createdFrom || null,
      createdTo: req.query?.created_to || req.query?.createdTo || null,
      analysisFrom: req.query?.analysis_from || req.query?.analysisFrom || null,
      analysisTo: req.query?.analysis_to || req.query?.analysisTo || null,
      dueFrom: req.query?.due_from || req.query?.dueFrom || null,
      dueTo: req.query?.due_to || req.query?.dueTo || null,
      batchId: req.query?.batch_id || req.query?.batchId || "",
      batchName: req.query?.batch_name || req.query?.batchName || "",
      query: req.query?.q || req.query?.query || "",
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Falha ao carregar lotes de tarefas." });
  }
}

async function listTaskBatchItemTokens(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.listTaskBatchItemTokens({
      accountKey: ctx.accountKey,
      batchId: req.params?.id,
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao carregar itens do lote." });
  }
}

async function createTasks(req, res) {
  try {
    const ctx = accountContext(res);
    const actor = await currentTaskActor(req, res);
    await service.assertStrategicActionPermission({ empresaId: ctx.empresaId, actor, actionKey: "task.create", mode: "edit", message: "Seu setor nao possui permissao para criar tarefas." });
    const payload = await service.createTasks({
      accessToken: pickAccessToken(req),
      mlCreds: ctx.mlCreds,
      accountKey: ctx.accountKey,
      accountLabel: ctx.accountLabel,
      empresaId: ctx.empresaId,
      query: req.body?.query || "",
      items: req.body?.items || [],
      taskFlags: req.body?.task_flags || req.body?.taskFlags || {},
      taskNotes: req.body?.task_notes || req.body?.taskNotes || "",
      taskTags: req.body?.task_tags || req.body?.taskTags || [],
      taskTagColors: req.body?.task_tag_colors || req.body?.taskTagColors || {},
      requiredSectors: req.body?.required_sectors || req.body?.requiredSectors || [],
      taskBatchId: req.body?.task_batch_id || req.body?.taskBatchId || "",
      taskBatchName: req.body?.task_batch_name || req.body?.taskBatchName || "",
      groupId: req.body?.group_id || req.body?.groupId || null,
      dueDate: req.body?.due_date || req.body?.dueDate || null,
      analysisStartDate: req.body?.analysis_start_date || req.body?.analysisStartDate || null,
      priority: req.body?.priority || "medium",
      createdByUserId: currentUserId(req),
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao criar pendencias." });
  }
}

async function updateTask(req, res) {
  try {
    const ctx = accountContext(res);
    const nextStatus = req.body?.status;
    if (String(nextStatus || "").toLowerCase() === "canceled") {
      const actor = await currentTaskActor(req, res);
      if (!actor.isAdmin) {
        return res.status(403).json({ success: false, error: "Apenas administradores podem cancelar pendencias." });
      }
    }
    const payload = await service.updateTaskStatus({
      accountKey: ctx.accountKey,
      taskId: req.params?.id,
      status: nextStatus,
      cancelReason: req.body?.cancel_reason || req.body?.cancelReason || "",
      analysisStartDate: req.body?.analysis_start_date ?? req.body?.analysisStartDate,
      userId: currentUserId(req),
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao atualizar pendencia." });
  }
}

async function listTaskSectors(req, res) {
  try {
    const ctx = accountContext(res);
    const sectors = await service.listTaskSectorOptions({ empresaId: ctx.empresaId });
    const integrations = await service.listStrategicIntegrationStatus({ empresaId: ctx.empresaId });
    const access = await service.listStrategicPermissions({ empresaId: ctx.empresaId });
    const actor = await currentTaskActor(req, res);
    res.json({ success: true, sectors, integrations, actions: access.actions, permissions: access.permissions, user_sectors: actor.sectors, is_admin: actor.isAdmin, can_act: actor.isAdmin || actor.sectors.length > 0, user_id: actor.userId });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Falha ao carregar setores." });
  }
}

async function listTrelloBoards(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.listTrelloBoards({
      empresaId: ctx.empresaId,
      actor: await currentTaskActor(req, res),
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao carregar boards do Trello." });
  }
}

async function listTrelloLists(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.listTrelloBoardLists({
      empresaId: ctx.empresaId,
      actor: await currentTaskActor(req, res),
      boardId: req.params?.boardId || req.query?.board_id || req.query?.boardId || "",
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao carregar listas do Trello." });
  }
}

async function previewTrelloCards(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.previewTrelloCards({
      empresaId: ctx.empresaId,
      actor: await currentTaskActor(req, res),
      boardId: req.body?.board_id || req.body?.boardId || "",
      listIds: req.body?.list_ids || req.body?.listIds || [],
      filter: req.body?.filter || "open",
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao carregar cards do Trello." });
  }
}

async function listWatchlist(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.listWatchlist({
      accountKey: ctx.accountKey,
      empresaId: ctx.empresaId,
      actor: await currentTaskActor(req, res),
      page: req.query?.page || 1,
      limit: req.query?.limit || 25,
      status: req.query?.status || "active",
      listingStatus: req.query?.listing_status || req.query?.listingStatus || "all",
      impact: req.query?.impact || "",
      query: req.query?.q || req.query?.query || "",
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Falha ao carregar Watchlist." });
  }
}

async function refreshWatchlistListingStatus(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.refreshWatchlistListingStatus({
      accessToken: pickAccessToken(req),
      mlCreds: ctx.mlCreds,
      accountKey: ctx.accountKey,
      empresaId: ctx.empresaId,
      actor: await currentTaskActor(req, res),
      status: req.body?.status || "active",
      listingStatus: req.body?.listing_status || req.body?.listingStatus || "all",
      impact: req.body?.impact || "",
      query: req.body?.q || req.body?.query || "",
      refreshListing: req.body?.refresh_listing,
      compareRounds: req.body?.compare_rounds,
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao atualizar status da Watchlist." });
  }
}

async function refreshTaskListingStatus(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.refreshTaskListingStatus({
      accessToken: pickAccessToken(req),
      mlCreds: ctx.mlCreds,
      accountKey: ctx.accountKey,
      actor: await currentTaskActor(req, res),
      status: req.body?.status || "open",
      priority: req.body?.priority || "",
      groupId: req.body?.group_id || req.body?.groupId || null,
      sector: req.body?.sector || req.body?.setor || "",
      tag: req.body?.tag || req.body?.task_tag || req.body?.taskTag || "",
      scope: req.body?.scope || "",
      createdFrom: req.body?.created_from || req.body?.createdFrom || null,
      createdTo: req.body?.created_to || req.body?.createdTo || null,
      analysisFrom: req.body?.analysis_from || req.body?.analysisFrom || null,
      analysisTo: req.body?.analysis_to || req.body?.analysisTo || null,
      dueFrom: req.body?.due_from || req.body?.dueFrom || null,
      dueTo: req.body?.due_to || req.body?.dueTo || null,
      batchId: req.body?.batch_id || req.body?.batchId || "",
      batchName: req.body?.batch_name || req.body?.batchName || "",
      query: req.body?.q || req.body?.query || "",
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao atualizar status dos anuncios das tarefas." });
  }
}

async function watchlistDetails(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.getWatchlistItemDetails({
      accessToken: pickAccessToken(req),
      mlCreds: ctx.mlCreds,
      accountKey: ctx.accountKey,
      empresaId: ctx.empresaId,
      actor: await currentTaskActor(req, res),
      watchlistId: req.params?.id,
      mode: req.query?.mode || req.query?.period_mode || "first_action",
      from: req.query?.from || req.query?.date_from || null,
      to: req.query?.to || req.query?.date_to || null,
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao carregar detalhes da Watchlist." });
  }
}

async function watchlistContains(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.listWatchlistContains({
      accountKey: ctx.accountKey,
      empresaId: ctx.empresaId,
      actor: await currentTaskActor(req, res),
      mlbs: req.query?.mlbs || req.query?.ids || "",
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Falha ao verificar Watchlist." });
  }
}

async function addWatchlistItem(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.addWatchlistItem({
      accessToken: pickAccessToken(req),
      mlCreds: ctx.mlCreds,
      accountKey: ctx.accountKey,
      accountLabel: ctx.accountLabel,
      empresaId: ctx.empresaId,
      actor: await currentTaskActor(req, res),
      query: req.body?.query || "",
      item: req.body?.item || null,
      reason: req.body?.reason || "",
      notes: req.body?.notes || "",
      baseMetrics: req.body?.base_metrics || req.body?.baseMetrics || {},
      createdByUserId: currentUserId(req),
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao adicionar na Watchlist." });
  }
}

async function recordWatchlistAction(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.recordWatchlistAction({
      accountKey: ctx.accountKey,
      empresaId: ctx.empresaId,
      actor: await currentTaskActor(req, res),
      watchlistId: req.params?.id,
      actionFlags: req.body?.action_flags || req.body?.actionFlags || {},
      hypothesis: req.body?.hypothesis || req.body?.hipotese || "",
      notes: req.body?.notes || "",
      occurredOn: req.body?.occurred_on || req.body?.occurredOn || null,
      primaryMetric: req.body?.primary_metric || req.body?.primaryMetric || "",
      windowDays: req.body?.window_days || req.body?.windowDays || 7,
      userId: currentUserId(req),
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao registrar acao na Watchlist." });
  }
}

async function recordWatchlistActionBulk(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.recordWatchlistActionBulk({
      accountKey: ctx.accountKey,
      empresaId: ctx.empresaId,
      actor: await currentTaskActor(req, res),
      watchlistIds: req.body?.ids || req.body?.watchlist_ids || req.body?.watchlistIds || [],
      actionFlags: req.body?.action_flags || req.body?.actionFlags || {},
      hypothesis: req.body?.hypothesis || req.body?.hipotese || "",
      notes: req.body?.notes || "",
      occurredOn: req.body?.occurred_on || req.body?.occurredOn || null,
      primaryMetric: req.body?.primary_metric || req.body?.primaryMetric || "",
      windowDays: req.body?.window_days || req.body?.windowDays || 7,
      userId: currentUserId(req),
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao registrar acoes na Watchlist." });
  }
}

async function removeWatchlistItem(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.removeWatchlistItem({
      accountKey: ctx.accountKey,
      empresaId: ctx.empresaId,
      actor: await currentTaskActor(req, res),
      watchlistId: req.params?.id,
      userId: currentUserId(req),
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao remover item da Watchlist." });
  }
}

async function restoreWatchlistItem(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.restoreWatchlistItem({
      accountKey: ctx.accountKey,
      empresaId: ctx.empresaId,
      actor: await currentTaskActor(req, res),
      watchlistId: req.params?.id,
      userId: currentUserId(req),
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao restaurar item da Watchlist." });
  }
}

async function removeWatchlistItems(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.removeWatchlistItems({
      accountKey: ctx.accountKey,
      empresaId: ctx.empresaId,
      actor: await currentTaskActor(req, res),
      watchlistIds: req.body?.ids || req.body?.watchlist_ids || req.body?.watchlistIds || [],
      userId: currentUserId(req),
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao remover itens da Watchlist." });
  }
}

async function addWatchlistTagsBulk(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.addWatchlistTagsBulk({
      accountKey: ctx.accountKey,
      empresaId: ctx.empresaId,
      actor: await currentTaskActor(req, res),
      watchlistIds: req.body?.ids || req.body?.watchlist_ids || req.body?.watchlistIds || [],
      tag: req.body?.tag || "",
      color: req.body?.color || "",
      userId: currentUserId(req),
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao adicionar tag na Watchlist." });
  }
}

async function createWatchlistTask(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.createTaskFromWatchlist({
      accessToken: pickAccessToken(req),
      mlCreds: ctx.mlCreds,
      accountKey: ctx.accountKey,
      accountLabel: ctx.accountLabel,
      empresaId: ctx.empresaId,
      actor: await currentTaskActor(req, res),
      watchlistId: req.params?.id,
      taskFlags: req.body?.task_flags || req.body?.taskFlags || {},
      taskNotes: req.body?.task_notes || req.body?.taskNotes || "",
      requiredSectors: req.body?.required_sectors || req.body?.requiredSectors || [],
      dueDate: req.body?.due_date || req.body?.dueDate || null,
      priority: req.body?.priority || "medium",
      createdByUserId: currentUserId(req),
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao criar tarefa pela Watchlist." });
  }
}

async function listPermissions(req, res) {
  try {
    const ctx = accountContext(res);
    const actor = await currentTaskActor(req, res);
    if (!actor.isAdmin) return res.status(403).json({ success: false, error: "Apenas administradores podem visualizar o painel de permissoes." });
    const payload = await service.listStrategicPermissions({ empresaId: ctx.empresaId });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Falha ao carregar permissoes." });
  }
}

async function savePermissions(req, res) {
  try {
    const ctx = accountContext(res);
    const actor = await currentTaskActor(req, res);
    if (!actor.isAdmin) return res.status(403).json({ success: false, error: "Apenas administradores podem alterar permissoes." });
    const payload = await service.saveStrategicPermissions({
      empresaId: ctx.empresaId,
      permissions: req.body?.permissions || {},
      userId: currentUserId(req),
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao salvar permissoes." });
  }
}

async function claimTaskBatchSector(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.claimTaskBatchSector({
      accountKey: ctx.accountKey,
      batchId: req.params?.id,
      sector: req.params?.sector || req.body?.sector || req.body?.setor,
      userId: currentUserId(req),
      actor: await currentTaskActor(req, res),
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao assumir setor." });
  }
}

async function completeTask(req, res) {
  try {
    const ctx = accountContext(res);
    const actor = await currentTaskActor(req, res);
    if (!actor.isAdmin) {
      return res.status(403).json({ success: false, error: "Apenas administradores podem finalizar pendencias e iniciar monitoramento." });
    }
    const payload = await service.completeTask({
      accessToken: pickAccessToken(req),
      mlCreds: ctx.mlCreds,
      accountKey: ctx.accountKey,
      accountLabel: ctx.accountLabel,
      empresaId: ctx.empresaId,
      taskId: req.params?.id,
      userId: currentUserId(req),
      user: currentUserSnapshot(req),
      actor,
      changeFlags: req.body?.change_flags || req.body?.changeFlags || null,
      changeNotes: req.body?.change_notes || req.body?.changeNotes || "",
      materialsCreated: req.body?.materials_created || req.body?.materialsCreated || {},
      materialLocations: req.body?.material_locations || req.body?.materialLocations || {},
      listingChanges: req.body?.listing_changes || req.body?.listingChanges || null,
      materialsNotApplicable: req.body?.materials_not_applicable || req.body?.materialsNotApplicable || {},
      listingNotApplicable: req.body?.listing_not_applicable || req.body?.listingNotApplicable || {},
      alterationDate: req.body?.alteration_date || req.body?.alterationDate || null,
      windowDays: req.body?.window_days || req.body?.windowDays || 7,
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao concluir pendencia." });
  }
}

async function updateTaskBatch(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.updateTaskBatch({
      accountKey: ctx.accountKey,
      empresaId: ctx.empresaId,
      batchId: req.params?.id,
      name: req.body?.name,
      priority: req.body?.priority,
      dueDate: req.body?.due_date ?? req.body?.dueDate,
      analysisStartDate: req.body?.analysis_start_date ?? req.body?.analysisStartDate,
      taskTags: req.body?.task_tags ?? req.body?.taskTags,
      taskTagColors: req.body?.task_tag_colors ?? req.body?.taskTagColors,
      taskFlags: req.body?.task_flags ?? req.body?.taskFlags,
      requiredSectors: req.body?.required_sectors ?? req.body?.requiredSectors,
      groupId: req.body?.group_id ?? req.body?.groupId,
      status: req.body?.status,
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao atualizar lote." });
  }
}

async function addTasksToBatch(req, res) {
  try {
    const ctx = accountContext(res);
    const actor = await currentTaskActor(req, res);
    await service.assertStrategicActionPermission({ empresaId: ctx.empresaId, actor, actionKey: "task.create", mode: "edit", message: "Seu setor nao possui permissao para criar tarefas." });
    const payload = await service.createTasks({
      accessToken: pickAccessToken(req),
      mlCreds: ctx.mlCreds,
      accountKey: ctx.accountKey,
      accountLabel: ctx.accountLabel,
      empresaId: ctx.empresaId,
      query: req.body?.query || "",
      items: req.body?.items || [],
      taskFlags: req.body?.task_flags || req.body?.taskFlags || {},
      taskNotes: req.body?.task_notes || req.body?.taskNotes || "",
      taskTags: req.body?.task_tags || req.body?.taskTags || [],
      taskTagColors: req.body?.task_tag_colors || req.body?.taskTagColors || {},
      requiredSectors: req.body?.required_sectors || req.body?.requiredSectors || [],
      taskBatchId: req.params?.id,
      dueDate: req.body?.due_date || req.body?.dueDate || null,
      analysisStartDate: req.body?.analysis_start_date || req.body?.analysisStartDate || null,
      priority: req.body?.priority || "medium",
      createdByUserId: currentUserId(req),
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao adicionar anuncios ao lote." });
  }
}

async function cancelTaskBatch(req, res) {
  try {
    const ctx = accountContext(res);
    const actor = await currentTaskActor(req, res);
    if (!actor.isAdmin) {
      return res.status(403).json({ success: false, error: "Apenas administradores podem cancelar lotes." });
    }
    const payload = await service.cancelTaskBatch({
      accountKey: ctx.accountKey,
      batchId: req.params?.id,
      userId: currentUserId(req),
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao cancelar lote." });
  }
}

async function recordTaskExecution(req, res) {
  try {
    const ctx = accountContext(res);
    const actor = await currentTaskActor(req, res);
    const statusAfter = req.body?.status_after || req.body?.statusAfter || "in_progress";
    if (!actor.isAdmin && statusAfter !== "in_progress") {
      return res.status(403).json({ success: false, error: "Usuarios comuns podem apenas salvar progresso." });
    }
    const payload = await service.recordTaskExecution({
      accessToken: req?.ml?.accessToken || null,
      mlCreds: ctx.mlCreds,
      accountKey: ctx.accountKey,
      accountLabel: ctx.accountLabel,
      empresaId: ctx.empresaId,
      taskId: req.params?.id,
      userId: currentUserId(req),
      user: currentUserSnapshot(req),
      actor,
      materialsCreated: req.body?.materials_created || req.body?.materialsCreated || {},
      materialLocations: req.body?.material_locations || req.body?.materialLocations || {},
      listingChanges: req.body?.listing_changes || req.body?.listingChanges || {},
      materialsUnset: req.body?.materials_unset || req.body?.materialsUnset || {},
      listingUnset: req.body?.listing_unset || req.body?.listingUnset || {},
      materialsNotApplicable: req.body?.materials_not_applicable || req.body?.materialsNotApplicable || {},
      listingNotApplicable: req.body?.listing_not_applicable || req.body?.listingNotApplicable || {},
      materialsNotApplicableUnset: req.body?.materials_not_applicable_unset || req.body?.materialsNotApplicableUnset || {},
      listingNotApplicableUnset: req.body?.listing_not_applicable_unset || req.body?.listingNotApplicableUnset || {},
      notes: req.body?.notes || req.body?.change_notes || req.body?.changeNotes || "",
      statusAfter,
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao registrar execucao da pendencia." });
  }
}

async function returnTaskMaterials(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.returnTaskMaterials({
      accountKey: ctx.accountKey,
      empresaId: ctx.empresaId,
      taskId: req.params?.id,
      userId: currentUserId(req),
      user: currentUserSnapshot(req),
      actor: await currentTaskActor(req, res),
      materials: req.body?.materials || req.body?.materials_returned || req.body?.materialsReturned || {},
      reason: req.body?.reason || req.body?.motivo || "",
      note: req.body?.note || req.body?.notes || req.body?.observacao || "",
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao devolver materiais." });
  }
}

async function review(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.reviewRound({
      roundId: req.params?.id,
      accessToken: pickAccessToken(req),
      mlCreds: ctx.mlCreds,
      force: req.body?.force === true || req.query?.force === "1",
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao revisar alteracao estrategica." });
  }
}

async function returnRoundToTask(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.returnRoundToTask({
      accountKey: ctx.accountKey,
      empresaId: ctx.empresaId,
      roundId: req.params?.id,
      userId: currentUserId(req),
      user: currentUserSnapshot(req),
      actor: await currentTaskActor(req, res),
      reason: req.body?.reason || req.body?.motivo || "",
      reopenFlags: req.body?.reopen_flags || req.body?.reopenFlags || {},
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao devolver monitoramento para tarefas." });
  }
}

async function due(_req, res) {
  try {
    const payload = await service.reviewDueRounds({ limit: 50 });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Falha ao revisar pendentes." });
  }
}

async function exportCsv(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.listDashboard({
      accountKey: ctx.accountKey,
      limit: req.query?.limit || 500,
      maxLimit: 500,
      groupId: req.query?.group_id || req.query?.groupId || null,
    });
    const csv = service.buildCsv(payload.rounds || []);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"estrategicos.csv\"");
    res.send(csv);
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Falha ao exportar CSV." });
  }
}

async function taskReportOptions(_req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.listTaskReportOptions({
      accountKey: ctx.accountKey,
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Falha ao carregar opcoes do relatorio." });
  }
}

async function exportTaskReportXlsx(req, res) {
  try {
    const ctx = accountContext(res);
    const file = await service.buildTaskReportWorkbook({
      accountKey: ctx.accountKey,
      accountLabel: ctx.accountLabel || ctx.mlCreds?.nome || ctx.mlCreds?.nickname || "",
      dateFrom: req.query?.date_from || req.query?.from || null,
      dateTo: req.query?.date_to || req.query?.to || null,
      userId: req.query?.user_id || req.query?.userId || "",
      sector: req.query?.sector || req.query?.setor || "",
      batchId: req.query?.batch_id || req.query?.batchId || "",
      status: req.query?.status || "",
    });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    res.send(file.buffer);
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Falha ao exportar relatorio de tarefas." });
  }
}

async function listGroups(_req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.listGroups({ accountKey: ctx.accountKey });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Falha ao listar grupos." });
  }
}

async function createGroup(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.createGroup({
      accountKey: ctx.accountKey,
      name: req.body?.name,
      color: req.body?.color || "blue",
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao criar grupo." });
  }
}

async function updateGroup(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await service.updateGroup({
      accountKey: ctx.accountKey,
      groupId: req.params?.id,
      name: req.body?.name,
      color: req.body?.color || "blue",
      isActive: req.body?.is_active !== false && req.body?.isActive !== false,
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao atualizar grupo." });
  }
}

module.exports = { list, lookup, create, listTasks, listTaskBatches, listTaskBatchItemTokens, listTaskSectors, listTrelloBoards, listTrelloLists, previewTrelloCards, listWatchlist, refreshWatchlistListingStatus, refreshTaskListingStatus, watchlistDetails, watchlistContains, addWatchlistItem, recordWatchlistAction, recordWatchlistActionBulk, removeWatchlistItem, restoreWatchlistItem, removeWatchlistItems, addWatchlistTagsBulk, createWatchlistTask, listPermissions, savePermissions, createTasks, updateTaskBatch, addTasksToBatch, cancelTaskBatch, updateTask, claimTaskBatchSector, recordTaskExecution, returnTaskMaterials, completeTask, returnRoundToTask, review, history, due, exportCsv, taskReportOptions, exportTaskReportXlsx, listGroups, createGroup, updateGroup };
