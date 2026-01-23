// detectors/IntentDetector.js
import { detectAllFlags } from '../utils/flagsDetector.js'; // ajuste o path
import TherapyDetector from './TherapyDetector.js';

export default class IntentDetector {
    constructor() {
        this.therapyDetector = new TherapyDetector();
    }

    detect(message) {
        const text = message?.content || message || '';

        // Detecta flags usando sua função existente
        const flags = detectAllFlags(text); // ou deriveFlagsFromText

        // Detecta terapia
        const therapy = this.therapyDetector.detect(text);

        return {
            type: this.resolveType(flags),
            flags, // ✅ importante: passar as flags
            therapy,
            confidence: 0.8
        };
    }

    resolveType(flags) {
        if (flags.wantsSchedule) return 'booking';
        if (flags.asksPrice) return 'product_inquiry';
        if (flags.mentionsSpeechTherapy) return 'therapy_question';
        return 'fallback';
    }
}