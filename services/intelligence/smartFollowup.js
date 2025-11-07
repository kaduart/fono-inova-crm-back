// services/intelligence/smartFollowup.js

/**
 * ⏰ Calcula tempo ideal para follow-up
 */
export function calculateOptimalFollowupTime({ lead, score, lastInteraction, attempt = 1 }) {
    const now = new Date();
    let delayMs = 0;

    // DELAY BASE POR SCORE
    if (score >= 80) delayMs = 1 * 60 * 60 * 1000; // 1h
    else if (score >= 50) delayMs = 4 * 60 * 60 * 1000; // 4h
    else delayMs = 24 * 60 * 60 * 1000; // 24h

    // AUMENTA A CADA TENTATIVA
    delayMs *= Math.pow(1.5, attempt - 1);

    let scheduledTime = new Date(now.getTime() + delayMs);

    // AJUSTA HORÁRIO COMERCIAL (8h-18h)
    const hour = scheduledTime.getHours();
    const day = scheduledTime.getDay();

    if (hour < 8 || hour >= 18) {
        scheduledTime.setHours(9, 0, 0, 0);
        if (hour >= 18) scheduledTime.setDate(scheduledTime.getDate() + 1);
    }

    // FIM DE SEMANA → segunda 9h
    if (day === 0) { // Domingo
        scheduledTime.setDate(scheduledTime.getDate() + 1);
        scheduledTime.setHours(9, 0, 0, 0);
    } else if (day === 6) { // Sábado
        scheduledTime.setDate(scheduledTime.getDate() + 2);
        scheduledTime.setHours(9, 0, 0, 0);
    }

    return scheduledTime;
}

/**
 * 💬 Gera mensagem contextualizada
 */
export function generateContextualFollowup({ lead, analysis, attempt = 1 }) {
    const { extracted, intent, score } = analysis;
    const firstName = (lead.name || '').split(' ')[0] || 'tudo bem';

    const templates = {
        first_hot_scheduling: [
            `Oi ${firstName}! 💚 Vi que você quer agendar ${extracted.queixa ? `avaliação para ${extracted.queixa.replace('_', ' ')}` : 'uma avaliação'}. Temos horários disponíveis ainda esta semana. Posso te ajudar?`,
            `${firstName}! 💚 Sobre o agendamento, temos vagas nos próximos dias. Qual período funciona melhor?`
        ],
        first_hot_price: [
            `Oi ${firstName}! 💚 A avaliação é R$ 220,00. ${extracted.urgencia === 'alta' ? 'Vi que é urgente - temos horários ainda esta semana!' : 'Posso te ajudar a agendar?'}`,
            `${firstName}! 💚 Sobre o valor: R$ 220,00 a avaliação. Quer reservar um horário?`
        ],
        first_warm: [
            `Oi ${firstName}! 💚 Passando para saber se ficou alguma dúvida. Posso te ajudar?`,
            `${firstName}! 💚 Nossa equipe está à disposição para esclarecer qualquer dúvida!`
        ],
        first_cold: [
            `Oi! 💚 Passando para saber se posso te ajudar com alguma informação. Estamos à disposição!`
        ],
        second_hot: [
            `${firstName}, oi! 💚 Não conseguimos finalizar o agendamento. ${extracted.urgencia === 'alta' ? 'Como é urgente, separei horários prioritários.' : 'Ainda tem interesse?'}`
        ],
        second_warm: [
            `${firstName}! 💚 Vi que você ainda não agendou. Ficou alguma dúvida? Estou aqui para ajudar!`
        ],
        third_plus: [
            `Oi! 💚 Esta é minha última tentativa de contato. Se ainda tiver interesse, estaremos sempre à disposição. Equipe Fono Inova! 💚`
        ]
    };

    let selectedTemplates;

    if (attempt >= 3) {
        selectedTemplates = templates.third_plus;
    } else if (attempt === 2) {
        selectedTemplates = score >= 80 ? templates.second_hot : templates.second_warm;
    } else {
        if (score >= 80) {
            if (intent.primary === 'agendar_avaliacao' || intent.primary === 'agendar_urgente') {
                selectedTemplates = templates.first_hot_scheduling;
            } else if (intent.primary === 'informacao_preco') {
                selectedTemplates = templates.first_hot_price;
            } else {
                selectedTemplates = templates.first_hot_scheduling;
            }
        } else if (score >= 50) {
            selectedTemplates = templates.first_warm;
        } else {
            selectedTemplates = templates.first_cold;
        }
    }

    return selectedTemplates[Math.floor(Math.random() * selectedTemplates.length)];
}