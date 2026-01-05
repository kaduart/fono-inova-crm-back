// utils/stagePrompts.js - PROMPTS DINÂMICOS POR ESTÁGIO

/**
 * 🎯 RETORNA INSTRUÇÕES ESPECÍFICAS PARA CADA ESTÁGIO DO FUNIL
 */
export function getPromptByStage(stage, context = {}) {
    const prompts = {
        'novo': `
🆕 LEAD NOVO - PRIMEIRA IMPRESSÃO É TUDO:
• Seja MUITO acolhedora e empática
• NÃO fale de preços logo de cara
• Pergunte a necessidade antes de qualquer coisa
• Foque em entender a dor/problema dele
• Exemplo: "Olá! Como posso te ajudar hoje?"
`,

        'primeiro_contato': `
👋 PRIMEIRO CONTATO - CONSTRUINDO RAPPORT:
• Seja calorosa mas profissional
• Faça perguntas abertas sobre a necessidade
• Evite bombardear com informações
• Foque em ENTENDER antes de VENDER
• Exemplo: "Que bom seu contato! Qual especialidade te trouxe até aqui?"
`,

        'pesquisando_preco': `
💰 LEAD PESQUISANDO PREÇO - USE ESTRATÉGIA VALOR→PREÇO:
• JÁ PERGUNTOU SOBRE VALORES ANTES!
• Primeiro: Reforce o VALOR (o que ele ganha)
• Depois: Informe o PREÇO
• Finalize: Pergunta de ENGAJAMENTO
• Exemplo: "A avaliação é completa e personalizada. Valor: R$ 200. É para criança ou adulto?"
${context.mentionedTherapies?.length > 0 ? `\n• Lembre que ele já perguntou sobre: ${context.mentionedTherapies.join(', ')}` : ''}
`,

        'engajado': `
🔥 LEAD ENGAJADO - ${context.messageCount || 0} MENSAGENS:
• Ele JÁ ESTÁ interessado (${context.messageCount}+ mensagens)
• Seja mais direta e objetiva
• Ofereça próximo passo claro
• Facilite o caminho para agendamento
• Exemplo: "Perfeito! Tenho horários esta semana. Qual período te atende melhor?"
${context.mentionedTherapies?.length > 0 ? `\n• Ele mencionou interesse em: ${context.mentionedTherapies.join(', ')}` : ''}
`,

        'interessado_agendamento': `
🎯 LEAD QUENTE - QUER AGENDAR (FOCO EM COLETAR DADOS):
• PRIORIDADE MÁXIMA: organizar as informações pra equipe da clínica
• Seu objetivo NÃO é marcar dia e horário exatos, e sim coletar:
  - nome completo do paciente
  - telefone com DDD
  - preferência de período (manhã ou tarde)
• Se o lead já respondeu com mais detalhes da queixa, NÃO repita o pedido inteiro de dados:
  - primeiro mostre que entendeu o que ele explicou
  - depois peça apenas o que ainda estiver faltando (nome, telefone ou período)
• Só diga que vai "encaminhar os dados para a equipe" DEPOIS de ter nome + telefone + período
• Quando já tiver tudo, faça UMA única mensagem de confirmação dizendo que vai passar os dados para a equipe, sem ficar repetindo isso em cada resposta
• Use 1–3 frases, tom humano e acolhedor, sempre com 1 💚 no final
• Exemplo: "Perfeito, entendi a dificuldade dele com as letrinhas. Pra eu organizar certinho aqui, me conta só o nome completo dele e se vocês preferem atendimento de manhã ou à tarde? 💚"
`,


        'agendado': `
✅ LEAD AGENDADO - GARANTIR COMPARECIMENTO:
• Confirme os detalhes do agendamento
• Dê informações práticas (endereço)
• Pergunte se tem alguma dúvida
• Seja acolhedora mas não invasiva
• Exemplo: "Confirmado! Dia [X] às [Y]. Ficamos na Av. Minas Gerais, 405. Alguma dúvida?"
`,

        'paciente': `
⭐ PACIENTE ATIVO - TRATAMENTO VIP:
• Seja mais INFORMAL e PRÓXIMA
• Use o nome dele sempre que possível
• Mencione histórico se relevante
• Priorize suporte rápido
• Exemplo: "Oi ${context.name || ''}! Como posso te ajudar hoje?"
${context.hasAppointments ? '\n• Ele já tem consultas marcadas - seja ainda mais atenciosa!' : ''}
`
    };

    return prompts[stage] || prompts['novo'];
}

/**
 * 🎨 RETORNA TOM E ESTILO POR ESTÁGIO
 */
export function getResponseStyleByStage(stage) {
    const styles = {
        'novo': {
            tone: 'acolhedor',
            length: 'curto',
            cta: 'suave',
            emoji: 1
        },
        'primeiro_contato': {
            tone: 'amigável',
            length: 'médio',
            cta: 'pergunta_aberta',
            emoji: 1
        },
        'pesquisando_preco': {
            tone: 'consultivo',
            length: 'médio',
            cta: 'qualificação',
            emoji: 1
        },
        'engajado': {
            tone: 'direto',
            length: 'curto',
            cta: 'próximo_passo',
            emoji: 1
        },
        'interessado_agendamento': {
            tone: 'objetivo',
            length: 'curto',
            cta: 'coleta_dados',
            emoji: 1
        },
        'agendado': {
            tone: 'confirmatório',
            length: 'médio',
            cta: 'suporte',
            emoji: 1
        },
        'paciente': {
            tone: 'próximo',
            length: 'curto',
            cta: 'direto',
            emoji: 1
        }
    };

    return styles[stage] || styles['novo'];
}

/**
 * 🔥 GATILHOS DE URGÊNCIA POR ESTÁGIO
 */
export function getUrgencyTrigger(stage, daysSinceLastContact) {
    // Só aplica urgência se faz mais de 3 dias
    if (daysSinceLastContact < 3) return null;

    const triggers = {
        'pesquisando_preco': "Vagas limitadas esta semana!",
        'engajado': "Tenho horários disponíveis ainda hoje!",
        'interessado_agendamento': "As vagas estão acabando rápido!"
    };

    return triggers[stage] || null;
}

export function buildDynamicPromptForMissing(missing, extracted = {}) {
    const partes = [];

    if (missing.includes("idade")) {
        partes.push("a idade do paciente (em anos ou meses)");
    }

    if (missing.includes("especialidade")) {
        partes.push("se é Psicologia, Fonoaudiologia, Terapia Ocupacional ou outra área");
    }

    if (missing.includes("período")) {
        partes.push("se vocês preferem atendimento de manhã ou à tarde");
    }

    if (partes.length === 0) {
        // nada faltando, não deveria ter caído aqui
        return "Perfeito! Me conta só mais um detalhe pra eu organizar certinho aqui, por favor. 💚";
    }

    const lista = partes.join(" e ");
    const dor = extracted.queixa || extracted.motivo || null;

    const inicio = dor
        ? `Perfeito, entendi a dificuldade que você comentou (${dor}). `
        : `Perfeito, entendi. `;

    return `${inicio}Pra eu organizar certinho aqui e já deixar tudo alinhado com a equipe, me conta só ${lista}? 💚`;
}
