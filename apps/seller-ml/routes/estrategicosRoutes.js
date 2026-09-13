"use strict";

const express = require("express");
const Controller = require("../controllers/EstrategicosController");
const { createAuditAction } = require("../middleware/auditAction");

const router = express.Router();

router.get("/", Controller.list);
router.get("/groups", Controller.listGroups);
router.get("/items/:mlb/history", Controller.history);
router.get("/task-sectors", Controller.listTaskSectors);
router.get("/trello/boards", Controller.listTrelloBoards);
router.get("/trello/boards/:boardId/lists", Controller.listTrelloLists);
router.get("/permissions", Controller.listPermissions);
router.get("/watchlist/contains", Controller.watchlistContains);
router.get("/watchlist", Controller.listWatchlist);
router.get("/watchlist/:id/details", Controller.watchlistDetails);
router.get("/tasks/report-options", Controller.taskReportOptions);
router.get("/tasks/report.xlsx", Controller.exportTaskReportXlsx);
router.get("/tasks/batches/:id/items", Controller.listTaskBatchItemTokens);
router.get("/tasks/batches", Controller.listTaskBatches);
router.get("/tasks", Controller.listTasks);

router.post(
  "/groups",
  createAuditAction({
    evento: "strategic_group_created",
    metadata: (req) => ({ name: req.body?.name || null, color: req.body?.color || "blue" }),
  }),
  Controller.createGroup,
);

router.put(
  "/groups/:id",
  createAuditAction({
    evento: "strategic_group_updated",
    metadata: (req) => ({ group_id: req.params?.id || null, name: req.body?.name || null }),
  }),
  Controller.updateGroup,
);

router.post(
  "/lookup",
  createAuditAction({
    evento: "strategic_items_lookup",
    metadata: (req) => ({ query_len: String(req.body?.query || "").length }),
  }),
  Controller.lookup,
);

router.post(
  "/rounds",
  createAuditAction({
    evento: "strategic_round_created",
    metadata: (req) => ({
      items: Array.isArray(req.body?.items) ? req.body.items.length : 0,
      window_days: req.body?.window_days || req.body?.windowDays || 7,
    }),
  }),
  Controller.create,
);

router.post(
  "/tasks",
  createAuditAction({
    evento: "strategic_tasks_created",
    metadata: (req) => ({
      query_len: String(req.body?.query || "").length,
      priority: req.body?.priority || "medium",
    }),
  }),
  Controller.createTasks,
);

router.post(
  "/trello/cards-preview",
  createAuditAction({
    evento: "strategic_trello_cards_previewed",
    metadata: (req) => ({
      board_id: req.body?.board_id || req.body?.boardId || null,
      lists: Array.isArray(req.body?.list_ids || req.body?.listIds) ? (req.body?.list_ids || req.body?.listIds).length : 0,
    }),
  }),
  Controller.previewTrelloCards,
);

router.post(
  "/watchlist",
  createAuditAction({
    evento: "strategic_watchlist_added",
    metadata: (req) => ({ query: req.body?.query || req.body?.item?.mlb || null }),
  }),
  Controller.addWatchlistItem,
);

router.post(
  "/watchlist/bulk/actions",
  createAuditAction({
    evento: "strategic_watchlist_bulk_action_registered",
    metadata: (req) => ({ total: Array.isArray(req.body?.ids) ? req.body.ids.length : 0 }),
  }),
  Controller.recordWatchlistActionBulk,
);

router.post(
  "/watchlist/bulk/tags",
  createAuditAction({
    evento: "strategic_watchlist_bulk_tag_added",
    metadata: (req) => ({ total: Array.isArray(req.body?.ids) ? req.body.ids.length : 0, tag: req.body?.tag || null }),
  }),
  Controller.addWatchlistTagsBulk,
);

router.post(
  "/watchlist/:id/actions",
  createAuditAction({
    evento: "strategic_watchlist_action_registered",
    metadata: (req) => ({ watchlist_id: req.params?.id || null, flags: Object.keys(req.body?.action_flags || req.body?.actionFlags || {}).filter((key) => (req.body?.action_flags || req.body?.actionFlags || {})[key]) }),
  }),
  Controller.recordWatchlistAction,
);

router.post(
  "/watchlist/:id/create-task",
  createAuditAction({
    evento: "strategic_watchlist_task_created",
    metadata: (req) => ({ watchlist_id: req.params?.id || null }),
  }),
  Controller.createWatchlistTask,
);

router.post(
  "/watchlist/refresh-listing-status",
  createAuditAction({
    evento: "strategic_watchlist_listing_status_refreshed",
    metadata: (req) => ({
      status: req.body?.status || "active",
      listing_status: req.body?.listing_status || req.body?.listingStatus || "all",
      query_len: String(req.body?.q || req.body?.query || "").length,
    }),
  }),
  Controller.refreshWatchlistListingStatus,
);

router.post(
  "/tasks/refresh-listing-status",
  createAuditAction({
    evento: "strategic_tasks_listing_status_refreshed",
    metadata: (req) => ({
      status: req.body?.status || "open",
      priority: req.body?.priority || "",
      sector: req.body?.sector || req.body?.setor || "",
      query_len: String(req.body?.q || req.body?.query || "").length,
    }),
  }),
  Controller.refreshTaskListingStatus,
);

router.post(
  "/watchlist/:id/restore",
  createAuditAction({
    evento: "strategic_watchlist_restored",
    metadata: (req) => ({ watchlist_id: req.params?.id || null }),
  }),
  Controller.restoreWatchlistItem,
);

router.delete(
  "/watchlist/:id",
  createAuditAction({
    evento: "strategic_watchlist_removed",
    metadata: (req) => ({ watchlist_id: req.params?.id || null }),
  }),
  Controller.removeWatchlistItem,
);

router.post(
  "/watchlist/bulk/remove",
  createAuditAction({
    evento: "strategic_watchlist_bulk_removed",
    metadata: (req) => ({ total: Array.isArray(req.body?.ids) ? req.body.ids.length : 0 }),
  }),
  Controller.removeWatchlistItems,
);

router.put(
  "/tasks/batches/:id",
  createAuditAction({
    evento: "strategic_task_batch_updated",
    metadata: (req) => ({ batch_id: req.params?.id || null, name: req.body?.name || null, status: req.body?.status || null }),
  }),
  Controller.updateTaskBatch,
);

router.post(
  "/tasks/batches/:id/items",
  createAuditAction({
    evento: "strategic_task_batch_items_added",
    metadata: (req) => ({ batch_id: req.params?.id || null, query_len: String(req.body?.query || "").length }),
  }),
  Controller.addTasksToBatch,
);

router.post(
  "/tasks/batches/:id/cancel",
  createAuditAction({
    evento: "strategic_task_batch_canceled",
    metadata: (req) => ({ batch_id: req.params?.id || null }),
  }),
  Controller.cancelTaskBatch,
);

router.put(
  "/permissions",
  createAuditAction({
    evento: "strategic_permissions_updated",
    metadata: (req) => ({ actions: Object.keys(req.body?.permissions || {}).length }),
  }),
  Controller.savePermissions,
);

router.post(
  "/tasks/batches/:id/sectors/:sector/claim",
  createAuditAction({
    evento: "strategic_task_batch_sector_claimed",
    metadata: (req) => ({ batch_id: req.params?.id || null, sector: req.params?.sector || null }),
  }),
  Controller.claimTaskBatchSector,
);

router.put(
  "/tasks/:id",
  createAuditAction({
    evento: "strategic_task_updated",
    metadata: (req) => ({ task_id: req.params?.id || null, status: req.body?.status || null }),
  }),
  Controller.updateTask,
);

router.post(
  "/tasks/:id/execution",
  createAuditAction({
    evento: "strategic_task_execution_recorded",
    metadata: (req) => ({ task_id: req.params?.id || null, status_after: req.body?.status_after || req.body?.statusAfter || null }),
  }),
  Controller.recordTaskExecution,
);

router.post(
  "/tasks/:id/return-materials",
  createAuditAction({
    evento: "strategic_task_materials_returned",
    metadata: (req) => ({ task_id: req.params?.id || null, materials: Object.keys(req.body?.materials || req.body?.materials_returned || {}).filter((key) => (req.body?.materials || req.body?.materials_returned || {})[key]) }),
  }),
  Controller.returnTaskMaterials,
);

router.post(
  "/tasks/:id/complete",
  createAuditAction({
    evento: "strategic_task_completed",
    metadata: (req) => ({ task_id: req.params?.id || null, window_days: req.body?.window_days || req.body?.windowDays || 7 }),
  }),
  Controller.completeTask,
);

router.post(
  "/rounds/:id/review",
  createAuditAction({
    evento: "strategic_round_reviewed",
    metadata: (req) => ({ round_id: req.params?.id || null, force: req.body?.force === true || req.query?.force === "1" }),
  }),
  Controller.review,
);

router.post(
  "/rounds/:id/return-task",
  createAuditAction({
    evento: "strategic_round_returned_to_task",
    metadata: (req) => ({ round_id: req.params?.id || null }),
  }),
  Controller.returnRoundToTask,
);

router.post("/review-due", Controller.due);
router.get("/export.csv", Controller.exportCsv);

module.exports = router;
