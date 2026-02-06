// utils/getPriceLinesForDetectedTherapies.js
// 💰 Usa pricing centralizado de config/pricing.js

import { THERAPY_PRICING, THERAPY_ALIASES, formatPrice } from '../../config/pricing.js';

const THERAPY_DESCRIPTIONS = {
    fonoaudiologia: '💚 Atendimento em fonoaudiologia com foco em evolução, cuidado individual e acompanhamento próximo.',
    psicologia: '💚 Atendimento psicológico em espaço seguro, acolhedor e com escuta profissional qualificada.',
    fisioterapia: '💚 Fisioterapia com abordagem individual, foco em desenvolvimento motor e qualidade de vida.',
    terapia_ocupacional: '💚 Terapia ocupacional voltada à autonomia, funcionalidade e desenvolvimento no dia a dia.',
    musicoterapia: '💚 Musicoterapia utilizando recursos sonoros e musicais para desenvolvimento e bem-estar.',
    psicopedagogia: '💚 Psicopedagogia focada em processos de aprendizagem e desenvolvimento educacional.',
    neuropsicologia: '💚 Avaliação neuropsicológica completa com laudo detalhado e orientações especializadas.',
};

const THERAPY_KEY_MAP = {
    'fonoaudiologia': 'fonoaudiologia',
    'fono': 'fonoaudiologia',
    'psicologia': 'psicologia',
    'psico': 'psicologia',
    'fisioterapia': 'fisioterapia',
    'fisio': 'fisioterapia',
    'terapia ocupacional': 'terapia_ocupacional',
    'to': 'terapia_ocupacional',
    'musicoterapia': 'musicoterapia',
    'musico': 'musicoterapia',
    'psicopedagogia': 'psicopedagogia',
    'neuropsicologia': 'neuropsicologia',
    'neuropsico': 'neuropsicologia',
};

/**
 * Retorna linhas de preço formatadas para as terapias detectadas
 * @param {string[]} therapies - Lista de terapias detectadas
 * @returns {string[]} - Linhas formatadas com descrição e preço
 */
export function getPriceLinesForDetectedTherapies(therapies = []) {
    const lines = [];
    
    therapies.forEach((therapy) => {
        const raw = therapy?.toLowerCase().trim();
        const key = THERAPY_KEY_MAP[raw] || THERAPY_ALIASES[raw];
        
        if (!key) return;
        
        const pricing = THERAPY_PRICING[key];
        const description = THERAPY_DESCRIPTIONS[key];
        
        if (description) {
            lines.push(description);
        }
        
        if (pricing) {
            if (pricing.incluiLaudo) {
                // Neuropsicologia - formato especial
                lines.push(`📦 Avaliação completa (${pricing.sessoesPacote} sessões + laudo): ${formatPrice(pricing.avaliacao)}${pricing.parcelamento ? ` em ${pricing.parcelamento}` : ''}`);
            } else {
                // Demais áreas
                lines.push(`📦 Acompanhamento mensal (4 sessões): ${formatPrice(pricing.pacoteMensal)} • Sessão avulsa: ${formatPrice(pricing.sessaoAvulsa)}`);
            }
        }
    });
    
    return lines;
}

export default getPriceLinesForDetectedTherapies;
