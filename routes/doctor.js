import express from 'express';
import { doctorOperations, getDoctorById, getDoctorPatients, getDoctorStats, getDoctorTherapySessions, getFutureAppointments, getTodaysAppointments } from '../controllers/doctorController.js';
import { adminOrSecretary, auth } from '../middleware/auth.js';
import validateId from '../middleware/validateId.js';

const router = express.Router();

// Novas rotas para o dashboard médico
router.get('/patients', auth, getDoctorPatients);
router.get('/appointments/today', auth, getTodaysAppointments);
router.get('/therapy-sessions', auth, getDoctorTherapySessions);
router.get('/appointments/stats', auth, getDoctorStats);
router.get('/appointments/future', auth, getFutureAppointments);
// Rotas principais
router.post('/', auth, adminOrSecretary, doctorOperations.create);
router.get('/', auth, adminOrSecretary, doctorOperations.get.all);
router.get('/:id', auth, validateId, getDoctorById);
router.patch('/:id', auth, adminOrSecretary, validateId, doctorOperations.update);
router.delete('/:id', auth, adminOrSecretary, validateId, doctorOperations.delete);

export default router;
