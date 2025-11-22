import express from 'express';
import {
    getAllProtocols,
    getProtocolByCode,
    createProtocol,
    updateProtocol,
    deactivateProtocol,
    getProtocolAnalytics,
    getProtocolEffectiveness
} from '../controllers/protocolController.js';
import { auth, authorize } from '../middleware/auth.js';

const router = express.Router();
router.use(auth);

// Todos podem ver protocolos
router.get('/', getAllProtocols);
router.get('/:code', getProtocolByCode);

// Apenas admin e doctor podem gerenciar
router.post('/', authorize(['admin', 'doctor']), createProtocol);
router.put('/:code', authorize(['admin', 'doctor']), updateProtocol);
router.delete('/:code', authorize(['admin']), deactivateProtocol);

// Analytics (admin e doctor)
router.get('/analytics/usage', authorize(['admin', 'doctor']), getProtocolAnalytics);
router.get('/analytics/effectiveness', authorize(['admin', 'doctor']), getProtocolEffectiveness);

export default router;