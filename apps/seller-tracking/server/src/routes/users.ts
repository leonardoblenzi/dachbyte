import { Router } from 'express';
import {
  changeCurrentUserPassword,
  completeAccessPassword,
  createSessionFromSuite,
  createUser,
  deleteUser,
  getCurrentUserProfile,
  getAccessLinkDetails,
  getUsers,
  login,
  requestPasswordReset,
  switchUserCompany,
  updateCurrentUserProfile,
  updateUser,
} from '../controllers/userController';
import { authenticateToken } from '../middleware/auth';

const router = Router();

// Rotas publicas
router.post('/login', login);
router.post('/session', createSessionFromSuite);
router.post('/forgot-password', requestPasswordReset);
router.get('/access-link/:token', getAccessLinkDetails);
router.post('/access-link/complete', completeAccessPassword);

// Rotas protegidas
router.get('/', authenticateToken, getUsers);
router.get('/me', authenticateToken, getCurrentUserProfile);
router.put('/me/profile', authenticateToken, updateCurrentUserProfile);
router.post('/me/password', authenticateToken, changeCurrentUserPassword);
router.post('/', authenticateToken, createUser);
router.put('/:id', authenticateToken, updateUser);
router.delete('/:id', authenticateToken, deleteUser);
router.post('/switch-company', authenticateToken, switchUserCompany);

export default router;
