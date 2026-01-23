// orchestrators/WhatsAppOrchestrator.js
import { IntentDetector } from '../detectors/index.js';
import * as handlers from '../handlers/index.js';
import * as leadCircuitService from '../services/intelligence/leadIntelligence.js';

import Logger from '../services/utils/Logger.js';

export class WhatsAppOrchestrator {
    constructor() {
        this.intentDetector = new IntentDetector();
        this.logger = new Logger('WhatsAppOrchestrator');
    }

    async process({ lead, message, context, services }) {
        n
        let lock;

        try {
            // 🔒 1. Lock do lead (mantido)
            lock = await leadCircuitService.lock(lead._id);

            // 🧠 2. Detectar intenção
            const intent = this.intentDetector.detect(message);

            // 🎯 3. Selecionar handler
            const handler = this.selectHandler(intent);

            // ▶️ 4. Executar handler (CONTRATO NOVO)
            const result = await handler.execute({
                lead,
                message,
                context: {
                    ...context,
                    therapy: intent.therapy,
                    intentConfidence: intent.confidence
                },
                services
            });

            // 🧭 5. Decidir próximo passo (AQUI é o cérebro)
            return this.decideCommand({
                lead,
                intent,
                handlerResult: result,
                context
            });

        } catch (error) {
            this.logger.error('Erro no Orchestrator', error);

            return {
                command: 'SEND_MESSAGE',
                payload: {
                    text: 'Tive um problema técnico aqui 😔 Pode tentar novamente?'
                },
                meta: { error: true }
            };

        } finally {
            if (lock) {
                await leadCircuitService.unlock(lead._id);
            }
        }
    }

    selectHandler(intent) {
        if (intent.flags?.some(f => f.level === 'high')) {
            return handlers.LeadQualificationHandler;
        }

        const map = {
            booking: handlers.BookingHandler,
            therapy_question: handlers.TherapyHandler,
            product_inquiry: handlers.ProductHandler
        };

        return map[intent.type] || handlers.FallbackHandler;
    }

    decideCommand({ handlerResult, intent }) {
        const { events = [], data } = handlerResult;

        // 🟢 Caso: slots disponíveis
        if (events.includes('SLOTS_AVAILABLE')) {
            return {
                command: 'SEND_MESSAGE',
                payload: {
                    type: 'SLOT_OPTIONS',
                    data
                }
            };
        }

        // 🟡 Fallback
        if (data?.fallback) {
            return {
                command: 'SEND_MESSAGE',
                payload: {
                    text: 'Pode me explicar um pouquinho melhor o que você precisa?'
                }
            };
        }

        // 🔵 Default seguro
        return {
            command: 'NO_REPLY',
            meta: { reason: 'no_action_required' }
        };
    }
}
