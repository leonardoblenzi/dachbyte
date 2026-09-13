"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const releaseNotesController_1 = require("../controllers/releaseNotesController");
const router = (0, express_1.Router)();
router.get('/', releaseNotesController_1.listReleaseNotes);
router.get('/:id', releaseNotesController_1.getReleaseNoteDetail);
router.post('/send', releaseNotesController_1.sendReleaseNotes);
exports.default = router;
