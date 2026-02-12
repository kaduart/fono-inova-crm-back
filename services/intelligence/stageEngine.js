// services/intelligence/stageEngine.js
// Stub para compatibilidade com o legado (amandaOrchestrator)
// A lógica original foi deletada como órfã do V7, mas o legado usa nextStage()

/**
 * Determina o próximo estágio do lead baseado no estágio atual e dados coletados.
 * Mantido simples para não quebrar o fluxo legado.
 */
export function nextStage(currentStage, data = {}) {
    const { hasTherapy, hasComplaint, hasAge, hasPeriod, hasSlots, hasName } = data;

    if (!currentStage || currentStage === 'novo') {
        if (hasTherapy) return 'qualificado';
        return 'engajado';
    }
    if (currentStage === 'engajado' && hasTherapy) return 'qualificado';
    if (currentStage === 'qualificado' && hasAge && hasPeriod) return 'triagem_agendamento';
    if (currentStage === 'triagem_agendamento' && hasSlots) return 'agendamento';
    if (currentStage === 'agendamento' && hasName) return 'paciente';

    return currentStage; // Mantém estágio atual se nenhuma condição satisfeita
}

export default { nextStage };
