import Logger from '../services/utils/Logger.js';

class ProductQuestionHandler {
    constructor() {
        this.logger = new Logger('ProductQuestionHandler');
    }

    async execute({ decisionContext }) {
        return {
            text: 'Posso te explicar os valores ou já verifico horários pra você? 💚'
        };
    }

}

export default new ProductQuestionHandler();
