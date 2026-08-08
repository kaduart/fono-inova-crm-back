import express from 'express';
import { auth, authorize } from '../middleware/auth.js';
import controller from '../controllers/insuranceBatchReceiptController.js';

const router = express.Router();
const canOperateBilling = authorize(['admin', 'secretary']);

router.get('/receivables', auth, canOperateBilling, controller.list);
router.post('/:id/receive', auth, canOperateBilling, controller.receive);

export default router;
