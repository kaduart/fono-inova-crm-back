// orchestrators/WhatsAppOrchestrator.js

import { IntentDetector } from '../detectors/index.js';
import * as handlers from '../handlers/index.js';
import Logger from '../services/utils/Logger.js';

export class WhatsAppOrchestrator {
    constructor() {
        this.intentDetector = new IntentDetector();
        this.logger = new Logger('WhatsAppOrchestrator');
    }

    async process({ lead, message, context, services }) {
        try {
            // 🧠 1. Detectar intenção
            const intent = this.intentDetector.detect(message);

            // 🎯 2. Selecionar handler
            const handler = this.selectHandler(intent);

            // ▶️ 3. Executar handler
            const result = await handler.execute({
                lead,
                message,
                context: {
                    ...context,
                    therapy: intent?.therapy || null,
                    intentConfidence: intent?.confidence || 0
                },
                services
            });

            // 🧭 4. Decidir próximo comando
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
        }
    }

    selectHandler(intent) {
        // prioridade clínica
        if (intent?.flags?.some(f => f.level === 'high')) {
            return handlers.LeadQualificationHandler;
        }

        const map = {
            booking: handlers.BookingHandler,
            therapy_question: handlers.TherapyHandler,
            product_inquiry: handlers.ProductHandler
        };

        return map[intent?.type] || handlers.FallbackHandler;
    }

    decideCommand({ handlerResult }) {
        const { events = [], data } = handlerResult || {};

        // 🟢 slots disponíveis
        if (events.includes('SLOTS_AVAILABLE')) {
            return {
                command: 'SEND_MESSAGE',
                payload: {
                    type: 'SLOT_OPTIONS',
                    data
                }
            };
        }

        // 🟡 fallback
        if (data?.fallback) {
            return {
                command: 'SEND_MESSAGE',
                payload: {
                    text: 'Pode me explicar um pouquinho melhor o que você precisa?'
                }
            };
        }

        // 🔵 default seguro
        return {
            command: 'NO_REPLY',
            meta: { reason: 'no_action_required' }
        };
    }
}
