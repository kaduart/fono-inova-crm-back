import bookingProductMapper from '../bookingProductMapper.js';
import aiAmandaService from '../aiAmandaService.js';
import Logger from '../services/utils/Logger.js';

class ProductQuestionHandler {
    constructor() {
        this.logger = new Logger('ProductQuestionHandler');
    }

    async execute(message, context) {
        try {
            this.logger.info('Pergunta sobre produto', {
                leadId: context.leadId
            });

            const product = await bookingProductMapper.map({
                message: message.content,
                therapy: context.therapy
            });

            const details = await aiAmandaService.getProductInfo({
                productId: product.id
            });

            return {
                type: 'product_information',
                data: details,
                message: details.description
            };
        } catch (error) {
            this.logger.error('Erro no ProductQuestionHandler', error);
            return {
                type: 'product_error',
                message: 'Erro ao buscar informações do produto.'
            };
        }
    }
}

export default new ProductQuestionHandler();
