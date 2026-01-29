// handlers/ProductHandler.js

import { buildValueAnchoredClosure } from '../services/intelligence/buildValueAnchoredClosure.js';
import { getPriceLinesForDetectedTherapies } from '../services/intelligence/getPriceLinesForDetectedTherapies.js';

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

        const therapy = memory.therapyArea || analysis.therapyArea || analysis.detectedTherapy;

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
        // 5️⃣ CTA FLEXÍVEL (só se não for interrupção)
        // =========================
        const isInterruption = missing?.currentAwaiting &&
            !missing.needsSlot &&
            !missing.needsSlotSelection;

        if (!isInterruption) {
            // ✅ MANTÉM: CTA normal quando NÃO é interrupção
            if (!missing.needsAge && !missing.needsTherapy) {
                responseText += `\n\nSe quiser, posso verificar horários disponíveis para você ainda hoje 💚`;
            } else {
                responseText += `\n\nQuer que eu te ajude a verificar horários? 💚`;
            }
        }
        // ⬆️ Se FOR interrupção, não adiciona nada aqui - Orchestrator cuida

        // Retorna com flag se for interrupção
        if (isInterruption) {
            return {
                text: responseText,
                needsResumption: true,
                nextField: missing.currentAwaiting
            };
        }

        return { text: responseText };
    }
}

export default new ProductHandler();
