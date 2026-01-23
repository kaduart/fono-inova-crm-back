import { detectAllFlags } from '../utils/flagsDetector.js';
import TherapyDetector from './TherapyDetector.js';

export default class IntentDetector {
    constructor() {
        this.therapyDetector = new TherapyDetector();
    }

    detect(message) {
        const text = message?.content?.toLowerCase() || '';

        const intentType = this.detectIntentType(text);
        const therapy = this.therapyDetector.detect(text);
        const flags = detectAllFlags.detect(text);

        return {
            type: intentType,
            therapy,
            flags,
            confidence: this.calculateConfidence({ intentType, therapy, flags })
        };
    }

    detectIntentType(text) {
        if (this.match(text, ['agendar', 'marcar', 'horário', 'consulta'])) {
            return 'booking';
        }

        if (this.match(text, ['preço', 'valor', 'quanto custa'])) {
            return 'product_question';
        }

        if (this.match(text, ['qual terapia', 'preciso de', 'indicação'])) {
            return 'therapy_question';
        }

        if (this.match(text, ['cancelar', 'desmarcar'])) {
            return 'cancel';
        }

        return 'unknown';
    }

    match(text, keywords) {
        return keywords.some(k => text.includes(k));
    }

    calculateConfidence({ intentType, therapy, flags }) {
        let score = 0.5;

        if (intentType !== 'unknown') score += 0.2;
        if (therapy !== 'unknown') score += 0.2;
        if (flags?.length) score += 0.1;

        return Math.min(score, 1);
    }
}
