// domains/whatsapp/workers/intentClassifierWorker.js
/**
 * Intent Classifier Worker
 *
 * Papel: Classificar a intenção de uma resposta a um follow-up
 *
 * Evento Consumido: FOLLOWUP_RESPONSE_RECEIVED
 * Evento Publicado: INTENT_CLASSIFIED
 *
 * Intents possíveis:
 *   STOP     → usuário não quer mais ser contactado
 *   SCHEDULE → usuário quer agendar
 *   PRICING  → usuário pergunta preço/convênio
 *   DELAY    → usuário quer mas "não agora"
 *   UNKNOWN  → não foi possível determinar intenção clara
 */

import { Worker } from 'bullmq';
import { bullMqConnection } from '../../../config/redisConnection.js';
import { moveToDLQ } from '../../../infrastructure/queue/queueConfig.js';
import logger from '../../../utils/logger.js';
import Message from '../../../models/Message.js';
import { publishEvent, EventTypes } from '../../../infrastructure/events/eventPublisher.js';

// ─── Padrões de Classificação ────────────────────────────────────────────────

const PATTERNS = {
  STOP: [
    /não\s*quero\s*(mais)?/i,
    /me\s*tira\s*da?\s*(lista)?/i,
    /para\s+de\s+me\s+(mandar|enviar|chamar)/i,
    /cancela\s*(isso)?/i,
    /desisto/i,
    /n[aã]o\s*me\s*interessa/i,
    /n[aã]o\s*tenho\s*interesse/i,
    /stop\b/i,
    /remove\s+meu\s+n[uú]mero/i,
    /sair\s+da\s+lista/i,
    /chega\b/i,
    /p[aá]ra\s+de\s+(me\s+)?(ligar|mandar|incomodar)/i,
  ],
  SCHEDULE: [
    /quero\s+agendar/i,
    /quero\s+marcar/i,
    /pode\s+marcar/i,
    /pode\s+agendar/i,
    /vamos\s+agendar/i,
    /hor[aá]rio\s+(disponível|livre|vago)/i,
    /tem\s+vaga/i,
    /quando\s+(tem|tem\s+horário|posso)/i,
    /consulta\s+(dispon[ií]vel|livre)/i,
    /topei?\b/i,
    /sim\s*,?\s*quero/i,
    /quero\s+sim/i,
    /bora\s+marcar/i,
    /me\s+agenda\b/i,
  ],
  PRICING: [
    /quanto\s+(custa|é|fica|cobram?)/i,
    /qual\s+[eo]\s+(valor|pre[çc]o|custo)/i,
    /pre[çc]o\b/i,
    /valor\b/i,
    /plano\b/i,
    /conv[eê]nio\b/i,
    /particular\b/i,
    /aceita[m]?\s+conv[eê]nio/i,
    /tem\s+conv[eê]nio/i,
    /unimed|bradesco\s+sa[uú]de|amil|s[uú]lprev/i,
  ],
  DELAY: [
    /mais\s+tarde/i,
    /depois\b/i,
    /agora\s+n[aã]o/i,
    /semana\s+que\s+vem/i,
    /pr[oó]xima?\s+semana/i,
    /pr[oó]ximo\s+m[eê]s/i,
    /em\s+outro\s+momento/i,
    /n[aã]o\s+agora/i,
    /daqui?\s+(a\s+)?(uns|algum|pouco|tempo)/i,
    /ainda\s+n[aã]o\s+to?u?\s+pronto/i,
    /me\s+fala\s+(depois|mais\s+tarde)/i,
  ],
};

/**
 * Classifica o texto da mensagem
 * @param {string} text
 * @returns {{ intent: string, confidence: 'HIGH'|'LOW', matchedPattern: string|null }}
 */
function classifyText(text) {
  if (!text || typeof text !== 'string') {
    return { intent: 'UNKNOWN', confidence: 'LOW', matchedPattern: null };
  }

  const normalized = text.trim().toLowerCase();

  for (const [intent, patterns] of Object.entries(PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(normalized)) {
        return {
          intent,
          confidence: 'HIGH',
          matchedPattern: pattern.source,
        };
      }
    }
  }

  return { intent: 'UNKNOWN', confidence: 'LOW', matchedPattern: null };
}

// ─── Worker ──────────────────────────────────────────────────────────────────

export function createIntentClassifierWorker() {
  return new Worker(
    'whatsapp-intent-classifier',
    async (job) => {
      const { eventId, payload, metadata } = job.data;
      const { leadId, messageId, followupId } = payload;
      const correlationId = metadata?.correlationId || eventId;

      logger.info('[IntentClassifier] Processing', { leadId, messageId, followupId, correlationId });

      // 1. Buscar texto da mensagem
      let messageText = '';
      if (messageId) {
        const msg = await Message.findById(messageId).select('content direction').lean();
        if (!msg) {
          logger.warn('[IntentClassifier] Message not found — classifying as UNKNOWN', { messageId });
        } else if (msg.direction !== 'inbound') {
          logger.warn('[IntentClassifier] Message is outbound — skip', { messageId });
          return { status: 'skipped', reason: 'OUTBOUND_MESSAGE' };
        } else {
          messageText = msg.content || '';
        }
      }

      // 2. Classificar intenção
      const { intent, confidence, matchedPattern } = classifyText(messageText);

      logger.info('[IntentClassifier] Classified', {
        leadId,
        intent,
        confidence,
        matchedPattern,
        textSnippet: messageText.substring(0, 80),
      });

      // 3. Publicar INTENT_CLASSIFIED
      await publishEvent(
        EventTypes.INTENT_CLASSIFIED,
        {
          leadId: leadId?.toString(),
          messageId: messageId?.toString(),
          followupId: followupId?.toString(),
          intent,
          confidence,
          matchedPattern,
          originalText: messageText.substring(0, 500), // cap para evitar payload gigante
        },
        {
          correlationId,
          aggregateType: 'lead',
          aggregateId: leadId?.toString(),
          metadata: { source: 'intent-classifier-worker' },
        }
      );

      return { status: 'completed', intent, confidence };
    },
    {
      connection: bullMqConnection,
      concurrency: 20,
      limiter: { max: 100, duration: 1000 },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'fixed', delay: 3000 },
        removeOnComplete: 200,
        removeOnFail: 50,
      },
    }
  );
}

export default createIntentClassifierWorker;
