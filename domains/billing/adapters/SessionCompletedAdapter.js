// back/domains/billing/adapters/SessionCompletedAdapter.js
/**
 * Session Completed Adapter
 * 
 * Anti-Corruption Layer (ACL) que traduz eventos do domínio Clinical
 * para comandos do domínio Billing.
 * 
 * 🎯 Responsabilidade: Decidir se uma sessão completa gera faturamento
 */

import { logger } from '../../../utils/logger.js';

/**
 * Traduz evento SESSION_COMPLETED para dados de billing
 * 
 * @param {Object} event - Evento SESSION_COMPLETED
 * @returns {Object|null} - Dados para billing ou null se não aplicar
 */
export function adaptSessionCompleted(event) {
    const { payload, correlationId } = event;
    
    logger.debug('adapter', 'Adaptando SESSION_COMPLETED', {
        sessionId: payload.sessionId,
        correlationId
    });
    
    // 🎯 Regra: Só gera billing se for convênio
    // (particular, liminar etc são tratados em outros domínios)
    if (payload.paymentType !== 'convenio' && payload.packageType !== 'convenio') {
        logger.debug('adapter', 'Ignorando - não é convênio', {
            paymentType: payload.paymentType,
            packageType: payload.packageType
        });
        return null;
    }
    
    // 🎯 Regra: Precisa ter paciente e convênio
    if (!payload.patientId || !payload.insuranceProvider) {
        logger.warn('adapter', 'Dados incompletos para billing', {
            sessionId: payload.sessionId,
            hasPatient: !!payload.patientId,
            hasProvider: !!payload.insuranceProvider
        });
        return null;
    }
    
    // Cria comando para billing
    return {
        commandType: 'CREATE_INSURANCE_ITEM',
        correlationId,
        sourceEventId: event.eventId,
        data: {
            referenceType: 'session',
            referenceId: payload.sessionId,
            appointmentId: payload.appointmentId,
            patientId: payload.patientId,
            doctorId: payload.doctorId,
            specialty: payload.specialty,
            serviceDate: payload.date,
            insuranceProvider: payload.insuranceProvider,
            procedureCode: payload.procedureCode,
            
            // ⚠️ Valor NÃO vem do clínico - billing busca no cadastro do convênio
            // Isso evita que mudanças de valor no convênio precisem alterar sessões
            sessionValue: null // Será preenchido pelo billing
        }
    };
}

/**
 * Traduz evento APPOINTMENT_COMPLETED
 */
export function adaptAppointmentCompleted(event) {
    const { payload, correlationId } = event;
    
    logger.debug('adapter', 'Adaptando APPOINTMENT_COMPLETED', {
        appointmentId: payload.appointmentId,
        correlationId
    });
    
    // Se não for convênio, ignora
    if (payload.type !== 'convenio') {
        return null;
    }
    
    return {
        commandType: 'VERIFY_INSURANCE_GUIDE',
        correlationId,
        sourceEventId: event.eventId,
        data: {
            referenceType: 'appointment',
            referenceId: payload.appointmentId,
            patientId: payload.patientId,
            insuranceProvider: payload.insuranceProvider
        }
    };
}

/**
 * Valida se payload tem campos obrigatórios
 */
function validateRequiredFields(payload, fields) {
    const missing = fields.filter(f => !payload[f]);
    if (missing.length > 0) {
        logger.warn('adapter', 'Campos obrigatórios ausentes', { missing });
        return false;
    }
    return true;
}

// Schema de validação para SESSION_COMPLETED
const SESSION_COMPLETED_SCHEMA = {
    required: ['sessionId', 'patientId', 'date'],
    optional: ['appointmentId', 'doctorId', 'specialty', 'procedureCode', 'insuranceProvider']
};

export default {
    adaptSessionCompleted,
    adaptAppointmentCompleted,
    SESSION_COMPLETED_SCHEMA
};
