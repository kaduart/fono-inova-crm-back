import { SESSION_DURATION_MS } from '../config/constants.js';
import Appointment from '../models/Appointment.js';
import Doctor from '../models/Doctor.js';

export const checkAppointmentConflicts = async (req, res, next) => {
    try {
        const { doctorId, patientId, date, time } = req.body;
        const appointmentId = req.body.metadata?.appointmentId || null;

        if (!doctorId || !patientId || !date || !time) {
            return res.status(400).json({ error: "Campos obrigatórios faltando" });
        }

        // Converter a data e hora recebidas (BRT) para UTC para consistência
        const requestStartUTC = parseBRTToUTCDate(date, time);
        const requestEndUTC = new Date(requestStartUTC.getTime() + SESSION_DURATION_MS);

        // Definir início e fim do dia em UTC para a query no MongoDB
        const startOfDayUTC = parseBRTToUTCDate(date, '00:00');
        const endOfDayUTC = parseBRTToUTCDate(date, '23:59');

        const existingDoctorAppointments = await Appointment.find({
            doctor: doctorId,
            date: { $gte: startOfDayUTC, $lt: endOfDayUTC },
            operationalStatus: { $ne: 'cancelado' },
            ...(appointmentId && { _id: { $ne: appointmentId } })
        }).lean();

        const hasDoctorConflict = existingDoctorAppointments.some(app => {
            const appStartUTC = new Date(app.date).getTime();
            const appEndUTC = appStartUTC + SESSION_DURATION_MS;
            return requestStartUTC.getTime() < appEndUTC && requestEndUTC.getTime() > appStartUTC;
        });

        if (hasDoctorConflict) {
            return res.status(409).json({
                error: 'Conflito de horário',
                message: 'Médico já possui agendamento ativo neste horário'
            });
        }

        if (req.packageData) {
            const packageAppointments = await Appointment.find({
                package: req.packageData._id,
                operationalStatus: { $ne: 'cancelado' }
            }).lean();

            if (packageAppointments.length >= req.packageData.totalSessions) {
                return res.status(409).json({
                    error: 'Limite de sessões excedido',
                    message: 'Este pacote já foi totalmente utilizado'
                });
            }
        }

        const existingPatientAppointments = await Appointment.find({
            patient: patientId,
            date: { $gte: startOfDayUTC, $lt: endOfDayUTC },
            operationalStatus: { $ne: 'cancelado' },
            ...(appointmentId && { _id: { $ne: appointmentId } })
        }).lean();

        const hasPatientConflict = existingPatientAppointments.some(app => {
            const appStartUTC = new Date(app.date).getTime();
            const appEndUTC = appStartUTC + SESSION_DURATION_MS;
            return requestStartUTC.getTime() < appEndUTC && requestEndUTC.getTime() > appStartUTC;
        });

        if (hasPatientConflict) {
            return res.status(409).json({
                error: 'Conflito de horário',
                message: 'Paciente já possui agendamento ativo neste horário'
            });
        }

        next();
    } catch (error) {
        console.error('Erro em checkAppointmentConflicts:', error);
        res.status(500).json({ error: 'Erro interno ao verificar conflitos' });
    }
};

export const getAvailableTimeSlots = async (req, res) => {
    try {
        const { doctorId, date } = req.query; // date é 'YYYY-MM-DD'

        if (!doctorId || !date) {
            return res.status(400).json({ error: 'Médico e data são obrigatórios' });
        }

        // 1. Buscar o médico para obter a disponibilidade semanal
        const doctor = await Doctor.findById(doctorId).lean();
        if (!doctor) {
            return res.status(404).json({ error: 'Médico não encontrado' });
        }

        const dateObjForDayOfWeek = new Date(date + 'T12:00:00Z'); // 'Z' para UTC puro, garantindo o dia correto
        const dayOfWeekIndex = dateObjForDayOfWeek.getDay(); // 0 = Domingo, 1 = Segunda, ..., 6 = Sábado

        const dayMap = {
            0: 'sunday',
            1: 'monday',
            2: 'tuesday',
            3: 'wednesday',
            4: 'thursday',
            5: 'friday',
            6: 'saturday',
        };
        const dayKey = dayMap[dayOfWeekIndex];

        // Encontrar a disponibilidade para o dia específico
        const dailyAvailability = doctor.weeklyAvailability.find(d => d.day === dayKey);

        if (!dailyAvailability || dailyAvailability.times.length === 0) {
            return res.json([]); // Não há slots disponíveis se a disponibilidade não estiver configurada
        }

        // 2. Gerar slots potenciais em UTC (com base nos horários BRT do médico)
        const potentialSlotsUTC = dailyAvailability.times.map(timeStr => {
            return parseBRTToUTCDate(date, timeStr);
        });

        potentialSlotsUTC.sort((a, b) => a.getTime() - b.getTime()); // Garante a ordem cronológica

        const startOfDayUTC = parseBRTToUTCDate(date, '00:00');
        const endOfDayUTC = parseBRTToUTCDate(date, '23:59');

        const existingAppointments = await Appointment.find({
            doctor: doctorId,
            date: { $gte: startOfDayUTC, $lte: endOfDayUTC }
        }).lean();

        // 4. Filtra slots disponíveis (lógica de conflito)
        const availableSlotsFilteredUTC = potentialSlotsUTC.filter(potentialSlotUTC => {
            const slotStartTimeUTC = potentialSlotUTC.getTime();
            const slotEndTimeUTC = slotStartTimeUTC + SESSION_DURATION_MS;

            const hasConflict = existingAppointments.some(app => {
                // Ignora agendamentos cancelados, pois eles não bloqueiam o horário
                if (app.operationalStatus === 'cancelado') return false;

                const appStartTimeUTC = new Date(app.date).getTime();
                const appEndTimeUTC = appStartTimeUTC + SESSION_DURATION_MS;

                // Verifica sobreposição: (Start1 < End2 AND End1 > Start2)
                return slotStartTimeUTC < appEndTimeUTC && slotEndTimeUTC > appStartTimeUTC;
            });

            return !hasConflict;
        });

        // 5. Formata os horários de volta para "HH:MM" (que já estão em formato BRT no objeto Date UTC)
        const formattedSlotsBRT = availableSlotsFilteredUTC.map(slotUTC => {
            const hours = slotUTC.getUTCHours();
            const minutes = slotUTC.getUTCMinutes();
            return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
        });

        return res.json(formattedSlotsBRT);
    } catch (error) {
        console.error('Erro ao obter horários disponíveis:', error);
        return res.status(500).json({ error: error.message });
    }
};

function parseBRTToUTCDate(dateStr, timeStr) {
    const [year, month, day] = dateStr.split('-').map(Number);
    const [hour, minute] = timeStr.split(':').map(Number);

    // Convertendo horário de Brasília para UTC
    return new Date(Date.UTC(year, month - 1, day, hour, minute));
}










