import express from 'express';
import { doctorOperations, getDoctorById, getDoctorPatients, getDoctorStats, getDoctorTherapySessions, getFutureAppointments, getTodaysAppointments } from '../controllers/doctorController.js';
import { auth } from '../middleware/auth.js';
import validateId from '../middleware/validateId.js';

const router = express.Router();

// Novas rotas para o dashboard médico - sempre tem qeu vir primeiro doq eu as demioas rotas senao quebra 
router.get('/patients', auth, getDoctorPatients);
router.get('/appointments/today', auth, getTodaysAppointments);
router.get('/therapy-sessions', auth, getDoctorTherapySessions);
router.get('/appointments/stats', auth, getDoctorStats);
router.get('/appointments/future', auth, getFutureAppointments);

// Rotas principais
router.post('/', auth, doctorOperations.create);
router.get('/', auth, doctorOperations.get.all);
router.get('/:id', auth, validateId, getDoctorById);
router.patch('/:id', auth, validateId, doctorOperations.update);
router.delete('/:id', auth, validateId, doctorOperations.delete);


export default router;
