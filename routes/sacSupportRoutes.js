"use strict";

const express = require("express");
const jwt = require("jsonwebtoken");
const { DACHBYTE_BRAND } = require("../lib/dachbyteBrand");

const service = require("../lib/sacSupportService");
const {
  sendTicketOpenedEmail,
  sendTicketReplyEmail,
  sendTicketStatusEmail,
} = require("../lib/sacSupportEmailService");

const router = express.Router();
const SAC_COOKIE = "sac_davantti_auth";
const SAC_JWT_SECRET =
  String(process.env.SAC_JWT_SECRET || "").trim() ||
  String(process.env.SUITE_JWT_SECRET || "").trim() ||
  String(process.env.JWT_SECRET || "").trim() ||
  "davantti-sac-local-secret-change-me";

let schemaReadyPromise = null;
let maintenanceStarted = false;
let overdueSweepRunning = false;

function isProduction() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    maxAge: 12 * 60 * 60 * 1000,
    path: "/",
  };
}

function parseCookies(req) {
  const header = String(req.headers?.cookie || "");
  return header.split(";").reduce((acc, part) => {
    const index = part.indexOf("=");
    if (index <= 0) return acc;
    const key = decodeURIComponent(part.slice(0, index).trim());
    const value = decodeURIComponent(part.slice(index + 1).trim());
    acc[key] = value;
    return acc;
  }, {});
}

async function adminFromRequest(req) {
  const token = parseCookies(req)[SAC_COOKIE];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, SAC_JWT_SECRET);
    const admin = await service.findSacSupportAdminByEmail(payload?.email);
    if (!admin) return null;
    return admin;
  } catch (_error) {
    return null;
  }
}

async function requireAdmin(req, res, next) {
  const admin = await adminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ ok: false, error: "Login SAC necessario." });
  }
  req.sacAdmin = admin;
  return next();
}

function ensureSchema(req, res, next) {
  if (!schemaReadyPromise) {
    schemaReadyPromise = service
      .ensureSacSupportSchema()
      .then(() => service.ensureSacSupportAdmins(service.defaultSacSupportAdminSeeds()))
      .then(() => service.cleanupExpiredRetention())
      .catch((error) => {
        schemaReadyPromise = null;
        throw error;
      });
  }
  schemaReadyPromise.then(() => next()).catch(next);
}

async function notifyClosedOverdue(ticket) {
  try {
    await sendTicketStatusEmail(
      ticket,
      "Seu ticket foi fechado automaticamente por falta de resposta em 48 horas uteis.",
    );
  } catch (error) {
    console.warn("[SAC] Falha ao notificar fechamento automatico:", error?.message || error);
  }
}

async function sweepOverdueTickets() {
  if (overdueSweepRunning) return;
  overdueSweepRunning = true;
  try {
    await service.ensureSacSupportSchema();
    const closed = await service.closeOverdueTickets();
    await Promise.all(closed.map((ticket) => notifyClosedOverdue(ticket)));
  } catch (error) {
    console.warn("[SAC] Sweep de tickets atrasados falhou:", error?.message || error);
  } finally {
    overdueSweepRunning = false;
  }
}

function startMaintenance() {
  if (maintenanceStarted) return;
  maintenanceStarted = true;
  sweepOverdueTickets();
  setInterval(sweepOverdueTickets, 30 * 60 * 1000).unref?.();
}

function errorResponse(error, res) {
  const status = Number(error?.status || 500);
  return res.status(status).json({
    ok: false,
    code: error?.code || (status >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR"),
    error: error?.message || `Falha no ${DACHBYTE_BRAND.sac}.`,
  });
}

function clientMeta(req) {
  return {
    userAgent: String(req.headers["user-agent"] || "").slice(0, 800),
  };
}

router.use(express.json({ limit: "1mb" }));
router.use(ensureSchema);

router.get("/status", (_req, res) => {
  startMaintenance();
  return res.json({ ok: true, support: service.supportStatus() });
});

router.post("/chats", async (req, res) => {
  try {
    startMaintenance();
    const chat = await service.createChat({
      ...req.body,
      ...clientMeta(req),
    });
    return res.status(201).json({ ok: true, chat });
  } catch (error) {
    return errorResponse(error, res);
  }
});

router.get("/chats/:id", async (req, res) => {
  try {
    const chat = await service.getChat(req.params.id);
    if (!chat) return res.status(404).json({ ok: false, error: "Chat nao encontrado." });
    return res.json({ ok: true, chat });
  } catch (error) {
    return errorResponse(error, res);
  }
});

router.post("/chats/:id/messages", async (req, res) => {
  try {
    const chat = await service.appendChatMessage(req.params.id, {
      author: "customer",
      authorName: req.body?.customerName || req.body?.name || "Cliente",
      text: req.body?.message,
    });
    return res.json({ ok: true, chat });
  } catch (error) {
    return errorResponse(error, res);
  }
});

router.post("/chats/:id/finalize", async (req, res) => {
  try {
    const chat = await service.finalizeChat(req.params.id, req.body || {});
    return res.json({ ok: true, chat });
  } catch (error) {
    return errorResponse(error, res);
  }
});

router.post("/tickets", async (req, res) => {
  try {
    startMaintenance();
    const ticket = await service.createTicket({
      ...req.body,
      ...clientMeta(req),
    });
    const email = await sendTicketOpenedEmail(ticket).catch((error) => ({
      sent: false,
      skipped: false,
      error: error?.message || String(error),
    }));
    return res.status(201).json({ ok: true, ticket, email });
  } catch (error) {
    return errorResponse(error, res);
  }
});

router.get("/tickets/:protocol", async (req, res) => {
  try {
    const ticket = await service.getTicket(req.params.protocol, req.query?.email);
    if (!ticket) return res.status(404).json({ ok: false, error: "Ticket nao encontrado." });
    return res.json({ ok: true, ticket });
  } catch (error) {
    return errorResponse(error, res);
  }
});

router.post("/tickets/:protocol/messages", async (req, res) => {
  try {
    const ticket = await service.getTicket(req.params.protocol, req.body?.email);
    if (!ticket) return res.status(404).json({ ok: false, error: "Ticket nao encontrado." });
    const result = await service.appendTicketMessage(ticket.id, {
      author: "customer",
      authorName: ticket.customer_name,
      text: req.body?.message,
    });
    return res.json({ ok: true, ticket: result.ticket });
  } catch (error) {
    return errorResponse(error, res);
  }
});

router.post("/tickets/:protocol/finalize", async (req, res) => {
  try {
    const ticket = await service.getTicket(req.params.protocol, req.body?.email);
    if (!ticket) return res.status(404).json({ ok: false, error: "Ticket nao encontrado." });
    const finalized = await service.finalizeTicket(ticket.id, req.body || {});
    return res.json({ ok: true, ticket: finalized });
  } catch (error) {
    return errorResponse(error, res);
  }
});

router.post("/admin/login", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || req.body?.senha || "").trim();
  const admin = await service.verifySacSupportAdminLogin(email, password);
  if (!admin) {
    const debug = await service.diagnoseSacSupportAdminLogin(email, password);
    return res.status(401).json({
      ok: false,
      error: "Credenciais SAC invalidas.",
      debug,
    });
  }
  const token = jwt.sign(
    { email: admin.email, role: admin.role || "sac_admin" },
    SAC_JWT_SECRET,
    { expiresIn: "12h" },
  );
  res.cookie(SAC_COOKIE, token, cookieOptions());
  return res.json({ ok: true, admin });
});

router.post("/admin/logout", (_req, res) => {
  res.clearCookie(SAC_COOKIE, { path: "/" });
  return res.status(204).end();
});

router.get("/admin/me", async (req, res) => {
  const admin = await adminFromRequest(req);
  if (!admin) return res.status(401).json({ ok: false, error: "Login SAC necessario." });
  return res.json({ ok: true, admin });
});

router.get("/admin/chats", requireAdmin, async (req, res) => {
  try {
    const chats = await service.listChats(req.query || {});
    return res.json({ ok: true, chats });
  } catch (error) {
    return errorResponse(error, res);
  }
});

router.get("/admin/chats/:id", requireAdmin, async (req, res) => {
  try {
    const chat = await service.getChat(req.params.id);
    if (!chat) return res.status(404).json({ ok: false, error: "Chat nao encontrado." });
    return res.json({ ok: true, chat });
  } catch (error) {
    return errorResponse(error, res);
  }
});

router.post("/admin/chats/:id/messages", requireAdmin, async (req, res) => {
  try {
    const chat = await service.appendChatMessage(req.params.id, {
      author: "admin",
      authorName: req.sacAdmin.name,
      text: req.body?.message,
    });
    return res.json({ ok: true, chat });
  } catch (error) {
    return errorResponse(error, res);
  }
});

router.post("/admin/chats/:id/finalize", requireAdmin, async (req, res) => {
  try {
    const chat = await service.finalizeChat(req.params.id, req.body || {});
    return res.json({ ok: true, chat });
  } catch (error) {
    return errorResponse(error, res);
  }
});

router.post("/admin/chats/:id/ticket", requireAdmin, async (req, res) => {
  try {
    const ticket = await service.createTicketFromChat(req.params.id, req.body || {});
    const email = await sendTicketOpenedEmail(ticket).catch((error) => ({
      sent: false,
      skipped: false,
      error: error?.message || String(error),
    }));
    return res.status(201).json({ ok: true, ticket, email });
  } catch (error) {
    return errorResponse(error, res);
  }
});

router.get("/admin/tickets", requireAdmin, async (req, res) => {
  try {
    await sweepOverdueTickets();
    const tickets = await service.listTickets(req.query || {});
    return res.json({ ok: true, tickets });
  } catch (error) {
    return errorResponse(error, res);
  }
});

router.get("/admin/tickets/:id", requireAdmin, async (req, res) => {
  try {
    const ticket = await service.getTicket(req.params.id);
    if (!ticket) return res.status(404).json({ ok: false, error: "Ticket nao encontrado." });
    return res.json({ ok: true, ticket });
  } catch (error) {
    return errorResponse(error, res);
  }
});

router.post("/admin/tickets/:id/messages", requireAdmin, async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();
    const result = await service.appendTicketMessage(req.params.id, {
      author: "admin",
      authorName: req.sacAdmin.name,
      text: message,
      notify: req.body?.notify !== false,
    });
    const email = result.shouldNotify
      ? await sendTicketReplyEmail(result.ticket, message).catch((error) => ({
          sent: false,
          skipped: false,
          error: error?.message || String(error),
        }))
      : { sent: false, skipped: true, reason: "Notificacao desativada pelo admin." };
    return res.json({ ok: true, ticket: result.ticket, email });
  } catch (error) {
    return errorResponse(error, res);
  }
});

router.post("/admin/tickets/:id/status", requireAdmin, async (req, res) => {
  try {
    const ticket = await service.updateTicketStatus(
      req.params.id,
      req.body?.action,
      req.sacAdmin.name,
    );
    let statusText = `Status do ticket atualizado pelo ${DACHBYTE_BRAND.support}.`;
    if (ticket.status === "resolved") statusText = `Seu ticket foi marcado como resolvido pelo ${DACHBYTE_BRAND.support}.`;
    if (ticket.status === "closed") statusText = `Seu ticket foi fechado pelo ${DACHBYTE_BRAND.support}.`;
    if (ticket.status === "reopened") statusText = `Seu ticket foi reaberto pelo ${DACHBYTE_BRAND.support}.`;
    const email = req.body?.notify === false
      ? { sent: false, skipped: true, reason: "Notificacao desativada pelo admin." }
      : await sendTicketStatusEmail(ticket, statusText).catch((error) => ({
          sent: false,
          skipped: false,
          error: error?.message || String(error),
        }));
    return res.json({ ok: true, ticket, email });
  } catch (error) {
    return errorResponse(error, res);
  }
});

router.post("/admin/tickets/:id/resend", requireAdmin, async (req, res) => {
  try {
    const ticket = await service.getTicket(req.params.id);
    if (!ticket) return res.status(404).json({ ok: false, error: "Ticket nao encontrado." });
    const lastAdmin = [...(ticket.messages || [])]
      .reverse()
      .find((message) => message.author === "admin");
    if (!lastAdmin) {
      return res.status(409).json({ ok: false, error: "Nao ha resposta do admin para reenviar." });
    }
    const email = await sendTicketReplyEmail(ticket, lastAdmin.text, { resend: true }).catch((error) => ({
      sent: false,
      skipped: false,
      error: error?.message || String(error),
    }));
    return res.json({ ok: true, ticket, email });
  } catch (error) {
    return errorResponse(error, res);
  }
});

module.exports = router;
