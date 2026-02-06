// utils/responseBuilder.js - MONTA RESPOSTAS BASEADO EM DADOS + FLAGS

import { getTherapyData } from './therapyDetector.js';
import { PRICING, formatPrice } from '../config/pricing.js';

/**
 * 🎯 Monta resposta para UMA terapia
 */
export function buildTherapyResponse(therapy, flags = {}) {
    const data = getTherapyData(therapy.id);
    if (!data) {
        return `Temos especialistas em ${therapy.name}! A avaliação inicial é ${formatPrice(PRICING.AVALIACAO_INICIAL)}. Posso te explicar como funciona? 💚`;
    }

    const { asksPrice, wantsSchedule, userProfile } = flags;

    // 🎯 Resposta para NEUROPSICOLÓGICA (sempre completa)
    if (therapy.id === 'neuropsychological') {
        if (wantsSchedule) {
            return `Perfeito! ${data.explanation}. ${data.details}. Valor: ${data.price}. Qual período funciona melhor: manhã ou tarde? 💚`;
        }
        return `Fazemos sim! ${data.explanation}. ${data.details}. Valor: ${data.price}. ${data.engagement} 💚`;
    }

    // 🎯 Resposta CONTEXTUAL baseada em perfil
    const profileContext = getProfileContext(data, userProfile);

    // Se pergunta preço
    if (asksPrice) {
        return `Fazemos sim! ${data.explanation}. ${profileContext}Valor: ${data.price}. ${data.engagement} 💚`;
    }

    // Se quer agendar
    if (wantsSchedule) {
        return `Perfeito! ${data.explanation}. Valor: ${data.price}. Qual período funciona melhor? 💚`;
    }

    // Resposta padrão
    return `Fazemos sim! ${data.explanation}. ${profileContext}Valor: ${data.price}. ${data.engagement} 💚`;
}

/**
 * 🎯 Monta resposta para MÚLTIPLAS terapias
 */
export function buildMultiTherapyResponse(therapies, flags = {}) {
    if (therapies.length === 1) {
        return buildTherapyResponse(therapies[0], flags);
    }

    const names = therapies.map(t => t.name).join(' e ');
    const { asksPrice, wantsSchedule } = flags;

    if (asksPrice) {
        return `Temos especialistas em ${names}! Cada uma tem sua avaliação específica. Qual você gostaria de saber mais? 💚`;
    }

    if (wantsSchedule) {
        return `Perfeito! Atendemos em ${names}. Qual especialidade te interessa mais para agendar? 💚`;
    }

    return `Atendemos em ${names}! Qual especialidade você procura? 💚`;
}

/**
 * 🎯 Contexto baseado no perfil
 */
function getProfileContext(data, userProfile) {
    const segments = {
        baby: "Para bebês com dificuldade na amamentação ou atraso na fala. ",
        child: "Para crianças com troca de letras ou gagueira. ",
        school: "Ideal para casos de dificuldade escolar ou suspeita de TDAH/TEA. ",
        behavior: "Para birras, manias ou dificuldades de comportamento. ",
        emotional: "Para ansiedade, medos ou questões emocionais. ",
        sensory: "Para crianças muito sensíveis a texturas, sons ou movimentos. ",
        motor: "Para dificuldades em amarrar tênis, segurar lápis etc. "
    };

    return segments[userProfile] || "";
}

/**
 * 🎯 Resposta de equivalência
 */
export function buildEquivalenceResponse() {
    return "Cada avaliação tem seu propósito específico! Me conta mais sobre o que você precisa que te explico a diferença? 💚";
}