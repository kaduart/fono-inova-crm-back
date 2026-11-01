import express from 'express';
import {
    doctorOperations, getAtendencePatient, getCalendarAppointments,
    getDoctorById, getDoctorPatients, getDoctorStats, getDoctorTherapySessions,
    getFutureAppointments, getTodaysAppointments
} from '../controllers/doctorController.js';
import { auth } from '../middleware/auth.js';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import validateId from '../middleware/validateId.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';
import { requireStaff } from '../middleware/requireRole.js';

const router = express.Router();

// Terapeuta só acessa dados do próprio :id; staff acessa qualquer profissional.
const selfOrStaff = (req, res, next) => {
  if (req.user?.role !== 'doctor' || String(req.params.id) === String(req.user.id)) return next();
  console.warn('[ROLE_DENIED] doctor acessando outro profissional', req.method, req.originalUrl);
  return sendApiError(res, new AppError('FORBIDDEN', 'Você só pode ver os seus próprios dados', { status: 403 }), req);
};

// Novas rotas para o dashboard médico - sempre tem qeu vir primeiro doq eu as demioas rotas senao quebra 
router.get('/patients', flexibleAuth, getDoctorPatients);
router.get('/appointments/today', auth, getTodaysAppointments);
router.get('/therapy-sessions', auth, getDoctorTherapySessions);
router.get('/appointments/stats', auth, getDoctorStats);
router.get('/appointments/future', auth, getFutureAppointments);
router.get('/appointments/calendar/:id', auth, selfOrStaff, getCalendarAppointments);
router.get('/:id/attendance-summary', auth, selfOrStaff, getAtendencePatient);

// Rotas de ativação/inativação (soft delete) - VEM ANTES das rotas com :id
router.get('/active/list', flexibleAuth, doctorOperations.getActive);
router.get('/inactive/list', flexibleAuth, doctorOperations.getInactive);
router.patch('/:id/deactivate', auth, requireStaff, validateId, doctorOperations.deactivate);
router.patch('/:id/reactivate', auth, requireStaff, validateId, doctorOperations.reactivate);

// TEMP: Rota para listar todos os médicos (ativos e inativos) - para debug
router.get('/debug/all', auth, requireStaff, async (req, res) => {
  try {
    const Doctor = (await import('../models/Doctor.js')).default;
    const doctors = await Doctor.find().select('_id fullName email active specialty').lean();
    res.json({ 
      success: true, 
      count: doctors.length,
      doctors: doctors.map(d => ({
        id: d._id,
        name: d.fullName,
        email: d.email,
        active: d.active,
        specialty: d.specialty
      }))
    });
  } catch (error) {
    sendApiError(res, error, req);
  }
});

// Rotas principais
router.post('/', auth, requireStaff, doctorOperations.create);
router.get('/', flexibleAuth, doctorOperations.get.all);
router.get('/:id', auth, validateId, selfOrStaff, getDoctorById);
router.patch('/:id', auth, validateId, selfOrStaff, doctorOperations.update);
router.delete('/:id', auth, requireStaff, validateId, doctorOperations.delete);


export default router;
