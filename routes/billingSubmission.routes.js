import express from 'express';
import { auth, authorize } from '../middleware/auth.js';
import controller from '../controllers/billingSubmissionController.js';

const router = express.Router();
const canOperateBilling = authorize(['admin', 'secretary']);

router.get('/', auth, canOperateBilling, controller.list);
router.post('/', auth, canOperateBilling, controller.create);
router.get('/:id', auth, canOperateBilling, controller.getById);
router.patch('/:id', auth, canOperateBilling, controller.update);
router.post('/:id/finalize', auth, canOperateBilling, controller.finalize);
router.post('/:id/cancel', auth, canOperateBilling, controller.cancel);

export default router;
