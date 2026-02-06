/**
 * 🧠 SmartFallback Service (Amanda 4.2.5)
 * 
 * Quando o sistema não sabe o que fazer (fallback genérico),
 * chama Claude para decidir baseado no contexto completo.
 * 
 * Filosofia: Não muda o que funciona, só salva quando ia quebrar.
 */

import callAI from '../IA/Aiproviderservice.js';
import Logger from '../utils/Logger.js';

const logger = new Logger('SmartFallback');

// 🎯 Prompt expandido com instruções por cenário (conciso, não manual)
const FALLBACK_SYSTEM_PROMPT = `Você é Amanda, assistente virtual da Clínica Fono Inova.

CONTEXTO: O sistema automatizado não entendeu a intenção do usuário. Analise o histórico e decida a melhor ação.

## 💰 DADOS DA CLÍNICA
- Av. Minas Gerais, 405 - Jundiaí, Anápolis/GO
- Avaliação R$220 | Sessão R$220 | Pacote 4x R$720
- Especialidades: Fono, Psico, TO, Fisio, Neuropsi, Musicoterapia
- Seg-Sex 8h-18h (manhã/tarde)

## 🎯 CENÁRIOS CRÍTICOS (detecte pelo contexto)

### Warm Recall (retorno 48h+)
SINAIS: últimaInteração > 48h, lead tem dados coletados
AÇÃO: "acknowledge_continue" com reconhecimento do retorno + resumo do contexto anterior

### Pai Ansioso (mensagens longas/emocionais)
SINAIS: texto longo, palavras como "desesperada", "não sei o que fazer", "piorando"
AÇÃO: "acknowledge_continue" com acolhimento profundo ANTES de qualquer pergunta

### Resposta Curta ("ok", "sim", "manhã")
SINAIS: mensagem curta (< 20 chars), histórico mostra que Amanda fez pergunta recente
AÇÃO: "interpret_reply" - o usuário está respondendo a última pergunta
EXEMPLO: Se última pergunta foi "manhã ou tarde?" e disse "manhã", extrair period="manha"

### Retorno Após Meses
SINAIS: últimaInteração > 30 dias, isExistingPatient=true
AÇÃO: "acknowledge_continue" perguntando se situação mudou, reconhecendo vínculo

### Já é Paciente (nova terapia)
SINAIS: isExistingPatient=true, mensagem menciona "quero começar [outra área]"
AÇÃO: "acknowledge_continue" facilitando agendamento (menos perguntas, reconhece vínculo)

### Objeção de Preço/Desistência
SINAIS: "vou pensar", "tá caro", "não dá agora", ou objectionsHistory não vazio
AÇÃO: "acknowledge_continue" mostrando valor (não desconto) + deixando porta aberta

## 📋 AÇÕES POSSÍVEIS
- "interpret_reply": Usuário respondendo pergunta anterior → extrair campo
- "ask_clarification": Perguntar de outra forma (não entendeu)
- "answer_question": Responder pergunta direta
- "acknowledge_continue": Acolher e continuar coleta
- "show_slots": Quer agendar e tem dados suficientes
- "warm_handoff": Transferir para humano (frustração explícita: "quero falar com pessoa")

## 📝 REGRAS DE RESPOSTA
- MÁXIMO 2-3 frases curtas
- Terminar com exatamente 1 💚
- NUNCA repetir pergunta já feita no histórico
- Se detectar frustração explícita → ação "warm_handoff"

## 📤 RETORNE JSON:
{
  "detected_intent": "descrição curta",
  "action": "uma das ações acima",
  "confidence": 0.0-1.0,
  "response": "mensagem para WhatsApp",
  "field_extracted": "period|age|complaint|therapy|null",
  "field_value": "valor extraído ou null",
  "reasoning": "por que escolhi isso (1 frase)"
}`;

/**
 * 🧠 SmartFallback - Decide quando o sistema padrão não sabe o que fazer
 */
export async function smartFallback({
    userMessage,
    history = [],
    leadData = {},
    enrichedContext = {}  // 🆕 NOVO: dados enriquecidos do Orchestrator
}) {
    const startTime = Date.now();
    
    logger.info('SMARTFALLBACK_TRIGGERED', {
        leadId: leadData?._id,
        userMessage: userMessage?.substring(0, 50),
        historyLength: history.length,
        isExistingPatient: enrichedContext?.isExistingPatient,
        hoursSinceLastContact: enrichedContext?.hoursSinceLastContact
    });

    try {
        // 📝 Monta contexto rico
        const contextMessage = buildContextMessage({
            userMessage,
            history,
            leadData,
            enrichedContext
        });

        // 🎯 Chama Claude
        const aiResponse = await callAI({
            systemPrompt: FALLBACK_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: contextMessage }],
            maxTokens: 350,
            temperature: 0.4  // Mais determinístico
        });

        // 🔍 Parse JSON
        let decision = parseDecision(aiResponse);

        // ✅ Validação
        const validActions = ['interpret_reply', 'ask_clarification', 'answer_question', 
                             'acknowledge_continue', 'show_slots', 'warm_handoff'];
        if (!validActions.includes(decision.action)) {
            decision.action = 'ask_clarification';
            decision.confidence = Math.min(decision.confidence, 0.3);
        }

        // 📊 Log estruturado
        const duration = Date.now() - startTime;
        logger.info('SMARTFALLBACK_DECISION', {
            leadId: leadData?._id,
            action: decision.action,
            confidence: decision.confidence,
            detected_intent: decision.detected_intent,
            field_extracted: decision.field_extracted,
            duration_ms: duration
        });

        return {
            used: true,
            action: decision.action,
            text: decision.response,
            confidence: decision.confidence,
            extractedInfo: buildExtractedInfo(decision),
            meta: {
                detected_intent: decision.detected_intent,
                reasoning: decision.reasoning,
                duration_ms: duration
            }
        };

    } catch (error) {
        logger.error('SMARTFALLBACK_ERROR', { leadId: leadData?._id, error: error.message });
        
        return {
            used: true,
            action: 'ask_clarification',
            text: 'Desculpe, não entendi direito. Pode me contar de outra forma? 💚',
            confidence: 0.0,
            extractedInfo: { smartFallbackError: true },
            meta: { error: error.message }
        };
    }
}

/**
 * 📝 Monta mensagem de contexto completa para o Claude
 */
function buildContextMessage({ userMessage, history, leadData, enrichedContext }) {
    const recentHistory = history.slice(-6);
    
    // Formata histórico
    let historyText = '';
    if (recentHistory.length > 0) {
        historyText = '\n## HISTÓRICO:\n' + 
            recentHistory.map(h => `${h.role === 'user' ? 'CLIENTE' : 'AMANDA'}: ${h.content?.substring(0, 100)}`).join('\n');
    }

    // Dados do lead (enxuto)
    const leadInfo = [
        `Nome: ${leadData?.name || 'não informado'}`,
        leadData?.therapyArea && `Terapia: ${leadData.therapyArea}`,
        leadData?.patientInfo?.age && `Idade: ${leadData.patientInfo.age}`,
        leadData?.primaryComplaint && `Queixa: ${leadData.primaryComplaint.substring(0, 50)}`,
        enrichedContext?.lastContext?.awaitingField && `Aguardando: ${enrichedContext.lastContext.awaitingField}`
    ].filter(Boolean).join(' | ');

    // Contexto temporal e relacional (CRÍTICO para cenários 3, 11, 13)
    let temporalContext = '';
    if (enrichedContext?.hoursSinceLastContact) {
        const hours = enrichedContext.hoursSinceLastContact;
        if (hours > 720) { // 30 dias
            temporalContext = `\n## TEMPO: Retorno após ${Math.round(hours/720)} meses`;
        } else if (hours > 48) {
            temporalContext = `\n## TEMPO: Retorno após ${Math.round(hours/24)} dias (warm recall)`;
        }
    }

    // Status de paciente (CRÍTICO para cenários 11, 13)
    let patientContext = '';
    if (enrichedContext?.isExistingPatient) {
        const appts = enrichedContext.recentAppointments || [];
        const lastAppt = appts[0];
        patientContext = `\n## PACIENTE: Sim (vínculo existente)`;
        if (lastAppt) {
            patientContext += ` | Último: ${lastAppt.therapyArea || 'atendimento'} em ${lastAppt.date?.substring(0, 10) || 'data anterior'}`;
        }
    }

    // Contexto de objeção (CRÍTICO para cenário 14)
    let objectionContext = '';
    if (enrichedContext?.objectionsHistory?.length > 0) {
        objectionContext = `\n## OBJEÇÕES ANTERIORES: ${enrichedContext.objectionsHistory.join(', ')}`;
    }

    return `## LEAD: ${leadInfo}${temporalContext}${patientContext}${objectionContext}${historyText}

## ÚLTIMA MENSAGEM AMANDA:
"""${enrichedContext?.lastAmandaMessage || '(início)'}"""

## MENSAGEM ATUAL:
"""${userMessage}"""

## DECIDA:
Retorne JSON com ação e resposta.`;
}

/**
 * 🔍 Parse seguro da resposta do Claude
 */
function parseDecision(aiResponse) {
    try {
        const jsonMatch = aiResponse.match(/```json\n?([\s\S]*?)\n?```/) || 
                          aiResponse.match(/\{[\s\S]*\}/);
        const jsonStr = jsonMatch ? jsonMatch[1] || jsonMatch[0] : aiResponse;
        const parsed = JSON.parse(jsonStr);
        
        return {
            detected_intent: parsed.detected_intent || 'unknown',
            action: parsed.action || 'ask_clarification',
            confidence: parseFloat(parsed.confidence) || 0.5,
            response: parsed.response || 'Como posso te ajudar? 💚',
            field_extracted: parsed.field_extracted || null,
            field_value: parsed.field_value || null,
            reasoning: parsed.reasoning || 'default'
        };
    } catch (err) {
        logger.error('SMARTFALLBACK_PARSE_ERROR', { error: err.message, response: aiResponse?.substring(0, 100) });
        return {
            detected_intent: 'parse_error',
            action: 'ask_clarification',
            confidence: 0.1,
            response: 'Desculpe, não entendi. Pode reformular? 💚',
            field_extracted: null,
            field_value: null,
            reasoning: 'parse_error'
        };
    }
}

/**
 * 📦 Monta extractedInfo baseado na decisão
 */
function buildExtractedInfo(decision) {
    const info = { smartFallbackUsed: true };
    
    if (decision.field_extracted && decision.field_value) {
        info[decision.field_extracted] = decision.field_value;
        info.smartFallbackExtracted = true;
        info.confidence = decision.confidence;
    }
    
    return info;
}

/**
 * 📊 Métricas
 */
export function getSmartFallbackStats() {
    return {
        implemented: true,
        version: '4.2.5',
        description: 'Fallback inteligente com contexto enriquecido'
    };
}

export default { smartFallback, getSmartFallbackStats };
