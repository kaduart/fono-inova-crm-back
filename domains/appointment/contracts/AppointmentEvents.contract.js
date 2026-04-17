// domains/appointment/contracts/AppointmentEvents.contract.js
/**
 * Contract oficial de eventos do domínio Appointment.
 */

import { defineEventContract, V } from '../../../infrastructure/events/eventContractRegistry.js';

const COMMON_APPOINTMENT_FIELDS = {
    required: ['appointmentId', 'patientId', 'doctorId', 'date', 'time'],
    optional: [
        'specialty',
        'serviceType',
        'packageId',
        'insuranceGuideId',
        'amount',
        'paymentMethod',
        'billingType',
        'notes',
        'leadId',
        'source',
        'preAgendamentoId',
        'userId',
        'correlationId',
        'sessionId'
    ],
    validators: {
        appointmentId: V.isMongoId(),
        patientId: V.isMongoId(),
        doctorId: V.isMongoId(),
        date: V.isDateString(),
        time: V.isTimeString(),
        packageId: V.isOptionalMongoId(),
        insuranceGuideId: V.isOptionalMongoId(),
        amount: V.isNumber('Deve ser um número (amount)'),
        userId: V.isOptionalMongoId(),
        leadId: V.isOptionalMongoId(),
        preAgendamentoId: V.isOptionalMongoId(),
        sessionId: V.isOptionalMongoId(),
    }
};

export function registerAppointmentEventContracts() {
    defineEventContract('APPOINTMENT_REQUESTED', {
        version: 1,
        ...COMMON_APPOINTMENT_FIELDS,
        description: 'Solicitação de agendamento particular (legado)'
    });

    defineEventContract('APPOINTMENT_CREATE_REQUESTED', {
        version: 1,
        ...COMMON_APPOINTMENT_FIELDS,
        description: 'Solicitação de criação de agendamento (v2)'
    });

    defineEventContract('PACKAGE_APPOINTMENT_REQUESTED', {
        version: 1,
        ...COMMON_APPOINTMENT_FIELDS,
        description: 'Solicitação de agendamento via pacote'
    });

    defineEventContract('INSURANCE_APPOINTMENT_REQUESTED', {
        version: 1,
        ...COMMON_APPOINTMENT_FIELDS,
        description: 'Solicitação de agendamento via convênio'
    });

    defineEventContract('ADVANCE_APPOINTMENT_REQUESTED', {
        version: 1,
        ...COMMON_APPOINTMENT_FIELDS,
        description: 'Solicitação de agendamento com adiantamento'
    });

    defineEventContract('APPOINTMENT_CREATED', {
        version: 1,
        ...COMMON_APPOINTMENT_FIELDS,
        description: 'Agendamento criado com sucesso'
    });

    defineEventContract('APPOINTMENT_UPDATED', {
        version: 1,
        required: ['appointmentId'],
        optional: ['patientId', 'doctorId', 'date', 'time', 'specialty', 'status', 'correlationId', 'changes'],
        validators: {
            appointmentId: V.isMongoId(),
            patientId: V.isOptionalMongoId(),
            doctorId: V.isOptionalMongoId(),
        },
        description: 'Agendamento atualizado'
    });

    defineEventContract('APPOINTMENT_COMPLETE_REQUESTED', {
        version: 1,
        required: ['appointmentId'],
        optional: ['sessionId', 'amount', 'paymentMethod', 'correlationId', 'userId'],
        validators: {
            appointmentId: V.isMongoId(),
            sessionId: V.isOptionalMongoId(),
            userId: V.isOptionalMongoId(),
        },
        description: 'Solicitação de completar agendamento'
    });

    defineEventContract('APPOINTMENT_CANCEL_REQUESTED', {
        version: 1,
        required: ['appointmentId'],
        optional: ['reason', 'correlationId', 'userId'],
        validators: {
            appointmentId: V.isMongoId(),
            userId: V.isOptionalMongoId(),
        },
        description: 'Solicitação de cancelamento de agendamento'
    });

    defineEventContract('APPOINTMENT_CANCELED', {
        version: 1,
        required: ['appointmentId'],
        optional: ['reason', 'correlationId', 'cancelledAt'],
        validators: {
            appointmentId: V.isMongoId(),
        },
        description: 'Agendamento cancelado'
    });

    defineEventContract('APPOINTMENT_COMPLETED', {
        version: 1,
        required: ['appointmentId'],
        optional: ['sessionId', 'amount', 'correlationId', 'completedAt'],
        validators: {
            appointmentId: V.isMongoId(),
            sessionId: V.isOptionalMongoId(),
        },
        description: 'Agendamento completado'
    });

    defineEventContract('APPOINTMENT_CONFIRMED', {
        version: 1,
        required: ['appointmentId'],
        optional: ['patientId', 'doctorId', 'date', 'time', 'correlationId'],
        validators: {
            appointmentId: V.isMongoId(),
        },
        description: 'Agendamento confirmado'
    });
}
