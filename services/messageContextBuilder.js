// services/messageContextBuilder.js
// Pipeline de inteligência pré-FSM
// Toda mensagem passa por aqui antes de qualquer decisão de estado.
// O FSM decide COM contexto, não no escuro.

import { detectGlobalIntent } from './StateMachine.js';
import {
  detectAllTherapies,
  detectTherapyBySymptoms,
  detectNegativeScopes,
  pickPrimaryTherapy,
  isTDAHQuestion,
} from '../utils/therapyDetector.js';
import {
  detectAllFlags,
  detectManualIntent,
  detectMedicalSpecialty,
  computeTeaStatus,
} from '../utils/flagsDetector.js';
import { shouldOfferScheduling } from '../utils/amandaPrompt.js';

/**
 * Roda todos os detectores para uma mensagem e retorna contexto consolidado.
 * Chamado uma única vez no início de process() — resultado disponível para
 * decisões pré-switch e para todos os estados do FSM.
 *
 * @param {string} text          - Texto da mensagem do lead
 * @param {object} lead          - Documento do lead (freshLead do banco)
 * @param {string} state         - Estado atual do FSM
 * @param {object} stateData     - Dados do estado atual
 * @param {object} insights      - Insights de conversas reais (amandaLearningService)
 * @returns {object} ctx         - Contexto consolidado
 */
export async function buildMessageContext(text, lead, state, stateData, insights = null) {
  // ── 1. FLAGS DE INTENÇÃO E EMOÇÃO ──────────────────────────────────────────
  // detectAllFlags = deriveFlagsFromText + contexto conversacional (isNewLead,
  // visitLeadHot, inSchedulingFlow, userProfile, wantsSchedulingNow, etc.)
  const flags = detectAllFlags(text, lead, {
    stage: state,
    messageCount: lead?.messageCount || 0,
  });

  // Intenção manual (endereço, planos de saúde, saudação, despedida)
  // Complementa globalIntent com categorias mais específicas
  const manualIntent = detectManualIntent(text);

  // ── 2. TERAPIAS ────────────────────────────────────────────────────────────
  // Detecta por nome direto (fono, psico) e por sintoma (agitado, não fala).
  const therapies = detectAllTherapies(text);
  const symptomTherapies = detectTherapyBySymptoms(text);

  // Primária: nome direto tem precedência sobre sintoma
  const primaryTherapy =
    therapies.length > 0
      ? pickPrimaryTherapy(therapies)
      : symptomTherapies[0] || null;

  // ── 3. INTELIGÊNCIA CLÍNICA ────────────────────────────────────────────────
  const isTDAH = isTDAHQuestion(text);
  const negativeScope = detectNegativeScopes(text); // { mentionsOrelhinha }
  // Fonte única de verdade para laudo vs acompanhamento (usa flags já computados)
  const teaStatus = computeTeaStatus(flags, text); // "laudo_confirmado" | "suspeita" | "desconhecido"

  // ── 4. INTENÇÕES GLOBAIS ───────────────────────────────────────────────────
  const globalIntent = detectGlobalIntent(text);           // PRICE_QUERY, LOCATION_QUERY…
  const medicalSpecialty = detectMedicalSpecialty(text);   // neuropediatra → neuropsicologia

  // ── 5. DADOS DO LEAD (fonte única de verdade) ─────────────────────────────
  // Resolve fragmentação entre stateData, patientInfo, qualificationData
  const leadData = {
    name:
      stateData?.patientName ||
      lead?.stateData?.name ||
      lead?.patientInfo?.fullName ||
      lead?.qualificationData?.nome ||
      null,

    age:
      stateData?.age ||
      lead?.stateData?.age ||
      lead?.patientInfo?.age ||
      lead?.qualificationData?.idade ||
      null,

    therapy: (() => {
      // Mapeia IDs de terapia (inglês/abreviações) para nomes em português
      const areaMap = {
        // Fonoaudiologia
        "speech": "fonoaudiologia",
        "tongue_tie": "fonoaudiologia",
        "fono": "fonoaudiologia",
        "fonoaudiologia": "fonoaudiologia",
        // Psicologia
        "psychology": "psicologia",
        "psico": "psicologia",
        "psicologia": "psicologia",
        // Terapia Ocupacional
        "occupational": "terapia_ocupacional",
        "to": "terapia_ocupacional",
        "terapia_ocupacional": "terapia_ocupacional",
        // Fisioterapia
        "physiotherapy": "fisioterapia",
        "fisio": "fisioterapia",
        "fisioterapia": "fisioterapia",
        // Musicoterapia
        "music": "musicoterapia",
        "musicoterapia": "musicoterapia",
        // Neuropsicologia
        "neuropsychological": "neuropsicologia",
        "neuro": "neuropsicologia",
        "neuropsicologia": "neuropsicologia",
        // Psicopedagogia
        "psychopedagogy": "psicopedagogia",
        "psicoped": "psicopedagogia",
        "psicopedagogia": "psicopedagogia",
        "neuropsychopedagogy": "neuropsicologia",
      };
      
      const rawTherapy = stateData?.therapy || lead?.therapyArea || (primaryTherapy?.id ?? primaryTherapy) || null;
      
      // Se for um ID conhecido, converte para nome em português
      if (rawTherapy && areaMap[rawTherapy]) {
        return areaMap[rawTherapy];
      }
      
      return rawTherapy;
    })(),

    complaint:
      stateData?.complaint ||
      lead?.autoBookingContext?.complaint ||
      lead?.qualificationData?.queixa ||
      null,
  };

  // ── 6. ESTRATÉGIA DE CONVERSÃO ────────────────────────────────────────────
  const canOfferScheduling = shouldOfferScheduling({
    therapyArea: leadData.therapy,
    patientAge: leadData.age,
    complaint: leadData.complaint,
    bookingOffersCount: lead?.bookingOffersCount || 0,
    emotionalContext: {
      interests: flags.isHotLead ? ['booking'] : [],
    },
  });

  // ── 7. PROMPT MODE com insights reais de conversas ────────────────────────
  // Monta o contexto para buildSystemPrompt incluindo aprendizados do histórico.
  // Insights contêm padrões extraídos de leads que efetivamente converteram.
  const promptMode = {
    therapyArea: leadData.therapy,
    patientAge: leadData.age,
    patientName: leadData.name,
    complaint: leadData.complaint,
    emotionalContext: {
      expressedWorry: flags.isEmotional,
      expressedUrgency: flags.mentionsUrgency,
      expressedFrustration: flags.refusesOrDenies,
    },
    intentScore: flags.isHotLead ? 85 : flags.wantsSchedule ? 60 : 20,
    // Aprendizados reais de conversas que converteram
    learnings: insights?.data ? {
      openings: insights.data.bestOpeningLines?.slice(0, 3) || [],
      priceHandling: insights.data.effectivePriceResponses?.slice(0, 2) || [],
      closings: insights.data.successfulClosingQuestions?.slice(0, 3) || [],
    } : null,
    negativeScope: insights?.data?.negativeScope || [],
  };

  return {
    // Texto
    text,

    // Flags de intenção e emoção (detectAllFlags — inclui contexto conversacional)
    flags,

    // Intenções globais e médicas
    globalIntent,
    manualIntent,
    medicalSpecialty,

    // Detecção clínica
    therapies,
    symptomTherapies,
    primaryTherapy,
    isTDAH,
    negativeScope,
    teaStatus,

    // Dados unificados do lead
    leadData,

    // Estratégia
    canOfferScheduling,
    promptMode,
  };
}
