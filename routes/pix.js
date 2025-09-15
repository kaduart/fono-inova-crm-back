import { Router } from 'express';
import { getReceived, handlePixWebhook } from '../controllers/sicoobController.js';

const router = Router();
/* 
router.post('/create/:appointmentId', createPix);
 */
router.post('/webhook', handlePixWebhook);
router.get('/received', getReceived);

export default router;
