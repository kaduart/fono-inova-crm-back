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

        const startTime = new Date(date);
        if (isNaN(startTime.getTime())) {
            return res.status(400).json({ error: "Data inválida" });
        }

        const SESSION_DURATION = SESSION_DURATION_MS;
        const endTime = new Date(startTime.getTime() + SESSION_DURATION);

        const startOfDay = new Date(startTime);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(startTime);
        endOfDay.setHours(23, 59, 59, 999);

        // Modificação 1: Ignorar agendamentos cancelados para médico
        const existingAppointments = await Appointment.find({
            doctorId,
            date: { $gte: startOfDay, $lt: endOfDay },
            status: { $ne: 'cancelado' }, // Ignora cancelados
            ...(appointmentId && { _id: { $ne: appointmentId } }) // Exclui o próprio agendamento
        });

        // Modificação 2: Verificação de conflito considerando apenas agendamentos ativos
        const hasDoctorConflict = existingAppointments.some(app => {
            const appStart = new Date(app.date);
            const appEnd = new Date(appStart.getTime() + SESSION_DURATION);
            return startTime < appEnd && endTime > appStart;
        });

        if (hasDoctorConflict) {
            return res.status(409).json({
                error: 'Conflito de horário',
                message: 'Médico já possui agendamento ativo neste horário'
            });
        }

        // Adicionar verificação de sessões de pacote
        if (req.packageData) {
            const packageAppointments = await Appointment.find({
                package: req.packageData._id,
                status: { $ne: 'cancelado' }
            });

            if (packageAppointments.length >= req.packageData.totalSessions) {
                return res.status(409).json({
                    error: 'Limite de sessões excedido',
                    message: 'Este pacote já foi totalmente utilizado'
                });
            }
        }
        // Modificação 3: Ignorar agendamentos cancelados para paciente
        const patientAppointments = await Appointment.find({
            patientId,
            date: { $gte: startOfDay, $lt: endOfDay },
            status: { $ne: 'cancelado' }, // Ignora cancelados
            ...(appointmentId && { _id: { $ne: appointmentId } }) // Exclui o próprio agendamento
        });

        // Modificação 4: Verificação de conflito para paciente
        const hasPatientConflict = patientAppointments.some(app => {
            const appStart = new Date(app.date);
            const appEnd = new Date(appStart.getTime() + SESSION_DURATION);
            return startTime < appEnd && endTime > appStart;
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

function parseBRTToUTCDate(dateStr, timeStr) {
    const [year, month, day] = dateStr.split('-').map(Number);
    const [hour, minute] = timeStr.split(':').map(Number);

    // Convertendo horário de Brasília para UTC
    return new Date(Date.UTC(year, month - 1, day, hour, minute));
}

// Remova este import se checkAppointmentConflicts não for mais usado aqui
// import { checkAppointmentConflicts } from '../middleware/conflictDetection.js'; 

export const getAvailableTimeSlots = async (req, res) => {
    try {
        const { doctorId, date } = req.query; // date é 'YYYY-MM-DD'

        if (!date || typeof date !== 'string') {
            return res.status(400).json({ message: 'O parâmetro "date" é obrigatório e deve ser uma string.' });
        }

        const parsedDate = new Date(date);
        if (isNaN(parsedDate.getTime())) { // Verifica se a data é inválida
            return res.status(400).json({ message: 'Formato de data inválido. Use YYYY-MM-DD.' });
        }

        // >>>>>>>>>>> REMOVA ESTA LINHA <<<<<<<<<<<
        // const availableSlots = await checkAppointmentConflicts(doctorId, date);

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
            date: { $gte: startOfDayUTC, $lte: endOfDayUTC },
            operationalStatus: { $ne: 'cancelado' } // Garante que agendamentos cancelados não bloqueiem
        }).lean();

        // 4. Filtra slots disponíveis (lógica de conflito)
        const availableSlotsFilteredUTC = potentialSlotsUTC.filter(potentialSlotUTC => {
            const slotStartTimeUTC = potentialSlotUTC.getTime();
            const slotEndTimeUTC = slotStartTimeUTC + SESSION_DURATION_MS;

            const hasConflict = existingAppointments.some(app => {
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










