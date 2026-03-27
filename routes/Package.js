import express from 'express';
import { generateReport, getPackageById, packageOperations, updateStatus, bulkCancelSessions } from '../controllers/therapyPackageController.js';
import { receiveSessionPayment, listPendingPayments } from '../controllers/packageSessionController.js';
import { auth } from '../middleware/auth.js';
import validateId from '../middleware/validateId.js';
import { validatePackageInput } from '../middleware/validatePackage.js';
import validateSession from '../middleware/validateSession.js';

const router = express.Router();

// Rotas Principais
router.post('/', validatePackageInput, auth, packageOperations.create);
router.get('/', auth, packageOperations.get.all);
router.get('/search', auth, packageOperations.get.search);
router.get('/:id', auth, getPackageById);
router.patch('/:id', auth, packageOperations.update.package);
router.delete('/:id', auth, packageOperations.delete.package);

// Rotas de Sessões - update sessio mesma coisa
//router.patch('/:id/use-session', auth, packageOperations.useSession);
router.patch('/:id/remove-session', auth, packageOperations.delete.session);
// update session
router.put('/:id/sessions/:sessionId',
    auth, validateId, validateSession, packageOperations.update.session);
router.post('/:id/add-session', auth, validateId, packageOperations.addSessionToPackage);

// Rotas de Pagamento
router.post('/:id/payments', auth, packageOperations.registerPayment);
router.patch('/:id/status', auth, updateStatus);

// 💰 Receber pagamento de sessão específica (modo per-session - paga no ato)
router.post('/sessions/:sessionId/pay', auth, receiveSessionPayment);

// 📋 Listar sessões pendentes de pagamento
router.get('/sessions/pending-payments', auth, listPendingPayments);

// Relatórios
router.get('/report/generate', auth, generateReport);

// 🔄 Cancelamento em massa de sessões
router.post('/:id/sessions/bulk-cancel', auth, validateId, bulkCancelSessions);

export default router;