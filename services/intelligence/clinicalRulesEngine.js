// services/intelligence/clinicalRulesEngine.js

export function clinicalRulesEngine({ memoryContext, analysis }) {
    const age = memoryContext?.patientAge || analysis?.extractedInfo?.age;
    const therapy = memoryContext?.therapyArea || analysis?.detectedTherapy;
    const relationship = memoryContext?.patientRelationship || analysis?.extractedInfo?.relationship;

    // Normaliza
    const ageNumber = Number(age);

    // =========================
    // REGRA 1 — Psicologia > 16 anos
    // =========================
    if (therapy === 'psicologia' && ageNumber > 16) {
        return {
            blocked: true,
            reason: 'psychology_age',
            message:
                'No momento, nosso atendimento em psicologia é voltado para crianças e adolescentes. Para adultos, posso te indicar um profissional parceiro, se quiser 💚'
        };
    }

    // =========================
    // REGRA 2 — Bebê + Fisioterapia (gate osteopatia)
    // =========================
    if (therapy === 'fisioterapia' && ageNumber <= 2) {
        if (!memoryContext?.osteopathyCleared) {
            return {
                blocked: true,
                reason: 'osteopathy_gate',
                message:
                    'Para bebês, precisamos primeiro avaliar se há indicação para osteopatia antes de iniciar a fisioterapia. Posso te explicar como funciona essa avaliação 💚'
            };
        }
    }

    // =========================
    // REGRA 3 — Neuropsicopedagogia (mensagem especial)
    // =========================
    if (therapy === 'neuropsicopedagogia') {
        return {
            blocked: false,
            reason: 'neuro_special',
            message:
                'A neuropsicopedagogia é indicada para dificuldades de aprendizagem e atenção. O ideal é começarmos com uma avaliação para entender direitinho a necessidade da criança 💚'
        };
    }

    // =========================
    // REGRA 4 — Relationship inválido
    // =========================
    if (relationship && !['mae', 'pai', 'responsavel', 'paciente'].includes(relationship)) {
        return {
            blocked: false,
            reason: 'relationship_other',
            message:
                'Perfeito, posso te ajudar sim 😊 Você é responsável pela criança ou o próprio paciente?'
        };
    }

    // =========================
    // REGRA 5 — Idade não informada
    // =========================
    if (!ageNumber && therapy) {
        return {
            blocked: false,
            reason: 'missing_age',
            message:
                'Para eu te orientar melhor, você poderia me dizer a idade do paciente? 💚'
        };
    }

    // =========================
    // DEFAULT — Nenhuma regra bloqueia
    // =========================
    return {
        blocked: false
    };
}
