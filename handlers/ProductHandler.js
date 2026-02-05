// handlers/ProductHandler.js
// 💰 Versão 2.0 - Resposta de Preço: VALOR → URGÊNCIA → PREÇO → RETOMA

import { detectAllTherapies, getTherapyData, THERAPY_DATA } from '../utils/therapyDetector.js';
import { detectAllFlags } from '../utils/flagsDetector.js';

class ProductHandler {
    async execute({ decisionContext }) {
        const { memory, analysis, message, missing, lead, inferredTherapy, pendingCollection } = decisionContext;
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
        // 🆕 DETECTAR SE É INTERRUÇÃO (tem coleta pendente)
        // =========================
        const isInterruption = pendingCollection && pendingCollection.length > 0;

        // Se for interrupção, usar formato VALOR → URGÊNCIA → PREÇO → RETOMA
        if (isInterruption) {
            return this.buildValueFirstResponse(therapyId, therapyName, memory, pendingCollection);
        }

        // =========================
        // 4️⃣ BUSCA PREÇO (USA THERAPY_DATA) - FLUXO NORMAL
        // =========================
        const therapyData = therapyId ? getTherapyData(therapyId) : null;

        let priceText = '';
        if (therapyData?.price) {
            priceText = `💚 ${this.formatTherapyDisplay(therapyId, therapyName)}: ${therapyData.price}`;
        } else {
            // Fallback: preço padrão
            priceText = `💚 ${therapyName || 'Atendimento'}: Avaliação R$ 200 · Sessão R$ 200 · Pacote mensal R$ 180/sessão`;
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
        // 6️⃣ CTA FLEXÍVEL
        // =========================
        if (!missing?.needsAge && !missing?.needsTherapy) {
            responseText += `\n\nSe quiser, posso verificar horários disponíveis para você ainda hoje 💚`;
        } else {
            responseText += `\n\nQuer que eu te ajude a verificar horários? 💚`;
        }

        return { text: responseText };
    }

    /**
     * 🆕 MÉTODO: Responde com VALOR DO TRABALHO → URGÊNCIA → PREÇO → RETOMA
     */
    buildValueFirstResponse(therapyId, therapyName, memory, pendingCollection) {
        const age = memory?.patientAge || memory?.patientInfo?.age;
        const complaint = memory?.complaint || memory?.primaryComplaint;

        // 1️⃣ VALOR DO TRABALHO
        const valuePitch = this.getValuePitch(therapyName, age);

        // 2️⃣ URGÊNCIA CONTEXTUAL
        const urgencyPitch = this.getUrgencyPitch(age, therapyName, complaint);

        // 3️⃣ PREÇO
        const pricePitch = this.getPricePitch(therapyName);

        // 4️⃣ RETOMADA
        const followUp = this.getSmartFollowUp(pendingCollection);

        // Montar resposta
        let response = valuePitch;
        if (urgencyPitch) response += ` ${urgencyPitch}`;
        response += ` ${pricePitch}`;
        if (followUp) response += ` ${followUp}`;

        return {
            text: response + ' 💚',
            needsResumption: true,
            pendingCollection
        };
    }

    /**
     * Explica o VALOR do trabalho por especialidade
     */
    getValuePitch(therapy, age) {
        const pitches = {
            'fonoaudiologia': 'A avaliação fonoaudiológica mapeia exatamente onde seu filho precisa de estímulo — vocês saem com um plano personalizado pro desenvolvimento da fala.',
            'fono': 'A avaliação fonoaudiológica mapeia exatamente onde seu filho precisa de estímulo — vocês saem com um plano personalizado pro desenvolvimento da fala.',

            'psicologia': 'A avaliação psicológica entende o que está por trás do comportamento e dá um direcionamento claro pra família — vocês saem com orientações práticas.',
            'psico': 'A avaliação psicológica entende o que está por trás do comportamento e dá um direcionamento claro pra família — vocês saem com orientações práticas.',

            'neuropsicologia': 'A avaliação neuropsicológica é completa: mapeamos atenção, memória, raciocínio e comportamento. Vocês recebem um laudo detalhado que serve pra escola, médicos e tratamentos.',
            'neuropsi': 'A avaliação neuropsicológica é completa: mapeamos atenção, memória, raciocínio e comportamento. Vocês recebem um laudo detalhado que serve pra escola, médicos e tratamentos.',

            'terapia_ocupacional': 'A avaliação de TO identifica as dificuldades sensoriais e de coordenação, e monta um plano pra ele ganhar mais autonomia no dia a dia.',
            'to': 'A avaliação de TO identifica as dificuldades sensoriais e de coordenação, e monta um plano pra ele ganhar mais autonomia no dia a dia.',

            'fisioterapia': 'A avaliação de fisioterapia analisa postura, equilíbrio e coordenação motora — saímos com um plano específico pro desenvolvimento.',
            'fisio': 'A avaliação de fisioterapia analisa postura, equilíbrio e coordenação motora — saímos com um plano específico pro desenvolvimento.',

            'musicoterapia': 'A avaliação de musicoterapia identifica como a música pode ajudar no desenvolvimento emocional e social.',

            'psicopedagogia': 'A avaliação psicopedagógica mapeia as dificuldades de aprendizagem e cria estratégias personalizadas pra escola.',

            'default': 'A avaliação é completa e personalizada — vocês saem com um plano claro do que fazer.'
        };

        return pitches[therapy?.toLowerCase()] || pitches['default'];
    }

    /**
     * Frase de urgência contextual por idade
     */
    getUrgencyPitch(age, therapy, complaint) {
        if (!age) return '';

        const ageNum = parseInt(age, 10);
        if (isNaN(ageNum)) return '';

        if (ageNum <= 6) {
            return 'Nessa fase, cada mês faz diferença pro desenvolvimento!';
        } else if (ageNum <= 12) {
            return 'É uma fase importante pra não deixar acumular dificuldades.';
        } else if (ageNum <= 17) {
            return 'Esse momento é chave pra recuperar o ritmo.';
        } else if (complaint?.includes('diagnóstico') || complaint?.includes('laudo') || therapy?.includes('neuro')) {
            return 'O laudo abre portas pra você entender melhor seus desafios.';
        }

        return '';
    }

    /**
     * Preço formatado como "investimento"
     */
    getPricePitch(therapy) {
        if (therapy?.includes('neuropsi') || therapy?.includes('neuropsicologia')) {
            return 'O investimento é R$ 2.500 (em até 6x) ou R$ 2.300 à vista.';
        }
        return 'O investimento na avaliação é R$ 200.';
    }

    /**
     * Retoma o flow de forma natural
     */
    getSmartFollowUp(pendingCollection) {
        if (!pendingCollection || pendingCollection.length === 0) {
            return 'Quer que eu veja os horários?';
        }

        const has = (item) => pendingCollection.includes(item);

        if (has('complaint')) return 'O que você tem observado que te preocupa?';
        if (has('age')) return 'Qual a idade do paciente?';
        if (has('period')) return 'Prefere manhã ou tarde?';
        if (has('therapy')) return 'É pra qual área?';

        return 'Quer que eu veja os horários?';
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