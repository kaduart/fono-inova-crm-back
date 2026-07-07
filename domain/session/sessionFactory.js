/**
 * 🔒 SESSION FACTORY - DOMAIN LOCK
 * 
 * ÚNICO lugar autorizado a criar Sessions.
 * Garante que sessionType SEMPRE seja uma especialidade clínica válida.
 * 
 * REGRA: Nunca criar Session diretamente. Sempre usar esta factory.
 */

import { resolveSessionType } from '../../utils/sessionTypeResolver.js';

/**
 * Cria uma Session a partir de um Appointment
 * Garante consistência de dados e sessionType válido
 * 
 * @param {Object} appointment - Objeto Appointment populado
 * @param {Object} options - Opções adicionais
 * @param {String} options.status - Status da sessão (default: 'scheduled')
 * @param {Boolean} options.isPaid - Se já está paga
 * @param {String} options.paymentStatus - Status de pagamento
 * @param {String} options.paymentOrigin - Origem do pagamento
 * @param {String|ObjectId} options.insuranceGuide - Guia de convênio vinculada
 * @returns {Object} - Dados prontos para Session.create()
 */
export function buildSessionFromAppointment(appointment, options = {}) {
    const {
        status = 'scheduled',
        isPaid = false,
        paymentStatus = 'pending',
        paymentOrigin = null,
        visualFlag = 'pending',
        notes = null,
        packageId = null,
        paymentId = null,
        correlationId = null,
        insuranceGuide = appointment.insuranceGuide || null
    } = options;

    // 🔒 GARANTIA: sessionType sempre vem do resolver
    const sessionType = resolveSessionType(appointment, appointment.doctor);

    return {
        patient: appointment.patient?._id || appointment.patient,
        patientId: appointment.patient?._id || appointment.patient,
        doctor: appointment.doctor?._id || appointment.doctor,
        doctorId: appointment.doctor?._id || appointment.doctor,
        appointment: appointment._id,
        appointmentId: appointment._id,
        
        date: appointment.date,
        time: appointment.time,
        
        // 🔒 ÚNICA FONTE DA VERDADE
        sessionType,
        
        sessionValue: appointment.sessionValue || 0,
        
        status,
        clinicalStatus: status === 'completed' ? 'completed' : 'pending',
        
        isPaid,
        paymentStatus,
        paymentOrigin,
        visualFlag,
        
        package: packageId,
        payment: paymentId,
        insuranceGuide,

        notes: notes || `Sessão criada via factory em ${new Date().toISOString()}`,
        
        correlationId,
        
        clinicId: appointment.clinicId || 'default',
        createdAt: new Date(),
        updatedAt: new Date()
    };
}

/**
 * Cria uma Session para pacote pré-pago
 */
export function buildPackageSession(appointment, packageId, options = {}) {
    return buildSessionFromAppointment(appointment, {
        status: options.status || 'completed',
        isPaid: true,
        paymentStatus: 'paid',
        paymentOrigin: 'package_prepaid',
        visualFlag: 'ok',
        packageId,
        ...options
    });
}

/**
 * Cria uma Session para sessão individual (particular)
 */
export function buildIndividualSession(appointment, options = {}) {
    return buildSessionFromAppointment(appointment, {
        status: options.status || 'scheduled',
        isPaid: options.isPaid || false,
        paymentStatus: options.paymentStatus || 'pending',
        paymentOrigin: 'individual',
        visualFlag: options.isPaid ? 'ok' : 'pending',
        ...options
    });
}

/**
 * Cria uma Session para convênio
 *
 * 🔒 GUARD: nunca pode nascer 'completed'. Consumo de guia (guideConsumed,
 * Payment, revenueRecognizedAt) só acontece via completeSessionV2 → ConvenioHandler.
 * Uma Session criada aqui já completed pularia esse efeito colateral inteiro
 * (causa raiz investigada em 2026-07-07 — guias com usedSessions divergente).
 */
export function buildInsuranceSession(appointment, options = {}) {
    if (options.status === 'completed') {
        throw new Error(
            'INVALID_SESSION_FACTORY_STATUS: buildInsuranceSession não pode criar Session já completed. ' +
            'Sessões de convênio só transicionam pra completed via completeSessionV2 (ConvenioHandler), ' +
            'que executa guideConsumed + Payment + revenueRecognizedAt junto. Se precisa registrar uma ' +
            'sessão histórica já realizada, crie como scheduled e complete pelo fluxo oficial.'
        );
    }
    return buildSessionFromAppointment(appointment, {
        status: options.status || 'scheduled',
        isPaid: false,
        paymentStatus: 'pending_receipt',
        paymentMethod: 'convenio',
        paymentOrigin: 'convenio',
        visualFlag: 'pending',
        ...options
    });
}

/**
 * Cria uma Session para liminar (crédito judicial)
 *
 * 🔒 GUARD: mesmo racional do buildInsuranceSession — consumo de crédito
 * judicial só acontece via fluxo oficial de complete.
 */
export function buildLiminarSession(appointment, options = {}) {
    if (options.status === 'completed') {
        throw new Error(
            'INVALID_SESSION_FACTORY_STATUS: buildLiminarSession não pode criar Session já completed. ' +
            'Consumo de crédito judicial só acontece via fluxo oficial de complete.'
        );
    }
    return buildSessionFromAppointment(appointment, {
        status: options.status || 'scheduled',
        isPaid: false,
        paymentStatus: 'pending',
        paymentOrigin: 'liminar_credit',
        visualFlag: 'pending',
        ...options
    });
}

export default {
    buildSessionFromAppointment,
    buildPackageSession,
    buildIndividualSession,
    buildInsuranceSession,
    buildLiminarSession
};
