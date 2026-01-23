export default class TherapyDetector {
    constructor() {
        this.therapyPatterns = {
            psicologia: [
                'psico',
                'ansiedade',
                'depressão',
                'terapia',
                'emocional'
            ],
            fonoaudiologia: [
                'fono',
                'fala',
                'gagueira',
                'articulação',
                'disfagia'
            ],
            fisioterapia: [
                'fisioterapia',
                'dor',
                'reabilitação',
                'movimento'
            ]
        };
    }

    detect(text = '') {
        const lower = text.toLowerCase();

        for (const [therapy, keywords] of Object.entries(this.therapyPatterns)) {
            if (keywords.some(k => lower.includes(k))) {
                return therapy;
            }
        }

        return 'unknown';
    }
}
