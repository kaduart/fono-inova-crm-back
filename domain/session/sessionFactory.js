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
        correlationId = null
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
 */
export function buildInsuranceSession(appointment, options = {}) {
    return buildSessionFromAppointment(appointment, {
        status: options.status || 'scheduled',
        isPaid: false,
        paymentStatus: 'pending_receipt',
        paymentOrigin: 'convenio',
        visualFlag: 'pending',
        ...options
    });
}

export default {
    buildSessionFromAppointment,
    buildPackageSession,
    buildIndividualSession,
    buildInsuranceSession
};
