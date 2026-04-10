/**
 * 🔧 SESSION TYPE RESOLVER
 * 
 * Resolve o sessionType correto garantindo que seja SEMPRE uma especialidade clínica válida.
 * NUNCA retorna serviceType (individual_session, evaluation, etc.)
 * SEMPRE retorna specialty (fonoaudiologia, psicologia)
 * 
 * Isso evita erros de validação do Mongoose no schema Session.
 */

// Mapeamento obrigatório: serviceType → specialty
export const SERVICE_TO_SPECIALTY = {
    'individual_session': 'fonoaudiologia',
    'evaluation': 'psicologia',
    'neuropsych_evaluation': 'psicologia',
    'return': 'fonoaudiologia',
    'package_session': 'fonoaudiologia',
    'convenio_session': 'fonoaudiologia',
    'alignment': 'fonoaudiologia',
    'meet': 'fonoaudiologia',
    'tongue_tie_test': 'fonoaudiologia',
    'avaliacao': 'psicologia',
    'sessao': 'fonoaudiologia'
};

/**
 * Resolve o sessionType correto para Session e Appointment
 * 
 * @param {Object} appointment - Objeto appointment com specialty, serviceType, etc.
 * @param {Object} doctor - Objeto doctor (opcional) com specialty
 * @returns {String} - Especialidade clínica válida (fonoaudiologia, psicologia)
 */
export function resolveSessionType(appointment, doctor = null) {
    // 1. Prioridade 1: specialty do appointment (se for válida)
    if (appointment.specialty && ['fonoaudiologia', 'psicologia'].includes(appointment.specialty)) {
        return appointment.specialty;
    }
    
    // 2. Prioridade 2: specialty do doctor
    if (doctor?.specialty && ['fonoaudiologia', 'psicologia'].includes(doctor.specialty)) {
        return doctor.specialty;
    }
    
    // 3. Prioridade 3: mapear serviceType
    if (appointment.serviceType && SERVICE_TO_SPECIALTY[appointment.serviceType]) {
        return SERVICE_TO_SPECIALTY[appointment.serviceType];
    }
    
    // 4. Prioridade 4: se sessionType já for uma specialty válida, usa ela
    if (appointment.sessionType && ['fonoaudiologia', 'psicologia'].includes(appointment.sessionType)) {
        return appointment.sessionType;
    }
    
    // 5. Fallback seguro (default da clínica)
    return 'fonoaudiologia';
}

/**
 * Normaliza o sessionType garantindo que nunca seja um serviceType
 * Útil para normalizar dados de entrada (API, imports, etc.)
 * 
 * @param {String} value - Valor recebido (pode ser specialty ou serviceType)
 * @param {String} fallback - Valor padrão se não conseguir resolver
 * @returns {String} - Especialidade clínica válida
 */
export function normalizeSessionType(value, fallback = 'fonoaudiologia') {
    // Se já é válido, retorna
    if (value && ['fonoaudiologia', 'psicologia'].includes(value)) {
        return value;
    }
    
    // Tenta mapear
    if (value && SERVICE_TO_SPECIALTY[value]) {
        return SERVICE_TO_SPECIALTY[value];
    }
    
    return fallback;
}

export default { resolveSessionType, normalizeSessionType, SERVICE_TO_SPECIALTY };
