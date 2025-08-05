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
            date,
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
            date,
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
            operationalStatus: { $ne: 'cancelado' }
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











