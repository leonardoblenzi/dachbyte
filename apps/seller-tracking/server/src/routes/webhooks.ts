import { Router } from 'express';
import { authenticateToken } from '../middleware/auth';
import {
  acknowledgeMonitoringFailureAlert,
  listAnymarketWebhookLogs,
  listMonitoringFailureAcks,
  receiveAnymarketWebhook,
  listIntelipostWebhookLogs,
  receiveIntelipostWebhook,
  clearWebhookFailureLogs,
  reprocessWebhookFailureLogs,
} from '../controllers/webhookController';

const router = Router();

router.post('/intelipost', receiveIntelipostWebhook);
router.post('/anymarket', receiveAnymarketWebhook);
router.get('/monitoring/failure-acks', authenticateToken, listMonitoringFailureAcks);
router.post('/monitoring/failure-acks', authenticateToken, acknowledgeMonitoringFailureAlert);
router.get('/anymarket/logs', authenticateToken, listAnymarketWebhookLogs);
router.get('/intelipost/logs', authenticateToken, listIntelipostWebhookLogs);
router.post('/:provider/failures/reprocess', authenticateToken, reprocessWebhookFailureLogs);
router.delete('/:provider/failures', authenticateToken, clearWebhookFailureLogs);

export default router;
