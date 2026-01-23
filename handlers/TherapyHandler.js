import { generateAmandaReply } from '../services/aiAmandaService.js';
import TherapyDetector from '../detectors/TherapyDetector.js';
import Logger from '../services/utils/Logger.js';

export class TherapyHandler {
    constructor() {
        this.logger = new Logger('TherapyHandler');
        this.therapyDetector = new TherapyDetector();
    }

    async execute({ message, context }) {
        try {
            const text = message.content;
            const therapy = context.therapy || this.therapyDetector.detect(text);

            this.logger.info('Processando terapia', { therapy });

            // Gera resposta explicativa sobre a terapia
            const response = await generateAmandaReply({
                userText: text,
                lead: { _id: context.lead?._id },
                context: {
                    therapy: therapy,
                    intent: 'therapy_recommendation'
                }
            });

            return {
                data: {
                    therapy,
                    aiResponse: response,
                    confidence: context.intentConfidence || 0.8
                },
                events: ['THERAPY_INFO_PROVIDED']
            };
        } catch (error) {
            this.logger.error('Erro no TherapyHandler', error);
            return {
                data: { fallback: true },
                events: []
            };
        }
    }
}