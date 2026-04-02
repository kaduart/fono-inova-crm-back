// services/createAppointmentService.js
import mongoose from 'mongoose';
import { saveToOutbox } from '../infrastructure/outbox/outboxPattern.js';
import crypto from 'crypto';
import Appointment from '../models/Appointment.js';

/**
 * Create Appointment Service
 * 
 * Responsabilidade: Orquestrar a criação de agendamento
 * - Valida entrada
 * - Cria appointment (status: pending)
 * - Salva evento na Outbox (ATÔMICO)
 * 
 * NOTA: Não valida regras de negócio complexas (isso é do worker)
 * Apenas validações básicas e criação do registro inicial
 */

export class CreateAppointmentService {
    constructor() {
        this.Appointment = Appointment;
    }

    /**
     * Executa criação do agendamento
     * 
     * @param {Object} data - Dados do agendamento
     * @param {mongoose.ClientSession} session - Sessão MongoDB
     * @returns {Object} { appointmentId, eventId, correlationId }
     */
    async execute(data, session) {
        const {
            patientId,
            doctorId,
            date,
            time,
            specialty = 'fonoaudiologia',
            packageId = null,
            serviceType = packageId ? 'package_session' : 'session',
            insuranceGuideId = null,
            paymentMethod = 'dinheiro',
            amount = 0,
            notes = '',
            userId = null
        } = data;

        // Validações básicas
        this.validateBasic(data);

        // Gera IDs
        const eventId = crypto.randomUUID();
        const correlationId = data.correlationId || `apt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

        // 1. Cria agendamento (status: pending)
        const appointment = new this.Appointment({
            patient: patientId,
            doctor: doctorId,
            date,
            time,
            specialty,
            serviceType,
            package: packageId,
            
            // Status inicial (state machine)
            operationalStatus: 'pending',
            clinicalStatus: 'pending',
            paymentStatus: this.determineInitialPaymentStatus({ serviceType, insuranceGuideId, amount }),
            
            // Dados de pagamento
            sessionValue: amount,
            paymentMethod,
            billingType: insuranceGuideId ? 'convenio' : 'particular',
            insuranceGuide: insuranceGuideId,
            
            // Metadados
            notes,
            correlationId,
            createdBy: userId,
            
            // Histórico
            history: [{
                action: 'appointment_requested',
                newStatus: 'pending',
                changedBy: userId,
                timestamp: new Date(),
                context: `Criação via event-driven: ${serviceType}`
            }]
        });

        await appointment.save({ session });

        // 2. Determina tipo de evento baseado no cenário
        const eventType = this.determineEventType({ serviceType, insuranceGuideId, packageId });

        // 3. Salva evento na Outbox (MESMA TRANSAÇÃO!)
        await saveToOutbox({
            eventId,
            eventType,
            correlationId,
            payload: {
                appointmentId: appointment._id.toString(),
                patientId: patientId?.toString(),
                doctorId: doctorId?.toString(),
                date,
                time,
                specialty,
                serviceType,
                packageId: packageId?.toString(),
                insuranceGuideId: insuranceGuideId?.toString(),
                paymentMethod,
                amount,
                notes,
                userId: userId?.toString()
            },
            aggregateType: 'appointment',
            aggregateId: appointment._id.toString()
        }, session);

        console.log(`[CreateAppointmentService] Agendamento criado: ${appointment._id}`, {
            eventId,
            correlationId,
            eventType
        });

        return {
            appointmentId: appointment._id.toString(),
            eventId,
            correlationId,
            status: 'pending',
            message: 'Agendamento registrado. Validação em andamento...'
        };
    }

    /**
     * Validações básicas de entrada
     */
    validateBasic(data) {
        const { patientId, doctorId, date, time } = data;

        if (!patientId) throw new Error('PACIENTE_OBRIGATORIO');
        if (!doctorId) throw new Error('PROFISSIONAL_OBRIGATORIO');
        if (!date || !this.isValidDate(date)) throw new Error('DATA_INVALIDA');
        if (!time || !this.isValidTime(time)) throw new Error('HORARIO_INVALIDO');
    }

    /**
     * Determina status inicial de pagamento
     */
    determineInitialPaymentStatus({ serviceType, insuranceGuideId, amount }) {
        if (insuranceGuideId) return 'pending_receipt'; // Convênio
        if (serviceType === 'package_session') return 'package_paid'; // Crédito do pacote
        if (amount === 0) return 'pending'; // Será pago depois
        return 'pending'; // Aguarda confirmação de pagamento
    }

    /**
     * Determina tipo de evento baseado no cenário
     */
    determineEventType({ serviceType, insuranceGuideId, packageId }) {
        if (insuranceGuideId) return 'INSURANCE_APPOINTMENT_REQUESTED';
        if (packageId) return 'PACKAGE_APPOINTMENT_REQUESTED';
        if (serviceType === 'advance_payment') return 'ADVANCE_APPOINTMENT_REQUESTED';
        return 'APPOINTMENT_REQUESTED'; // Particular avulso
    }

    isValidDate(date) {
        return /^\d{4}-\d{2}-\d{2}$/.test(date);
    }

    isValidTime(time) {
        return /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(time);
    }
}

// Export singleton
export const createAppointmentService = new CreateAppointmentService();
