import { resolveTopicFromFlags } from "./flagsDetector.js";
import { detectAllTherapies, pickPrimaryTherapy } from "./therapyDetector.js";

/**
 * Normaliza em algo que a camada de agenda entende:
 *  - therapyArea: 'fonoaudiologia' | 'psicologia' | 'fisioterapia' | 'terapia_ocupacional' | 'psicomotricidade' | 'musicoterapia' | 'psicopedagogia'
 *  - specialties: tags para no bookingater com Doctor.specialties
 *  - product: rótulo lógico do tipo de atendimento
 */
export function mapFlagsToBookingProduct(flags = {}, lead = {}) {
  // ✅ FIX: Limpa nome da clínica ANTES de detectar área (DENTRO da função)
  const text = (flags.text || "")
    .toLowerCase()
    .replace(/cl[ií]nica\s+fono\s+inova/gi, '')
    .replace(/fono\s+inova/gi, '');

  const rawText = flags.rawText ?? flags.text ?? "";
  const topic = flags.topic || resolveTopicFromFlags(flags, rawText);
  // 🧠 DETECÇÃO AUTOMÁTICA DE TERAPIA
  const detectedTherapies = detectAllTherapies(text);
  const primaryTherapy = pickPrimaryTherapy(detectedTherapies);

  if (primaryTherapy) {
    // Faz o mapeamento automático
    const therapyMap = {
      speech: "fonoaudiologia",
      tongue_tie: "fonoaudiologia",
      psychology: "psicologia",
      occupational: "terapia_ocupacional",
      physiotherapy: "fisioterapia",
      music: "musicoterapia",
      psychomotor: "psicomotricidade",
      neuropsychological: "psicologia",
      neuropsychopedagogy: "psicopedagogia",
      psychopedagogy: "psicologia"
    };

    const therapyArea = therapyMap[primaryTherapy] || "fonoaudiologia";

    // ======================================================
    // 🧩 PATCH: Neuropsico e TDAH enriquecidos
    // ======================================================
    const primaryArea = flags.therapyArea || flags.topic || lead?.therapyArea;

    if (!primaryArea && text?.match(/(encaminhament|solicita(ç|c)(a|ã)o).{0,40}neuropsic/i)) {
      primaryArea = "neuropsicologia";
    }

    if (text?.match(/\b(foco|aten[çc][aã]o|concentra[çc][aã]o)\b/i)) {
      if (!primaryArea) primaryArea = "psicologia";
      flags.tdah = true; // ✅ CORRETO
    }

    if (text?.match(/refor[çc]o\s+escolar/i)) {
      if (!primaryArea) primaryArea = "psicopedagogia";
    }


    return {
      therapyArea,
      specialties: [primaryTherapy],
      product: primaryTherapy,
    };
  }

  const wantsLinguinha = /linguinha|fr[eê]nulo/i.test(text);
  const wantsFisio = /fisioterap|fisio\b/i.test(text);

  if (wantsLinguinha && wantsFisio) {
    return {
      therapyArea: null, // força triagem no orchestrator
      specialties: [],
      product: "multi_servico",
      multi: ["teste_linguinha", "fisioterapia"],
    };
  }

  // ✅ Lock só quando NÃO houver área explícita na mensagem
  const explicitArea =
    /\b(fono|fonoaudiolog)\b/i.test(text) ? "fonoaudiologia"
      : /\b(psico|psicolog)\b/i.test(text) ? "psicologia"
        : /fisioterap|fisio\b/i.test(text) ? "fisioterapia"
          : /terapia\s+ocupacional|terapeuta\s+ocupacional|\bT\.?\s*O\.?\b/i.test(flags.text || "") ? "terapia_ocupacional"
            : null;

  if (explicitArea) {
    const savedArea = lead?.autoBookingContext?.mappedTherapyArea || lead?.therapyArea;
    const canReuse = savedArea && savedArea === explicitArea;

    return {
      therapyArea: explicitArea,
      specialties: canReuse ? (lead?.autoBookingContext?.mappedSpecialties || []) : [],
      product: canReuse ? (lead?.autoBookingContext?.mappedProduct || explicitArea) : explicitArea,
      // opcional: marcador pra orquestrador saber que foi dito explicitamente
      _explicitArea: true,
    };
  }

  // ✅ Se estamos no fluxo de agendamento e já existe área salva, NÃO remapear
  // ...a menos que o usuário tenha dito explicitamente outra área agora
  if (flags.inSchedulingFlow || flags.wantsSchedulingNow) {
    const savedArea =
      lead?.autoBookingContext?.mappedTherapyArea || lead?.therapyArea;

    if (savedArea && !explicitArea) {
      return {
        therapyArea: savedArea,
        specialties: lead?.autoBookingContext?.mappedSpecialties || [],
        product: lead?.autoBookingContext?.mappedProduct || savedArea,
      };
    }
  }

  // 🧠 NEUROPSICOLOGIA / AVALIAÇÃO NEUROPSICOLÓGICA → Vitória
  if (
    topic === "neuropsicologica" ||
    /neuropsico|avalia[çc][aã]o\s+neuro/i.test(text)
  ) {
    return {
      therapyArea: "psicologia",
      specialties: ["avaliacao_neuropsicologica", "neuropsicologia"],
      product: "avaliacao_neuropsicologica",
    };
  }

  // 📝 PSICOPEDAGOGIA (criança ou adulto) → agenda na PSICO com especialidade
  if (
    topic === "psicopedagogia" ||
    flags.asksPsychopedagogy ||
    /\bpsicopedagog/i.test(text)
  ) {
    return {
      therapyArea: "psicologia",
      specialties: ["psicopedagogia", "neuropsicopedagoga"],
      product: "psicopedagogia",
    };
  }

  // 👅 TESTE DA LINGUINHA → Lorrany
  if (topic === "teste_linguinha" || /linguinha|fr[eê]nulo/i.test(text)) {
    return {
      therapyArea: "fonoaudiologia",
      specialties: ["teste_linguinha"],
      product: "teste_linguinha",
    };
  }

  // 📣 CAA / Comunicação Alternativa → Lorrany
  if (
    flags.asksCAA ||
    /comunica[çc][aã]o\s+alternativa|pecs|caa\b/i.test(text)
  ) {
    return {
      therapyArea: "fonoaudiologia",
      specialties: ["caa"],
      product: "fono_caa",
    };
  }

  // 🗣️ Psico em LIBRAS
  if (/\blibras\b/i.test(text)) {
    return {
      therapyArea: "psicologia",
      specialties: ["psicologia_libras"],
      product: "psicologia_libras",
    };
  }


  // 🗣️ Fono com método PROMPT
  if (flags.mentionsMethodPrompt) {
    return {
      therapyArea: "fonoaudiologia",
      specialties: ["fono_prompt"],
      product: "fono_prompt",
    };
  }

  // 🏃 Fisioterapia
  if (/fisioterap|fisio\b/i.test(text)) {
    return {
      therapyArea: "fisioterapia",
      specialties: [],
      product: "fisioterapia",
    };
  }

  // ✋ Terapia Ocupacional
  const mentionsTO =
    /terapia\s+ocupacional|terapeuta\s+ocupacional|\bT\.?\s*O\.?\b/i.test(flags.text || "");

  if (mentionsTO) {
    return {
      therapyArea: "terapia_ocupacional",
      specialties: [],
      product: "terapia_ocupacional",
    };
  }

  // 🧩 TEA / AUTISMO / TDAH (CAMINHO DE TERAPIA, QUALQUER IDADE)
  //
  // Aqui não é laudo neuropsico (já tratado lá em cima).
  // É para organizar as terapias pós-laudo: comportamento, fala, autonomia, escola.
  const mentionsTEA =
    flags.mentionsTEA_TDAH ||
    /\b(tea|autismo|autista|tdah)\b/i.test(text);

  if (mentionsTEA) {
    const mentionsBehavior =
      /comport|emoç|ansied|crise|birra|socializ|socializa|relacionar|conviv[êe]ncia|agressiv/i.test(
        text
      );
    const mentionsSpeech =
      flags.mentionsSpeechTherapy ||
      /fala|linguagem|comunica[çc][aã]o/i.test(text);
    const mentionsAutonomy =
      /autonomi|rotina|independ[êe]ncia|avd(s)?|sensorial|integra[çc][aã]o\s+sensorial|organiza[çc][aã]o/i.test(
        text
      );
    const mentionsSchool =
      /escola|escolar|aprendiz|estudo|prova|liç[aã]o|liçao|tarefa|vestibular|enem/i.test(
        text
      );

    // 👇 Aqui a triagem fina por foco:

    // 1) COMPORTAMENTO / EMOÇÃO / SOCIALIZAÇÃO → Psicologia
    if (mentionsBehavior) {
      return {
        therapyArea: "psicologia",
        specialties: ["psicologia_tea", "habilidades_sociais"],
        product: "psicologia_tea_comportamental",
      };
    }

    // 2) FALA / COMUNICAÇÃO → Fonoaudiologia
    if (mentionsSpeech) {
      return {
        therapyArea: "fonoaudiologia",
        specialties: ["fono_tea"],
        product: "fono_tea",
      };
    }

    // 3) AUTONOMIA / ROTINA / SENSORIAL → Terapia Ocupacional
    if (mentionsAutonomy) {
      return {
        therapyArea: "terapia_ocupacional",
        specialties: ["to_tea"],
        product: "to_tea",
      };
    }

    // 4) ESCOLA / APRENDIZAGEM / ESTUDOS → Psico / Neuropsicopedagogia (agenda em psico)
    if (mentionsSchool) {
      return {
        therapyArea: "psicologia",
        specialties: ["neuropsicopedagogia", "psicopedagogia"],
        product: "psico_aprendizagem_tea",
      };
    }

    // 5) Só diz que é autista/TEA, sem foco → Psicologia TEA genérico
    return {
      therapyArea: "psicologia",
      specialties: ["psicologia_tea"],
      product: "psicologia_tea",
    };
  }

  // Fallback: se o lead já tem área salva, usa
  if (lead.therapyArea) {
    return {
      therapyArea: lead.therapyArea,
      specialties: [],
      product: lead.therapyArea,
    };
  }

  // ✅ FIX: Se não detectou área, retorna null para forçar triagem
  // NÃO usar fallback de "psicologia" - isso pula a pergunta de queixa!
  return {
    therapyArea: null,
    specialties: [],
    product: null,
  };
}

/**
 * Só loga os sinais principais do funil de agendamento.
 * O orquestrador já chama `logBookingGate(flags)`, então definimos aqui.
 */
export function logBookingGate(flags = {}, mapped = null) {
  console.log("[BOOKING_GATE]", {
    wantsSchedule: !!flags.wantsSchedule,
    wantsSchedulingNow: !!flags.wantsSchedulingNow,
    inSchedulingFlow: !!flags.inSchedulingFlow,
    mappedTherapyArea: mapped?.therapyArea || null,
    topic: flags.topic || null,
  });
}