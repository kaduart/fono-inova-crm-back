import { resolveTopicFromFlags } from "./amandaPrompt.js";


/**
 * Normaliza em algo que a camada de agenda entende:
 *  - therapyArea: 'fonoaudiologia' | 'psicologia' | 'fisioterapia' | 'terapia_ocupacional'
 *  - specialties: tags para bater com Doctor.specialties
 *  - product: rótulo lógico do tipo de atendimento
 */
export function mapFlagsToBookingProduct(flags = {}, lead = {}) {
  const text = (flags.text || "").toLowerCase();
  const topic = flags.topic || resolveTopicFromFlags(flags.text || "");

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

  // ✅ Se estamos no fluxo de agendamento e já existe área salva, NÃO remapear por mensagem curta ("manhã", "sim", etc.)
  if (flags.inSchedulingFlow || flags.wantsSchedulingNow) {
    const therapyArea =
      lead?.autoBookingContext?.mappedTherapyArea || lead?.therapyArea;

    if (therapyArea) {
      return {
        therapyArea,
        specialties: lead?.autoBookingContext?.mappedSpecialties || [],
        product: lead?.autoBookingContext?.mappedProduct || therapyArea,
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

  // Fallback genérico: psicologia / avaliação inicial
  return {
    therapyArea: "psicologia",
    specialties: [],
    product: "avaliacao_inicial",
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

