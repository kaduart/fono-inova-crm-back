import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import { updateAppointmentFromSession, updatePatientAppointments } from '../utils/appointmentUpdater.js';

/**
 * Registra um pagamento antecipado com criação automática de:
 * - Pagamento principal (Payment)
 * - Sessão atual (Session + Appointment)
 * - Sessões futuras (advanceSessions)
 * - Atualização de Patient.lastAppointment / nextAppointment
 */
export const handleAdvancePayment = async (req, res) => {
    const mongoSession = await mongoose.startSession();
    mongoSession.startTransaction();

    try {
        const {
            patientId,
            doctorId,
            serviceType,
            amount,
            paymentMethod,
            notes,
            specialty,
            advanceSessions = [],
        } = req.body;

        const now = new Date();

        // 🔹 1. Cria o pagamento principal
        const payment = new Payment({
            patient: patientId,
            doctor: doctorId,
            serviceType,
            amount,
            paymentMethod,
            notes,
            status: 'paid',
            isAdvance: advanceSessions.length > 0,
            createdAt: now,
            updatedAt: now,
        });
        await payment.save({ session: mongoSession });

        // 🔹 2. Cria sessão do pagamento atual (dia de hoje)
        const todaySession = new Session({
            patient: patientId,
            doctor: doctorId,
            serviceType,
            sessionType: specialty || 'fonoaudiologia',
            date: now.toISOString().split('T')[0],
            time: now.toISOString().split('T')[1].slice(0, 5),
            isPaid: true,
            paymentStatus: 'paid',
            visualFlag: 'ok',
            status: 'confirmado',
            isAdvance: false,
            payment: payment._id,
            createdAt: now,
            updatedAt: now,
        });
        await todaySession.save({ session: mongoSession });

        // Cria o agendamento correspondente à sessão de hoje
        const todayAppointment = new Appointment({
            patient: patientId,
            doctor: doctorId,
            session: todaySession._id,
            date: todaySession.date,
            time: todaySession.time,
            status: 'confirmado',
            paymentStatus: 'paid',
            visualFlag: 'ok',
        });
        await todayAppointment.save({ session: mongoSession });

        // Mantém coerência visual e financeira
        await updateAppointmentFromSession(todaySession, mongoSession);

        // 🔹 3. Cria sessões futuras (advanceSessions)
        for (const adv of advanceSessions) {
            const advSession = new Session({
                patient: patientId,
                doctor: doctorId,
                serviceType: adv.serviceType || 'individual_session',
                sessionType: adv.sessionType || specialty || 'fonoaudiologia',
                date: adv.date,
                time: adv.time,
                value: adv.amount,
                isPaid: true, // já pago antecipadamente
                paymentStatus: 'paid',
                visualFlag: 'ok',
                status: 'agendado',
                isAdvance: true,
                payment: payment._id,
                createdAt: now,
                updatedAt: now,
            });
            await advSession.save({ session: mongoSession });

            const advAppointment = new Appointment({
                patient: patientId,
                doctor: doctorId,
                session: advSession._id,
                date: adv.date,
                time: adv.time,
                status: 'agendado',
                paymentStatus: 'paid',
                visualFlag: 'ok',
            });
            await advAppointment.save({ session: mongoSession });

            await updateAppointmentFromSession(advSession, mongoSession);
        }

        // 🔹 4. Atualiza dados do paciente
        await updatePatientAppointments(patientId);

        // 🔹 5. Confirma a transação
        await mongoSession.commitTransaction();

        const populatedPayment = await Payment.findById(payment._id)
            .populate('patient doctor')
            .session(mongoSession);

        res.status(201).json({
            success: true,
            message: `Pagamento antecipado registrado com ${advanceSessions.length} sessão(ões) futura(s).`,
            data: {
                payment: populatedPayment,
            },
        });
    } catch (error) {
        await mongoSession.abortTransaction();
        console.error('❌ Erro ao registrar pagamento antecipado:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao registrar pagamento antecipado',
            error: error.message,
        });
    } finally {
        mongoSession.endSession();
    }
};
