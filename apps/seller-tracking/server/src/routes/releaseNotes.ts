import { Router } from 'express';
import {
  getReleaseNoteDetail,
  listReleaseNotes,
  sendReleaseNotes,
} from '../controllers/releaseNotesController';

const router = Router();

router.get('/', listReleaseNotes);
router.get('/:id', getReleaseNoteDetail);
router.post('/send', sendReleaseNotes);

export default router;
