import { generateAmandaReply } from '../services/aiAmandaService.js';
import { mapFlagsToBookingProduct } from '../utils/bookingProductMapper.js'; // ✅ Importe a função direta
import Logger from '../services/utils/Logger.js';

export class ProductHandler {
    constructor() {
        this.logger = new Logger('ProductHandler');
    }

    async execute({ message, context, services }) {
        try {
            this.logger.info('Processando pergunta de produto', {
                leadId: context.lead?._id
            });

            // ✅ Use a função diretamente (não é .map())
            const flags = context.flags || {};
            const product = mapFlagsToBookingProduct(flags, context.lead);

            // Se precisar do texto da mensagem nos flags:
            if (!flags.text && message.content) {
                flags.text = message.content;
                flags.rawText = message.content;
            }

            const response = await generateAmandaReply({
                userText: message.content,
                lead: { _id: context.lead?._id },
                context: {
                    product,
                    intent: 'price_inquiry'
                }
            });

            return {
                data: {
                    product,
                    aiResponse: response
                },
                events: ['PRODUCT_INFO_PROVIDED']
            };

        } catch (error) {
            this.logger.error('Erro no ProductHandler', error);
            return {
                data: { fallback: true },
                events: []
            };
        }
    }
}