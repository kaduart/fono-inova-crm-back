// utils/getPriceLinesForDetectedTherapies.js

const PRICE_TABLE = {
    fono: [
        '💚 Atendimento em fonoaudiologia com foco em evolução, cuidado individual e acompanhamento próximo.',
        '📦 Acompanhamento mensal (4 sessões): R$ 680 • Sessão avulsa: R$ 180'
    ],
    psicologia: [
        '💚 Atendimento psicológico em espaço seguro, acolhedor e com escuta profissional qualificada.',
        '📦 Acompanhamento mensal (4 sessões): R$ 520 • Sessão avulsa: R$ 130'
    ],
    fisio: [
        '💚 Fisioterapia com abordagem individual, foco em desenvolvimento motor e qualidade de vida.',
        '📦 Acompanhamento mensal (4 sessões): R$ 640 • Sessão avulsa: R$ 160'
    ],
    to: [
        '💚 Terapia ocupacional voltada à autonomia, funcionalidade e desenvolvimento no dia a dia.',
        '📦 Acompanhamento mensal (4 sessões): R$ 680 • Sessão avulsa: R$ 180'
    ]

};

const THERAPY_KEY_MAP = {
    'fonoaudiologia': 'fono',
    'psicologia': 'psicologia',
    'fisioterapia': 'fisio',
    'terapia ocupacional': 'to'
};

export function getPriceLinesForDetectedTherapies(therapies = []) {
    const lines = [];
    therapies.forEach((therapy) => {
        const raw = therapy?.toLowerCase();
        const key = THERAPY_KEY_MAP[raw] || raw;  // ✅ Normaliza!

        if (PRICE_TABLE[key]) {
            lines.push(...PRICE_TABLE[key]);
        }
    });
    return lines;
}
