import express from 'express';
import { authController } from '../controllers/authController.js';

const router = express.Router();


router.post('/forgot-password', authController.forgotPassword);
router.get('/verify-reset-token/:token', authController.verifyResetToken);
router.patch('/reset-password/:token', authController.resetPassword);


export default router;
