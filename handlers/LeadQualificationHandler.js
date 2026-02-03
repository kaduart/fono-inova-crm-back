// handlers/LeadQualificationHandler.js
// 🧠 Versão 2.0 - Consultora Premium Inteligente

import callAI from '../services/IA/Aiproviderservice.js';
import Logger from '../services/utils/Logger.js';
import { 
    DYNAMIC_MODULES, 
    OBJECTION_SCRIPTS,
    getObjectionScript 
} from '../utils/amandaPrompt.js';
import ensureSingleHeart from '../utils/helpers.js';


class LeadQualificationHandler {
    constructor() {
        this.logger = new Logger('LeadQualificationHandler');
    }

    async execute({ decisionContext, services }) {
        const startTime = Date.now();
        
        try {
            const { memory, analysis, missing, message, action, objectionType, attempt, pendingCollection } = decisionContext;
            
            this.logger.info('HANDLER_EXECUTE_START', {
                action,
                objectionType,
                hasMemory: !!memory,
                messagePreview: message?.text?.substring(0, 50)
            });
            
            // ===========================
            // 🆕 TRATAMENTO ESPECIAL: OBJEÇÕES
            // ===========================
            if (action === 'handle_objection' && objectionType) {
                this.logger.info('HANDLER_HANDLE_OBJECTION', { objectionType, attempt });
                return this.handleObjection(objectionType, attempt, pendingCollection, memory);
            }
            
            // ===========================
            // 🆕 TRATAMENTO ESPECIAL: ACOLHIMENTO EMOCIONAL
            // ===========================
            if (action === 'acknowledge_pain') {
                this.logger.info('HANDLER_ACKNOWLEDGE_PAIN');
                return this.handleEmotionalAcknowledgment(pendingCollection, memory);
            }
            
            // ===========================
            // 🆕 TRATAMENTO ESPECIAL: WARM RECALL (lead retornando)
            // ===========================
            if (action === 'warm_recall') {
                this.logger.info('HANDLER_WARM_RECALL', { hasText: !!decisionContext.text });
                // O texto já vem pronto do DecisionEngine
                return {
                    text: decisionContext.text || "Oi! Que bom te ver de novo 💚 Como posso te ajudar hoje?",
                    extractedInfo: decisionContext.extractedInfo || { returningLead: true }
                };
            }
            
            // ===========================
            // 🆕 TRATAMENTO ESPECIAL: SMART RESPONSE (responde + retoma)
            // ===========================
            if (action === 'smart_response') {
                this.logger.info('HANDLER_SMART_RESPONSE', { hasText: !!decisionContext.text, textLength: decisionContext.text?.length });
                // O texto já vem pronto do DecisionEngine (resposta + retomada)
                return {
                    text: decisionContext.text || "Como posso te ajudar? 💚",
                    extractedInfo: decisionContext.extractedInfo || {}
                };
            }
            
            // ===========================
            // 🆕 TRATAMENTO ESPECIAL: SHOW SLOTS (Mostrar horários)
            // ===========================
            if (action === 'show_slots') {
                this.logger.info('HANDLER_SHOW_SLOTS', { 
                    hasDecisionText: !!decisionContext.text,
                    period: memory?.preferredPeriod || memory?.pendingPreferredPeriod 
                });
                
                // Se já tem texto pronto do decisionContext, usar
                if (decisionContext.text && decisionContext.text.length > 10) {
                    return {
                        text: decisionContext.text,
                        extractedInfo: decisionContext.extractedInfo || {}
                    };
                }
                
                // Resposta padrão para mostrar horários
                const period = memory?.preferredPeriod || memory?.pendingPreferredPeriod || 'esse período';
                return {
                    text: `Perfeito! Deixa eu verificar os horários disponíveis de ${period}... 💚`,
                    extractedInfo: decisionContext.extractedInfo || { awaitingField: 'slot_confirmation' }
                };
            }
            
            // ===========================
            // 🆕 TRATAMENTO ESPECIAL: CONTINUE COLLECTION
            // ===========================
            if (action === 'continue_collection') {
                this.logger.info('HANDLER_CONTINUE_COLLECTION', { 
                    hasDecisionText: !!(decisionContext.text && decisionContext.text.length > 10),
                    awaitingField: decisionContext.extractedInfo?.awaitingField 
                });
                // Se já tem texto pronto do decisionContext, usar
                if (decisionContext.text && decisionContext.text.length > 10) {
                    return {
                        text: decisionContext.text,
                        extractedInfo: decisionContext.extractedInfo || {}
                    };
                }
                
                // Se acabou de receber período
                const userText = message?.text || '';
                if (memory?.pendingPreferredPeriod || userText.toLowerCase().includes('manhã') || userText.toLowerCase().includes('tarde')) {
                    const period = memory?.pendingPreferredPeriod || 
                                   (userText.toLowerCase().includes('manhã') ? 'manhã' : 'tarde');
                    
                    return {
                        text: `Certo! Deixa eu ver os horários de ${period}... 👀`,
                        extractedInfo: decisionContext.extractedInfo || {}
                    };
                }
                
                // Se acabou de receber idade
                const patientAge = memory?.patientInfo?.age || memory?.patientAge;
                if (patientAge && !memory?.complaint) {
                    return {
                        text: 'Me conta: o que você tem observado que te preocupou? 💚',
                        extractedInfo: decisionContext.extractedInfo || {}
                    };
                }
                
                return {
                    text: decisionContext.text || 'Me conta um pouquinho mais? 💚',
                    extractedInfo: decisionContext.extractedInfo || {}
                };
            }
            
            // ===========================
            // 1️⃣ MONTA CONTEXTO
            // ===========================
            const leadName = memory?.name?.split(' ')[0] || null;
            const patientAge = analysis?.extractedInfo?.age || memory?.patientAge;
            const therapyArea = memory?.therapyArea || analysis?.therapyArea || null;
            const isFirstContact = memory?.isFirstContact || false;
            const history = memory?.conversationHistory || [];

            // 🧠 RECONEXÃO - VERIFICA SE VOLTOU DEPOIS DE TEMPO
            const conversationSummary = memory?.conversationSummary || null;
            const daysSinceLastContact = memory?.daysSinceLastContact || 0;
            const isReconnection = daysSinceLastContact > 7 && !isFirstContact;

            // Detecta se é saudação inicial (oi, olá, bom dia...)
            const isGreeting = /^\s*(oi|ol[aá]|bom dia|boa tarde|boa noite|e a[ií]|tudo bem|oi amanda)/i.test(message?.text?.trim());
            const shouldAcknowledgeHistory = isGreeting && isReconnection && conversationSummary;

            // ===========================
            // 2️⃣ SELECIONA MÓDULOS
            // ===========================
            const modules = [
                DYNAMIC_MODULES.acolhimentoModeContext,
                DYNAMIC_MODULES.valueProposition,
                DYNAMIC_MODULES.clinicalStrategyContext,
            ];

            // Perfil por idade
            if (patientAge) {
                if (patientAge < 13) modules.push(DYNAMIC_MODULES.childProfile);
                else if (patientAge < 18) modules.push(DYNAMIC_MODULES.teenProfile);
                else modules.push(DYNAMIC_MODULES.adultProfile);
            }

            // Módulo da especialidade
            const therapyModules = {
                'fonoaudiologia': DYNAMIC_MODULES.speechContext,
                'fono': DYNAMIC_MODULES.speechContext,
                'psicologia': DYNAMIC_MODULES.psycoContext,
                'terapia ocupacional': DYNAMIC_MODULES.occupationalContext,
                'fisioterapia': DYNAMIC_MODULES.physioContext,
                'neuropsicologia': DYNAMIC_MODULES.neuroPsychContext,
                'musicoterapia': DYNAMIC_MODULES.musicTherapyContext,
                'psicopedagogia': DYNAMIC_MODULES.psychopedContext,
            };
            const therapyMod = therapyModules[therapyArea?.toLowerCase()];
            if (therapyMod) modules.push(therapyMod);

            // ===========================
            // 3️⃣ DEFINE OBJETIVO
            // ===========================
            let objetivo = '';
            let extractedInfo = {}; // 🆕 Para salvar estado de aguardo

            // 🆕 RESPOSTAS NATURAIS (rápidas, sem IA) para casos simples
            
            // 🆕 VERIFICA SE É UMA QUEIXA/RELATO DE DOR PRIMEIRO
            // Se o usuário está relatando algo que o preocupa, ACOLHER antes de tudo
            const userText = message?.text || '';
            const isComplaint = /(não fala|não anda|não obedece|birra|chora|medo|ansioso|hiperativo|agitado|não concentra|dificuldade|problema|atraso|troca letra|gagueira|autismo|tea|tdah|deficit|desobedece|birra|crise)/i.test(userText);
            const hasEmotionalTone = /(preocupada|desesperada|medo|difícil|sofrimento|sofrimento|triste|não sei o que fazer)/i.test(userText);
            
            if ((isComplaint || hasEmotionalTone) && !memory?.painAcknowledged) {
                // Acolher primeiro, depois perguntar o que falta
                const patientName = memory?.patientInfo?.name || memory?.patientName;
                const nameRef = patientName ? patientName.split(' ')[0] : (patientAge ? 'ele(a)' : 'seu filho');
                
                let acolhimento = '';
                if (hasEmotionalTone) {
                    acolhimento = `Entendo como você deve estar... Deve ser muito difícil ver ${nameRef} passando por isso. Você está fazendo o certo em buscar ajuda.`;
                } else {
                    acolhimento = `Sinto muito que ${nameRef} esteja passando por isso. Isso é algo que precisa de uma avaliação sim.`;
                }
                
                // Agora perguntar o que falta de forma suave
                const context = {
                    userName: memory?.name,
                    patientName,
                    patientAge,
                    therapyArea,
                    emotionalState: hasEmotionalTone ? 'ansioso' : 'calmo',
                    userText,
                };
                
                let pergunta = '';
                if (missing.needsAge && !patientAge) {
                    pergunta = 'Qual a idade dele(a)?';
                } else if (missing.needsPeriod) {
                    pergunta = 'De manhã ou à tarde funciona melhor pra vocês?';
                } else if (missing.needsComplaint) {
                    pergunta = 'Me conta: o que você tem observado que te preocupou?';
                } else {
                    pergunta = 'Me conta um pouco mais sobre o que você tem observado?';
                }
                
                return {
                    text: ensureSingleHeart(`${acolhimento}\n\n${pergunta}`),
                    extractedInfo: { 
                        painAcknowledged: true,
                        emotionalSupportProvided: true 
                    }
                };
            }
            
            // 🆕 SELEÇÃO DE TERAPIA (quando há múltiplas detectadas)
            if (missing.needsTherapySelection && decisionContext?.detectedTherapies?.length > 1) {
                const therapies = decisionContext.detectedTherapies;
                const therapyList = therapies.map((t, i) => `${String.fromCharCode(65 + i)}) ${t.charAt(0).toUpperCase() + t.slice(1)}`).join('\n');
                
                return {
                    text: `Vi que você tem autorização para várias terapias 💚\n\n${therapyList}\n\nQual delas você gostaria de agendar?`,
                    extractedInfo: { 
                        awaitingTherapySelection: true, 
                        lastQuestion: 'therapy_selection',
                        detectedTherapies: therapies
                    }
                };
            }
            
            if (!shouldAcknowledgeHistory && missing.needsTherapy) {
                return {
                    text: 'É pra qual área: Fono, Psicologia, Terapia Ocupacional ou Fisio? 💚',
                    extractedInfo: {}
                };
            }
            
            if (missing.needsAge) {
                return {
                    text: 'Qual a idade? 💚',
                    extractedInfo: { awaitingAge: true, lastQuestion: 'age' }
                };
            }
            
            if (missing.needsPeriod) {
                return {
                    text: 'De manhã ou à tarde? 💚',
                    extractedInfo: { awaitingPeriod: true, lastQuestion: 'period' }
                };
            }

            if (shouldAcknowledgeHistory) {
                objetivo = `Reconhecer que o lead voltou após ${daysSinceLastContact} dias. Mencione brevemente o contexto anterior (${therapyArea || 'a terapia'} para situação de ${memory?.primaryComplaint || 'saúde'} de ${patientAge || 'a criança'}) e pergunte se quer continuar de onde parou ou tem algo novo. Seja acolhedora e natural.`;
            } else {
                objetivo = 'Todas as informações foram coletadas. Agradecer e informar que vai verificar horários.';
            }

            // ===========================
            // 4️⃣ MONTA HISTÓRICO
            // ===========================
            const historyText = history.slice(-6).map(h =>
                `${h.role === 'user' ? 'Lead' : 'Amanda'}: ${h.content}`
            ).join('\n');

            // ===========================
            // 5️⃣ MONTA PROMPT
            // ===========================
            const systemPrompt = `Você é a Amanda, assistente virtual da Clínica Fono Inova.

            ${modules.join('\n\n')}

            REGRAS DE ESTILO:
            - Seja acolhedora, humana, nunca robótica
            - Use no MÁXIMO 2-3 frases curtas
            - Exatamente 1 💚 no final
            - Pode usar 1 emoji leve (😊, ✨) se fizer sentido
            - NUNCA repita perguntas já feitas no histórico
            - Se o lead já informou algo, reconheça e avance
            `.trim();

            const userPrompt = `
            CONTEXTO DO LEAD:
            - Nome: ${leadName || 'não informado'}
            - Idade do paciente: ${patientAge || 'não informada'}
            - Área de interesse: ${therapyArea || 'não informada'}
            - Primeiro contato: ${isFirstContact ? 'SIM' : 'NÃO'}
           ${shouldAcknowledgeHistory ? `CONTEXTO HISTÓRICO (lead retornou depois de ${daysSinceLastContact} dias):\n${conversationSummary.substring(0, 150)}...\n` : ''}

            ${shouldAcknowledgeHistory ? 'OBS: O lead voltou após algum tempo. Reconheça brevemente o contexto anterior antes de continuar.' : ''}

            HISTÓRICO RECENTE:
            ${historyText || '(primeira mensagem)'}

            ÚLTIMA MENSAGEM DO LEAD:
            "${message.text}"

           SEU OBJETIVO AGORA:
            ${shouldAcknowledgeHistory
                    ? `Reconhecer o retorno do lead mencionando brevemente o contexto anterior (${therapyArea || 'a terapia'} para ${patientAge || 'a criança'}) e perguntar se quer continuar de onde parou ou tem algo novo.`
                    : objetivo}

            Gere APENAS o texto da resposta (sem explicações, sem "Amanda:").
            `.trim();

            // ===========================
            // 6️⃣ CHAMA A LLM
            // ===========================
            const response = await callAI({
                systemPrompt,
                messages: [{ role: 'user', content: userPrompt }],
                maxTokens: 150,
                temperature: 0.7
            });

            const finalText = ensureSingleHeart(response || 'Posso te ajudar com mais alguma informação? 💚');
            
            this.logger.info('HANDLER_EXECUTE_COMPLETE', {
                durationMs: Date.now() - startTime,
                textLength: finalText.length,
                extractedInfoKeys: Object.keys(extractedInfo || {})
            });

            return {
                text: finalText,
                extractedInfo // 🆕 Retorna o estado de aguardo (awaitingAge/awaitingPeriod) se aplicável
            };

        } catch (error) {
            this.logger.error('HANDLER_EXECUTE_ERROR', {
                error: error.message,
                stack: error.stack,
                durationMs: Date.now() - startTime,
                action: decisionContext?.action
            });
            return {
                text: 'Me conta um pouquinho mais sobre o que você precisa? Estou aqui pra te ajudar 💚'
            };
        }
    }

    // ============================================================================
    // 🆕 MÉTODOS PARA FLUXO INTELIGENTE CONSULTORA PREMIUM
    // ============================================================================

    /**
     * 🛡️ Trata objeção com scripts progressivos (primary → secondary → lastResort)
     */
    handleObjection(objectionType, attempt, pendingCollection, memory) {
        // Busca script apropriado
        let script;
        if (attempt === 1) {
            script = getObjectionScript(objectionType, 'primary');
        } else if (attempt === 2) {
            script = getObjectionScript(objectionType, 'secondary');
        } else {
            script = getObjectionScript(objectionType, 'lastResort') || getObjectionScript(objectionType, 'secondary');
        }
        
        return {
            text: ensureSingleHeart(script),
            extractedInfo: { 
                objectionHandled: objectionType, 
                objectionAttempt: attempt,
                painAcknowledged: true
            }
        };
    }

    /**
     * 💚 Acolhimento emocional quando lead expressa dor/preocupação
     */
    handleEmotionalAcknowledgment(pendingCollection, memory) {
        const patientName = memory?.patientInfo?.name || memory?.patientName;
        const nameRef = patientName ? `o(a) ${patientName.split(' ')[0]}` : 'seu filho';
        
        const acknowledgment = `Entendo sua preocupação 💚 Você fez muito bem em buscar orientação cedo — isso faz toda diferença pro desenvolvimento de ${nameRef}.`;
        
        return {
            text: ensureSingleHeart(acknowledgment),
            extractedInfo: { 
                painAcknowledged: true,
                emotionalSupportProvided: true
            }
        };
    }

    /**
     * 💰 Constrói resposta de preço: VALOR DO TRABALHO → URGÊNCIA → PREÇO
     */
    buildPriceResponse(memory, flags = {}) {
        const therapy = memory?.therapyArea || 'avaliação';
        const age = memory?.patientAge || memory?.patientInfo?.age;
        const complaint = memory?.complaint || memory?.primaryComplaint;
        
        // 1️⃣ VALOR DO TRABALHO (explicar o que o lead vai receber)
        const valuePitch = this.getValuePitch(therapy, age);
        
        // 2️⃣ URGÊNCIA CONTEXTUAL (se tiver idade)
        const urgencyPitch = this.getUrgencyPitch(age, therapy, complaint);
        
        // 3️⃣ PREÇO
        const pricePitch = this.getPricePitch(therapy);
        
        // Montar resposta completa
        let response = valuePitch;
        if (urgencyPitch) response += ` ${urgencyPitch}`;
        response += ` ${pricePitch}`;
        
        return response.trim();
    }

    /**
     * Explica o VALOR do trabalho por especialidade
     */
    getValuePitch(therapy, age) {
        const pitches = {
            'fonoaudiologia': 'A avaliação fonoaudiológica mapeia exatamente onde seu filho precisa de estímulo — vocês saem com um plano personalizado pro desenvolvimento da fala, não é só uma consulta.',
            'fono': 'A avaliação fonoaudiológica mapeia exatamente onde seu filho precisa de estímulo — vocês saem com um plano personalizado pro desenvolvimento da fala, não é só uma consulta.',
            
            'psicologia': 'A avaliação psicológica entende o que está por trás do comportamento e dá um direcionamento claro pra família — vocês saem com orientações práticas pra aplicar no dia a dia.',
            'psico': 'A avaliação psicológica entende o que está por trás do comportamento e dá um direcionamento claro pra família — vocês saem com orientações práticas pra aplicar no dia a dia.',
            
            'neuropsicologia': 'A avaliação neuropsicológica é completa: mapeamos atenção, memória, raciocínio e comportamento. Vocês recebem um laudo detalhado que serve pra escola, médicos e tratamentos.',
            'neuropsi': 'A avaliação neuropsicológica é completa: mapeamos atenção, memória, raciocínio e comportamento. Vocês recebem um laudo detalhado que serve pra escola, médicos e tratamentos.',
            
            'terapia_ocupacional': 'A avaliação de TO identifica as dificuldades sensoriais e de coordenação, e monta um plano pra ele ganhar mais autonomia nas atividades do dia a dia.',
            'to': 'A avaliação de TO identifica as dificuldades sensoriais e de coordenação, e monta um plano pra ele ganhar mais autonomia nas atividades do dia a dia.',
            
            'fisioterapia': 'A avaliação de fisioterapia analisa postura, equilíbrio e coordenação motora — saímos com um plano específico pro desenvolvimento motor dele.',
            'fisio': 'A avaliação de fisioterapia analisa postura, equilíbrio e coordenação motora — saímos com um plano específico pro desenvolvimento motor dele.',
            
            'musicoterapia': 'A avaliação de musicoterapia identifica como a música pode ajudar no desenvolvimento emocional e social — é uma abordagem lúdica e efetiva.',
            
            'psicopedagogia': 'A avaliação psicopedagógica mapeia as dificuldades de aprendizagem e cria estratégias personalizadas pra escola e estudos.',
            
            'default': 'A avaliação é completa e personalizada — vocês saem com um plano claro do que fazer, não é só uma consulta.'
        };
        
        return pitches[therapy?.toLowerCase()] || pitches['default'];
    }

    /**
     * Frase de urgência contextual por idade
     */
    getUrgencyPitch(age, therapy, complaint) {
        if (!age) return '';
        
        const ageNum = parseInt(age, 10);
        if (isNaN(ageNum)) return '';
        
        if (ageNum <= 6) {
            return 'Nessa fase, cada mês faz diferença pro desenvolvimento!';
        } else if (ageNum <= 12) {
            return 'É uma fase importante pra não deixar acumular dificuldades.';
        } else if (ageNum <= 17) {
            return 'Esse momento é chave pra recuperar o ritmo antes do vestibular/ENEM.';
        } else if (complaint?.includes('diagnóstico') || complaint?.includes('laudo') || therapy?.includes('neuro')) {
            return 'O laudo abre portas pra você entender melhor seus desafios e ter os suportes necessários.';
        }
        
        return '';
    }

    /**
     * Preço formatado como "investimento"
     */
    getPricePitch(therapy) {
        if (therapy?.includes('neuropsi') || therapy?.includes('neuropsicologia')) {
            return 'O investimento é R$ 2.500 (em até 6x) ou R$ 2.300 à vista — inclui todas as sessões e o laudo completo.';
        }
        return 'O investimento na avaliação é R$ 220.';
    }
}

export default new LeadQualificationHandler();