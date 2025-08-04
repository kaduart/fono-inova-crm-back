import { SESSION_DURATION_MS } from '../config/constants.js';
import Appointment from '../models/Appointment.js';
import Doctor from '../models/Doctor.js';
import { DateTime } from 'luxon';

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

    return new Date(Date.UTC(year, month - 1, day, hour, minute));
}

export const getAvailableTimeSlots = async (req, res) => {
    try {
      const { doctorId, date } = req.query;

    if (!date || typeof date !== 'string') {
      return res.status(400).json({ message: 'O parâmetro "date" é obrigatório e deve ser uma string.' });
    }

    const doctor = await Doctor.findById(doctorId).lean();
    if (!doctor) {
      return res.status(404).json({ error: 'Médico não encontrado' });
    }

    const dayOfWeekIndex = DateTime.fromISO(date).weekday; // 1 = Monday ... 7 = Sunday
    const dayMap = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayKey = dayMap[dayOfWeekIndex % 7]; // Luxon: segunda = 1

    const dailyAvailability = doctor.weeklyAvailability.find(d => d.day === dayKey);

    if (!dailyAvailability || dailyAvailability.times.length === 0) {
      return res.json([]);
    }

    // 👉 Gera slots em BRT
    const potentialSlots = dailyAvailability.times.map(timeStr => {
      return DateTime.fromISO(`${date}T${timeStr}`, {
        zone: 'America/Sao_Paulo'
      }).toJSDate();
    });

    potentialSlots.sort((a, b) => a.getTime() - b.getTime());

    // Busca agendamentos no mesmo dia
    const startOfDay = DateTime.fromISO(date, { zone: 'America/Sao_Paulo' }).startOf('day').toJSDate();
    const endOfDay = DateTime.fromISO(date, { zone: 'America/Sao_Paulo' }).endOf('day').toJSDate();

    const existingAppointments = await Appointment.find({
      doctor: doctorId,
      date: { $gte: startOfDay, $lte: endOfDay },
      operationalStatus: { $ne: 'cancelado' }
    }).lean();

    const availableSlots = potentialSlots.filter(slot => {
      const slotStart = slot.getTime();
      const slotEnd = slotStart + SESSION_DURATION_MS;

      const hasConflict = existingAppointments.some(app => {
        const appStart = new Date(app.date).getTime();
        const appEnd = appStart + SESSION_DURATION_MS;

        return slotStart < appEnd && slotEnd > appStart;
      });

      return !hasConflict;
    });

    const formattedSlots = availableSlots.map(slot => {
      const time = DateTime.fromJSDate(slot, { zone: 'America/Sao_Paulo' }).toFormat('HH:mm');
      return time;
    });

    return res.json(formattedSlots);
    } catch (error) {
        console.error('Erro ao obter horários disponíveis:', error);
        return res.status(500).json({ error: error.message });
    }
};










