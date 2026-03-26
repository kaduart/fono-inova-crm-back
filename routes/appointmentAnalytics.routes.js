import express from 'express';
import { auth } from '../middleware/auth.js';
import { 
    getAppointmentsByType, 
    getConversionTimeline 
} from '../controllers/appointmentAnalyticsController.js';

const router = express.Router();

/**
 * 📊 GET /api/analytics/appointments/by-type
 * 
 * Retorna agendamentos do dia separados em:
 * - novos: primeiro agendamento do paciente (lead que virou paciente)
 * - recorrentes: paciente já tinha agendamentos anteriores
 * 
 * Query params:
 * - ?date=2026-03-26 (padrão: hoje)
 * - ?startDate=2026-03-01&endDate=2026-03-31 (período)
 * - ?doctorId=xxx (filtrar por médico)
 */
router.get('/appointments/by-type', auth, getAppointmentsByType);

/**
 * 📈 GET /api/analytics/appointments/conversion-timeline
 * 
 * Timeline de quando leads viraram pacientes (primeiro agendamento)
 * Útil pra ver efetividade de campanhas de marketing
 * 
 * Query params:
 * - ?days=30 (padrão: últimos 30 dias)
 */
router.get('/appointments/conversion-timeline', auth, getConversionTimeline);

export default router;
