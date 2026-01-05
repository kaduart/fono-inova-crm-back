// services/intelligence/stageEngine.js
export function nextStage(current, flags = {}) {
    const {
        wantsSchedule,
        asksPrice,
        hasAppointment,
        isPatient,
        conversionScore
    } = flags;

    // Já é paciente
    if (isPatient || hasAppointment) return 'paciente';

    // Quer agendar
    if (wantsSchedule) return 'interessado_agendamento';

    // Pesquisando preço
    if (asksPrice) return 'pesquisando_preco';

    // Score alto = engajado
    if (conversionScore && conversionScore >= 70) return 'engajado';

    // Fluxo padrão
    const progression = {
        'novo': 'primeiro_contato',
        'primeiro_contato': 'engajado',
        'engajado': 'interessado_agendamento',
        'pesquisando_preco': 'interessado_agendamento',
        'interessado_agendamento': 'triagem_agendamento',
        'triagem_agendamento': 'agendado',
    };

    return progression[current] || current;
}

export default { nextStage };
