/**
 * services/orchestrator/runOrchestrator.js
 *
 * Lógica de decisão de resposta da Amanda (FSM nova ou legado).
 *
 * Extraído de whatsappController.js — remove acoplamento circular entre
 * whatsappAutoReplyWorker → whatsappController.
 *
 * Depende de:
 *   orchestrators/WhatsAppOrchestrator.js   (FSM V8 — única rota ativa)
 */

import WhatsAppOrchestrator from '../../orchestrators/WhatsAppOrchestrator.js';
import { createContextLogger } from '../../utils/logger.js';

const logger = createContextLogger('runOrchestrator');

// Singleton — evita overhead de instanciação por mensagem
const fsmOrchestrator = new WhatsAppOrchestrator();


// ─────────────────────────────────────────────────────────────────────────────
// CLASSIFICAÇÃO INTELIGENTE DE LEAD (persona + intenção)
// ─────────────────────────────────────────────────────────────────────────────

function mapTherapyToDor(especialidade) {
    const dorMap = {
        fonoaudiologia:      'atraso_fala_comunicacao',
        psicologia:          'comportamento_emocional',
        neuropsicologia:     'aprendizagem_cognitivo',
        terapia_ocupacional: 'sensorial_motricidade',
        fisioterapia:        'desenvolvimento_motor',
        musicoterapia:       'estimulacao_emocional',
    };
    return dorMap[especialidade] || 'descoberta';
}

function calcularEstagio(lead) {
    const score    = lead.qualificationData?.score || 0;
    const msgCount = lead.messagesCount || lead.messageCount || 0;
    const hasIntent = lead.qualificationData?.intent;

    if (score >= 80 || hasIntent === 'agendar') return 'quente';
    if (score >= 50 || msgCount >= 3)            return 'morno';
    if (score >= 20 || msgCount >= 1)            return 'consideracao';
    return 'frio';
}

function detectarObjecao(extractedInfo) {
    const text = JSON.stringify(extractedInfo || {}).toLowerCase();

    if (/tarde|futuro|esperar|ainda|pequen|novo|tempo/i.test(text))       return 'fase';
    if (/marido|esposa|mae|pai|familia|decidir|decisao/i.test(text))      return 'marido';
    if (/caro|valor|preco|gratis|plano|dinheiro/i.test(text))             return 'preco';
    if (/longe|distancia|bairro|endereco/i.test(text))                    return 'local';
    if (/outro|clinica|concorrente/i.test(text))                          return 'concorrente';
    return null;
}

function selecionarPersona(classificacao) {
    const { estagio, objecao, emocao } = classificacao;

    if (estagio === 'frio') {
        return { nome: 'Educadora',    instrucao: 'Explique de forma leve, sem pressionar. Gere curiosidade. Use exemplos do dia a dia.' };
    }
    if (estagio === 'quente') {
        return { nome: 'Fechadora',    instrucao: 'Seja direta e gentil. Conduza para agendamento com clareza. Elimine atritos.' };
    }
    if (objecao === 'fase') {
        return { nome: 'Quebradora',   instrucao: 'Valide primeiro ("entendo a preocupação"), depois corrija a crença com dados concretos e cuidado.' };
    }
    if (objecao === 'marido') {
        return { nome: 'Empoderadora', instrucao: 'Dê segurança e argumentos para decisão. Ofereça materiais para compartilhar.' };
    }
    if (emocao === 'ansioso' || emocao === 'preocupado') {
        return { nome: 'Validadora',   instrucao: 'Acolha profundamente. Não minimize. Demonstre que entende a urgência emocional.' };
    }
    return { nome: 'Validadora',       instrucao: 'Acolha e incentive a pessoa a compartilhar mais. Seja receptiva e calorosa.' };
}


// ─────────────────────────────────────────────────────────────────────────────
// FUNÇÃO PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decide e gera a resposta da Amanda para um lead.
 *
 * @param {object} lead       — documento do lead (preferencialmente fresh do banco)
 * @param {string} userText   — texto do usuário (pode ser transcrito de áudio)
 * @param {object} context    — contexto enriquecido (preferredPeriod, therapy, etc.)
 * @returns {Promise<{ command: 'SEND_MESSAGE'|'NO_REPLY', payload?: { text: string } }>}
 */
export async function runOrchestrator(lead, userText, context = {}) {
    const leadId = lead?._id;

    // Monta classificação inteligente
    const classificacao = {
        dor_principal: mapTherapyToDor(lead.qualificationData?.extractedInfo?.especialidade),
        estagio:       calcularEstagio(lead),
        emocao:        lead.qualificationData?.sentiment || 'neutro',
        intencao:      lead.qualificationData?.intent    || 'informacao',
        objecao:       detectarObjecao(lead.qualificationData?.extractedInfo),
    };

    const persona = selecionarPersona(classificacao);

    const enrichedContext = {
        ...context,
        inteligencia: { classificacao, persona },
    };

    logger.info('lead_intelligence', {
        leadId,
        estagio:  classificacao.estagio,
        emocao:   classificacao.emocao,
        persona:  persona.nome,
        correlationId: context.correlationId,
    });

    logger.info('orchestrator_fsm', { leadId, currentState: lead.currentState });

    const result = await fsmOrchestrator.process({
        lead,
        message: { content: userText },
        context: enrichedContext,
    });

    logger.info('orchestrator_fsm_result', { leadId, command: result?.command });
    return result;
}
