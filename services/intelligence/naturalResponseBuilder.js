/**
 * 💬 Natural Response Builder
 * Gera respostas humanizadas, variadas e contextuais
 */

const RESPONSES = {
    ask_therapy: {
        variations: [
            "Qual área você procura? Temos Fono, Psicologia, Fisio e TO 💚",
            "Qual especialidade? 💚",
            "O que você precisa? Fono, Psi, Fisio? 💚"
        ]
    },
    ask_complaint: {
        fonoaudiologia: [
            "Entendi que é fono 💚 Me conta: troca letras? Fala pouco?",
            "Vou te ajudar com fonoaudiologia 💚 O que notou na fala?"
        ],
        psicologia: [
            "Entendi, psicologia 💚 O que te preocupa?",
            "Vou ajudar com psicologia 💚 Me conta o que acontece"
        ],
        default: [
            "Me conta um pouquinho 💚",
            "O que você observou? 💚"
        ]
    },
    ask_age: [
        "Qual a idade? 💚",
        "Quantos anos? 💚"
    ],
    ask_period: [
        "Manhã ou tarde? 💚",
        "Prefere qual período? 💚"
    ]
};

function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

export function buildResponse(type, context = {}) {
    const { therapy } = context;
    
    if (type === 'ask_complaint' && therapy) {
        const key = therapy.toLowerCase();
        return pick(RESPONSES.ask_complaint[key] || RESPONSES.ask_complaint.default);
    }
    
    return pick(RESPONSES[type] || ['Como posso ajudar? 💚']);
}

export default { buildResponse };
