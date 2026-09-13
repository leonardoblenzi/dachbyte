import { Router } from 'express';
import {
  addMonitoredOrders,
  getNotificationFeed,
  listMonitoredOrders,
  markAllNotificationsAsRead,
  removeMonitoredOrder,
} from '../controllers/notificationController';

const router = Router();

router.get('/feed', getNotificationFeed);
router.post('/mark-all-read', markAllNotificationsAsRead);
router.get('/monitored-orders', listMonitoredOrders);
router.post('/monitored-orders', addMonitoredOrders);
router.delete('/monitored-orders/:orderId', removeMonitoredOrder);

export default router;
