import express from 'express';
import { auth } from '../middleware/auth.js';
import Appointment from '../models/Appointment.js';

const router = express.Router();

/**
 * 📊 GET /daily-closing-simple
 * 
 * Versão simplificada do daily-closing com separação novos vs recorrentes
 * Usa o campo isFirstAppointment (calculado na criação)
 */
router.get('/', auth, async (req, res) => {
    try {
        const { date, doctorId } = req.query;
        
        // Data alvo
        const targetDate = date ? new Date(date) : new Date();
        targetDate.setHours(0, 0, 0, 0);
        const nextDay = new Date(targetDate);
        nextDay.setDate(nextDay.getDate() + 1);

        // Filtro base
        const filter = {
            createdAt: {
                $gte: targetDate,
                $lt: nextDay
            }
        };
        
        if (doctorId) filter.doctor = doctorId;

        // 🚀 Query simples usando o campo pre-calculado
        const appointments = await Appointment.find(filter)
            .populate('patient', 'name phone')
            .populate('doctor', 'fullName')
            .lean();

        // Separa usando o campo isFirstAppointment
        const novos = appointments.filter(a => a.isFirstAppointment === true);
        const recorrentes = appointments.filter(a => a.isFirstAppointment === false);

        res.json({
            success: true,
            date: targetDate.toISOString().split('T')[0],
            summary: {
                total: appointments.length,
                novos: {
                    count: novos.length,
                    percentage: appointments.length > 0 
                        ? Math.round((novos.length / appointments.length) * 100) 
                        : 0
                },
                recorrentes: {
                    count: recorrentes.length,
                    percentage: appointments.length > 0 
                        ? Math.round((recorrentes.length / appointments.length) * 100) 
                        : 0
                }
            },
            details: {
                novos: novos.map(a => ({
                    _id: a._id,
                    patient: a.patient?.name,
                    time: a.time,
                    specialty: a.specialty,
                    doctor: a.doctor?.fullName
                })),
                recorrentes: recorrentes.map(a => ({
                    _id: a._id,
                    patient: a.patient?.name,
                    time: a.time,
                    specialty: a.specialty,
                    doctor: a.doctor?.fullName
                }))
            }
        });

    } catch (error) {
        console.error('❌ Erro em daily-closing-simple:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar dados',
            error: error.message
        });
    }
});

export default router;
