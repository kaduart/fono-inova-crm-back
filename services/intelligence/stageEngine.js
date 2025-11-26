// services/intelligence/stageEngine.js
export function nextStage(currentStage, {
    extracted = {},
    intent = {},
    score = 50,
    flags = {},
    lead = {},
} = {}) {
    const isPatient = lead?.status === 'paciente' || lead?.isPatient;

    // 1️⃣ Paciente sempre vence
    if (isPatient) {
        return 'paciente';
    }

    const primary = intent.primary || 'duvida_geral';
    const bloqueio = extracted.bloqueioDecisao || null;

    // 2️⃣ Se quer agendar → sobe pro estágio mais quente
    if (primary === 'agendar_urgente' || primary === 'agendar_avaliacao' || flags?.wantsSchedule) {
        return 'interessado_agendamento';
    }

    // 3️⃣ Bloqueios declarados que "congelam" a decisão
    //    ex: "vou falar com meu marido", "vou ver o preço", "vou organizar rotina"
    if (['consultar_terceiro', 'consultar_escola', 'avaliar_preco', 'ajustar_rotina', 'refletir'].includes(bloqueio)) {
        // se ainda era "novo", sobe pra "pesquisando_preco" / "engajado"
        if (currentStage === 'novo') {
            return primary === 'informacao_preco' || bloqueio === 'avaliar_preco'
                ? 'pesquisando_preco'
                : 'engajado';
        }

        // se já estava em pesquisando_preco/engajado, mantém
        if (currentStage === 'pesquisando_preco' || currentStage === 'engajado') {
            return currentStage;
        }
    }

    // 4️⃣ Lead frio x quente baseado em score
    if (score >= 75) {
        // se era novo, sobe pra engajado
        if (currentStage === 'novo') return 'engajado';
    } else if (score < 40) {
        // não derrubo estágio, só não deixo subir
        return currentStage || 'novo';
    }

    // 5️⃣ Se já estava em um estágio "avançado", não rebaixa
    switch (currentStage) {
        case 'interessado_agendamento':
        case 'pesquisando_preco':
        case 'engajado':
            return currentStage;
        default:
            return currentStage || 'novo';
    }
}
