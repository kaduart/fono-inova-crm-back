// services/intelligence/clinicalRulesEngine.js

export function clinicalRulesEngine({ memoryContext, analysis, text = '' }) {
    const age = memoryContext?.patientAge || analysis?.extractedInfo?.age;
    const therapy = memoryContext?.therapyArea || analysis?.detectedTherapy;
    const relationship = memoryContext?.patientRelationship || analysis?.extractedInfo?.relationship;

    // Normaliza
    const ageNumber = Number(age);
    const normalizedText = (text || '').toLowerCase();

    // =========================
    // REGRA 0 — Especialidades médicas NÃO atendidas
    // =========================
    const MEDICAL_SPECIALTIES = [
        { terms: ['neurologista', 'neurologia', 'neurologo', 'neuropediatra'], type: 'neurologista' },
        { terms: ['pediatra', 'pediatria'], type: 'pediatra' },
        { terms: ['cardiologista', 'cardiologia'], type: 'cardiologista' },
        { terms: ['ortopedista', 'ortopedia'], type: 'ortopedista' },
        { terms: ['dermatologista', 'dermatologia'], type: 'dermatologista' }
    ];

    for (const specialty of MEDICAL_SPECIALTIES) {
        const detected = specialty.terms.some(term => normalizedText.includes(term));
        if (detected) {
            let message = '';

            if (specialty.type === 'neurologista') {
                message = 'Entendi que você tá buscando **neurologista** 🧠\n\n' +
                    'Aqui na Fono Inova a gente trabalha com **Neuropsicologia** (avaliação das funções cerebrais como atenção, memória, raciocínio), ' +
                    'mas pra acompanhamento neurológico médico, você vai precisar consultar um neurologista clínico.\n\n' +
                    '✨ Posso te ajudar com **Neuropsicologia** ou outras terapias que temos:\n' +
                    '• 💬 Fonoaudiologia\n• 🧠 Psicologia\n• 🏃 Fisioterapia\n• 🤲 Terapia Ocupacional\n• 📚 Psicopedagogia\n• 🎵 Musicoterapia\n\nQual te interessa?';
            } else if (specialty.type === 'pediatra') {
                message = 'Entendi! Você tá buscando **pediatra** 👶\n\n' +
                    'A gente é uma clínica de **terapias e reabilitação**, não atendemos com pediatras.\n\n' +
                    'Mas temos **terapias infantis** como:\n' +
                    '• 💬 Fonoaudiologia (fala, linguagem)\n• 🧠 Psicologia Infantil\n• 🤲 Terapia Ocupacional\n• 📚 Psicopedagogia\n\nAlguma te interessa?';
            } else {
                message = `Entendi! Você tá buscando **${specialty.type}** 🏥\n\n` +
                    'Somos especializados em **terapias e reabilitação**. Não atendemos com médicos, mas temos:\n' +
                    '• 💬 Fonoaudiologia\n• 🧠 Psicologia\n• 🏃 Fisioterapia\n• 🤲 Terapia Ocupacional\n• 📚 Psicopedagogia\n• 🧩 Neuropsicologia\n• 🎵 Musicoterapia\n\nAlguma te interessa?';
            }

            return {
                blocked: true,
                reason: 'medical_specialty_not_served',
                specialty: specialty.type,
                message
            };
        }
    }

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
