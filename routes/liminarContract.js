import express from 'express';
import { auth } from '../middleware/auth.js';
import { requireStaff } from '../middleware/requireRole.js';
import {
  createLiminarContract,
  getLiminarContract,
  listLiminarContracts,
  rechargeContract,
  createTherapeuticPlan,
  listTherapeuticPlans,
  getActivePlan,
  generateSessions,
  addHistoricalCancellations,
  getCommittedBalance,
  getContractSessions,
  updateTherapy,
  getContractIntegrity,
  inactivateContract,
  moveAppointmentSpecialty,
} from '../controllers/liminarContractController.js';

const router = express.Router();

// Toda a API de liminar exige login; mutações só admin/secretária.
router.use(auth);

// Contratos
router.post('/', requireStaff,           createLiminarContract);
router.get('/',            listLiminarContracts);
router.get('/:id',         getLiminarContract);
router.patch('/:id/recharge', requireStaff, rechargeContract);
router.get('/:id/committed-balance', getCommittedBalance);
router.get('/:id/sessions',   getContractSessions);
router.get('/:id/integrity',  getContractIntegrity);
router.patch('/:id/appointments/:appointmentId/specialty', requireStaff, moveAppointmentSpecialty);
router.post('/:id/inactivate', requireStaff, inactivateContract);

// Planos terapêuticos
router.post('/:id/plans',  requireStaff,                         createTherapeuticPlan);
router.get('/:id/plans',                           listTherapeuticPlans);
router.get('/:id/plans/active',                    getActivePlan);
router.post('/:id/plans/:planId/generate-sessions', requireStaff, generateSessions);
router.post('/:id/plans/:planId/historical-cancellations', requireStaff, addHistoricalCancellations);
router.patch('/:id/plans/:planId/therapies/:specialty', requireStaff, updateTherapy);

export default router;
