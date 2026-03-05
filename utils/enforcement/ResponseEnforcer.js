// enforcement/ResponseEnforcer.js - NOVO ARQUIVO

import { PRICING } from '../../config/pricing.js';

export class ResponseEnforcer {
    constructor(context) {
        this.context = context;
        this.violations = [];
    }

    enforce(response) {
        let enforced = response;

        // Regra 1: Se perguntou preço, deve ter R$ e contexto
        if (this.context.flags.asksPrice) {
            enforced = this.enforcePriceContext(enforced);
        }

        // Regra 2: Se modo CLOSER, deve ter CTA específico
        if (this.context.mode === 'CLOSER') {
            enforced = this.enforceCloserCTA(enforced);
        }

        // Regra 3: Proibido "à disposição"
        enforced = this.enforceSafety(enforced);

        // Regra 4: Se mencionou criança, deve usar nome se disponível
        if (this.context.patientName) {
            enforced = this.enforcePersonalization(enforced);
        }

        return {
            text: enforced,
            violations: this.violations,
            wasModified: enforced !== response
        };
    }

    enforcePriceContext(text) {
        if (!/\bR\$\s*\d+/.test(text)) {
            this.violations.push('MISSING_PRICE_SYMBOL');
            const defaultPrice = PRICING.AVALIACAO_INICIAL || 200;
            return text + `\n\nO investimento é R$ ${defaultPrice} (avaliação inicial).`;
        }

        if (!/(inclui|anamnese|avalia|sessão)/i.test(text)) {
            this.violations.push('PRICE_WITHOUT_CONTEXT');
            // Inserir contexto antes do preço
            return text.replace(/(R\$\s*\d+)/, 'que inclui anamnese completa, entrevista e plano terapêutico — $1');
        }

        return text;
    }

    enforceCloserCTA(text) {
        const hasStrongCTA = /(posso garantir|tenho vaga|fechar|agendar agora)/i.test(text);
        if (!hasStrongCTA) {
            this.violations.push('WEAK_CTA_IN_CLOSER_MODE');
            return text + '\n\nPosso garantir uma vaga para essa semana? Tenho horário na terça ou quinta pela manhã.';
        }
        return text;
    }

    enforceSafety(text) {
        const forbidden = /(à disposição|disponha|estamos à disposição)/i;
        if (forbidden.test(text)) {
            this.violations.push('FORBIDDEN_PHRASE');
            return text.replace(forbidden, 'fico por aqui se precisar');
        }
        return text;
    }

    enforcePersonalization(text) {
        const name = this.context.patientName;
        if (!text.includes(name) && text.length > 100) {
            // Inserir nome naturalmente na primeira frase
            const sentences = text.split(/([.!?]+)/);
            if (sentences[0].length > 20) {
                sentences[0] = sentences[0].replace(/(filho|criança|paciente)/i, `${name}`);
                return sentences.join('');
            }
        }
        return text;
    }
}