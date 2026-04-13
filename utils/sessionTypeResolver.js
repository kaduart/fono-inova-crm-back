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
// evaluation NÃO é specialty - é serviceType. Mapeamos para fonoaudiologia (default) ou psicologia
export const SERVICE_TO_SPECIALTY = {
    'individual_session': 'fonoaudiologia',
    'evaluation': 'fonoaudiologia',  // Avaliação → fonoaudiologia (default da clínica)
    'neuropsych_evaluation': 'psicologia',
    'return': 'fonoaudiologia',
    'package_session': 'fonoaudiologia',
    'convenio_session': 'fonoaudiologia',
    'alignment': 'fonoaudiologia',
    'meet': 'fonoaudiologia',
    'tongue_tie_test': 'fonoaudiologia',
    'tongue_tie_evaluation': 'fonoaudiologia',  // Teste da linguinha → fonoaudiologia
    'avaliacao': 'fonoaudiologia',  // Mapeia pt → fonoaudiologia
    'sessao': 'fonoaudiologia'
};

/**
 * Resolve o sessionType correto para Session e Appointment
 * 
 * @param {Object} appointment - Objeto appointment com specialty, serviceType, etc.
 * @param {Object} doctor - Objeto doctor (opcional) com specialty
 * @returns {String} - Especialidade clínica válida (fonoaudiologia, psicologia)
 */
// Valores válidos de specialty (especialidades clínicas)
const VALID_SPECIALTIES = [
    'fonoaudiologia', 'psicologia', 'terapia_ocupacional', 'fisioterapia',
    'pediatria', 'neuroped', 'musicoterapia', 'psicomotricidade', 'psicopedagogia'
];

export function resolveSessionType(appointment, doctor = null) {
    // 1. Prioridade 1: specialty do appointment (se for válida)
    if (appointment.specialty && VALID_SPECIALTIES.includes(appointment.specialty)) {
        return appointment.specialty;
    }
    
    // 2. Prioridade 2: specialty do doctor
    if (doctor?.specialty && VALID_SPECIALTIES.includes(doctor.specialty)) {
        return doctor.specialty;
    }
    
    // 3. Prioridade 3: mapear serviceType
    if (appointment.serviceType && SERVICE_TO_SPECIALTY[appointment.serviceType]) {
        return SERVICE_TO_SPECIALTY[appointment.serviceType];
    }
    
    // 4. Prioridade 4: se sessionType já for uma specialty válida, usa ela
    if (appointment.sessionType && VALID_SPECIALTIES.includes(appointment.sessionType)) {
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
    if (value && VALID_SPECIALTIES.includes(value)) {
        return value;
    }
    
    // Tenta mapear
    if (value && SERVICE_TO_SPECIALTY[value]) {
        return SERVICE_TO_SPECIALTY[value];
    }
    
    return fallback;
}

export default { resolveSessionType, normalizeSessionType, SERVICE_TO_SPECIALTY };
