// handlers/ProductHandler.js

import { detectAllTherapies, getTherapyData, THERAPY_DATA } from '../utils/therapyDetector.js';
import { detectAllFlags } from '../utils/flagsDetector.js';

class ProductHandler {
    async execute({ decisionContext }) {
        const { memory, analysis, message, missing, lead, inferredTherapy } = decisionContext;
        const text = message?.content || message?.text || '';

        // =========================
        // 1️⃣ USA INFRAESTRUTURA EXISTENTE!
        // =========================
        const flags = detectAllFlags(text, lead, { stage: lead?.stage });
        const detectedTherapies = detectAllTherapies(text);

        // =========================
        // 2️⃣ CASCATA INTELIGENTE DE TERAPIA
        // =========================
        let therapyId = null;
        let therapyName = null;

        // Prioridade 0: inferredTherapy do Orchestrator (mais confiável)
        if (inferredTherapy) {
            therapyName = inferredTherapy;
            therapyId = this.mapTherapyNameToId(therapyName);
        }
        // Prioridade 1: Detectou no texto atual
        else if (detectedTherapies.length > 0) {
            therapyId = detectedTherapies[0].id;
            therapyName = detectedTherapies[0].name;
        }
        // Prioridade 2: Já temos no contexto (Orchestrator inferiu)
        else if (analysis.therapyArea) {
            therapyName = analysis.therapyArea;
            therapyId = this.mapTherapyNameToId(therapyName);
        }
        // Prioridade 3: Já temos na memória
        else if (memory?.therapyArea) {
            therapyName = memory.therapyArea;
            therapyId = this.mapTherapyNameToId(therapyName);
        }
        // Prioridade 4: Já temos no lead
        else if (lead?.therapyArea) {
            therapyName = lead.therapyArea;
            therapyId = this.mapTherapyNameToId(therapyName);
        }

        console.log('🔍 [ProductHandler] Terapia detectada:', { therapyId, therapyName, fromText: detectedTherapies.length > 0 });

        // =========================
        // 3️⃣ SE NÃO SABE A TERAPIA
        // =========================
        if (!therapyId && !therapyName) {
            return {
                text: 'Para te informar o valor certinho, é para qual área você está procurando atendimento? (fono, psicologia, fisio ou TO) 💚'
            };
        }

        // =========================
        // 4️⃣ BUSCA PREÇO (USA THERAPY_DATA)
        // =========================
        const therapyData = therapyId ? getTherapyData(therapyId) : null;

        let priceText = '';
        if (therapyData?.price) {
            priceText = `💚 ${this.formatTherapyDisplay(therapyId, therapyName)}: ${therapyData.price}`;
        } else {
            // Fallback: preço padrão
            priceText = `💚 ${therapyName || 'Atendimento'}: Avaliação R$ 220 · Sessão R$ 220 · Pacote mensal R$ 180/sessão`;
        }

        // =========================
        // 5️⃣ MONTA RESPOSTA
        // =========================
        let responseText = `Perfeito! Vou te explicar direitinho 😊\n\n${priceText}`;

        // Adiciona explicação se tiver
        if (therapyData?.explanation) {
            responseText += `\n\n${therapyData.explanation}`;
        }

        // =========================
        // 6️⃣ CTA FLEXÍVEL (só se não for interrupção)
        // =========================
        const isInterruption = missing?.currentAwaiting &&
            !missing.needsSlot &&
            !missing.needsSlotSelection;

        if (!isInterruption) {
            if (!missing?.needsAge && !missing?.needsTherapy) {
                responseText += `\n\nSe quiser, posso verificar horários disponíveis para você ainda hoje 💚`;
            } else {
                responseText += `\n\nQuer que eu te ajude a verificar horários? 💚`;
            }
        }

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

    // =========================
    // HELPERS
    // =========================

    mapTherapyNameToId(name) {
        if (!name) return null;
        const n = name.toLowerCase().trim();

        const map = {
            'psicologia': 'psychology',
            'psicólogo': 'psychology',
            'psicologo': 'psychology',
            'psicológico': 'psychology',
            'fonoaudiologia': 'speech',
            'fono': 'speech',
            'fonoaudiólogo': 'speech',
            'terapia ocupacional': 'occupational',
            'to': 'occupational',
            'fisioterapia': 'physiotherapy',
            'fisio': 'physiotherapy',
            'musicoterapia': 'music',
            'neuropsicologia': 'neuropsychological',
            'neuropsicológica': 'neuropsychological',
            'avaliação neuropsicológica': 'neuropsychological',
            'psicopedagogia': 'psychopedagogy',
            'neuropsicopedagogia': 'neuropsychopedagogy',
            'teste da linguinha': 'tongue_tie',
            'linguinha': 'tongue_tie'
        };

        return map[n] || null;
    }

    formatTherapyDisplay(therapyId, therapyName) {
        const displayMap = {
            'psychology': 'Atendimento psicológico em espaço sensorial exclusivo',
            'speech': 'Avaliação fonoaudiológica completa',
            'occupational': 'Terapia ocupacional com integração sensorial',
            'physiotherapy': 'Fisioterapia especializada',
            'neuropsychological': 'Avaliação neuropsicológica completa',
            'psychopedagogy': 'Psicopedagogia',
            'music': 'Musicoterapia',
            'tongue_tie': 'Teste da linguinha'
        };

        return displayMap[therapyId] || therapyName || 'Atendimento';
    }
}

export default new ProductHandler();