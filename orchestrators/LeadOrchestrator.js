const BaseOrchestrator = require('./BaseOrchestrator');
const leadIntelligence = require('../leadIntelligence');
const leadCircuitService = require('../leadCircuitService');
const handlers = require('../handlers');

class LeadOrchestrator extends BaseOrchestrator {
    constructor() {
        super();
    }

    async process(lead) {
        try {
            this.logger.info('Processando lead no circuito', { leadId: lead.id });

            // 1. Verificar se lead tem circuito ativo
            const circuit = await leadCircuitService.getActiveCircuit(lead.id);

            if (circuit) {
                return await this.continueCircuit(circuit, lead);
            }

            // 2. Qualificar lead novo
            const qualification = await leadIntelligence.scoreLead(lead);

            // 3. Decidir circuito
            const circuitConfig = this.decideCircuit(qualification);

            // 4. Criar circuito
            const newCircuit = await leadCircuitService.createCircuit({
                leadId: lead.id,
                config: circuitConfig,
                priority: qualification.priority
            });

            return {
                type: 'circuit_started',
                data: { circuit: newCircuit, qualification },
                nextAction: circuitConfig.firstAction
            };

        } catch (error) {
            this.logError('LeadOrchestrator.process', error, { leadId: lead.id });
            return this.getFallbackResponse();
        }
    }

    async continueCircuit(circuit, lead) {
        const handler = handlers[`${circuit.currentStep}Handler`];

        if (!handler) {
            throw new Error(`Handler não encontrado para: ${circuit.currentStep}`);
        }

        const result = await handler.execute({ lead, circuit });
        return result;
    }

    decideCircuit(qualification) {
        const circuits = {
            high_priority: {
                type: 'urgent_followup',
                duration: '2h',
                steps: ['immediate_contact', 'booking_offer', 'reminder'],
                firstAction: 'immediate_contact'
            },
            ready_to_buy: {
                type: 'fast_conversion',
                duration: '24h',
                steps: ['product_presentation', 'booking_offer', 'followup'],
                firstAction: 'product_presentation'
            },
            nurturing: {
                type: 'education',
                duration: '7d',
                steps: ['educational_content', 'soft_offer', 'checkin'],
                firstAction: 'educational_content'
            }
        };

        return circuits[qualification.segment] || circuits.nurturing;
    }
}

module.exports = new LeadOrchestrator();