// services/intelligence/buildValueAnchoredClosure.js

export function buildValueAnchoredClosure({ therapy, age, complaint }) {
    let text = 'Quanto antes iniciarmos o acompanhamento, maiores são as chances de evolução 💚';

    if (therapy) {
        text = `Quanto antes iniciarmos o acompanhamento em ${therapy}, maiores são as chances de evolução 💚`;
    }

    if (age) {
        text += ` Nessa idade, a evolução costuma ser ainda mais rápida.`;
    }

    return text;
}
