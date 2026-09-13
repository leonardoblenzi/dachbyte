"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const userController_1 = require("../controllers/userController");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// Rotas publicas
router.post('/login', userController_1.login);
router.post('/session', userController_1.createSessionFromSuite);
router.post('/forgot-password', userController_1.requestPasswordReset);
router.get('/access-link/:token', userController_1.getAccessLinkDetails);
router.post('/access-link/complete', userController_1.completeAccessPassword);
// Rotas protegidas
router.get('/', auth_1.authenticateToken, userController_1.getUsers);
router.get('/me', auth_1.authenticateToken, userController_1.getCurrentUserProfile);
router.put('/me/profile', auth_1.authenticateToken, userController_1.updateCurrentUserProfile);
router.post('/me/password', auth_1.authenticateToken, userController_1.changeCurrentUserPassword);
router.post('/', auth_1.authenticateToken, userController_1.createUser);
router.put('/:id', auth_1.authenticateToken, userController_1.updateUser);
router.delete('/:id', auth_1.authenticateToken, userController_1.deleteUser);
router.post('/switch-company', auth_1.authenticateToken, userController_1.switchUserCompany);
exports.default = router;
