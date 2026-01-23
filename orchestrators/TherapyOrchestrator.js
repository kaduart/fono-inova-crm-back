const BaseOrchestrator = require('./BaseOrchestrator');
const therapyDetector = require('../detectors/TherapyDetector');
const aiAmandaService = require('../aiAmandaService');
const Logger = require('../services/utils/Logger');

class TherapyOrchestrator extends BaseOrchestrator {
    constructor() {
        super();
        this.logger = new Logger('TherapyOrchestrator');
    }

    async process(data) {
        try {
            const { message, session } = data;

            this.logger.info('Orquestrando fluxo de terapia', {
                sessionId: session.id,
                step: session.currentStep
            });

            // Fluxo especializado para diagnóstico de terapia
            const stepHandlers = {
                'initial_screening': this.handleScreening.bind(this),
                'therapy_recommendation': this.handleRecommendation.bind(this),
                'specialist_match': this.handleSpecialistMatch.bind(this)
            };

            const handler = stepHandlers[session.currentStep];

            if (!handler) {
                throw new Error(`Step desconhecido: ${session.currentStep}`);
            }

            return await handler(message, session);

        } catch (error) {
            this.logError('TherapyOrchestrator.process', error);
            return this.getFallbackResponse();
        }
    }

    async handleScreening(message, session) {
        // 1. Detectar sinais clínicos
        const clinicalFlags = therapyDetector.detectClinicalFlags(message.content);

        // 2. Atualizar score do session
        session.screeningScore = this.calculateScreeningScore(clinicalFlags);

        // 3. Decidir próximo passo
        session.nextStep = session.screeningScore > 7 ? 'urgent_referral' : 'therapy_recommendation';

        return {
            type: 'screening_result',
            data: { session, flags: clinicalFlags },
            nextStep: session.nextStep
        };
    }

    async handleRecommendation(message, session) {
        // Lógica para recomendar terapia específica
        const recommendation = await aiAmandaService.recommendTherapy({
            screeningScore: session.screeningScore,
            preferences: session.preferences
        });

        return {
            type: 'therapy_recommendation',
            data: { recommendation },
            nextStep: 'specialist_match'
        };
    }

    async handleSpecialistMatch(message, session) {
        // Lógica para matching com especialista
        const specialist = await aiAmandaService.findSpecialist({
            therapy: session.recommendedTherapy,
            availability: session.preferences
        });

        return {
            type: 'specialist_found',
            data: { specialist },
            nextStep: 'booking'
        };
    }

    calculateScreeningScore(flags) {
        return flags.reduce((score, flag) => {
            return score + (flag.weight || 1);
        }, 0);
    }
}

module.exports = new TherapyOrchestrator();