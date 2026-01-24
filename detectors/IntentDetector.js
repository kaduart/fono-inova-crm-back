// detectors/IntentDetector.js
import { detectAllFlags } from '../utils/flagsDetector.js'; // ajuste o path
import TherapyDetector from './TherapyDetector.js';

export default class IntentDetector {
    constructor() {
        this.therapyDetector = new TherapyDetector();
    }

    detect(message, enrichedContext = {}) {
        const text = message?.content || message || '';

        // Detecta flags usando contexto
        const flags = detectAllFlags(text, {}, enrichedContext);
        const detectedTherapies = detectAllTherapies(text);
        const therapy = pickPrimaryTherapy(detectedTherapies);

        // USA CONTEXTO PARA MELHORAR DECISÃO
        const hasTherapyInContext = !!enrichedContext.therapyArea;
        const hasAgeInContext = !!enrichedContext.patientAge;

        return {
            type: this.resolveType(flags, { hasTherapyInContext, hasAgeInContext }),
            flags,
            therapy,
            confidence: this.calculateConfidence(flags, enrichedContext)
        };
    }

    resolveType(flags, ctx = {}) {
        // Se já tem terapia + idade e quer agendar → booking direto
        if (flags.wantsSchedule && ctx.hasTherapyInContext && ctx.hasAgeInContext) {
            return 'booking_ready';
        }

        if (flags.wantsSchedule) return 'booking';
        if (flags.asksPrice) return 'product_inquiry';
        if (flags.mentionsSpeechTherapy) return 'therapy_question';
        return 'qualification'; // fallback mais inteligente
    }

    calculateConfidence(flags, context) {
        let confidence = 0.5;
        if (context.conversationHistory?.length > 3) confidence += 0.2;
        if (context.therapyArea) confidence += 0.15;
        if (Object.values(flags).filter(Boolean).length > 2) confidence += 0.15;
        return Math.min(confidence, 1);
    }

}