/* =========================================================================
   AMANDA INTENTS - Sistema de Fallback + Follow-ups
   Clínica Fono Inova - Anápolis/GO
   
   Versão: 3.0 - Inclui scripts de follow-up por semana
   ========================================================================= */

/* =========================================================================
   📖 MANUAL_AMANDA - Respostas Canônicas
   ========================================================================= */
export const MANUAL_AMANDA = {
    "saudacao": "Olá! 😊 Sou a Amanda, da Clínica Fono Inova. Como posso ajudar você hoje? 💚",

    "localizacao": {
        "endereco": "Ficamos na Av. Minas Gerais, 405 - Jundiaí, Anápolis-GO! 💚",
        "como_chegar": "Estamos em frente ao SESI no Jundiaí! Precisa do link do Google Maps? 💚"
    },

    "valores": {
        "avaliacao": "A avaliação inicial é R$ 220; é o primeiro passo para entender a queixa e traçar o plano ideal. Prefere agendar essa avaliação pra essa semana ou pra próxima? 💚",
        "neuropsico": "Avaliação Neuropsicológica completa (10 sessões): R$ 2.500 em até 6x ou R$ 2.300 à vista 💚",
        "teste_linguinha": "Teste da Linguinha: R$ 150. Avaliamos o frênulo lingual de forma rápida e segura 💚",
        "sessao": "Sessão avulsa R$ 220 | Pacote mensal (1x/semana): R$ 180/sessão (~R$ 720/mês) 💚",
        "psicopedagogia": "Psicopedagogia: Anamnese R$ 200 | Pacote mensal R$ 160/sessão (~R$ 640/mês) 💚"
    },

    "planos_saude": {
        "credenciamento": "Muitas famílias têm plano, mas escolhem o particular pra começar mais rápido e ter equipe especializada. Hoje a Fono Inova é 100% particular — a evolução do seu filho não pode esperar fila de convênio. Quer conhecer nosso espaço? 💚"
    },

    "agendamento": {
        "horarios": "Perfeito! 💚 Qual período funciona melhor: manhã ou tarde?",
        "dados": "Vou precisar de: Nome e idade do paciente, nome do responsável e principal queixa 💚"
    },

    "especialidades": {
        "tea_tdah": "Temos profissionais especializados em TEA e planos individuais! O ideal é vir conhecer o espaço e conversar com a equipe. Amanhã à tarde ou quinta pela manhã seria melhor? 💚",
        "fono": "Nossas fonoaudiólogas são especializadas em desenvolvimento da linguagem. A intervenção precoce faz toda diferença! Quer conhecer o espaço? 💚",
        "psicologia": "Nossas psicólogas são especializadas em infantil e trabalham de forma integrada com a equipe. Vamos agendar uma visita? 💚",
        "caa": "Temos fono especializada em CAA! 💚 Trabalhamos com PECS e outros sistemas. A comunicação alternativa NÃO atrapalha a fala — pelo contrário!"
    },

    "duvidas_frequentes": {
        "duracao": "Cada sessão dura 40 minutos. É um tempo pensado para que a criança participe bem, sem ficar cansada 💚",
        "idade_minima": "Atendemos a partir de 1 ano! 💚 A avaliação neuropsicológica é a partir de 4 anos",
        "pagamento": "Aceitamos PIX, cartão em até 6x e dinheiro 💚",
        "pedido_medico": "Não precisa de pedido médico para agendar! 💚 A avaliação é o primeiro passo"
    },

    "despedida": "Foi um prazer conversar! Qualquer dúvida, estou à disposição. 💚"
};

/* =========================================================================
   📬 FOLLOW-UPS - Sequência Completa (5 semanas)
   ========================================================================= */
export const FOLLOWUP_TEMPLATES = {
    // =========================================================================
    // 📅 PRIMEIRA SEMANA (4 follow-ups)
    // =========================================================================
    week1: {
        day1: {
            template: (leadName, childName) =>
                `Oi${leadName ? `, ${leadName}` : ''}! Obrigado pelo interesse na Fono Inova. ` +
                `Posso te ajudar a escolher o melhor dia pra conhecer o espaço${childName ? ` com o(a) ${childName}` : ''}? 💚`,
            delay: 1, // dias após primeiro contato
            type: 'engagement',
        },
        day3: {
            template: (leadName, childName) =>
                `Oi${leadName ? `, ${leadName}` : ''}! Conseguiu ver as informações que mandei? ` +
                `Temos horários abertos essa semana pra visita. Quer que eu te mostre os disponíveis? 💚`,
            delay: 3,
            type: 'engagement',
        },
        day5: {
            template: (leadName, childName) =>
                `Oi${leadName ? `, ${leadName}` : ''}! Muitas famílias têm vindo conhecer nosso espaço e adorado. ` +
                `Quer que eu te envie um vídeo da clínica pra você conhecer antes? 💚`,
            delay: 5,
            type: 'value',
        },
        day7: {
            template: (leadName, childName) =>
                `Oi${leadName ? `, ${leadName}` : ''}! Últimos horários pra visitas essa semana. ` +
                `Posso reservar um pra você${childName ? ` e o(a) ${childName}` : ''}? 💚`,
            delay: 7,
            type: 'urgency',
        },
    },

    // =========================================================================
    // 📅 SEMANAS 2-5 (1 follow-up por semana)
    // =========================================================================
    week2: {
        template: (leadName, childName) =>
            `Oi${leadName ? `, ${leadName}` : ''}! Continuamos com horários disponíveis pra visitas. ` +
            `Quer ver o que encaixa melhor na sua rotina? 💚`,
        delay: 14,
        type: 'engagement',
    },
    week3: {
        template: (leadName, childName) =>
            `Oi${leadName ? `, ${leadName}` : ''}! Posso te mandar um vídeo da nossa clínica ` +
            `pra você conhecer o espaço antes de vir? 💚`,
        delay: 21,
        type: 'value',
    },
    week4: {
        template: (leadName, childName) =>
            `Oi${leadName ? `, ${leadName}` : ''}! Temos um novo programa de acompanhamento ` +
            `com ótimos resultados. Quer saber como funciona? 💚`,
        delay: 28,
        type: 'value',
    },
    week5: {
        template: (leadName, childName) =>
            `Oi${leadName ? `, ${leadName}` : ''}! Seguimos à disposição aqui na Fono Inova. ` +
            `Caso queira conhecer o espaço, é só me chamar. Será um prazer ajudar vocês! 💚`,
        delay: 35,
        type: 'soft_close',
    },
};

/* =========================================================================
   🛡️ SCRIPTS DE QUEBRA DE OBJEÇÃO
   ========================================================================= */
export const OBJECTION_SCRIPTS = {
    // 💰 Preço / Concorrência
    price: {
        primary: "Entendo a preocupação com o valor. O que muitos pais descobrem é que o investimento em uma equipe especializada traz resultados mais rápidos — e no final, sai até mais em conta. Que tal conhecer o espaço antes de decidir? 💚",
        secondary: "Cada clínica tem um jeito de trabalhar. O nosso diferencial é a equipe multiprofissional integrada — fono, psicólogo, TO, todo mundo conversa sobre o caso. Muitos pais que foram em outras clínicas acabam vindo pra cá. 💚",
        lastResort: "Entendo! Posso guardar seu contato e te avisar quando tivermos condições especiais? A porta tá sempre aberta pra vocês. 💚",
    },

    // 🏥 Plano de saúde
    insurance: {
        primary: "Muitas famílias têm plano, mas escolhem o particular justamente pra começar mais rápido e ter equipe especializada desde o início. A evolução do seu filho não pode esperar fila de convênio. 💚",
        secondary: "Pelo plano, às vezes a espera é de meses. Aqui a gente começa em poucos dias, com profissionais que realmente entendem de neurodesenvolvimento. Quer conhecer? 💚",
    },

    // ⏰ Falta de tempo
    time: {
        primary: "Entendo, a rotina é corrida mesmo! A visita é bem leve — uns 20-30 minutos só pra conhecer e tirar dúvidas. Sem compromisso! Qual dia da semana costuma ser mais tranquilo? 💚",
        secondary: "Temos horários bem flexíveis — manhã, tarde e até início da noite. Qual período encaixa melhor? 💚",
    },

    // 🏥 Outra clínica
    otherClinic: {
        primary: "Que bom que vocês já estão cuidando! Cada clínica tem um jeito de trabalhar. Recomendo conhecer a nossa também — o acolhimento e a equipe integrada fazem muita diferença. Muitos pais que vieram 'só comparar' acabaram ficando. 💚",
        secondary: "Fico feliz que esteja dando certo! Se em algum momento quiser uma segunda opinião, a porta tá aberta. Posso guardar seu contato? 💚",
    },

    // 👶 Dúvida sobre TEA
    teaDoubt: {
        primary: "Entendo a dúvida — é natural ficar inseguro. A visita ajuda justamente nisso: entender o desenvolvimento e ver se há necessidade de acompanhamento. É leve, sem compromisso, e você já sai com orientação. Quer agendar? 💚",
        secondary: "Quanto mais cedo a gente observa, melhor. Não precisa esperar ter certeza pra buscar orientação. E se não for nada, você sai tranquilo. 💚",
    },
};

/* =========================================================================
   🔍 HELPER - Busca no manual
   ========================================================================= */
export function getManual(cat, sub) {
    if (!cat) return null;
    const node = MANUAL_AMANDA?.[cat];
    if (!node) return null;
    if (sub && typeof node === 'object') return node[sub] ?? null;
    return typeof node === 'string' ? node : null;
}

/* =========================================================================
   📬 HELPER - Gera mensagem de follow-up
   ========================================================================= */
export function getFollowupMessage(weekKey, dayKey, leadName = null, childName = null) {
    const week = FOLLOWUP_TEMPLATES[weekKey];
    if (!week) return null;

    // Se for semana 1, precisa do dia específico
    if (weekKey === 'week1') {
        const dayTemplate = week[dayKey];
        if (!dayTemplate) return null;
        return dayTemplate.template(leadName, childName);
    }

    // Semanas 2-5 têm template direto
    return week.template(leadName, childName);
}

/* =========================================================================
   🛡️ HELPER - Busca script de objeção
   ========================================================================= */
export function getObjectionScript(type, variant = 'primary') {
    const scripts = OBJECTION_SCRIPTS[type];
    if (!scripts) return null;
    return scripts[variant] || scripts.primary;
}

/* =========================================================================
   📊 HELPER - Calcula próximo follow-up
   ========================================================================= */
export function getNextFollowupSchedule(daysSinceFirstContact) {
    const schedules = [
        { days: 1, week: 'week1', day: 'day1' },
        { days: 3, week: 'week1', day: 'day3' },
        { days: 5, week: 'week1', day: 'day5' },
        { days: 7, week: 'week1', day: 'day7' },
        { days: 14, week: 'week2', day: null },
        { days: 21, week: 'week3', day: null },
        { days: 28, week: 'week4', day: null },
        { days: 35, week: 'week5', day: null },
    ];

    // Encontra o próximo follow-up não enviado
    for (const schedule of schedules) {
        if (daysSinceFirstContact < schedule.days) {
            return {
                ...schedule,
                daysUntil: schedule.days - daysSinceFirstContact,
            };
        }
    }

    // Já passou de todas as semanas
    return null;
}