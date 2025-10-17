import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import Doctor from '../models/Doctor.js';

export const checkAppointmentConflicts = async (req, res, next) => {
    const { doctorId, patientId, date, time } = req.body;
    const appointmentId = req.params.id;

    // Verificação mais robusta de campos obrigatórios
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
        // Verificação de conflitos para o médico - versão mais segura
        const doctorConflict = await Appointment.findOne({
            doctor: new mongoose.Types.ObjectId(doctorId),
            date,
            time,
            operationalStatus: { $ne: 'canceled' },
            _id: { $ne: appointmentId }
        }).lean();

        if (doctorConflict) {
            const conflictInfo = {
                appointmentId: doctorConflict._id,
                // Acesso seguro a fullName com fallback
                patientName: doctorConflict.patient?.fullName
                    || doctorConflict.patientId?.fullName
                    || 'Nome não disponível',
                existingAppointment: doctorConflict
            };

            return res.status(409).json({
                error: 'Conflito de agenda médica',
                message: 'O médico já possui um compromisso neste horário',
                conflict: conflictInfo,
                suggestion: 'Por favor, escolha outro horário ou médico'
            });
        }

        // Verificação de conflitos para o paciente - versão mais segura
        const patientConflict = await Appointment.findOne({
            patient: new mongoose.Types.ObjectId(patientId),
            date,
            time,
            operationalStatus: { $ne: 'canceled' },
            _id: { $ne: appointmentId }
        }).lean();

        if (patientConflict) {
            const conflictInfo = {
                appointmentId: patientConflict._id,
                // Acesso seguro a fullName com fallback
                doctorName: patientConflict.doctor?.fullName
                    || patientConflict.doctorId?.fullName
                    || 'Nome não disponível',
                existingAppointment: patientConflict
            };

            return res.status(409).json({
                error: 'Conflito de agenda do paciente',
                message: 'O paciente já possui um compromisso neste horário',
                conflict: conflictInfo,
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
        console.log(`\n[Buscando horários para médico ${doctorId} em ${date}]`);

        // 1. Validar a data de entrada
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: 'Formato de data inválido. Use YYYY-MM-DD' });
        }

        // 2. Buscar médico e disponibilidade
        const doctor = await Doctor.findById(doctorId).lean();
        if (!doctor) {
            return res.status(404).json({ error: 'Médico não encontrado' });
        }

        // 3. Obter disponibilidade do dia
        const dayOfWeek = new Date(`${date}T12:00:00Z`).getDay();
        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const dailyAvailability = doctor.weeklyAvailability.find(d => d.day === days[dayOfWeek]);

        if (!dailyAvailability?.times?.length) {
            return res.json([]);
        }

        // 4. Buscar agendamentos do dia (sem conversão de fuso)
        const appointments = await Appointment.find({
            doctor: doctorId,
            date: date, // comparação direta string
            operationalStatus: { $ne: 'canceled' }
        });

        // 5. Extrair horários ocupados
        const bookedTimes = appointments.map(app => app.time);

        // 6. Filtrar horários disponíveis
        const availableSlots = dailyAvailability.times.filter(time =>
            !bookedTimes.includes(time)
        );

        return res.json(availableSlots);

    } catch (error) {
        console.error('Erro detalhado:', {
            message: error.message,
            stack: error.stack,
            query: req.query
        });
        return res.status(500).json({ error: 'Erro ao buscar horários disponíveis' });
    }
};











