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
• Exemplo: "A avaliação é completa e personalizada. Valor: R$ 220. É para criança ou adulto?"
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
🎯 LEAD QUENTE - QUER AGENDAR:
• PRIORIDADE MÁXIMA: Facilitar agendamento
• Ofereça 2 opções CONCRETAS de horário
• Seja DIRETA e OBJETIVA
• Confirme dados de contato
• Exemplo: "Perfeito! Tenho vaga amanhã 16h ou quinta 10h. Qual funciona melhor?"
`,
        
        'agendado': `
✅ LEAD AGENDADO - GARANTIR COMPARECIMENTO:
• Confirme os detalhes do agendamento
• Dê informações práticas (endereço, estacionamento)
• Pergunte se tem alguma dúvida
• Seja acolhedora mas não invasiva
• Exemplo: "Confirmado! Dia [X] às [Y]. Ficamos na Av. Minas Gerais, 405 (tem estacionamento). Alguma dúvida?"
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
            cta: 'opções_concretas',
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