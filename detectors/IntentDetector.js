// detectors/IntentDetector.js
import { detectAllFlags } from '../utils/flagsDetector.js';
import { detectAllTherapies } from '../utils/therapyDetector.js'; // ✅ ADD

export default class IntentDetector {
    // ❌ REMOVER: constructor com TherapyDetector não usado

    detect(message, enrichedContext = {}) {
        const text = message?.content || message || '';

        // Detecta flags usando contexto
        const flags = detectAllFlags(text, {}, enrichedContext);

        // Detecta terapias
        const detectedTherapies = detectAllTherapies(text);
        const therapy = detectedTherapies?.[0] || null; // ✅ FIX: pega primeira terapia

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
        if (flags.wantsSchedule && ctx.hasTherapyInContext && ctx.hasAgeInContext) {
            return 'booking_ready';
        }
        if (flags.wantsSchedule) return 'booking';
        if (flags.asksPrice) return 'product_inquiry';
        if (flags.mentionsSpeechTherapy) return 'therapy_question';
        return 'qualification';
    }

    calculateConfidence(flags, context) {
        let confidence = 0.5;
        if (context.conversationHistory?.length > 3) confidence += 0.2;
        if (context.therapyArea) confidence += 0.15;
        if (Object.values(flags).filter(Boolean).length > 2) confidence += 0.15;
        return Math.min(confidence, 1);
    }
}