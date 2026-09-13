"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getReleaseNoteDetail = exports.listReleaseNotes = exports.sendReleaseNotes = void 0;
const crypto_1 = __importDefault(require("crypto"));
const releaseNotesService_1 = require("../services/releaseNotesService");
const db_1 = require("../lib/db");
const MASTER_ADMIN_EMAIL = 'admin@avantracking.com.br';
const normalizeLines = (value) => String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
const sendReleaseNotes = async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ error: 'Usuario nao autenticado' });
    }
    if (req.user.email !== MASTER_ADMIN_EMAIL) {
        return res.status(403).json({ error: 'Apenas o admin master pode enviar release notes.' });
    }
    const version = String(req.body?.version || '').trim();
    const title = String(req.body?.title || '').trim();
    const summary = String(req.body?.summary || '').trim();
    const newFeatures = normalizeLines(req.body?.newFeatures);
    const adjustments = normalizeLines(req.body?.adjustments);
    const requestedRecipientIds = Array.isArray(req.body?.recipientUserIds)
        ? req.body.recipientUserIds
            .map((value) => String(value || '').trim())
            .filter(Boolean)
        : [];
    if (!version || !title || !summary) {
        return res.status(400).json({
            error: 'Informe versao, titulo e texto principal para montar o release notes.',
        });
    }
    if (requestedRecipientIds.length === 0) {
        return res.status(400).json({ error: 'Selecione pelo menos um destinatario.' });
    }
    try {
        const usersResult = await (0, db_1.dbQuery)(`
        SELECT
          u."id",
          u."name",
          u."email"
        FROM "User" u
        WHERE u."id" = ANY($1::text[])
      `, [requestedRecipientIds]);
        const users = usersResult.rows;
        const recipientsMap = new Map();
        for (const user of users) {
            const normalizedEmail = String(user.email || '').trim().toLowerCase();
            if (!normalizedEmail)
                continue;
            recipientsMap.set(normalizedEmail, {
                email: user.email,
                name: user.name || user.email,
            });
        }
        const recipients = Array.from(recipientsMap.values());
        if (recipients.length === 0) {
            return res.status(400).json({ error: 'Nenhum e-mail valido encontrado nos destinatarios selecionados.' });
        }
        await (0, releaseNotesService_1.sendReleaseNotesEmail)({
            version,
            title,
            summary,
            newFeatures,
            adjustments,
            recipients,
        });
        const htmlContent = (0, releaseNotesService_1.buildReleaseNotesHtml)({
            version,
            title,
            summary,
            newFeatures,
            adjustments,
        });
        const releaseNoteResult = await (0, db_1.dbQuery)(`
        INSERT INTO "ReleaseNote" (
          "id",
          "version",
          "title",
          "summary",
          "newFeatures",
          "adjustments",
          "htmlContent",
          "recipientCount",
          "sentByUserId",
          "createdAt"
        )
        VALUES (
          $9,
          $1,
          $2,
          $3,
          $4::text[],
          $5::text[],
          $6,
          $7,
          $8,
          NOW()
        )
        RETURNING
          "id",
          "version",
          "title",
          "recipientCount",
          "createdAt"
      `, [
            version,
            title,
            summary,
            newFeatures,
            adjustments,
            htmlContent,
            recipients.length,
            req.user.id,
            crypto_1.default.randomUUID(),
        ]);
        const releaseNote = releaseNoteResult.rows[0];
        return res.json({
            success: true,
            message: `Release notes enviado para ${recipients.length} destinatario(s).`,
            releaseNote,
        });
    }
    catch (error) {
        console.error('Erro ao enviar release notes:', error);
        return res.status(500).json({ error: 'Falha ao enviar release notes.' });
    }
};
exports.sendReleaseNotes = sendReleaseNotes;
const listReleaseNotes = async (_req, res) => {
    try {
        const releaseNotesResult = await (0, db_1.dbQuery)(`
        SELECT
          rn."id",
          rn."version",
          rn."title",
          rn."summary",
          rn."newFeatures",
          rn."adjustments",
          rn."recipientCount",
          rn."createdAt"
        FROM "ReleaseNote" rn
        ORDER BY rn."createdAt" DESC
      `);
        const releaseNotes = releaseNotesResult.rows;
        return res.json(releaseNotes.map((item) => ({
            ...item,
            featureCount: Array.isArray(item.newFeatures) ? item.newFeatures.length : 0,
            adjustmentCount: Array.isArray(item.adjustments) ? item.adjustments.length : 0,
        })));
    }
    catch (error) {
        console.error('Erro ao listar release notes:', error);
        return res.status(500).json({ error: 'Falha ao carregar atualizacoes.' });
    }
};
exports.listReleaseNotes = listReleaseNotes;
const getReleaseNoteDetail = async (req, res) => {
    const id = String(req.params?.id || '').trim();
    if (!id) {
        return res.status(400).json({ error: 'ID da atualizacao obrigatorio.' });
    }
    try {
        const releaseNoteResult = await (0, db_1.dbQuery)(`
        SELECT
          rn."id",
          rn."version",
          rn."title",
          rn."summary",
          rn."newFeatures",
          rn."adjustments",
          rn."recipientCount",
          rn."htmlContent",
          rn."createdAt"
        FROM "ReleaseNote" rn
        WHERE rn."id" = $1
        LIMIT 1
      `, [id]);
        const releaseNote = releaseNoteResult.rows[0] || null;
        if (!releaseNote) {
            return res.status(404).json({ error: 'Atualizacao nao encontrada.' });
        }
        return res.json({
            ...releaseNote,
            featureCount: Array.isArray(releaseNote.newFeatures)
                ? releaseNote.newFeatures.length
                : 0,
            adjustmentCount: Array.isArray(releaseNote.adjustments)
                ? releaseNote.adjustments.length
                : 0,
        });
    }
    catch (error) {
        console.error('Erro ao buscar detalhe do release note:', error);
        return res.status(500).json({ error: 'Falha ao carregar atualizacao.' });
    }
};
exports.getReleaseNoteDetail = getReleaseNoteDetail;
