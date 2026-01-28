// handlers/ProductHandler.js

import { getPriceLinesForDetectedTherapies } from '../services/intelligence/getPriceLinesForDetectedTherapies.js';
import { buildValueAnchoredClosure } from '../services/intelligence/buildValueAnchoredClosure.js';

class ProductHandler {
    async execute({ decisionContext }) {
        const { memory, analysis, strategy, missing } = decisionContext;

        // =========================
        // 1️⃣ SE NÃO SABE A TERAPIA
        // =========================
        if (missing.needsTherapy) {
            return {
                text: 'Para te informar o valor certinho, é para qual área você está procurando atendimento? (fono, psicologia, fisio ou TO) 💚'
            };
        }

        const therapy = memory.therapyArea || analysis.detectedTherapy;

        // =========================
        // 2️⃣ BUSCA LINHAS DE PREÇO
        // =========================
        const priceLines = getPriceLinesForDetectedTherapies([therapy]);

        if (!priceLines || priceLines.length === 0) {
            return {
                text: 'Posso verificar os valores para você sim 😊 Você poderia me dizer qual área de atendimento está procurando? 💚'
            };
        }

        const priceText = priceLines.join('\n');

        // =========================
        // 3️⃣ TEXTO BASE (VALOR + BENEFÍCIO)
        // =========================
        let responseText = `Perfeito! Vou te explicar direitinho 😊\n\n${priceText}`;

        // =========================
        // 4️⃣ VALUE ANCHORING (URGÊNCIA)
        // =========================
        if (strategy?.urgency >= 2) {
            const closure = buildValueAnchoredClosure({
                therapy,
                age: memory.patientAge,
                complaint: memory.complaint
            });

            if (closure) {
                responseText += `\n\n${closure}`;
            }
        }

        // =========================
        // 5️⃣ CTA FLEXÍVEL
        // =========================
        if (!missing.needsAge && !missing.needsTherapy) {
            responseText += `\n\nSe quiser, posso verificar horários disponíveis para você ainda hoje 💚`;
        } else {
            responseText += `\n\nQuer que eu te ajude a verificar horários? 💚`;
        }

        // Se vier do contexto de interrupção, sinaliza que precisa de retomada
        if (decisionContext?.analysis?.intent === 'price' &&
            decisionContext?.missing &&
            (!decisionContext.missing.needsSlot && !decisionContext.missing.needsSlotSelection)) {
            // Estamos no meio da qualificação (antes de buscar slots)
            return {
                text: responseText,
                needsResumption: true,  // Flag para o orchestrator
                nextField: decisionContext.missing.currentAwaiting
            };
        }
        return {
            text: responseText
        };
    }
}

export default new ProductHandler();
