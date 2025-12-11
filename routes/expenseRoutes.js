import { manualCommissionTrigger } from '../jobs/scheduledTasks.js';

/**
 * @route   POST /api/expenses/generate-commissions
 * @desc    Gera comissões manualmente (teste/emergência)
 * @access  Private (admin only)
 */
router.post('/generate-commissions', auth, authorize(['admin']), manualCommissionTrigger);