import express from 'express';
import { doctorOperations, getAtendencePatient, getCalendarAppointments, 
    getDoctorById, getDoctorPatients, getDoctorStats, getDoctorTherapySessions,
     getFutureAppointments, getTodaysAppointments, getDoctorFinancialReport  } from '../controllers/doctorController.js';
import { auth } from '../middleware/auth.js';
import validateId from '../middleware/validateId.js';

const router = express.Router();

// Novas rotas para o dashboard médico - sempre tem qeu vir primeiro doq eu as demioas rotas senao quebra 
router.get('/patients', auth, getDoctorPatients);
router.get('/appointments/today', auth, getTodaysAppointments);
router.get('/therapy-sessions', auth, getDoctorTherapySessions);
router.get('/appointments/stats', auth, getDoctorStats);
router.get('/appointments/future', auth, getFutureAppointments);
router.get('/appointments/calendar/:id', auth, getCalendarAppointments);
router.get('/:id/attendance-summary', auth, getAtendencePatient);
router.get('/:doctorId/financial-report', auth, getDoctorFinancialReport);

// Rotas principais
router.post('/', auth, doctorOperations.create);
router.get('/', auth, doctorOperations.get.all);
router.get('/:id', auth, validateId, getDoctorById);
router.patch('/:id', auth, validateId, doctorOperations.update);
router.delete('/:id', auth, validateId, doctorOperations.delete);


export default router;
