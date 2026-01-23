// orchestrators/WhatsAppOrchestrator.js
import { IntentDetector } from '../detectors/index.js';
import * as handlers from '../handlers/index.js'; // agora vem instâncias
import Logger from '../services/utils/Logger.js';

export class WhatsAppOrchestrator {
    constructor() {
        this.intentDetector = new IntentDetector();
        this.logger = new Logger('WhatsAppOrchestrator');
    }

    async process({ lead, message, context, services }) {
        try {
            if (!services) {
                throw new Error('Services não fornecidos');
            }

            // 1. Detectar intenção
            const intent = this.intentDetector.detect(message);
            this.logger.info('Intenção detectada', { type: intent.type });

            // 2. Selecionar handler (agora retorna instância)
            const handler = this.selectHandler(intent);

            if (!handler || typeof handler.execute !== 'function') {
                this.logger.error('Handler inválido', {
                    handler: handler?.constructor?.name,
                    type: typeof handler
                });
                throw new Error('Handler não encontrado ou inválido');
            }

            // 3. Executar handler
            const result = await handler.execute({
                lead,
                message,
                context: {
                    ...context,
                    therapy: intent?.therapy || null,
                    intentConfidence: intent?.confidence || 0,
                    flags: intent?.flags || {}
                },
                services
            });

            // 4. Decidir comando
            return this.decideCommand({ handlerResult: result });

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

    selectHandler(intent = {}) {
        const flags = intent.flags || {};

        // Agora retorna as instâncias importadas, não as classes
        if (flags.wantsSchedule) {
            return handlers.bookingHandler; // ✅ instância criada no index.js
        }

        if (flags.asksPrice) {
            return handlers.productHandler; // ✅ instância
        }

        if (flags.mentionsSpeechTherapy || intent.type === 'therapy_question') {
            return handlers.therapyHandler; // ✅ instância
        }

        return handlers.fallbackHandler; // ✅ instância
    }

    decideCommand({ handlerResult }) {
        const { events = [], data } = handlerResult || {};

        // 🟢 1. Slots disponíveis (Booking) - PRIORIDADE 1
        if (events?.includes('SLOTS_AVAILABLE')) {
            return {
                command: 'SEND_MESSAGE',
                payload: {
                    type: 'SLOT_OPTIONS',
                    data
                }
            };
        }

        // 🟡 2. Informações de produto (Preço) - PRIORIDADE 2
        if (events?.includes('PRODUCT_INFO_PROVIDED')) {
            return {
                command: 'SEND_MESSAGE',
                payload: {
                    type: 'PRODUCT_INFO',
                    text: data?.aiResponse || `Sobre ${data?.product?.product || 'consulta'}: consulte valores`,
                    data: data?.product
                }
            };
        }

        // 🔵 3. Informações de terapia - PRIORIDADE 3
        if (events?.includes('THERAPY_INFO_PROVIDED')) {
            return {
                command: 'SEND_MESSAGE',
                payload: {
                    type: 'THERAPY_INFO',
                    text: data?.aiResponse || `Sobre ${data?.therapy}: ...`,
                    data
                }
            };
        }

        // 🟠 4. Fallback (não entendeu)
        if (data?.fallback) {
            return {
                command: 'SEND_MESSAGE',
                payload: {
                    text: 'Pode me explicar um pouquinho melhor o que você precisa?'
                }
            };
        }

        // ⚪ 5. Default - Nenhuma ação
        return {
            command: 'NO_REPLY',
            meta: { reason: 'no_action_required' }
        };
    }
}