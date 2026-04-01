// Rota de teste temporária - criar agendamento para validação do fluxo V2
// ⚠️ REMOVER EM PRODUÇÃO

import express from 'express';
import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import Doctor from '../models/Doctor.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';

const router = express.Router();

// POST /api/test/seed-appointment
router.post('/seed-appointment', async (req, res) => {
    try {
        // Busca ou cria paciente de teste
        let patient = await Patient.findOne({ fullName: 'Paciente Teste V2' });
        
        if (!patient) {
            patient = await Patient.create({
                fullName: 'Paciente Teste V2',
                phone: '5511999999999',
                email: 'teste@v2.com'
            });
            console.log(`[TestSeed] Paciente criado: ${patient._id}`);
        }

        // Busca um doutor qualquer
        let doctor = await Doctor.findOne();
        if (!doctor) {
            doctor = await Doctor.create({
                name: 'Doutor Teste',
                specialty: 'fonoaudiologia',
                email: 'dr@teste.com'
            });
        }

        // Cria agendamento para HOJE (já passado, pode completar)
        const today = new Date();
        today.setHours(9, 0, 0, 0);

        const appointment = await Appointment.create({
            patient: patient._id,
            doctor: doctor._id,
            date: today,
            specialty: 'fonoaudiologia',
            operationalStatus: 'confirmed',
            clinicalStatus: 'confirmed',
            notes: 'Agendamento V2 - TESTE EVENT-DRIVEN'
        });

        console.log(`[TestSeed] Agendamento V2 criado: ${appointment._id}`);

        res.json({
            success: true,
            message: 'Agendamento V2 criado - pode completar via /api/v2/appointments/:id/complete',
            data: {
                appointmentId: appointment._id.toString(),
                patientId: patient._id.toString(),
                doctorId: doctor._id.toString(),
                date: today
            }
        });

    } catch (error) {
        console.error('[TestSeed] Erro:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// POST /api/test/complete-v2/:appointmentId
// Completa agendamento via V2 (event-driven)
router.post('/complete-v2/:appointmentId', async (req, res) => {
    try {
        const { appointmentId } = req.params;
        const { addToBalance = false } = req.body;

        console.log(`[TestV2] Iniciando complete V2: ${appointmentId}`);

        // Publica evento APPOINTMENT_COMPLETE_REQUESTED
        const result = await publishEvent(
            EventTypes.APPOINTMENT_COMPLETE_REQUESTED,
            {
                appointmentId: appointmentId.toString(),
                addToBalance,
                userId: 'test-system',
                requestedAt: new Date().toISOString()
            },
            {
                correlationId: `test_${Date.now()}`,
                aggregateType: 'appointment',
                aggregateId: appointmentId
            }
        );

        console.log(`[TestV2] Evento publicado: ${result.eventId}`, {
            queue: result.queue,
            jobId: result.jobId
        });

        res.status(202).json({
            success: true,
            message: 'Complete V2 iniciado (event-driven)',
            data: {
                eventId: result.eventId,
                jobId: result.jobId,
                queue: result.queue,
                checkStatusUrl: `/api/v2/appointments/status/${result.eventId}`
            }
        });

    } catch (error) {
        console.error('[TestV2] Erro:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

export default router;
