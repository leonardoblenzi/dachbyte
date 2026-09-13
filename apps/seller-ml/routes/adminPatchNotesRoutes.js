"use strict";

const express = require("express");
const { createAuditAction } = require("../middleware/auditAction");
const {
  deletePatchNotes,
  filterRecipients,
  getPatchNoteById,
  getPatchNoteByVersion,
  listPatchNotes,
  listRecipientOptions,
  markPatchNoteAsSent,
  sanitizePatchNoteInput,
  saveDeliveryLog,
  upsertPatchNote,
} = require("../services/patchNotesService");
const {
  buildPatchNotesHtml,
  buildPatchNotesSubject,
  sendPatchNotesEmail,
} = require("../services/patchNotesEmailService");

const router = express.Router();

function ensureMasterOnly(req, res, next) {
  const u = req.user || res.locals.user;
  const nivel = String(u?.nivel || "").trim().toLowerCase();
  if (nivel === "admin_master" || u?.is_master === true) return next();
  return res.status(403).json({ ok: false, error: "Acesso nao autorizado." });
}

router.use(ensureMasterOnly);

router.get("/patch-notes", async (req, res) => {
  try {
    const notes = await listPatchNotes({ limit: req.query?.limit });
    return res.json({ ok: true, notes });
  } catch (err) {
    console.error("GET /api/admin/patch-notes erro:", err);
    return res.status(500).json({ ok: false, error: "Erro ao listar patch notes." });
  }
});

router.get("/patch-notes/recipients", async (_req, res) => {
  try {
    const recipients = await listRecipientOptions();
    return res.json({ ok: true, recipients });
  } catch (err) {
    console.error("GET /api/admin/patch-notes/recipients erro:", err);
    return res.status(500).json({ ok: false, error: "Erro ao listar destinatarios." });
  }
});

router.get("/patch-notes/by-version/:version", async (req, res) => {
  try {
    const note = await getPatchNoteByVersion(req.params.version);
    if (!note) {
      return res.status(404).json({ ok: false, error: "Patch note nao encontrado." });
    }
    return res.json({ ok: true, note });
  } catch (err) {
    const message = err?.message || "Erro ao carregar patch note.";
    const status = /versao invalida/i.test(message) ? 400 : 500;
    if (status === 500) console.error("GET /api/admin/patch-notes/by-version/:version erro:", err);
    return res.status(status).json({ ok: false, error: message });
  }
});

router.get("/patch-notes/:id", async (req, res) => {
  try {
    const note = await getPatchNoteById(req.params.id);
    if (!note) {
      return res.status(404).json({ ok: false, error: "Patch note nao encontrado." });
    }
    return res.json({ ok: true, note });
  } catch (err) {
    console.error("GET /api/admin/patch-notes/:id erro:", err);
    return res.status(500).json({ ok: false, error: "Erro ao carregar patch note." });
  }
});

router.post(
  "/patch-notes/delete",
  createAuditAction({
    evento: "admin_patch_note_deleted",
    metadata: (req) => ({
      patch_note_ids: Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 100) : [],
    }),
  }),
  express.json({ limit: "1mb" }),
  async (req, res) => {
    try {
      const result = await deletePatchNotes(req.body?.ids || []);
      if (!result.deletedCount) {
        return res.status(400).json({ ok: false, error: "Selecione ao menos um patch note para excluir." });
      }
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error("POST /api/admin/patch-notes/delete erro:", err);
      return res.status(500).json({ ok: false, error: "Erro ao excluir patch notes." });
    }
  },
);

router.post(
  "/patch-notes",
  createAuditAction({
    evento: "admin_patch_note_saved",
    metadata: (req) => ({
      version: req.body?.version || null,
      title: req.body?.title || null,
    }),
  }),
  express.json({ limit: "1mb" }),
  async (req, res) => {
    try {
      const saved = await upsertPatchNote(req.body, req.user?.uid);
      return res.json({ ok: true, note: saved });
    } catch (err) {
      const message = err?.message || "Erro ao salvar patch note.";
      const status =
        /versao invalida|nao encontrado/i.test(message) ? 400
        : String(err?.code) === "23505" ? 409
        : 500;
      if (status === 500) console.error("POST /api/admin/patch-notes erro:", err);
      return res.status(status).json({ ok: false, error: message });
    }
  },
);

router.post(
  "/patch-notes/preview",
  express.json({ limit: "1mb" }),
  async (req, res) => {
    try {
      const note = sanitizePatchNoteInput(req.body);
      return res.json({
        ok: true,
        subject: buildPatchNotesSubject(note),
        html: buildPatchNotesHtml(note),
        normalized: note,
      });
    } catch (err) {
      const message = err?.message || "Erro ao gerar preview.";
      const status = /versao invalida/i.test(message) ? 400 : 500;
      if (status === 500) console.error("POST /api/admin/patch-notes/preview erro:", err);
      return res.status(status).json({ ok: false, error: message });
    }
  },
);

router.post(
  "/patch-notes/:id/send",
  createAuditAction({
    evento: "admin_patch_note_sent",
    metadata: (req) => ({
      patch_note_id: Number(req.params.id) || null,
      audience: req.body?.audience || null,
      recipient_ids: Array.isArray(req.body?.recipient_ids) ? req.body.recipient_ids.slice(0, 100) : [],
    }),
  }),
  express.json({ limit: "1mb" }),
  async (req, res) => {
    try {
      const note = await getPatchNoteById(req.params.id);
      if (!note) {
        return res.status(404).json({ ok: false, error: "Patch note nao encontrado." });
      }

      const recipientsBase = await listRecipientOptions();
      const recipients = filterRecipients(recipientsBase, {
        audience: req.body?.audience || note.audience,
        recipientIds: req.body?.recipient_ids || [],
        manualEmails: req.body?.manual_emails || [],
      });

      if (!recipients.length) {
        return res.status(400).json({ ok: false, error: "Selecione ao menos um destinatario." });
      }

      const results = [];
      for (const recipient of recipients) {
        try {
          const delivery = await sendPatchNotesEmail({
            toEmail: recipient.email,
            toName: recipient.nome,
            note,
          });

          await saveDeliveryLog({
            patchNoteId: note.id,
            recipientEmail: recipient.email,
            recipientName: recipient.nome,
            deliveryStatus: delivery.sent ? "sent" : "pending",
            providerMessageId: delivery.messageId,
            errorMessage: delivery.reason || null,
          });

          results.push({
            email: recipient.email,
            sent: !!delivery.sent,
            skipped: !!delivery.skipped,
            messageId: delivery.messageId || null,
            reason: delivery.reason || null,
          });
        } catch (err) {
          await saveDeliveryLog({
            patchNoteId: note.id,
            recipientEmail: recipient.email,
            recipientName: recipient.nome,
            deliveryStatus: "failed",
            providerMessageId: null,
            errorMessage: err?.message || "Falha ao enviar.",
          });

          results.push({
            email: recipient.email,
            sent: false,
            skipped: false,
            reason: err?.message || "Falha ao enviar.",
          });
        }
      }

      await markPatchNoteAsSent(note.id, req.body?.audience || note.audience);

      return res.json({
        ok: true,
        sent_count: results.filter((item) => item.sent).length,
        failed_count: results.filter((item) => !item.sent && !item.skipped).length,
        skipped_count: results.filter((item) => item.skipped).length,
        results,
      });
    } catch (err) {
      console.error("POST /api/admin/patch-notes/:id/send erro:", err);
      return res.status(500).json({ ok: false, error: "Erro ao enviar patch notes." });
    }
  },
);

module.exports = router;
