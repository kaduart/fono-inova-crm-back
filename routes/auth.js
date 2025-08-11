import express from 'express';
import { authController } from '../controllers/authController.js';

const router = express.Router();

// Rota pública - solicitar reset
router.post('/forgot-password', authController.forgotPassword);

// Rota pública - definir nova senha
router.patch('/reset-password/:token', authController.resetPassword);

export default router;