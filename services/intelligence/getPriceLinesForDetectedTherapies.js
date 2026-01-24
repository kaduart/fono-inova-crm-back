// utils/getPriceLinesForDetectedTherapies.js

const PRICE_TABLE = {
    fono: [
        '💚 Sessão de fonoaudiologia: R$ 180',
        '📦 Pacote mensal (4 sessões): R$ 680 (desconto por pontualidade)'
    ],
    psicologia: [
        '💚 Sessão de psicologia: R$ 200',
        '📦 Pacote mensal (4 sessões): R$ 720'
    ],
    fisio: [
        '💚 Sessão de fisioterapia: R$ 180',
        '📦 Pacote mensal (4 sessões): R$ 680'
    ],
    to: [
        '💚 Sessão de terapia ocupacional: R$ 180',
        '📦 Pacote mensal (4 sessões): R$ 680'
    ]
};

export function getPriceLinesForDetectedTherapies(therapies = []) {
    const lines = [];

    therapies.forEach((therapy) => {
        const key = therapy?.toLowerCase();

        if (PRICE_TABLE[key]) {
            lines.push(...PRICE_TABLE[key]);
        }
    });

    return lines;
}
