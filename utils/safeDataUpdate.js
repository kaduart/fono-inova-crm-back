/**
 * 🛡️ Safe Data Update Utilities
 * Protege contra corrupção de dados do paciente
 */

/**
 * Atualiza idade com proteção contra downgrade/corrupção
 * @param {number|null} currentAge - Idade atual no banco
 * @param {number|null} newAge - Nova idade extraída
 * @param {string} text - Texto original para contexto
 * @returns {object} { age: number|null, reason: string }
 */
export function safeAgeUpdate(currentAge, newAge, text = '') {
    // Se não tem nova idade, mantém atual
    if (newAge === null || newAge === undefined) {
        return { age: currentAge, reason: 'no_new_data' };
    }

    // Se não tem idade atual, aceita nova
    if (currentAge === null || currentAge === undefined) {
        return { age: newAge, reason: 'first_time' };
    }

    // PROTEÇÃO 1: Nunca permitir downgrade drástico
    // Se idade atual é maior que 10, não aceitar < 5
    if (currentAge > 10 && newAge < 5) {
        console.log(`[SAFE-AGE] Rejeitado: ${currentAge} → ${newAge} (downgrade suspeito)`);
        return { age: currentAge, reason: 'reject_downgrade' };
    }

    // PROTEÇÃO 2: Diferença máxima de 50%
    const maxDiff = Math.floor(currentAge * 0.5);
    if (Math.abs(currentAge - newAge) > maxDiff && currentAge > 3) {
        console.log(`[SAFE-AGE] Rejeitado: ${currentAge} → ${newAge} (diferença > 50%)`);
        return { age: currentAge, reason: 'reject_large_diff' };
    }

    // PROTEÇÃO 3: Verificar contexto válido no texto
    // Se nova idade é menor, exigir contexto explícito de "anos"
    if (newAge < currentAge) {
        const hasAnosContext = /\b(\d{1,3})\s*(anos?|ano)\b/i.test(text);
        if (!hasAnosContext) {
            console.log(`[SAFE-AGE] Rejeitado: ${currentAge} → ${newAge} (sem contexto 'anos')`);
            return { age: currentAge, reason: 'reject_no_context' };
        }
    }

    return { age: newAge, reason: 'accepted' };
}

/**
 * Verifica se texto tem contexto claro de idade
 * @param {string} text 
 * @returns {boolean}
 */
export function hasAgeContext(text) {
    if (!text) return false;
    const t = text.toLowerCase();
    
    // Contextos válidos de idade
    const validContexts = [
        /\b(\d{1,3})\s*(anos?|ano)\b/i,      // "20 anos"
        /\b(\d{1,2})\s*(meses?|mês)\b/i,     // "8 meses"
        /\btem\s+(\d{1,3})\b/i,              // "tem 20"
        /\bfez\s+(\d{1,3})\b/i,              // "fez 5"
        /\bcompletou\s+(\d{1,3})\b/i,        // "completou 3"
        /\bde\s+(\d{1,3})\s*(anos?)\b/i,     // "de 20 anos"
    ];
    
    return validContexts.some(regex => regex.test(t));
}

/**
 * Previne loop na triagem verificando se dados já existem
 * @param {object} lead 
 * @param {string} field - Campo sendo perguntado ('period', 'age', 'name', 'complaint')
 * @returns {boolean} - true se deve pular a pergunta
 */
export function shouldSkipQuestion(lead, field) {
    if (!lead) return false;

    switch (field) {
        case 'period':
            // Pular se já tem período em qualquer lugar
            return !!(
                lead.pendingPreferredPeriod ||
                lead.qualificationData?.disponibilidade ||
                lead.preferredTime
            );
            
        case 'age':
            return !!(lead.patientInfo?.age || lead.qualificationData?.idade);
            
        case 'name':
            return !!(lead.patientInfo?.fullName || lead.patientInfo?.name);
            
        case 'complaint':
            return !!(lead.complaint || lead.primaryComplaint);
            
        default:
            return false;
    }
}
