/**
 * 🚀 PATCH MODO LP (LANDING PAGE) - Amanda Orchestrator
 * 
 * Instruções de aplicação:
 * 1. Copiar as funções abaixo para o início do AmandaOrchestrator.js (após os imports)
 * 2. Modificar processMessageLikeAmanda para aceitar context como 4º parâmetro
 * 3. Modificar buildSimpleResponse (case 'therapyArea')
 * 4. Modificar fluxo de neuropsicologia para checar isLPMode
 */

// ============================================================================
// 🆕 MODO LP (LANDING PAGE) - DETECTOR DE CONTEXTO
// ============================================================================

/**
 * Detecta se a mensagem veio de uma landing page e infere área terapêutica
 */
function detectLPContext(text, context = {}) {
    // Se já tem context.source === 'lp', usa isso
    if (context?.source === 'lp' || context?.lpContext) {
        return inferAreaFromLPText(text);
    }
    
    // Detecta implicitamente se parece mensagem de site
    const looksLikeLP = isLikelyLandingPageMessage(text);
    if (looksLikeLP) {
        return inferAreaFromLPText(text);
    }
    
    return null;
}

/**
 * Detecta se a mensagem parece vir de uma landing page
 * Características: curta, direta, sem cumprimentos longos
 */
function isLikelyLandingPageMessage(text = '') {
    const normalized = text.toLowerCase().trim();
    
    // Mensagens de LP são tipicamente curtas e diretas
    const isShort = normalized.length < 100;
    const hasNoLongGreeting = !/^(oi|ol[aá]|bom dia|boa tarde|boa noite)[,\s!]+[^\n]{20,}/i.test(normalized);
    const hasClearIntent = /\b(quero|gostaria|preciso|busco|queria|avalia[çc][aã]o|agendar|marcar|atendimento|interessad|informa[cç][oõ]es?)\b/i.test(normalized);
    const isDirect = /\b(neuropsicolog|fonoaudiolog|psicolog|terapia|fisioterapia|dislexia|autismo|tea|tdah|linguinha)\b/i.test(normalized);
    
    return isShort && hasNoLongGreeting && (hasClearIntent || isDirect);
}

/**
 * Infere a área terapêutica baseada no texto da LP
 * Mapeamento expandido para cobrir todas as páginas do site
 */
function inferAreaFromLPText(text = '') {
    if (!text) return null;
    
    const normalized = text.toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
    
    // Mapeamento de páginas/palavras para áreas
    const lpMappings = [
        // NEUROPSICOLOGIA (mais específicos primeiro)
        { 
            patterns: [
                /\bneuropsicolog/i, 
                /\bavaliacao neuropsicolog/i, 
                /\blaudo\b/i, 
                /\btea\b/i, 
                /\bautismo\b/i, 
                /\btdah\b/i,
                /\bdeficit de atencao\b/i,
                /\bhiperatividad\b/i,
                /\bdislexia\b/i, 
                /\bdificuldade de aprendizagem\b/i,
                /\bdificuldade escolar\b/i,
                /\bproblema na escola\b/i,
                /\baltas habilidades\b/i,
                /\bsuperdotacao\b/i,
                /\bteste de qi\b/i,
                /\bfuncoes executivas\b/i
            ],
            area: 'neuropsicologia',
            context: 'neuro'
        },
        // PSICOLOGIA
        { 
            patterns: [
                /\bpsicolog(ia|o)\b/i,
                /\bcomportamento\b/i,
                /\bansiedade\b/i,
                /\bbirra\b/i,
                /\bagressivo\b/i,
                /\bemo[cç][aã]o/i,
                /\bdepress[aã]o\b/i,
                /\bsocializa[cç][aã]o\b/i
            ],
            area: 'psicologia',
            context: 'psico'
        },
        // FONOAUDIOLOGIA
        { 
            patterns: [
                /\bfono(?:audiologia)?\b/i,
                /\bfala\b/i,
                /\bn[aã]o fala\b/i,
                /\bpronuncia\b/i,
                /\blinguinha\b/i,
                /\bfreio\b/i,
                /\bfrenulo\b/i,
                /\bvoz\b/i,
                /\bgagueira\b/i,
                /\batraso de fala\b/i,
                /\bfenda palatina\b/i,
                /\blabio leporino\b/i,
                /\bengasga\b/i
            ],
            area: 'fonoaudiologia',
            context: 'fono'
        },
        // TERAPIA OCUPACIONAL
        { 
            patterns: [
                /\bterapia ocupacional\b/i,
                /\bto\b/i,
                /\bsensorial\b/i,
                /\bcoordenacao motora\b/i,
                /\bmotricidade\b/i,
                /\bautonomia\b/i,
                /\bintegracao sensorial\b/i,
                /\bavds?\b/i,
                /\brotina\b/i
            ],
            area: 'terapia_ocupacional',
            context: 'to'
        },
        // FISIOTERAPIA
        { 
            patterns: [
                /\bfisio(?:terapia)?\b/i,
                /\bdesenvolvimento motor\b/i,
                /\batraso motor\b/i,
                /\bequilibrio\b/i,
                /\bpostura\b/i,
                /\bforca muscular\b/i,
                /\btorticolo\b/i,
                /\bprematur\b/i,
                /\bsindrome de down\b/i
            ],
            area: 'fisioterapia',
            context: 'fisio'
        },
        // MUSICOTERAPIA
        { 
            patterns: [
                /\bmusicoterapia\b/i,
                /\bmusica\b/i
            ],
            area: 'musicoterapia',
            context: 'music'
        }
    ];
    
    for (const mapping of lpMappings) {
        if (mapping.patterns.some(p => p.test(normalized))) {
            return { area: mapping.area, context: mapping.context, confidence: 'high' };
        }
    }
    
    // Se não detectou área específica, mas parece LP
    if (isLikelyLandingPageMessage(text)) {
        return { area: null, context: 'lp_generic', confidence: 'low' };
    }
    
    return null;
}

// ============================================================================
// 🆕 MODIFICAÇÕES NAS FUNÇÕES EXISTENTES
// ============================================================================

/**
 * MODIFICAÇÃO 1: processMessageLikeAmanda
 * 
 * Adicionar como 4º parâmetro: context = {}
 * Adicionar após a criação de `extracted`:
 
async function processMessageLikeAmanda(text, lead = {}, enrichedContext = null, context = {}) {
    console.log('🧠 [AMANDA-SÊNIOR] Analisando:', text.substring(0, 50));
    
    // ... código existente até criar 'extracted' ...
    
    // 🆕 MODO LP: Detecta se veio do site e infere área
    const lpContext = detectLPContext(text, context);
    if (lpContext && !extracted.therapyArea) {
        console.log(`[MODO-LP] Contexto LP detectado: ${lpContext.context} → ${lpContext.area}`);
        extracted.therapyArea = lpContext.area;
        
        // Guarda referência para uso posterior
        extracted._lpContext = lpContext;
        
        // Se veio de LP, assume que é lead quente (já pesquisou)
        if (!extracted.flags.isHotLead) {
            extracted.flags.isHotLead = true;
        }
        
        // Se veio de LP com área definida, já sabe a queixa implícita
        if (lpContext.area && !extracted.complaint) {
            extracted.complaint = text;
        }
    }
    
    // ... resto da função ...
}

 */

/**
 * MODIFICAÇÃO 2: buildSimpleResponse (case 'therapyArea')
 * 
 * Substituir o case 'therapyArea' por:

case 'therapyArea': {
    const flagsBSR = extracted.flags || {};
    
    // 🆕 MODO LP: Se detectou contexto LP mas não tem área ainda
    const lpCtx = extracted._lpContext || detectLPContext(extracted._rawText || '', {});
    
    if (lpCtx && !lpCtx.area) {
        // LP genérico sem área específica — pergunta o que busca de forma aberta
        return ensureSingleHeart(
            `Oi${respName ? ' ' + respName : ''}! 💚\n\n` +
            `Me conta o que você está buscando — assim consigo te direcionar para a especialidade certa!`
        );
    }
    
    if (flagsBSR.isEmotional || flagsBSR.mentionsUrgency) {
        return ensureSingleHeart(`${respName ? 'Oi ' + respName + '! ' : 'Oi! '}Entendo sua preocupação, estou aqui pra ajudar 💚\n\nQual especialidade você busca? Temos Fonoaudiologia, Psicologia, Terapia Ocupacional, Fisioterapia ou Neuropsicologia.`);
    }
    if (flagsBSR.wantsSchedule || flagsBSR.isHotLead) {
        return ensureSingleHeart(`${respName ? 'Oi ' + respName + '! ' : ''}Ótimo, vou te ajudar a agendar! 💚\n\nQual especialidade você busca? Temos Fonoaudiologia, Psicologia, Terapia Ocupacional, Fisioterapia ou Neuropsicologia.`);
    }
    return ensureSingleHeart(`Oi${respName ? ' ' + respName : ''}! 💚 Me conta o que você busca — assim te direciono para a especialidade certa. Temos Fonoaudiologia, Psicologia, Terapia Ocupacional, Fisioterapia ou Neuropsicologia.`);
}
 */

/**
 * MODIFICAÇÃO 3: Fluxo de Neuropsicologia
 * 
 * Substituir a parte do isNeuro por:

// 🧠 CASO ESPECIAL: Neuropsicologia → Sondar objetivo (laudo vs acompanhamento)
const isNeuro = amandaAnalysis.extracted.therapyArea === 'neuropsicologia' || lead?.therapyArea === 'neuropsicologia';
const alreadyAskedObjective = lead?.neuroObjectiveAsked || lead?.neuroObjetivoSondado;
const hasObjectiveInfo = lead?.neuroObjetivo || lead?.wantsLaudo !== undefined;

// 🆕 MODO LP: Se veio do site com contexto neuro, vai direto sem perguntar laudo vs terapia
const isLPMode = amandaAnalysis.extracted._lpContext?.context === 'neuro' || 
                 detectLPContext(text, context)?.context === 'neuro';

if (isNeuro && !alreadyAskedObjective && !hasObjectiveInfo) {
    console.log('[AMANDA] Neuropsicologia detectada - sondando objetivo...');
    
    // 🆕 MODO LP: Pula pergunta de objetivo, vai direto para agendamento
    if (isLPMode) {
        console.log('[AMANDA] Modo LP ativo - pulando pergunta de objetivo');
        
        await safeLeadUpdate(lead._id, {
            $set: { 
                neuroObjectiveAsked: true, 
                neuroObjetivo: 'avaliacao',
                wantsLaudo: true,
                stage: 'triagem_agendamento' 
            }
        }).catch(() => { });
        
        // Resposta direta sem perguntar laudo vs terapia
        return ensureSingleHeart(
            `Perfeito! 💚\n\n` +
            `A **Avaliação Neuropsicológica** analisa funções como atenção, memória, linguagem e raciocínio. ` +
            `São ~10 sessões (1x por semana), e ao final emitimos um laudo completo.\n\n` +
            `💰 *Valores:* R$ 2.000 em até 6x no cartão, ou R$ 1.700 à vista\n\n` +
            `Posso te ajudar a agendar? Qual período funciona melhor: **manhã ou tarde**?`
        );
    }
    
    // 🔄 Fluxo normal (conversa orgânica) - código existente...
    await safeLeadUpdate(lead._id, {
        $set: { neuroObjectiveAsked: true, stage: 'triagem_agendamento' }
    }).catch(() => { });
    
    // ... resto do código existente ...
}
 */

/**
 * MODIFICAÇÃO 4: Passar context para processMessageLikeAmanda
 * 
 * No getOptimizedAmandaResponse, alterar a chamada:
 * 
 * DE:
 *   const amandaAnalysis = await processMessageLikeAmanda(text, lead, enrichedContext);
 * 
 * PARA:
 *   const amandaAnalysis = await processMessageLikeAmanda(text, lead, enrichedContext, context);
 */

/**
 * MODIFICAÇÃO 5: Guardar texto raw no extracted
 * 
 * No início de processMessageLikeAmanda, adicionar:
 *   extracted._rawText = text;
 */

// Exportar funções para testes
export { detectLPContext, isLikelyLandingPageMessage, inferAreaFromLPText };
