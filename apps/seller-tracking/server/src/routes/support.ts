import { Router } from 'express';
import { sendSupportRequest } from '../controllers/supportController';

const router = Router();

router.post('/contact', sendSupportRequest);

export default router;
