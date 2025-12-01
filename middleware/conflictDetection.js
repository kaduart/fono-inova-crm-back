import mongoose from 'mongoose';
import { NON_BLOCKING_OPERATIONAL_STATUSES } from '../constants/appointmentStatus.js';
import Appointment from '../models/Appointment.js';
import Doctor from '../models/Doctor.js';

export const checkAppointmentConflicts = async (req, res, next) => {
    const { doctorId, patientId, date, time } = req.body;
    const appointmentId = req.params.id;

    if (!doctorId || !patientId || !date || !time) {
        return res.status(400).json({
            error: "Dados incompletos para verificação de conflitos",
            requiredFields: {
                doctorId: !doctorId ? "Campo obrigatório" : "OK",
                patientId: !patientId ? "Campo obrigatório" : "OK",
                date: !date ? "Campo obrigatório" : "OK",
                time: !time ? "Campo obrigatório" : "OK"
            }
        });
    }

    try {
        const doctorObjectId = new mongoose.Types.ObjectId(doctorId);
        const patientObjectId = new mongoose.Types.ObjectId(patientId);

        // 🔹 Conflito para o médico
        const doctorConflict = await Appointment.findOne({
            doctor: doctorObjectId,
            date,
            time,
            // 👇 mesma regra do índice & available-slots
            operationalStatus: { $nin: NON_BLOCKING_OPERATIONAL_STATUSES },
            ...(appointmentId && { _id: { $ne: appointmentId } }) // pra atualização
        }).populate('patient', 'fullName').lean();

        if (doctorConflict) {
            return res.status(409).json({
                error: 'Conflito de agenda médica',
                message: 'O médico já possui um compromisso neste horário',
                conflict: {
                    appointmentId: doctorConflict._id,
                    patientName: doctorConflict.patient?.fullName || 'Nome não disponível',
                    existingAppointment: doctorConflict
                },
                suggestion: 'Por favor, escolha outro horário ou médico'
            });
        }

        // 🔹 Conflito para o paciente
        const patientConflict = await Appointment.findOne({
            patient: patientObjectId,
            date,
            time,
            operationalStatus: { $nin: NON_BLOCKING_OPERATIONAL_STATUSES },
            ...(appointmentId && { _id: { $ne: appointmentId } })
        }).populate('doctor', 'fullName').lean();

        if (patientConflict) {
            return res.status(409).json({
                error: 'Conflito de agenda do paciente',
                message: 'O paciente já possui um compromisso neste horário',
                conflict: {
                    appointmentId: patientConflict._id,
                    doctorName: patientConflict.doctor?.fullName || 'Nome não disponível',
                    existingAppointment: patientConflict
                },
                suggestion: 'Por favor, escolha outro horário ou paciente'
            });
        }

        next();
    } catch (error) {
        console.error('Erro detalhado na verificação de conflitos:', {
            error: error.message,
            stack: error.stack,
            requestBody: req.body,
            params: req.params
        });

        res.status(500).json({
            error: 'Erro interno na verificação de conflitos',
            details: process.env.NODE_ENV === 'development' ? {
                message: error.message,
                stack: error.stack
            } : undefined
        });
    }
};

export const getAvailableTimeSlots = async (req, res) => {
    try {
        const { doctorId, date } = req.query;

        if (!doctorId || !date) {
            return res.status(400).json({ error: 'doctorId e date são obrigatórios' });
        }

        const doctor = await Doctor.findById(doctorId).lean();
        if (!doctor) {
            return res.status(404).json({ error: 'Médico não encontrado' });
        }

        // 🗓️ Dia da semana (forçando horário "meio-dia" em SP pra evitar bug de fuso)
        const dayOfWeek = new Date(`${date}T12:00:00-03:00`).getDay();
        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

        const dailyAvailability = doctor.weeklyAvailability
            ?.find(d => d.day === days[dayOfWeek]);

        if (!dailyAvailability?.times?.length) {
            return res.json([]); // nenhum horário cadastrado nesse dia
        }

        // 🧩 Buscar TODOS agendamentos não cancelados nesse dia/médico
        const appointments = await Appointment.find({
            doctor: doctorId,
            date,
            operationalStatus: { $nin: NON_BLOCKING_OPERATIONAL_STATUSES }
        }).select('time');

        // transforma em Set pra lookup O(1)
        const bookedTimes = new Set(appointments.map(a => a.time));

        // 🔹 Remove os horários ocupados
        const availableSlots = dailyAvailability.times.filter(
            (t) => !bookedTimes.has(t)
        );

        return res.json(availableSlots);
    } catch (err) {
        console.error('❌ Erro getAvailableTimeSlots:', err);
        res.status(500).json({ error: err.message });
    }
};












