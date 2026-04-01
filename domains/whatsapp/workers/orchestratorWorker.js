// back/domains/whatsapp/workers/orchestratorWorker.js
/**
 * Orchestrator Worker (Amanda AI)
 * 
 * Papel: Cérebro da Amanda - decide respostas baseado em contexto
 * 
 * Evento Consumido: ORCHESTRATOR_RUN_REQUESTED
 * Evento Publicado: NOTIFICATION_REQUESTED (com resposta decidida)
 * 
 * Regras:
 * - RN-WHATSAPP-009: Context window (últimas 12 mensagens)
 * - RN-WHATSAPP-010: First contact detection (novo lead)
 * - RN-WHATSAPP-011: Intent classification (classificar intenção)
 * - RN-WHATSAPP-012: Escalation rules (quando chamar humano)
 */

import { Worker } from 'bullmq';
import { getRedisConnection } from '../../../infra/redis/redisClient.js';
import { logger } from '../../../infra/logger.js';

const CONTEXT_WINDOW_SIZE = 12;
const MAX_RESPONSE_TIME_MS = 5000; // Timeout para IA

/**
 * Cria o Orchestrator Worker
 * 
 * @param {Object} deps - Dependências
 * @param {Object} deps.aiService - Serviço de IA (OpenAI/Claude)
 * @param {Object} deps.redis - Cliente Redis
 * @param {Function} deps.publishEvent - Função para publicar eventos
 */
export function createOrchestratorWorker(deps) {
  const { aiService, redis, publishEvent } = deps;

  return new Worker(
    'whatsapp-orchestrator',
    async (job) => {
      const { eventId, payload, metadata } = job.data;
      const { leadContext, message, originalEventId } = payload;
      const { phone, leadId, isNewLead, previousContext } = leadContext;
      const correlationId = metadata?.correlationId || eventId;

      logger.info('[OrchestratorWorker] Processing', {
        phone,
        isNewLead,
        messageLength: message?.length,
        correlationId
      });

      const startTime = Date.now();

      try {
        // RN-WHATSAPP-010: First contact detection
        if (isNewLead) {
          logger.info('[OrchestratorWorker] First contact detected', { phone });
          
          const welcomeResponse = await generateWelcomeResponse(leadContext, aiService);
          
          await publishNotificationEvent(publishEvent, {
            originalEventId,
            phone,
            leadId,
            response: welcomeResponse,
            isNewLead: true,
            correlationId
          });

          return {
            status: 'completed',
            decision: 'welcome_new_lead',
            responseLength: welcomeResponse.length,
            processingTime: Date.now() - startTime
          };
        }

        // RN-WHATSAPP-009: Context window (últimas 12 mensagens)
        const contextWindow = await buildContextWindow(redis, leadId, CONTEXT_WINDOW_SIZE);
        
        logger.debug('[OrchestratorWorker] Context window built', {
          leadId,
          messageCount: contextWindow.length
        });

        // RN-WHATSAPP-011: Intent classification
        const intent = await classifyIntent(message, contextWindow, aiService);
        
        logger.info('[OrchestratorWorker] Intent classified', {
          phone,
          intent: intent.type,
          confidence: intent.confidence
        });

        // RN-WHATSAPP-012: Escalation rules
        const shouldEscalate = checkEscalationRules(intent, contextWindow);
        
        if (shouldEscalate) {
          logger.warn('[OrchestratorWorker] Escalating to human', {
            phone,
            reason: shouldEscalate.reason,
            intent: intent.type
          });

          await escalateToHuman(redis, phone, leadId, {
            reason: shouldEscalate.reason,
            message,
            intent
          });

          const escalationMessage = await generateEscalationMessage(leadContext, aiService);
          
          await publishNotificationEvent(publishEvent, {
            originalEventId,
            phone,
            leadId,
            response: escalationMessage,
            isEscalation: true,
            escalationReason: shouldEscalate.reason,
            correlationId
          });

          return {
            status: 'escalated',
            decision: 'human_handoff',
            reason: shouldEscalate.reason,
            processingTime: Date.now() - startTime
          };
        }

        // Decisão normal - gerar resposta
        const response = await generateAIResponse({
          message,
          contextWindow,
          intent,
          leadContext
        }, aiService);

        // Verifica timeout
        const processingTime = Date.now() - startTime;
        if (processingTime > MAX_RESPONSE_TIME_MS) {
          logger.warn('[OrchestratorWorker] Response time exceeded', {
            phone,
            processingTime
          });
        }

        await publishNotificationEvent(publishEvent, {
          originalEventId,
          phone,
          leadId,
          response: response.text,
          intent: intent.type,
          actions: response.actions,
          correlationId
        });

        logger.info('[OrchestratorWorker] Response generated', {
          phone,
          intent: intent.type,
          responseLength: response.text.length,
          processingTime
        });

        return {
          status: 'completed',
          decision: 'ai_response',
          intent: intent.type,
          responseLength: response.text.length,
          processingTime
        };

      } catch (error) {
        logger.error('[OrchestratorWorker] Error', {
          error: error.message,
          phone,
          correlationId
        });

        // Fallback: mensagem genérica de erro
        try {
          const fallbackMessage = "Desculpe, estou com dificuldades técnicas no momento. Um atendente humano vai te ajudar em breve.";
          
          await publishNotificationEvent(publishEvent, {
            originalEventId,
            phone,
            leadId,
            response: fallbackMessage,
            isFallback: true,
            correlationId
          });
        } catch (publishError) {
          logger.error('[OrchestratorWorker] Failed to publish fallback', {
            error: publishError.message
          });
        }

        throw error; // Requeue para retry
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 5, // Limitado por chamadas de IA
      limiter: {
        max: 30,
        duration: 1000
      }
    }
  );
}

// ============================================
// HELPERS
// ============================================

async function generateWelcomeResponse(leadContext, aiService) {
  const prompt = `Você é Amanda, assistente virtual de uma clínica médica. 
    Este é o primeiro contato do lead ${leadContext.phone}.
    Crie uma mensagem de boas-vindas calorosa, profissional e breve.
    Pergunte o nome da pessoa e como pode ajudar.`;

  return await aiService.generateResponse(prompt, { maxTokens: 150 });
}

async function buildContextWindow(redis, leadId, limit) {
  if (!leadId) return [];
  
  const key = `context:whatsapp:${leadId}`;
  const messages = await redis.lrange(key, 0, limit - 1);
  
  return messages.map(m => JSON.parse(m)).reverse(); // Mais antigo primeiro
}

async function classifyIntent(message, contextWindow, aiService) {
  const prompt = `Classifique a intenção da mensagem abaixo em uma das categorias:
    - AGENDAMENTO (marcar/cancelar/consulta)
    - INFORMACAO (dúvidas sobre serviços)
    - EMERGENCIA (urgência médica)
    - RECLAMACAO (insatisfação)
    - FINANCEIRO (pagamento/convênio)
    - SAUDACAO (cumprimentos)
    - OUTRO
    
    Contexto: ${contextWindow.slice(-3).map(m => m.text).join('\n')}
    Mensagem: ${message}
    
    Responda apenas com: CATEGORIA|confiança(0-1)`;

  try {
    const result = await aiService.generateResponse(prompt, { maxTokens: 20 });
    const [type, confidence] = result.split('|');
    
    return {
      type: type?.trim() || 'OUTRO',
      confidence: parseFloat(confidence) || 0.5
    };
  } catch (error) {
    logger.warn('[OrchestratorWorker] Intent classification failed', { error: error.message });
    return { type: 'OUTRO', confidence: 0.5 };
  }
}

function checkEscalationRules(intent, contextWindow) {
  // Emergência médica - sempre escalar
  if (intent.type === 'EMERGENCIA') {
    return { escalate: true, reason: 'emergency_detected' };
  }

  // Confiança baixa na intenção
  if (intent.confidence < 0.4) {
    return { escalate: true, reason: 'low_confidence' };
  }

  // Muitas mensagens do usuário sem resolução (> 5 trocas)
  const userMessages = contextWindow.filter(m => m.from === 'user');
  if (userMessages.length > 5) {
    return { escalate: true, reason: 'too_many_exchanges' };
  }

  // Reclamação grave
  if (intent.type === 'RECLAMACAO' && intent.confidence > 0.8) {
    return { escalate: true, reason: 'complaint' };
  }

  return { escalate: false };
}

async function escalateToHuman(redis, phone, leadId, context) {
  const key = `escalation:whatsapp:${leadId || phone}`;
  await redis.setex(key, 3600, JSON.stringify({
    phone,
    leadId,
    ...context,
    escalatedAt: new Date().toISOString()
  }));
}

async function generateEscalationMessage(leadContext, aiService) {
  return "Entendo. Vou transferir você para um de nossos atendentes que poderá te ajudar melhor. Por favor, aguarde um momento. 🙏";
}

async function generateAIResponse({ message, contextWindow, intent, leadContext }, aiService) {
  const systemPrompt = `Você é Amanda, assistente virtual simpática e profissional de uma clínica médica.
    Contexto do lead: ${JSON.stringify(leadContext, null, 2)}
    Intenção detectada: ${intent.type}
    
    Responda de forma natural, útil e breve (máx 2 parágrafos).
    Se não souber algo, seja honesta e ofereça conectar com um humano.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...contextWindow.map(m => ({
      role: m.from === 'user' ? 'user' : 'assistant',
      content: m.text
    })),
    { role: 'user', content: message }
  ];

  const response = await aiService.chat(messages, { maxTokens: 300 });
  
  return {
    text: response,
    actions: [] // TODO: Extrair ações (agendamento, etc)
  };
}

async function publishNotificationEvent(publishEvent, data) {
  await publishEvent('NOTIFICATION_REQUESTED', {
    originalEventId: data.originalEventId,
    phone: data.phone,
    leadId: data.leadId,
    message: data.response,
    metadata: {
      isNewLead: data.isNewLead,
      isEscalation: data.isEscalation,
      isFallback: data.isFallback,
      intent: data.intent,
      actions: data.actions,
      escalationReason: data.escalationReason
    },
    correlationId: data.correlationId
  }, { correlationId: data.correlationId });
}

// ============================================
// REGRAS DOCUMENTADAS
// ============================================

export const OrchestratorRules = {
  'RN-WHATSAPP-009': 'Context window - manter últimas 12 mensagens para contexto',
  'RN-WHATSAPP-010': 'First contact detection - tratamento especial para novos leads',
  'RN-WHATSAPP-011': 'Intent classification - classificar intenção do usuário',
  'RN-WHATSAPP-012': 'Escalation rules - regras para transferir para humano'
};

export default createOrchestratorWorker;
