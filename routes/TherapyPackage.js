/* import express from 'express';
import { generateReport, packageOperations, updateStatus } from '../controllers/therapyPackageController.js';

const router = express.Router();

// Rotas CRUD para TherapyPackage
router.post('/', packageOperations.create);       // Criar pacote
router.get('/', packageOperations.get.all);        // Listar todos os pacotes
router.get('/:id', packageOperations.get.byId);    // Obter pacote por ID
router.put('/:id', packageOperations.update.package); // Atualizar pacote
router.delete('/:id', packageOperations.delete.package); // Deletar pacote

// Rotas para sessões e pagamentos
router.post('/:id/sessions', packageOperations.addSession);              // Adicionar sessão
router.post('/:id/payments', packageOperations.registerPayment); // Registrar pagamento

// Atualizar status
router.patch('/:id/status', updateStatus);          // Atualizar status do pacote

// Relatório financeiro
router.get('/reports/financial', generateReport);   // Gerar relatório financeiro

export default router;
 */