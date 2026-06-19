/**
 * ROTAS V2 - Appointments
 *
 * Delega para os handlers do appointment.js existente.
 * Adiciona endpoints V2-específicos:
 *   GET  /:id/status   → status async do agendamento
 *   POST /agenda/suggestions → sugestões de horário
 */
import express from 'express';
import mongoose from 'mongoose';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import Appointment from '../models/Appointment.js';

// Importa o router existente do appointment.js e re-exporta sua maioria
import legacyRouter from './appointment.js';

// Router V2 — começa com as rotas novas/específicas de V2
const router = express.Router();

// ── V2-ONLY: status polling para criação async ─────────────────────────────
router.get('/:id/status', flexibleAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, error: 'ID inválido' });
        }
        const appt = await Appointment.findById(id)
            .select('_id operationalStatus clinicalStatus paymentStatus date specialty patient')
            .lean();
        if (!appt) return res.status(404).json({ success: false, error: 'Agendamento não encontrado' });
        return res.json({ success: true, data: appt });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ── V2-ONLY: sugestões de agenda ───────────────────────────────────────────
router.post('/agenda/suggestions', flexibleAuth, async (req, res) => {
    try {
        const { specialty, doctorId, preferredDates, patientId } = req.body;
        // Busca slots disponíveis nos próximos 14 dias para a especialidade
        const now = new Date();
        const until = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

        const existingAppts = await Appointment.find({
            ...(doctorId ? { doctor: doctorId } : {}),
            ...(specialty ? { specialty } : {}),
            date: { $gte: now, $lte: until },
            operationalStatus: { $in: ['scheduled', 'confirmed'] }
        }).select('date time doctor specialty').lean();

        return res.json({
            success: true,
            data: {
                suggestions: [],
                occupied: existingAppts.length,
                note: 'Use GET /available-slots para slots detalhados'
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ── Delega todo o resto para o router legado ───────────────────────────────
// Isso inclui: POST /, GET /, GET /:id, PUT /:id, PATCH /:id/complete,
// PATCH /:id/cancel, PATCH /:id/confirm, DELETE /:id, etc.
router.use('/', legacyRouter);

export default router;
