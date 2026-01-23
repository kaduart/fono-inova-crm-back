import * as leadIntelligence from '../services/intelligence/leadIntelligence.js';

import Logger from '../services/utils/Logger.js';

class LeadQualificationHandler {
    constructor() {
        this.logger = new Logger('LeadQualificationHandler');
    }

    async execute(message, context) {
        try {
            const qualification = await leadIntelligence.scoreLead({
                leadId: context.leadId,
                message: message.content
            });

            return {
                type: 'lead_qualified',
                data: qualification,
                message: 'Lead qualificado com sucesso.'
            };
        } catch (error) {
            this.logger.error('Erro na qualificação', error);
            return {
                type: 'qualification_error',
                message: 'Erro ao qualificar lead.'
            };
        }
    }
}

export default new LeadQualificationHandler();
