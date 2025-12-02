// utils/bookingProductMapper.js

import { inferTopic } from "./amandaPrompt.js";

/**
 * Normaliza em algo que a camada de agenda entende:
 *  - therapyArea: 'fonoaudiologia' | 'psicologia' | 'fisioterapia' | 'terapia_ocupacional'
 *  - specialties: tags para bater com Doctor.specialties
 *  - product: rótulo lógico do tipo de atendimento
 */
export function mapFlagsToBookingProduct(flags = {}, lead = {}) {
  const text = (flags.text || "").toLowerCase();
  const topic = flags.topic || inferTopic(flags.text || "");

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

  // 📝 PSICOPEDAGOGIA (criança ou adulto)
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
  if (flags.asksCAA || /comunica[çc][aã]o\s+alternativa|pecs|caa\b/i.test(text)) {
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
  if (/terapia\s+ocupacional|\bto\b/i.test(text)) {
    return {
      therapyArea: "terapia_ocupacional",
      specialties: [],
      product: "terapia_ocupacional",
    };
  }

  // Fallback: se o lead já tem area salva, usa
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
