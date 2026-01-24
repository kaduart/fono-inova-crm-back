// handlers/LeadQualificationHandler.js

import Logger from '../services/utils/Logger.js';

class LeadQualificationHandler {
    constructor() {
        this.logger = new Logger('LeadQualificationHandler');
    }

    async execute({ decisionContext, services }) {
        try {
            const { memory, analysis, missing } = decisionContext;

            // Pergunta SOMENTE o que falta
            if (missing.needsTherapy) {
                return {
                    text: 'Para qual área você está procurando atendimento? (fono, psicologia, fisio ou TO) 💚',
                    extractedInfo: {}
                };
            }

            if (missing.needsAge) {
                return {
                    text: 'Qual a idade do paciente? 💚',
                    extractedInfo: {}
                };
            }

            if (missing.needsComplaint) {
                return {
                    text: 'Você pode me contar o que está acontecendo ou quais são as principais dificuldades? 💚',
                    extractedInfo: {}
                };
            }

            if (missing.needsPeriod) {
                return {
                    text: 'Prefere período da manhã ou da tarde? 💚',
                    extractedInfo: {}
                };
            }

            // Caso não falte nada → encaminha para agendamento
            return {
                text: 'Perfeito, já entendi direitinho 😊 Vou verificar os horários disponíveis para você 💚',
                extractedInfo: {}
            };

        } catch (error) {
            this.logger.error('Erro no LeadQualificationHandler', error);
            return {
                text: 'Posso te ajudar com mais algumas informações para te orientar melhor? 💚'
            };
        }
    }
}

export default new LeadQualificationHandler();
