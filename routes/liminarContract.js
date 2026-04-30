import express from 'express';
import {
  createLiminarContract,
  getLiminarContract,
  listLiminarContracts,
  rechargeContract,
  createTherapeuticPlan,
  listTherapeuticPlans,
  getActivePlan,
  generateSessions,
  getCommittedBalance,
  getContractSessions
} from '../controllers/liminarContractController.js';

const router = express.Router();

// Contratos
router.post('/',           createLiminarContract);
router.get('/',            listLiminarContracts);
router.get('/:id',         getLiminarContract);
router.patch('/:id/recharge', rechargeContract);
router.get('/:id/committed-balance', getCommittedBalance);
router.get('/:id/sessions', getContractSessions);

// Planos terapêuticos
router.post('/:id/plans',                          createTherapeuticPlan);
router.get('/:id/plans',                           listTherapeuticPlans);
router.get('/:id/plans/active',                    getActivePlan);
router.post('/:id/plans/:planId/generate-sessions', generateSessions);

export default router;
