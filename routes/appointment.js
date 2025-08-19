import dotenv from 'dotenv';
import express from 'express';
import mongoose from 'mongoose';
import { auth } from '../middleware/auth.js';
import { checkPackageAvailability } from '../middleware/checkPackageAvailability.js';
import { checkAppointmentConflicts, getAvailableTimeSlots } from '../middleware/conflictDetection.js';
import validateId from '../middleware/validateId.js';
import { validateIndividualPayment } from '../middleware/validateIndividualPayment.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';
import Patient from '../models/Patient.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import { handlePackageSessionUpdate, syncEvent } from '../services/syncService.js';
import { updatePatientAppointments } from '../utils/appointmentUpdater.js';

const ObjectId = mongoose.Types.ObjectId;

class ValidationError extends Error {
    constructor(message, errors) {
        super(message);
        this.name = 'ValidationError';
        this.errors = errors;
    }
}

dotenv.config();
const router = express.Router();

// Verifica horários disponíveis
router.get('/available-slots', auth, getAvailableTimeSlots);


// Cria um novo agendamento
router.post('/', auth, checkPackageAvailability, validateIndividualPayment, checkAppointmentConflicts, async (req, res) => {
    const mongoSession = await mongoose.startSession();
    await mongoSession.startTransaction();

    try {
        const doctorId = req.body.doctorId || req.user.id;

        // Verificação de permissões
        if (req.user.role === 'patient') {
            await mongoSession.abortTransaction();
            return res.status(403).json({ error: 'Acesso negado' });
        }

        // Buscar paciente
        const patient = await Patient.findById(req.body.patientId).session(mongoSession);
        if (!patient) {
            await mongoSession.abortTransaction();
            return res.status(404).json({ error: 'Paciente não encontrado' });
        }

        // Verificar permissões do médico
        if (req.user.role === 'doctor' && patient.doctor && patient.doctor.toString() !== req.user.id) {
            await mongoSession.abortTransaction();
            return res.status(403).json({ error: 'Paciente não pertence ao seu consultório' });
        }

        // Se o paciente não tem médico, atribui o médico atual
        if (!patient.doctor) {
            patient.doctor = doctorId;
            await patient.save({ session: mongoSession });
        }

        // Verifica se já existe agendamento
        const existingAppointment = await Appointment.findOne({
            patient: patient._id,
            doctor: doctorId,
            date: new Date(req.body.date),
            time: req.body.time
        });

        if (existingAppointment) {
            return res.status(409).json({
                code: 'DUPLICATE_APPOINTMENT',
                message: 'Já existe um agendamento para este paciente/médico na data e hora selecionadas',
                existingAppointment
            });
        }

        let selectedPackage = null;
        // Verificar pacote APENAS se for serviço do tipo pacote
        if (req.body.serviceType === 'package') {
            selectedPackage = await Package.findById(req.body.packageId).session(mongoSession);

            // Bloqueia agendamento se não houver sessões disponíveis
            if (!selectedPackage || selectedPackage.remainingSessions <= 0) {
                await mongoSession.abortTransaction();
                return res.status(400).json({ error: 'Pacote sem sessões disponíveis' });
            }
        }

        const specialtyValue = req.body.specialty || patient.specialty;
        const validSpecialties = ['fonoaudiologia', 'psicologia', 'terapia_ocupacional', 'psicopedagogia'];

        if (!validSpecialties.includes(specialtyValue)) {
            // IMPORTANTE: Abortar transação ANTES de responder
            await mongoSession.abortTransaction();
            return res.status(400).json({
                error: 'Especialidade inválida',
                validSpecialties
            });
        }

        // Criar agendamento principal
        const appointmentData = {
            date: req.body.date,
            time: req.body.time,
            sessionType: req.body.sessionType,
            sessionValue: req.body.paymentAmount,
            notes: req.body.notes,
            specialty: specialtyValue,
            doctor: doctorId,
            patient: patient._id,
            operationalStatus: 'agendado',
            clinicalStatus: 'pendente',
            serviceType: req.body.serviceType,
            paymentAmount: req.body.paymentAmount,
            paymentMethod: req.body.paymentMethod,
        };
        const appointment = new Appointment(appointmentData);
        await appointment.save({ session: mongoSession });

        let payment = null;
        let session = null;
        const allAppointments = [appointment._id];

        // Criar pagamento APENAS para sessões individuais
        if (req.body.serviceType === 'individual_session' || req.body.serviceType === 'evaluation') {
            payment = new Payment({
                amount: req.body.paymentAmount,
                method: req.body.paymentMethod,
                status: 'pending',
                patient: patient._id,
                doctor: doctorId,
                serviceType: req.body.serviceType,
                appointment: appointment._id,
                paymentMethod: req.body.paymentMethod,
            });

            await payment.save({ session: mongoSession });

            appointment.payment = payment._id;
            appointment.paymentStatus = 'pending';
            await appointment.save({ session: mongoSession });

            const newSession = await Session.create([{
                serviceType: req.body.serviceType,
                patient: patient._id,
                doctor: doctorId,
                appointment: appointment._id,
                payment: payment._id,
                sessionType: req.body.sessionType,
                date: req.body.date,
                time: req.body.time,
                notes: req.body.notes,
                status: 'scheduled',
                isPaid: true,
                paymentMethod: req.body.paymentMethod,
                sessionValue: req.body.paymentAmount
            }], { session: mongoSession });

            payment.session = newSession[0]._id;
            appointment.payment = payment._id;
            appointment.session = newSession[0]._id;
            appointment.paymentStatus = req.body.paymentMethod === 'pending' ? 'pending' : 'paid';

            await payment.save({ session: mongoSession });
        }

        // Atualizar pacote se for serviço de pacote
        else if (req.body.serviceType === 'package_session') {
            if (appointment.package && appointment.package.remainingSessions > 0) {
                selectedPackage.remainingSessions -= 1;
                selectedPackage.sessions.push(appointment._id);
                await selectedPackage.save({ session: mongoSession });
                appointment.package = selectedPackage._id;
                appointment.paymentStatus = 'package_paid';
            }

        }

        await appointment.save({ session: mongoSession });



        // ATUALIZAÇÃO DO PACIENTE DE FORMA SEGURA
        await Patient.findByIdAndUpdate(
            patient._id,
            { $push: { appointments: appointment._id } },
            { session: mongoSession }
        );
        await patient.save({ session: mongoSession });
        await mongoSession.commitTransaction();


        try {
            await updatePatientAppointments(patient._id);
            await syncEvent(appointment, 'appointment');
            if (payment) await syncEvent(payment, 'payment');
            if (session) await syncEvent(session, 'session');
        } catch (syncError) {
            console.error('Erro em operações pós-transação:', syncError);
        }


        res.status(201).json({
            appointment,
            paymentId: payment?._id,
            sessionId: session?._id,
            packageRemainingSessions: selectedPackage?.remainingSessions
        });

    } catch (error) {
        console.error('Erro completo:', error);
        await mongoSession.abortTransaction();
        // 🔴 TRATAMENTO DE AGENDAMENTO DUPLICADO
        if (error.code === 11000 && error.keyPattern?.patient && error.keyPattern?.doctor && error.keyPattern?.date && error.keyPattern?.time) {
            return res.status(409).json({
                error: 'Já existe um agendamento para este paciente, médico, data e hora.'
            });
        }

        if (error.name === 'ValidationError') {
            const errors = Object.keys(error.errors).reduce((acc, key) => {
                acc[key] = error.errors[key].message;
                return acc;
            }, {});
            return res.status(400).json({ message: 'Falha na validação dos dados', errors });
        }

        return res.status(500).json({
            error: 'Erro interno',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        await mongoSession.endSession();
    }
});
// Busca agendamentos com filtros
router.get('/', auth, async (req, res) => {
    try {
        const { patientId, doctorId, status, specialty, startDate, endDate } = req.query;
        const filter = {};

        // Filtros por paciente e médico
        if (patientId && patientId !== 'all' && mongoose.Types.ObjectId.isValid(patientId)) {
            filter.patient = new mongoose.Types.ObjectId(patientId);
        }
        if (doctorId && doctorId !== 'all' && mongoose.Types.ObjectId.isValid(doctorId)) {
            filter.doctor = new mongoose.Types.ObjectId(doctorId);
        }

        if (status && status !== 'all') filter.status = status;
        if (specialty && specialty !== 'all') filter.specialty = specialty;

        // Filtro por período
        if (startDate && endDate) {
            filter.date = {
                $gte: new Date(startDate),
                $lte: new Date(endDate)
            };
        }

        // Buscar agendamentos
        const appointments = await Appointment.find(filter)
            .populate({ path: 'doctor', select: 'fullName specialty' })
            .populate({ path: 'patient', select: 'fullName dateOfBirth gender phone email address cpf rg' })
            .sort({ date: 1 })
            .lean();

        // Mapear para FullCalendar
        const calendarEvents = appointments
            .filter(appt => appt.patient) // ignorar agendamentos sem paciente
            .map(appt => {
                const [hours, minutes] = appt.time.split(':').map(Number);
                const start = new Date(appt.date);
                start.setHours(hours, minutes);
                const end = new Date(start.getTime() + (appt.duration || 40) * 60000);

                return {
                    id: appt._id.toString(),
                    title: `${appt.reason || 'Consulta'} - ${appt.doctor?.fullName || 'Profissional'}`,
                    start: start.toISOString(),
                    end: end.toISOString(),
                    date: appt.date,
                    time: appt.time,
                    status: appt.status,
                    specialty: appt.specialty,
                    description: appt.reason,
                    patient: {
                        id: appt.patient._id.toString(),
                        fullName: appt.patient.fullName,
                        dateOfBirth: appt.patient.dateOfBirth,
                        gender: appt.patient.gender,
                        phone: appt.patient.phone,
                        email: appt.patient.email,
                        cpf: appt.patient.cpf,
                        rg: appt.patient.rg,
                        address: appt.patient.address,
                    },
                    doctor: {
                        id: appt.doctor?._id.toString(),
                        fullName: appt.doctor?.fullName,
                        specialty: appt.doctor?.specialty
                    },
                    operationalStatus: appt.operationalStatus,
                    clinicalStatus: appt.clinicalStatus,
                    reason: appt.reason
                };
            });

        res.json(calendarEvents);
    } catch (error) {
        console.error('Erro ao buscar agendamentos:', error);

        if (error.name === 'CastError') {
            return res.status(400).json({
                error: 'ID inválido',
                message: 'O formato do ID fornecido é inválido'
            });
        }

        res.status(500).json({
            error: 'Erro interno',
            details: error.message
        });
    }
});


// Busca agendamentos por especialidade
router.get('/by-specialty/:specialty', auth, async (req, res) => {
    try {
        const { specialty } = req.params;
        const appointments = await Appointment.find({
            doctor: req.user._id,
            specialty
        }).populate('patient', 'fullName');

        res.json(appointments);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Atualiza um agendamento com verificação de conflitos
router.put('/:id', validateId, auth, checkPackageAvailability,
    validateIndividualPayment, checkAppointmentConflicts, async (req, res) => {

        const mongoSession = await mongoose.startSession();

        try {
            await mongoSession.startTransaction();

            // 1. Buscar e validar agendamento com lock
            const appointment = await Appointment.findOneAndUpdate(
                { _id: req.params.id },
                { $set: {} }, // Operação vazia apenas para travar o documento
                { new: true, session: mongoSession }
            );

            if (!appointment) {
                await mongoSession.abortTransaction();
                return res.status(404).json({ error: 'Agendamento não encontrado' });
            }

            // 2. Verificar permissões
            if (req.user.role === 'doctor' && appointment.doctor.toString() !== req.user.id) {
                await mongoSession.abortTransaction();
                return res.status(403).json({ error: 'Acesso não autorizado' });
            }

            // 3. Aplicar atualizações manualmente
            const updateData = {
                ...req.body,
                doctor: req.body.doctorId
            };

            // Atualizar 
            const previousData = appointment.toObject();
            Object.assign(appointment, updateData);

            // 4. Validar antes de salvar
            await appointment.validate();
            const updated = await appointment.save({ session: mongoSession });

            if (appointment.session) {
                const session = await Session.findById(appointment.session).session(mongoSession);

                if (session) {
                    if (updateData.date) session.date = new Date(updateData.date);
                    if (updateData.time) session.time = updateData.time;
                    if (updateData.status) session.status = updateData.status;
                    if (updateData.doctor) session.doctor = updateData.doctorId;
                    await session.save({ session: mongoSession });
                }
            }

            await mongoSession.commitTransaction();

            setTimeout(async () => {
                try {
                    // Sincronização básica do agendamento
                    await syncEvent(updated, 'appointment');

                    // Se for sessão de pacote, tratar no syncService
                    if (updated.serviceType === 'package_session') {
                        const action = determineActionType(req.body, previousData);

                        await handlePackageSessionUpdate(
                            updated,
                            action,
                            req.user,
                            {
                                changes: req.body,
                                previousData
                            }
                        );
                    }
                } catch (err) {
                    console.error('Erro na sincronização pós-atualização:', err);
                }
            }, 100);

            res.json(updated);
        } catch (error) {
            console.error('Erro ao atualizar agendamento:', error);

            // Abortar transação se ainda estiver ativa
            if (mongoSession.inTransaction()) {
                await mongoSession.abortTransaction();
            }

            // Tratamento de erros
            if (error.name === 'ValidationError') {
                const errors = Object.values(error.errors).reduce((acc, err) => {
                    acc[err.path] = err.message;
                    return acc;
                }, {});

                return res.status(400).json({
                    message: 'Falha na validação dos dados',
                    errors
                });
            }

            if (error.name === 'CastError') {
                return res.status(400).json({
                    error: 'ID inválido',
                    message: 'O formato do ID fornecido é inválido'
                });
            }

            if (error.message === 'Pacote inválido ou sem sessões disponíveis') {
                return res.status(400).json({ error: error.message });
            }

            res.status(500).json({
                error: 'Erro interno',
                details: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        } finally {
            await mongoSession.endSession();
        }
    });

function determineActionType(updateData) {
    if (updateData.status === 'canceled') return 'cancel';
    if (updateData.date || updateData.time) return 'reschedule';
    return 'update';
}

// Deleta um agendamento
router.delete('/:id', validateId, auth, async (req, res) => {
    try {
        await Appointment.findByIdAndDelete(req.params.id);
        res.json({ message: 'Agendamento deletado com sucesso' });

        await updatePatientAppointments(req.body.patientId);
    } catch (error) {
        if (error.name === 'ValidationError') {
            const errors = Object.keys(error.errors).reduce((acc, key) => {
                acc[key] = error.errors[key].message;
                return acc;
            }, {});

            return res.status(400).json({
                message: 'Falha na validação dos dados',
                errors
            });
        }

        return res.status(500).json({ error: 'Erro interno' });
    }
});

// Histórico de agendamentos por paciente
router.get('/history/:patientId', async (req, res) => {
    try {
        const { patientId } = req.params;
        const history = await Appointment.find({ patientId }).sort({ date: -1 });
        res.json(history);
    } catch (error) {
        if (error.name === 'ValidationError') {
            const errors = Object.keys(error.errors).reduce((acc, key) => {
                acc[key] = error.errors[key].message;
                return acc;
            }, {});

            return res.status(400).json({
                message: 'Falha na validação dos dados',
                errors
            });
        }

        return res.status(500).json({ error: 'Erro interno' });
    }
});

// Cancela um agendamento
router.patch('/:id/cancel', validateId, auth, async (req, res) => {
    const dbSession = await mongoose.startSession();

    try {
        await dbSession.startTransaction();

        // 1. Validação básica
        const { reason, confirmedAbsence = false } = req.body;
        if (!reason) {
            await dbSession.abortTransaction();
            return res.status(400).json({ error: 'O motivo do cancelamento é obrigatório' });
        }

        // 2. Buscar e travar o agendamento
        const appointment = await Appointment.findOneAndUpdate(
            { _id: req.params.id },
            { $set: {} },
            {
                new: true,
                session: dbSession
            }
        ).populate('session'); // Popula a sessão relacionada

        if (!appointment) {
            await dbSession.abortTransaction();
            return res.status(404).json({ error: 'Agendamento não encontrado' });
        }

        // 3. Verificar status atual
        if (appointment.operationalStatus === 'canceled') {
            await dbSession.abortTransaction();
            return res.status(400).json({ error: 'Este agendamento já está cancelado' });
        }

        // 4. Preparar dados do histórico
        const historyEntry = {
            action: 'cancelamento',
            newStatus: 'canceled',
            changedBy: req.user._id,
            timestamp: new Date(),
            context: 'operacional',
            details: { reason, confirmedAbsence }
        };

        // 5. Atualizar agendamento
        const updatedAppointment = await Appointment.findByIdAndUpdate(
            req.params.id,
            {
                operationalStatus: 'cancelado',
                status: 'canceled',
                canceledReason: reason,
                confirmedAbsence,
                $push: { history: historyEntry }
            },
            { new: true, session: dbSession }
        );

        // 6. Atualizar sessão relacionada se existir
        if (appointment.session) {
            await Session.findByIdAndUpdate(
                appointment.session._id,
                {
                    $set: {
                        status: 'canceled',
                        confirmedAbsence
                    },
                    $push: {
                        history: {
                            action: 'cancelamento_via_agendamento',
                            changedBy: req.user._id,
                            timestamp: new Date(),
                            details: { reason }
                        }
                    }
                },
                { session: dbSession }
            );
        }

        await dbSession.commitTransaction();

        // 7. Sincronização assíncrona
        setTimeout(async () => {
            try {
                // Sincronizar agendamento
                await syncEvent(updatedAppointment, 'appointment');

                // Se for sessão de pacote, sincronizar tudo
                if (updatedAppointment.serviceType === 'package_session') {
                    // Sincronizar sessão
                    if (appointment.session) {
                        const updatedSession = await Session.findById(appointment.session._id);
                        await syncEvent(updatedSession, 'session');
                    }

                    // Sincronizar pacote
                    if (appointment.package) {
                        await syncPackageUpdate({
                            packageId: appointment.package,
                            action: 'cancel',
                            changes: { reason, confirmedAbsence },
                            appointmentId: appointment._id
                        });
                    }
                }
            } catch (syncError) {
                console.error('Erro na sincronização pós-cancelamento:', {
                    error: syncError.message,
                    appointmentId: appointment?._id,
                    stack: syncError.stack
                });
                // Implementar lógica de retry aqui se necessário
            }
        }, 100);

        res.json(updatedAppointment);

    } catch (error) {
        // Tratamento de erros
        if (dbSession.inTransaction()) {
            await dbSession.abortTransaction();
        }

        console.error('Erro ao cancelar agendamento:', {
            error: error.message,
            appointmentId: req.params.id,
            stack: error.stack
        });

        if (error.name === 'ValidationError') {
            const errors = Object.values(error.errors).reduce((acc, err) => {
                acc[err.path] = err.message;
                return acc;
            }, {});
            return res.status(400).json({ errors });
        }

        res.status(500).json({
            error: 'Erro interno no servidor',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        await dbSession.endSession();
    }
});

// Marca agendamento como concluído
router.patch('/:id/complete', auth, async (req, res) => {
    try {
        const { id } = req.params;

        // Popula mais dados necessários
        const appointment = await Appointment.findById(id)
            .populate('session package patient doctor')
            .populate({
                path: 'package',
            });

        if (!appointment) {
            return res.status(404).json({ error: 'Agendamento não encontrado' });
        }

        if (appointment.operationalStatus === 'confirmado') {
            return res.status(400).json({ error: 'Este agendamento já está concluído' });
        }

        // FLUXO DE PAGAMENTO AUTOMÁTICO
        let paymentRecord = null;

        // 1. Sessão avulsa (individual)
        if (appointment.serviceType == 'individual_session') {
            // Obter valor da sessão com fallbacks seguros
            const sessionValue = appointment.sessionValue ||
                (appointment.package?.sessionValue) ||
                200; // Valor padrão

            if (appointment.payment) {
                // Atualiza pagamento existente
                paymentRecord = await Payment.findById(appointment.payment);
                if (paymentRecord) {
                    paymentRecord.patient = appointment.patient._id;
                    paymentRecord.doctor = appointment.doctor._id;
                    paymentRecord.serviceType = appointment.serviceType;
                    paymentRecord.amount = sessionValue;
                    paymentRecord.paymentMethod = appointment.paymentMethod || paymentRecord.paymentMethod || 'dinheiro';
                    paymentRecord.status = 'paid';
                    paymentRecord.appointment = appointment._id;
                    paymentRecord.notes = 'Pagamento automático por conclusão de sessão avulsa';
                    await paymentRecord.save();
                }
            }
        }

        // 2. Sessão de pacote
        if (appointment.session) {
            // Atualizar sessão do pacote
            await Session.findByIdAndUpdate(
                appointment.session._id,
                { status: 'completed' }
            );

            // Atualizar contagem no pacote
            if (appointment.package) {
                await Package.findByIdAndUpdate(
                    appointment.package._id,
                    { $inc: { sessionsDone: 1 } }
                );
            }
        }

        // Atualizar agendamento
        const updateData = {
            operationalStatus: 'confirmado',
            clinicalStatus: 'concluído',
            $push: {
                history: {
                    action: 'confirmado',
                    newStatus: 'confirmado',
                    changedBy: req.user._id,
                    timestamp: new Date(),
                    context: 'operacional',
                }
            }
        };

        // Vincular pagamento se existir
        if (paymentRecord) {
            updateData.payment = paymentRecord._id;
            updateData.paymentStatus = 'paid';
        }

        const updatedAppointment = await Appointment.findByIdAndUpdate(
            id,
            updateData,
            { new: true }
        );

        // Sincronizar eventos após atualização
        try {
            await syncEvent(updatedAppointment, 'appointment');
            if (paymentRecord) {
                await syncEvent(paymentRecord, 'payment');
            }
        } catch (syncError) {
            console.error('Erro na sincronização pós-conclusão:', syncError);
        }

        res.json(updatedAppointment);

    } catch (error) {
        console.error('Erro ao concluir agendamento:', error);
        res.status(500).json({
            error: 'Erro interno no servidor',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Busca todos os agendamentos de um paciente
router.get('/patient/:id', validateId, auth, async (req, res) => {

    const patient = req.params.id;
    try {
        const appointments = await Appointment.find({ patient }).populate([
            { path: 'doctor', select: 'fullName crm' },
            { path: 'patient', select: 'fullName phone' },
            { path: 'payment' },
            {
                path: 'advancedSessions', // Nome correto do campo
                select: 'date time specialty operationalStatus clinicalStatus',
                populate: {
                    path: 'doctor',
                    select: 'fullName specialty'
                }
            },
            {
                path: 'history.changedBy',
                select: 'name email role',
                options: { retainNullValues: true },
            },
            {
                path: 'package',
                select: 'sessionType durationMonths sessionsPerWeek',
                populate: {
                    path: 'sessions',
                    select: 'date status isPaid'
                }
            },
            {
                path: 'session',
                select: 'date status isPaid confirmedAbsence',
                populate: {
                    path: 'package',
                    select: 'sessionType durationMonths sessionsPerWeek'
                }
            }
        ]).lean();

        const formattedAppointments = appointments.map(appt => {
            // Formatar sessões adiantadas
            if (appt.advancedSessions) {
                appt.advancedSessions = appt.advancedSessions.map(session => ({
                    ...session,
                    formattedDate: new Date(session.date).toLocaleDateString('pt-BR'),
                    formattedTime: session.time,
                }));
            }

            return {
                ...appt,
                paymentStatus: appt.package ? 'paid' : appt.paymentStatus,
                source: appt.package ? 'package' : 'individual'
            };
        });


        res.json(formattedAppointments);
    } catch (error) {
        if (error.name === 'ValidationError') {
            const errors = Object.keys(error.errors).reduce((acc, key) => {
                acc[key] = error.errors[key].message;
                return acc;
            }, {});

            return res.status(400).json({
                message: 'Falha na validação dos dados',
                errors
            });
        }

        return res.status(500).json({ error: 'Erro interno' });
    }
});

router.get('/count-by-status', auth, async (req, res) => {
    try {
        const { dateFrom, dateTo, specialty } = req.query;

        // FILTRO SEM MÉDICO (toda clínica)
        const filter = {};

        // Filtro de datas
        if (dateFrom || dateTo) {
            filter.date = {};
            if (dateFrom) filter.date.$gte = new Date(dateFrom);
            if (dateTo) {
                const end = new Date(dateTo);
                end.setHours(23, 59, 59, 999);
                filter.date.$lte = end;
            }
        }

        // Filtro de especialidade
        if (specialty && specialty !== 'all') {
            filter.specialty = specialty;
        }

        // Agregação
        const counts = await Appointment.aggregate([
            { $match: filter },
            {
                $group: {
                    _id: "$operationalStatus",
                    count: { $sum: 1 }
                }
            }
        ]);

        // Formatar resultado
        const result = {
            agendado: 0,
            confirmado: 0,
            cancelado: 0,
            pago: 0,
            faltou: 0
        };

        counts.forEach(item => {
            if (result.hasOwnProperty(item._id)) {
                result[item._id] = item.count;
            }
        });

        return res.json({ success: true, data: result });

    } catch (error) {
        console.error('Erro na rota count-by-status:', error);
        return res.status(500).json({
            success: false,
            message: 'Erro interno do servidor',
            error: error.message
        });
    }
});

// Nova rota para estatísticas completas
// Atualize a rota de estatísticas
router.get('/stats', auth, async (req, res) => {
    try {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const todayEnd = new Date();
        todayEnd.setHours(23, 59, 59, 999);

        const doctor = new mongoose.Types.ObjectId(req.user._id);

        // Configuração das especialidades
        const specialtiesConfig = {
            'Terapia Ocupacional': {
                id: 'to',
                name: 'Terapia Ocupacional',
                icon: 'accessibility',
                color: '#9C27B0',
                sessionDuration: 40,
                price: 200.00 // Adicionado preço para cálculo de receita
            },
            'Psicologia': {
                id: 'psicologia',
                name: 'Psicologia',
                icon: 'psychology',
                color: '#3F51B5',
                sessionDuration: 40,
                price: 200.00
            },
            'Psiquiatria': {
                id: 'psiquiatria',
                name: 'Psiquiatria',
                icon: 'medical_services',
                color: '#009688',
                sessionDuration: 30,
                price: 300.00
            },
            'Fonoaudiologia': {
                id: 'fonoaudiologia',
                name: 'Fonoaudiologia',
                icon: 'AudioLines',
                color: '#FF9800',
                sessionDuration: 40,
                price: 180.00
            }
        };

        const stats = await Appointment.aggregate([
            { $match: { doctor } },
            {
                $facet: {
                    today: [
                        { $match: { date: { $gte: todayStart, $lte: todayEnd } } },
                        { $count: "count" }
                    ],
                    confirmed: [
                        { $match: { status: 'confirmado' } },
                        { $count: "count" }
                    ],
                    totalPatients: [
                        { $group: { _id: "$patientId" } },
                        { $count: "count" }
                    ],
                    bySpecialty: [
                        {
                            $group: {
                                _id: "$specialty",
                                scheduled: { $sum: 1 },
                                completed: {
                                    $sum: {
                                        $cond: [{ $eq: ["$operationalStatus", "concluído"] }, 1, 0]
                                    }
                                },
                                canceled: {
                                    $sum: {
                                        $cond: [{ $eq: ["$operationalStatus", "cancelado"] }, 1, 0]
                                    }
                                }
                            }
                        }
                    ]
                }
            }
        ]);

        const result = {
            today: stats[0]?.today[0]?.count || 0,
            confirmed: stats[0]?.confirmed[0]?.count || 0,
            totalPatients: stats[0]?.totalPatients[0]?.count || 0,
            specialties: []
        };

        const specialtyStats = stats[0]?.bySpecialty || [];

        for (const [name, config] of Object.entries(specialtiesConfig)) {
            const stat = specialtyStats.find(s => s._id === name) || {
                scheduled: 0,
                completed: 0,
                canceled: 0
            };

            const revenue = stat.completed * config.price;

            result.specialties.push({
                ...config,
                stats: {
                    scheduled: stat.scheduled || 0,
                    completed: stat.completed || 0,
                    canceled: stat.canceled || 0,
                    revenue: revenue || 0
                }
            });
        }

        res.json(result);

    } catch (error) {
        console.error('Erro ao buscar estatísticas:', error);
        res.status(500).json({
            error: 'Erro interno',
            details: error.message
        });
    }
});

// backend/controllers/appointmentController.js
router.patch('/:id/clinical-status', validateId, auth, async (req, res) => {
    try {
        const { status } = req.body;
        const validStatuses = ['em_andamento', 'concluído', 'faltou'];

        if (!validStatuses.includes(status)) {
            return res.status(400).json({ error: 'Status clínico inválido' });
        }

        const appointment = await Appointment.findById(req.params.id);

        if (req.user.role === 'doctor' && appointment.doctor.toString() !== req.user.id) {
            return res.status(403).json({ error: 'Acesso não autorizado' });
        }

        // Atualização segura que ignora validações problemáticas
        appointment.clinicalStatus = status;
        appointment.history.push({
            action: 'atualização_status_clínico',
            newStatus: status,
            changedBy: req.user._id,
            timestamp: new Date(),
            context: 'clínico'
        });

        if (status === 'concluído') {
            appointment.operationalStatus = 'pago';
        }

        // Salva sem validar campos problemáticos
        const updatedAppointment = await appointment.save({ validateBeforeSave: false });

        res.json(updatedAppointment);

    } catch (error) {
        console.error('Erro ao atualizar status clínico:', error);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
});

export default router;