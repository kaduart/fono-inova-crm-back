
import "dotenv/config";
import { getTherapyPricing, formatPrice } from "../config/pricing.js";
import { analyzeLeadMessage } from "../services/intelligence/leadIntelligence.js";
import { urgencyScheduler } from "../services/intelligence/UrgencyScheduler.js";
import enrichLeadContext from "../services/leadContext.js";
import { deriveFlagsFromText, detectAllFlags, resolveTopicFromFlags, detectManualIntent, computeTeaStatus } from "../utils/flagsDetector.js";
import { detectWithContext as detectWithContextualDetectors } from "../detectors/DetectorAdapter.js";
import { buildStrategicContext, logStrategicEnrichment } from "./ContextEnrichmentLayer.js"; // 🆕 FASE 3
import { trackDetection, recordOutcome } from "../services/DetectorFeedbackTracker.js"; // 🆕 FASE 4
import { enforce as enforceStructuralRules } from "../services/EnforcementLayer.js";
import { buildEquivalenceResponse } from "../utils/responseBuilder.js";
import {
    detectAllTherapies,
    detectNegativeScopes,
    getPriceLinesForDetectedTherapies,
    getTDAHResponse,
    isAskingAboutEquivalence,
    isTDAHQuestion
} from "../utils/therapyDetector.js";

import Followup from "../models/Followup.js";
import Leads from "../models/Leads.js";
import { callOpenAIFallback } from "../services/aiAmandaService.js";
import {
    autoBookAppointment,
    findAvailableSlots,
    formatDatePtBr,
    formatSlot,
    pickSlotFromUserReply,
    validateSlotStillAvailable
} from "../services/amandaBookingService.js";
import { getLatestInsights } from "../services/amandaLearningService.js";
import { buildValueAnchoredClosure, determinePsychologicalFollowup } from "../services/intelligence/smartFollowup.js";
import { nextStage } from "../services/intelligence/stageEngine.js";
import manageLeadCircuit from "../services/leadCircuitService.js";
import { handleInboundMessageForFollowups } from "../services/responseTrackingService.js";
import { sendLocationMessage, sendTextMessage } from "../services/whatsappService.js";
import {
    buildDynamicSystemPrompt,
    buildUserPromptWithValuePitch,
    calculateUrgency,
    shouldOfferScheduling,
} from "../utils/amandaPrompt.js";
import { logBookingGate, mapFlagsToBookingProduct } from "../utils/bookingProductMapper.js";
import { extractPreferredDateFromText } from "../utils/dateParser.js";
import { getWisdomForContext, TESTE_LINGUINHA_WISDOM } from "../utils/clinicWisdom.js";
import ensureSingleHeart from "../utils/helpers.js";
import { extractAgeFromText, extractBirth, extractComplaint, extractName, extractPeriodFromText, isValidPatientName } from "../utils/patientDataExtractor.js";
import { safeAgeUpdate } from "../utils/safeDataUpdate.js";
import { buildSlotMenuMessage } from "../utils/slotMenuBuilder.js";
import callAI from "../services/IA/Aiproviderservice.js";
import { clinicalEligibility } from "../domain/policies/ClinicalEligibility.js";
import { canAutoRespond, buildResponseFromFlags, getTherapyInfo } from '../services/ResponseBuilder.js';
import {
  resolveDecision,
  extractDetectorResults,
  logDecision
} from './decision/index.js';
import { isSafeEmploymentIntent } from './decision/EmploymentGuard.js';
import { resolveClinicalArea } from './decision/ClinicalMapper.js';
import { resolveBestArea } from './decision/PriorityResolver.js';
import { CLINIC_KNOWLEDGE } from '../knowledge/clinicKnowledge.js';
import { hasContextHint } from '../utils/intentRouter.js';
import { isNationalHoliday } from '../config/feriadosBR.js';
import Appointment from '../models/Appointment.js';
// 🆕 Helper interno para detectar emoção (inline para evitar dependência circular)
function detectEmotionalState(text = '') {
    const anxietyWords = /preocup|ansios|desesper|urgente|muito mal|piorando|não aguento|desesperada/i;
    const sadnessWords = /triste|chorando|sofrimento|sofr|angústi|depress/i;
    return {
        isAnxious: anxietyWords.test(text),
        isSad: sadnessWords.test(text),
    };
}

const recentResponses = new Map();

// ============================================================================
// 🔧 HELPER: Normaliza período para schema (remove acentos)
// 'manhã' → 'manha' | 'tarde' → 'tarde' | 'noite' → 'noite'
// ============================================================================
const normalizePeriod = (p) => {
    if (!p) return null;
    return p.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
};

// ============================================================================
// 🛡️ SERVIÇOS VÁLIDOS DA CLÍNICA (fonte única da verdade)
// ============================================================================
const VALID_SERVICES = {
    // Terapias disponíveis
    fonoaudiologia: { name: "Fonoaudiologia", available: true },
    psicologia: { name: "Psicologia Infantil", available: true, ageLimit: 16 },
    terapia_ocupacional: { name: "Terapia Ocupacional", available: true },
    fisioterapia: { name: "Fisioterapia", available: true },
    musicoterapia: { name: "Musicoterapia", available: true },
    neuropsicologia: { name: "Neuropsicologia", available: true },
    psicopedagogia: { name: "Psicopedagogia", available: true },

    // Mapeamentos comuns
    fono: { alias: "fonoaudiologia" },
    to: { alias: "terapia_ocupacional" },
    fisio: { alias: "fisioterapia" },
    neuropsico: { alias: "neuropsicologia" },

    // Multi terapias (do LEGACY)
    multiprofissional: { name: "Multiprofissional", available: true, isMulti: true },
};

// Especialidades médicas que NÃO oferecemos
// ✅ ATUALIZADO Abr/2026: Removido 'neuropediatra' - agora temos na clínica!
const MEDICAL_SPECIALTIES = [
    { terms: ['neurologista', 'neurologia'], name: 'Neurologista', redirect: 'neuropsicologia' },
    { terms: ['pediatra', 'pediatria'], name: 'Pediatra', redirect: 'fonoaudiologia' },
    { terms: ['psiquiatra', 'psiquiatria'], name: 'Psiquiatra', redirect: 'psicologia' },
    { terms: ['cardiologista', 'ortopedista', 'dermatologista'], name: null, redirect: null },
    // NOTA: neuropediatra foi removido pois agora é um serviço disponível (R$ 550)
];

/**
 * 🩺 Valida se o serviço solicitado existe na clínica
 * Retorna: { valid: boolean, service: string, message?: string, redirect?: string }
 */
function validateServiceRequest(text = "") {
    // 🛡️ FIX: Normaliza acentos para detectar palavras com/sem acento
    const normalized = text.toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

    // 🆕 FIX: Se usuário mencionou serviço VÁLIDO da clínica, não bloquear por especialidade médica
    // Ex: "quero neuropsicóloga mas estou esperando neuropediatra" → deve permitir
    const hasValidService = Object.entries(VALID_SERVICES).some(([key, config]) => {
        if (config.alias) return false;
        const terms = [key, config.name?.toLowerCase()].filter(Boolean);
        return config.available !== false && terms.some(term => normalized.includes(term));
    });

    // 1. Verificar especialidades médicas primeiro
    for (const medical of MEDICAL_SPECIALTIES) {
        if (medical.terms.some(term => normalized.includes(term))) {
            // 🛡️ Se usuário também mencionou serviço válido, não bloquear
            if (hasValidService) {
                console.log(`[VALIDATION] Especialidade médica '${medical.name}' detectada, mas usuário também mencionou serviço válido. Permitindo.`);
                return { valid: true };
            }
            return {
                valid: false,
                isMedicalSpecialty: true,
                requested: medical.name,
                redirect: medical.redirect,
                message: buildMedicalSpecialtyResponse(medical)
            };
        }
    }

    // 2. Verificar serviços indisponíveis
    for (const [key, config] of Object.entries(VALID_SERVICES)) {
        if (config.alias) continue; // Pular aliases

        // Verificar se mencionou este serviço
        const serviceTerms = [key, config.name?.toLowerCase()].filter(Boolean);
        const mentioned = serviceTerms.some(term => normalized.includes(term));

        if (mentioned && config.available === false) {
            return {
                valid: false,
                requested: config.name,
                redirect: config.redirectTo,
                reason: config.reason,
                message: buildUnavailableServiceResponse(config)
            };
        }
    }

    return { valid: true };
}

/**
 * 💚 Resposta humanizada para especialidade médica
 * Usa variações para não parecer robótico
 */
function buildMedicalSpecialtyResponse(medical, context = {}) {
    const name = medical.name;
    const redirect = medical.redirect;
    const { leadName, mentionedSymptoms } = context;

    // Variações de abertura mais naturais
    const openingVariations = [
        `Oi${leadName ? ` ${leadName}` : ''}! 💚`,
        `Oi! Tudo bem? 💚`,
        `Olá! 😊`,
    ];

    const opening = openingVariations[Math.floor(Math.random() * openingVariations.length)];

    // Reconhecimento da demanda
    let acknowledgment = '';
    if (mentionedSymptoms) {
        acknowledgment = ` Entendi que vocês estão lidando com ${mentionedSymptoms}. É uma preocupação válida!`;
    }

    // Explicação sobre ser clínica de terapias
    const explanations = [
        `\n\nSomos uma clínica de **terapias especializadas** — trabalhamos com fonoaudiologia, psicologia, neuropsicologia, terapia ocupacional e fisioterapia. Não temos médicos na equipe.`,
        `\n\nAqui na Fono Inova somos uma equipe de **terapeutas** (fonoaudiólogas, psicólogas, neuropsicólogas). Não atendemos com médicos.`,
        `\n\nSomos especializados em **terapias** para desenvolvimento infantil. Não temos médicos na equipe, mas trabalhamos em parceria com a área médica quando necessário!`,
    ];

    const explanation = explanations[Math.floor(Math.random() * explanations.length)];

    let redirectPart = '';
    if (redirect) {
        const redirectOptions = {
            neuropsicologia: {
                intro: [
                    `\n\nMas posso te ajudar com **Neuropsicologia**! 😊`,
                    `\n\nO que posso oferecer é **Neuropsicologia**:`,
                    `\n\nUma alternativa que costuma ajudar muito é a **Neuropsicologia**:`,
                ],
                details: [
                    `Avaliamos as funções cerebrais (atenção, memória, linguagem, raciocínio) e emitimos laudo completo. É diferente da consulta médica — somos terapeutas, não médicos.`,
                    `Fazemos uma bateria de testes para avaliar cognição, comportamento e aprendizagem. O laudo serve para escola, médicos e planejamento terapêutico.`,
                    `Avaliamos tudo: atenção, memória, forma de pensar, comportamento. É super completo e o laudo é válido para escola e médicos!`,
                ]
            },
            fonoaudiologia: {
                intro: [`\n\nPosso te ajudar com **Fonoaudiologia**! 😊`],
                details: [`Trabalhamos desenvolvimento da fala, linguagem, alimentação e motricidade oral.`],
            },
            psicologia: {
                intro: [`\n\nPosso te ajudar com **Psicologia Infantil**! 😊`],
                details: [`Acompanhamento terapêutico para questões emocionais, comportamentais e desenvolvimento.`],
            }
        };

        const info = redirectOptions[redirect];
        if (info) {
            const intro = info.intro[Math.floor(Math.random() * info.intro.length)];
            const detail = info.details[Math.floor(Math.random() * info.details.length)];
            redirectPart = intro + '\n' + detail;
        }
    } else {
        redirectPart = `\n\nSe quiser, posso explicar como as terapias podem ajudar no desenvolvimento! 💚`;
    }

    return opening + acknowledgment + explanation + redirectPart + '\n\nQuer saber mais? 💚';
}

/**
 * 💚 Resposta humanizada para serviço indisponível
 */
function buildUnavailableServiceResponse(config, context = {}) {
    const { leadName, conversationHistory } = context;
    const hasHistory = conversationHistory && conversationHistory.length > 0;

    // Abertura mais pessoal se já tem histórico
    let opening = '';
    if (hasHistory) {
        opening = `Oi${leadName ? ` ${leadName}` : ''}! 💚 Entendi que você tá buscando **${config.name}**.`;
    } else {
        opening = `Oi! 💚 Agradeço o interesse em **${config.name}**!`;
    }

    let body = '';
    if (config.reason) {
        const explanations = [
            `\n\nNo momento não temos profissional de ${config.name} ativo na clínica. Mas não quer dizer que não possamos ajudar de outra forma!`,
            `\n\nInfelizmente agora não temos ${config.name} disponível. Mas deixa eu te explicar uma alternativa que pode ser até melhor:`,
        ];
        body = explanations[Math.floor(Math.random() * explanations.length)];
    }

    let redirectPart = '';
    if (config.redirectTo) {
        const redirectOptions = {
            neuropsicologia: {
                name: "Neuropsicologia",
                phrases: [
                    `Posso te ajudar com **Neuropsicologia**! É uma avaliação completa das funções cognitivas (atenção, memória, linguagem, raciocínio). Na prática, muitas crianças com dificuldades escolares se beneficiam MUITO dessa avaliação! 😊`,
                    `O que oferecemos é **Neuropsicologia** — é tipo um "raio-x" do cérebro, mas feito com testes. Avaliamos tudo: como a criança presta atenção, memoriza, raciocina. O laudo é super completo!`,
                ]
            }
        };

        const info = redirectOptions[config.redirectTo];
        if (info) {
            const phrase = info.phrases[Math.floor(Math.random() * info.phrases.length)];
            redirectPart = `\n\n${phrase}`;
        }
    }

    // Fechamento acolhedor
    const closings = [
        `\n\nPosso te explicar melhor como funciona? 💚`,
        `\n\nQuer que eu te conte mais sobre isso? 😊`,
        `\n\nSe quiser saber mais, é só me perguntar! Estou aqui pra ajudar. 💚`,
    ];
    const closing = closings[Math.floor(Math.random() * closings.length)];

    return opening + body + redirectPart + closing;
}

/**
 * 🧠 Extrai sintomas/contexto do texto para personalizar resposta
 */
function extractContextForResponse(text = "", lead = {}) {
    const normalized = text.toLowerCase();
    const symptoms = [];

    // Mapeamento de sintomas comuns
    const symptomMap = {
        'atraso de fala': /n[aã]o fala|fala pouco|demorou pra falar/i,
        'dificuldade escolar': /n[aã]o aprende|dificuldade na escola|nota baixa/i,
        'problema de comportamento': /birra|agressivo|n[aã]o obedece/i,
        'suspeita de autismo': /autismo|tea|suspeita/i,
        'dificuldade motora': /n[aã]o anda direito|tropeça|coordena[cç][aã]o/i,
    };

    for (const [symptom, pattern] of Object.entries(symptomMap)) {
        if (pattern.test(normalized)) {
            symptoms.push(symptom);
        }
    }

    return {
        leadName: lead?.patientInfo?.fullName?.split(' ')[0] || lead?.contact?.name?.split(' ')[0],
        mentionedSymptoms: symptoms.length > 0 ? symptoms.join(', ') : null,
        conversationHistory: lead?.conversationHistory || []
    };
}

// ============================================================================
// 🛡️ HELPER: Update seguro que inicializa autoBookingContext se for null
// ============================================================================
async function safeLeadUpdate(leadId, updateData, options = {}) {
    try {
        // Tenta o update normal primeiro
        const result = await Leads.findByIdAndUpdate(leadId, updateData, { new: true, ...options });
        return result;
    } catch (err) {
        // Se o erro for sobre autoBookingContext null, inicializa e tenta de novo
        if (err.message?.includes("Cannot create field") && err.message?.includes("autoBookingContext")) {
            console.log("🔧 [SAFE-UPDATE] Inicializando autoBookingContext e tentando novamente...");

            // Primeiro inicializa o autoBookingContext como objeto vazio
            await Leads.findByIdAndUpdate(leadId, {
                $set: { autoBookingContext: {} }
            }).catch(err => logSuppressedError('safeLeadUpdate', err));

            // Agora tenta o update original de novo
            try {
                const result = await Leads.findByIdAndUpdate(leadId, updateData, { new: true, ...options });
                console.log("✅ [SAFE-UPDATE] Update bem-sucedido após inicialização");
                return result;
            } catch (err2) {
                console.error("❌ [SAFE-UPDATE] Falhou mesmo após inicialização:", err2.message);
                return null;
            }
        }

        // Outro tipo de erro - propaga
        throw err;
    }
}


const PURE_GREETING_REGEX =
    /^(oi|ol[aá]|boa\s*(tarde|noite|dia)|bom\s*dia)[\s!,.]*$/i;

const GENERIC_SCHEDULE_EVAL_REGEX =
    /\b(agendar|marcar|agendamento|quero\s+agendar|gostaria\s+de\s+agendar)\b.*\b(avalia[çc][aã]o)\b/i;

// ============================================================================
// 🆕 HELPERS DE EXTRAÇÃO (ADICIONADOS PARA CORRIGIR O LOOP)
// ============================================================================

// ============================================================================
// 🛡️ DYNAMIC_MODULES - Versão Completa (migrado de amandaPrompt.js legado)
// ============================================================================
const DYNAMIC_MODULES = {
    // =========================================================================
    // 🎭 MODOS DE CONDUÇÃO DO LEAD
    // =========================================================================
    consultoriaModeContext: `
💎 MODO CONSULTORIA PREMIUM — HUMANIZADO E ASSERTIVO

- Tom de especialista acolhedora (não robótica nem excessivamente emocional).
- Use validação leve + direção firme.
- Exemplo de sequência:
  "Entendo, isso é algo que muitos pais observam nessa fase. 💚"
  "O ideal é fazermos uma avaliação, pra entender a causa e já montar um plano claro."
  "Prefere essa semana ou na próxima?"

Frases de apoio:
- "A avaliação é o passo certo pra agir com clareza."
- "Quando a gente entende o quadro, tudo flui melhor em casa e na escola."
- "Você tá fazendo o certo em buscar ajuda logo — isso faz muita diferença."
"Aqui a gente trabalha com clareza de propósito: o primeiro passo é sempre entender o quadro com um especialista, pra decidir com segurança o melhor caminho."
`,

    acolhimentoModeContext: `
🟢 MODO ACOLHIMENTO — TOM EMPÁTICO

- Comunicação mais suave e acolhedora.
- Valide sentimentos antes de orientar.
- Traga segurança antes da decisão.

Use frases como:
- "Entendo 💚 Isso é algo que preocupa muitos pais, e você fez muito bem em buscar orientação cedo."
- "Vocês não estão sozinhos, a gente caminha junto."
- "A avaliação ajuda a trazer clareza com tranquilidade."

Objetivo: reduzir medo e criar vínculo.
`.trim(),

    // =========================================================================
    // 🎯 MÓDULO CORE: PROPOSTA DE VALOR (SEMPRE ATIVO)
    // =========================================================================
    valueProposition: `
🎯 PROPOSTA DE VALOR DA FONO INOVA (USE SEMPRE):

POR QUE SOMOS DIFERENTES:
• Equipe MULTIPROFISSIONAL integrada (Fono, Psico, TO, Fisio, Neuro, Musicoterapia)
• Plano INDIVIDUALIZADO para cada criança — não é "mais do mesmo"
• Acompanhamento PRÓXIMO — os pais participam do processo
• Ambiente ACOLHEDOR pensado para crianças
• Profissionais ESPECIALIZADOS em neurodesenvolvimento

FRASES DE VALOR (use naturalmente):
- "Aqui cada criança tem um plano pensado só pra ela."
- "Nossa equipe trabalha junta — fono, psicólogo, TO conversam sobre o caso do seu filho."
- "Muitos pais que vieram 'só pesquisar' saíram encantados com o acolhimento."
- "A evolução do seu filho não pode esperar — e aqui a gente começa rápido."
- "O diferencial é o cuidado: você não vai ser só mais um número."

⚠️ REGRA DE OURO:
Antes de falar PREÇO, sempre contextualize o VALOR.
O pai/mãe precisa entender que está investindo no MELHOR para o filho.
`.trim(),

    // =========================================================================
    // 📊 MÓDULOS DE PERFIL
    // =========================================================================
    childProfile: `
📌 PERFIL DO PACIENTE: CRIANÇA
- Interlocutor: Pai/Mãe/Responsável (use "seu filho", "sua filha", nome da criança).
- Foco: Desenvolvimento, escola, fala, comportamento.
- Use "você" para o responsável, não para a criança.
- SEMPRE mencione o nome da criança quando souber.
- NÃO pergunte novamente se é para criança ou adulto.
`.trim(),

    adultProfile: `
📌 PERFIL DO PACIENTE: ADULTO
- Interlocutor: O próprio paciente (use "você").
- Foco: Trabalho, faculdade, autonomia, laudo para concurso/vida.
- Neuropsicopedagogia ajuda em: atenção, memória, organização de estudos.
`.trim(),

    teenProfile: `
📌 PERFIL DO PACIENTE: ADOLESCENTE
- Interlocutor: Pode ser o próprio ou o responsável.
- Foco: Escola, ENEM/vestibular, socialização.
`.trim(),

    clinicalStrategyContext: `
🧠 VISÃO CLÍNICA INTEGRADA (SEMPRE ATIVA)

- A Fono Inova atua de forma multiprofissional.
- Muitos casos não são de uma única área.
- A avaliação inicial serve para:
  • entender o quadro como um todo,
  • definir a área principal,
  • decidir se o melhor é sessão avulsa ou acompanhamento estruturado.

Frase-chave:
"Aqui a gente não começa escolhendo tratamento, a gente começa entendendo a pessoa."
`.trim(),

    // =========================================================================
    // 🧠 MÓDULOS DE ESPECIALIDADE
    // =========================================================================
    neuroContext: `
🧠 CONTEXTO TEA / TDAH / AUTISMO:
- Acolha a preocupação sem assustar.
- Diagnóstico final só em avaliação presencial, nunca por WhatsApp.
- Equipe: Multiprofissional (Fono, Psico, TO, Fisio, Neuropsicopedagogia).
- DIFERENCIAL: "Temos profissionais especializados em TEA e planos individuais."

📌 REGRA ESPECÍFICA QUANDO A DOR É "AUTISMO / TEA / LAUDO":
- Sempre explique que, nesse tipo de caso, a Fono Inova trabalha com DOIS CAMINHOS principais:
  1) **Avaliação neuropsicológica completa** (pacote de ~10 sessões) que gera um **laudo** detalhado;
  2) **Iniciar terapias** (Fono / Psico / TO) por cerca de 3 meses, e ao final a equipe emite um **relatório clínico** para levar ao neuropediatra.

- Deixe claro que:
  • Terapia sozinha NÃO substitui laudo médico;
  • O laudo geralmente vem do neuropediatra/psiquiatra, e a clínica ajuda com laudo neuropsicológico e/ou relatório terapêutico.

- SEMPRE faça uma pergunta binária para o responsável escolher:
  "Pra vocês, faz mais sentido começar pela **avaliação pra laudo** ou pelas **terapias com relatório pro neuropediatra**?"

- AÇÃO: Depois que a pessoa escolher o caminho (neuropsico ou terapias), aí sim conduza para agendar avaliação ou montar o plano.
`.trim(),

    teaTriageContext: `
🧭 TRIAGEM TEA/AUTISMO - REGRA OBRIGATÓRIA

⚠️ SEMPRE QUE O RESPONSÁVEL MENCIONAR TEA/AUTISMO/SUSPEITA:

1. Acolha brevemente
2. Explique os DOIS CAMINHOS:

   📋 CAMINHO 1 - AVALIAÇÃO NEUROPSICOLÓGICA:
   • Pacote ~10 sessões → gera LAUDO
   • R$ 2.000 (até 6x)

   🧩 CAMINHO 2 - TERAPIAS + RELATÓRIO:
   • Fono/Psico/TO por ~3 meses
   • Equipe emite RELATÓRIO CLÍNICO pro neuropediatra

3. SEMPRE PERGUNTE:
   "Pra vocês, faz mais sentido começar pela **avaliação pra laudo** ou pelas **terapias com relatório pro neuro**?"

🚨 NÃO ofereça só neuropsico direto! Dê as duas opções primeiro.
`.trim(),

    teaPostDiagnosisContext: `
🧭 TRIAGEM PARA TEA/TDAH COM LAUDO FECHADO (QUALQUER IDADE)

📌 QUANDO ESTE MÓDULO VALE:
- O paciente JÁ TEM laudo de TEA/TDAH (criança, adolescente ou adulto).
- O foco agora não é "descobrir se tem", e sim organizar as TERAPIAS.

REGRA GERAL:
- NÃO empurre avaliação neuropsicológica de novo se o objetivo não for laudo.
- Foque em entender QUAL ÁREA é mais prioritária nas terapias.

1️⃣ ADAPTE A FALA À IDADE:
- Se já souber que é CRIANÇA:
  → Fale com o responsável: "seu filho", "sua filha", use o nome da criança.
- Se for ADOLESCENTE:
  → Pode alternar entre "ele/ela" e "vocês", sempre tratando o responsável como decisor.
- Se for ADULTO falando de si:
  → Use "você" diretamente.
- NUNCA pergunte de novo se é criança ou adulto se isso já estiver claro no histórico.

2️⃣ PERGUNTA-CHAVE (FOCO TERAPÊUTICO):
Sempre que for TEA/TDAH COM LAUDO, faça uma pergunta como:

- Para CRIANÇA/ADOLESCENTE:
  "Como ele(a) já tem laudo fechado, o próximo passo é focar nas terapias.
   Hoje a maior necessidade é mais pra:
   • comportamento / emoções / socialização,
   • fala / comunicação,
   • aprendizagem / escola,
   • ou autonomia do dia a dia (rotina, independência, parte sensorial)?"

- Para ADULTO:
  "Como você / ele já tem laudo fechado, agora o foco é nas terapias.
   Hoje incomoda mais:
   • comportamento / emoções / socialização,
   • fala / comunicação,
   • rotina e autonomia (organização do dia, trabalho, faculdade),
   • ou aprendizagem / estudo / foco?"

3️⃣ MAPEAR FOCO → ESPECIALIDADE CERTA:
Leia o que a pessoa responder e decida a área principal:

- Se falar de COMPORTAMENTO, EMOÇÕES, ANSIEDADE, CRISES, SOCIALIZAÇÃO:
  → Principal: **Psicologia**.
  Ex.: "Nesse caso, aqui na Fono Inova quem assume é a Psicologia, com foco em comportamento e habilidades sociais."

- Se falar de FALA, COMUNICAÇÃO, NÃO FALA DIREITO, NÃO SE EXPRESSA:
  → Principal: **Fonoaudiologia**.

- Se falar de AUTONOMIA, ROTINA, INDEPENDÊNCIA, ORGANIZAÇÃO, SENSORIAL, DIFICULDADE EM ATIVIDADES DO DIA A DIA:
  → Principal: **Terapia Ocupacional**.

- Se falar de APRENDIZAGEM / ESCOLA / ESTUDOS / PROVAS / VESTIBULAR:
  → Criança/adolescente: **Psicopedagogia / Neuropsicopedagogia**.
→ Adulto (faculdade/concursos): **Neuropsicopedagogia** (NÃO oferecemos Psicologia para adultos).

- Se falar de COORDENAÇÃO, FORÇA, EQUILÍBRIO, QUESTÕES MOTORAS:
  → Principal: **Fisioterapia**.

4️⃣ COMO RESPONDER NA PRÁTICA:
- Primeiro, reconheça o laudo:
  "Entendi, ele já tem laudo fechado de TEA."
- Depois, foque na área:
  "Pelo que você contou, o que está pegando mais é a parte de [comportamento/fala/autonomia/escola]."
- Em seguida, amarre com a especialidade:
  "Aqui na clínica isso fica com a [Psicologia/Fonoaudiologia/Terapia Ocupacional/etc.]."
- E termine chamando pra AVALIAÇÃO na área escolhida:
  "Posso te explicar rapidinho como funciona a avaliação inicial nessa área e ver um período bom pra vocês (manhã ou tarde)?"

5️⃣ REGRAS IMPORTANTES:
- NÃO volte a falar de avaliação neuropsicológica pra laudo se o paciente já é laudado e o objetivo é só terapia.
- Se o responsável mencionar mais de uma coisa (ex.: fala + comportamento), escolha UMA área principal pra começar e diga que a equipe é multiprofissional:
  "A gente começa pela Psicologia, e conforme for, pode integrar com Fono/TO depois."
`.trim(),

    speechContext: `
🗣️ CONTEXTO FONOAUDIOLOGIA:
- MÉTODO PROMPT: Temos fono com formação (fala/motricidade orofacial).
- CAA: Usamos Comunicação Alternativa. Explique que NÃO atrapalha a fala.
- TESTE DA LINGUINHA: Bebês/Crianças, R$ 150, rápido e seguro.
- Gagueira, atraso de fala, voz: Todos atendidos.
- DURAÇÃO: Avaliação inicial ~40min. Sessões semanais ~40min.
`.trim(),

    neuroPsychContext: `
📚 REGRAS NEUROPSICOLOGIA (DIFERENTE DAS OUTRAS ÁREAS):
- NÃO existe "avaliação inicial avulsa" separada.
- O PRODUTO É: "Avaliação Neuropsicológica Completa".
- ESTRUTURA: Pacote de ~10 sessões (Entrevista + Testes + Laudo).
- DURAÇÃO: ~40min por sessão. Total do processo: ~10 sessões + laudo completo.
- PREÇO: R$ 2.000 (até 6x).
- Atendemos CRIANÇAS (a partir de 4 anos) e ADULTOS.
`.trim(),

    psycoContext: `
🧠 CONTEXTO PSICOLOGIA:
- Atendimento **exclusivo para CRIANÇAS e ADOLESCENTES até 16 anos**.
- Foco: comportamento, emoções, habilidades sociais e orientação aos pais.
- NÃO realizamos atendimentos de psicologia para adultos.
- DURAÇÃO: Avaliação inicial ~40min–1h. Sessões semanais ~40min.
`.trim(),

    psychopedContext: `
📝 CONTEXTO PSICOPEDAGOGIA:
- Foco: Dificuldades de aprendizagem, atenção, memória, rendimento escolar.
- ADULTOS: Preparação para cursos, concursos e faculdade.
- Anamnese inicial: consulte o valor atualizado (fonoaudiologia R$ 250, outras áreas R$ 200).
- Pacote mensal: R$ 160/sessão (~R$ 640/mês).
- DURAÇÃO: Anamnese ~40min–1h. Sessões semanais ~40min.
`.trim(),

    physioContext: `
🏃 CONTEXTO FISIOTERAPIA:
- Foco: Atendimento terapêutico CLÍNICO.
- NÃO fazemos RPG ou Pilates.
- Infantil: Desenvolvimento motor, postura, equilíbrio.
- Adulto: Reabilitação funcional, dor crônica, mobilidade.
- BOBATH: Usamos abordagem neurofuncional quando indicado.
- DURAÇÃO: Avaliação inicial ~40min–1h. Sessões ~40min.
`.trim(),

    occupationalContext: `
🖐️ CONTEXTO TERAPIA OCUPACIONAL:
- Foco: Integração sensorial, coordenação, autonomia.
- Infantil: AVDs, escrita, organização sensorial.
- Adulto: Rotina, independência, habilidades funcionais.
- DURAÇÃO: Avaliação inicial ~40min–1h. Sessões semanais ~40min.
`.trim(),

    musicTherapyContext: `
🎵 CONTEXTO MUSICOTERAPIA:
- Foco: Regulação emocional, interação social, desenvolvimento global.
- Infantil: Expressão, comunicação não-verbal, vínculo.
- Adulto: Ansiedade, relaxamento, foco.
- DURAÇÃO: Avaliação inicial ~40min–1h. Sessões semanais ~40min.
`.trim(),

    // =========================================================================
    // 🔥 MÓDULOS DE FUNIL (LEAD QUENTE/FRIO)
    // =========================================================================
    hotLeadContext: `
🔥 LEAD QUENTE (quer resolver logo):

SCRIPT PRINCIPAL (AVALIAÇÃO):
"Perfeito! Temos profissionais especializados e planos individuais pro seu filho. 
O próximo passo é agendar uma AVALIAÇÃO INICIAL aqui na clínica, pra entender direitinho o desenvolvimento dele. 
Fica melhor pra vocês essa semana ou na próxima?"

SE O LEAD DEMONSTRAR RESISTÊNCIA À AVALIAÇÃO:
- Exemplos de resistência:
  • "ah, por enquanto só tô vendo"
  • "não quero marcar nada agora"
  • "depois eu vejo isso"
  • "só queria conhecer primeiro"

SCRIPT ALTERNATIVO (VISITA):
"Sem problema, eu te entendo! Se você preferir, podemos combinar só uma VISITA rápida 
pra vocês conhecerem o espaço e tirarem dúvidas pessoalmente, sem compromisso de iniciar o tratamento. 
Faz mais sentido pra você já deixar essa visita combinada ou prefere continuar tirando dúvidas por aqui?"

REGRAS:
- PRIMEIRO: ofereça AVALIAÇÃO INICIAL.
- SÓ depois, se houver resistência clara, ofereça VISITA como alternativa mais leve.
- Seja direta, mas acolhedora.
- Não invente horário exato (use sempre dia/período).
`.trim(),

    coldLeadContext: `
❄️ LEAD FRIO (ainda pesquisando):

SCRIPT PRINCIPAL:
"Muita gente começa assim mesmo, só pesquisando — é normal! 
Se você quiser, podemos agendar uma AVALIAÇÃO INICIAL aqui na clínica, sem compromisso de continuidade, 
só pra entender melhor o desenvolvimento e tirar suas dúvidas com calma. 
Faz sentido já deixar essa avaliação combinada ou prefere receber mais informações por enquanto?"

SE DEMONSTRAR RESISTÊNCIA À AVALIAÇÃO:
"Sem problema, de verdade! Se você preferir, podemos combinar só uma VISITA rápida 
pra vocês conhecerem o espaço, verem como funciona e tirarem dúvidas pessoalmente, sem compromisso. 
Você prefere já deixar essa visita combinada ou quer pensar mais um pouquinho?"

✔ SE A PESSOA ESCOLHER UM HORÁRIO:
"Perfeito! Vou só confirmar os dados do paciente e já encaminho pra equipe finalizar o agendamento 💚"

SE NÃO AGENDAR NADA:
"Sem problema! Posso te mandar algumas informações pra você conhecer melhor nosso trabalho. 
E quando fizer sentido pra você, a gente combina a avaliação ou a visita, tudo bem?"

REGRAS:
- Normalizar a pesquisa (não pressionar).
- AVALIAÇÃO é a primeira opção; VISITA é a alternativa leve.
- Manter sempre a porta aberta.
`.trim(),

    // ✅ TRIAGEM / ANTI-LOOP (ordem e comportamento)
    schedulingTriageRules: `
🧭 TRIAGEM DE AGENDAMENTO (ANTI-LOOP) - REGRA OBRIGATÓRIA

OBJETIVO: coletar só o necessário, 1 pergunta por vez, sem repetir.

ORDEM:
1) PERFIL/IDADE (anos ou meses)
2) QUEIXA (apenas se a área ainda não estiver clara)
3) PERÍODO (manhã/tarde/noite)

REGRAS:
- Se já estiver claro no histórico/lead, NÃO pergunte de novo.
- Se a área apareceu "por acidente" (sem queixa clara), IGNORE e pergunte a queixa.
- Não fale de preço nessa fase.
- Não invente horários.
`.trim(),

    // ✅ NOVO: NÃO PEDIR NOME ANTES DE SLOT
    noNameBeforeSlotRule: `
🚫 REGRA: NÃO PEDIR NOME ANTES DE SLOT ESCOLHIDO
- Só peça o nome completo após o cliente escolher um horário (A, B, C...).
- Se ele só disser "manhã" ou "tarde", primeiro mostre as opções disponíveis.
- Não diga "vou encaminhar pra equipe" sem confirmar um horário específico.
`.trim(),

    // ✅ NOVO: EVITAR REPETIÇÃO DE CONFIRMAÇÃO (HANDOFF SPAM)
    handoffNoSpamRule: `
⚠️ REGRA: EVITAR REPETIÇÃO DE "ENCAMINHEI PRA EQUIPE"
- Se a pessoa já respondeu "ok", "obrigado" ou "aguardo", não repita a mesma frase.
- Se precisar, responda uma única vez com algo curto: "Perfeito 💚, qualquer dúvida é só me chamar."
- Depois disso, silencie (não reabra conversa).
`.trim(),

    // ✅ NOVO: PRIORIDADE DE PERGUNTA DE PREÇO
    pricePriorityAfterBooking: `
💰 REGRA: PERGUNTA DE PREÇO TEM PRIORIDADE
- Mesmo após o agendamento, se o cliente perguntar "valor", "quanto", "preço" etc, responda com o preço da área.
- Use o tom leve e explicativo: "A avaliação é o primeiro passo pra entender o que a criança precisa 💚 (valor varia por área: fonoaudiologia R$ 250, outras R$ 200)"
- Não repita "agendamento realizado" antes de responder o preço.
`.trim(),

    // ✅ Quando usuário escolhe uma opção (A/B/C) -> pedir nome
    slotChosenAskName: (slotText) => `
O cliente escolheu o horário "${slotText}".
- Confirme a escolha de forma acolhedora.
- Peça SOMENTE o NOME COMPLETO do paciente (não peça mais nada agora).
- Não repita lista de horários e não ofereça novas opções.
- 2–3 frases, 1 pergunta binária/objetiva.
`.trim(),

    // ✅ Depois do nome -> pedir nascimento
    slotChosenAskBirth: `
Você já tem o nome completo do paciente.
- Peça SOMENTE a data de nascimento (dd/mm/aaaa).
- Seja breve, acolhedora e direta.
`.trim(),

    // ✅ Não entendeu a escolha do slot
    slotChoiceNotUnderstood: `
Não ficou claro qual opção o cliente escolheu.
- Reapresente as opções (sem inventar horários) e peça para responder com a LETRA (A-F).
- Seja breve e simpática.
`.trim(),

    multiTeamContext: `
🤝 CONTEXTO MULTIPROFISSIONAL
- Quando o responsável diz "precisa de tudo" ou cita mais de uma área (fono, psico, TO, ABA, etc.), trate como caso multiprofissional.
- Explique que a Fono Inova tem equipe integrada: fonoaudióloga, psicóloga e terapeuta ocupacional trabalham juntas no plano da criança.
- A avaliação inicial serve pra montar o plano conjunto.
- Frase sugerida:
  "Perfeito! Aqui na Fono Inova temos psicólogo (ABA), fono e terapeuta ocupacional que trabalham juntos no mesmo plano. Posso te explicar como funciona a avaliação inicial pra montar esse plano multiprofissional? 💚"
`.trim(),

    // ✅ Quando falta queixa (pra mapear área)
    triageAskComplaint: `
O cliente quer agendar, mas ainda não disse a queixa.
- Valide a preocupação brevemente.
- Pergunte qual a principal preocupação/queixa observada no dia a dia.
- Não fale de preço e não ofereça horários ainda.
`.trim(),

    // ✅ Quando falta idade
    triageAskAge: (areaName = "a área ideal") => `
A queixa indica ${areaName}.
- Valide e diga que a clínica pode ajudar.
- Pergunte a idade do paciente (anos ou meses).
- 2–3 frases, 1 pergunta.
`.trim(),

    // ✅ Quando falta período
    triageAskPeriod: `
Agora falta só o período preferido.
- Pergunte se prefere MANHÃ ou TARDE (ou NOITE se vocês usam).
- Não invente horários e não ofereça opções ainda.
`.trim(),

    // =========================================================================
    // 🛡️ MÓDULOS DE QUEBRA DE OBJEÇÃO (CRÍTICOS!)
    // =========================================================================

    // 💰 OBJEÇÃO: PREÇO / OUTRA CLÍNICA MAIS BARATA
    priceObjection: `
"Entendo totalmente 💚, é natural comparar. 
O que muitas famílias percebem é que investir em uma equipe integrada (fono + psico + TO) 
faz o tratamento render mais e, no fim, até economiza tempo e sessões. 
Quer que eu te explique como funciona o primeiro passo pra vocês decidirem tranquilos?"
`,

    // 🏥 OBJEÇÃO: PLANO DE SAÚDE / CONVÊNIO
    insuranceObjection: `
"Entendo perfeitamente 💚. Muitas famílias têm plano, e hoje a Fono Inova é particular — 
mas emitimos nota fiscal completa, e vários pacientes do **Bradesco Saúde** e **Unimed** 
têm conseguido reembolso parcial direto pelo app. 
A vantagem é começar logo, sem precisar esperar meses pra iniciar o cuidado. 
Quer que eu te explique rapidinho como funciona esse reembolso?"
`,

    // ⏰ OBJEÇÃO: FALTA DE TEMPO
    timeObjection: `
🛡️ OBJEÇÃO: "NÃO TENHO TEMPO" / "AGENDA CHEIA"

SCRIPT:
"Entendo, a rotina é corrida mesmo! Por isso a visita é bem leve — 
uns 20-30 minutos só pra você conhecer o espaço e tirar dúvidas. 
Sem compromisso nenhum. Qual dia da semana costuma ser mais tranquilo pra você?"

ALTERNATIVA:
"A gente tem horários bem flexíveis — de manhã, tarde e até início da noite. 
Qual período encaixaria melhor na sua rotina?"

REFORÇO:
"E olha, uma vez que o tratamento começa, a rotina fica mais leve — 
porque você vai ter clareza do que fazer. Vale o investimento de tempo inicial."
`.trim(),

    // 🏥 OBJEÇÃO: JÁ ESTÁ EM OUTRA CLÍNICA
    otherClinicObjection: `
                          🛡️ OBJEÇÃO: "JÁ ESTOU VENDO EM OUTRA CLÍNICA"

                          SCRIPT:
                          "Que bom que vocês já estão cuidando! Cada clínica tem um jeito de trabalhar. 
                          Recomendo vir conhecer a nossa também — o acolhimento e a equipe integrada 
                          fazem muita diferença. Muitos pais que vieram 'só comparar' acabaram ficando. 
                          Quer agendar uma visita sem compromisso?"

                          SE PARECER SATISFEITO COM A OUTRA:
                          "Fico feliz que esteja dando certo! Se em algum momento quiser uma segunda opinião 
                          ou conhecer outra abordagem, a porta tá aberta. Posso guardar seu contato?"

                          DIFERENCIAL:
                          "Aqui o diferencial é a equipe multiprofissional que trabalha JUNTO. 
                          Fono, psicólogo, TO — todo mundo conversa sobre o caso. 
                          Nem toda clínica tem isso."
                          `.trim(),

    // 👶 OBJEÇÃO: DÚVIDA SOBRE TEA / FILHO MUITO NOVO
    teaDoubtObjection: `
                      🛡️ OBJEÇÃO: "SERÁ QUE É TEA?" / "ELE É MUITO NOVO PRA SABER"

                      SCRIPT:
                      "Entendo a dúvida — é natural ficar inseguro. A visita ajuda justamente nisso: 
                      entender o desenvolvimento e ver se há necessidade de acompanhamento. 
                      É leve, sem compromisso, e você já sai com uma orientação inicial. 
                      Quer agendar?"

                      REFORÇO:
                      "Quanto mais cedo a gente observa, melhor. Não precisa esperar ter certeza 
                      pra buscar orientação. E se não for nada, você sai tranquilo."

                      SE RESISTIR:
                      "Muitos pais vêm com essa mesma dúvida. A avaliação serve exatamente pra isso — 
                      dar clareza. E aqui a gente faz com muito cuidado e acolhimento."
                      `.trim(),

    // =========================================================================
    // 📅 MÓDULO DE AGENDAMENTO
    // =========================================================================
    schedulingContext: `📅 SCRIPT DE AGENDAMENTO (AGENDA EM TEMPO REAL)

- Você recebe do sistema uma lista de horários disponíveis (slots). Use APENAS esses horários. NÃO invente.

OBJETIVO:
1) A pessoa escolher uma opção (letra).
2) Só depois coletar os dados do paciente, 1 por vez: primeiro nome completo, depois data de nascimento.

COMO APRESENTAR OS HORÁRIOS:
- Mostre as opções em lista com letras (A, B, C, D...).
- As letras seguem a ordem em que as opções aparecem (sem "pular" letra).
- Sempre escreva "dia + horário" (ex.: quinta às 14h).

REGRAS:
1) Nunca confirme um horário fora da lista.
2) Não "chute" horário quando a pessoa disser só "manhã/tarde": mostre até 2 opções daquele período e peça a letra.
3) Pergunte: "Qual você prefere? (responda com a letra)"

DEPOIS DA ESCOLHA (passo a passo):
- Primeiro: "Perfeito! Me manda só o **nome completo** do paciente 💚"
- Depois que receber o nome: "Obrigada! Agora a **data de nascimento** (dd/mm/aaaa) 💚"`.trim(),


    // =========================================================================
    // 🚫 MÓDULO DE ESCOPO NEGATIVO
    // =========================================================================
    negativeScopeContext: `
                        🚫 LIMITES DO ESCOPO (O QUE NÃO FAZEMOS):
                        1. EXAMES DE AUDIÇÃO (Audiometria, BERA, PEATE):
                          - "Não realizamos exames auditivos. Nosso foco é avaliação e terapia."
                          - Ofereça: "Podemos agendar uma avaliação clínica."
                          - "Não realizamos exames auditivos nem avaliações de hiperacusia. Nosso foco é terapia fonoaudiológica."

                        2. RPG ou PILATES:
                          - "Nossa Fisioterapia é voltada para atendimento terapêutico clínico."

                        3. CONVÊNIOS:
                          - Todos os atendimentos são PARTICULARES.

                      4. REABILITAÇÃO VOCAL PÓS-CIRÚRGICA:  
                      - "Não trabalhamos com reabilitação de voz pós-cirurgia."
                      - Rouquidão COMUM (uso excessivo da voz, gritar muito, etc.) → ATENDEMOS
                      - Rouquidão PÓS-CIRURGIA (intubação, cirurgia de tireoide, etc.) → NÃO ATENDEMOS
`.trim(),

    // 🚫 MÓDULO: EXAMES AUDITIVOS / HIPERACUSIA (não realizamos)
    auditoryTestsContext: `
🚫 EXAMES AUDITIVOS / HIPERACUSIA
- Quando o lead mencionar "hiperacusia", "limiar auditivo", "audiometria", "exame de audição", "BERA" etc:
  • NUNCA ofereça avaliação ou agendamento.
  • Responda SEMPRE:
    "No momento **não realizamos exames auditivos (como audiometria, limiar ou avaliação de hiperacusia)** — somos clínica focada em **terapia fonoaudiológica e reabilitação**. 
    Se quiser, posso te orientar sobre como funciona a **terapia para sensibilidade a sons** ou indicar onde realizar o exame. 💚"
- NÃO reabra follow-ups automáticos nesses casos.
`.trim(),


    // =========================================================================
    // 💰 MÓDULO DE VENDAS (PREÇO COM VALOR)
    // =========================================================================
    salesPitch: (urgencyPitch, priceInfo) => `
💰 SCRIPT DE VENDAS(VALOR → PREÇO → AÇÃO):

1️⃣ CONTEXTUALIZE O VALOR:
"${urgencyPitch}"

2️⃣ DÊ O PREÇO COM NATURALIDADE:
"${priceInfo}"

3️⃣ FINALIZE COM AÇÃO BINÁRIA:
"Prefere agendar essa semana ou na próxima?"
OU
"Quer vir conhecer o espaço antes de decidir?"

🚫 PROIBIDO:
- Dar preço seco sem contexto
  - Perguntar "quer saber mais?"(dá escapatória)
    - Terminar sem call - to - action
      `.trim(),
};

function useModule(key, ...args) {
    const mod = DYNAMIC_MODULES?.[key];
    if (!mod) return "";
    return typeof mod === "function" ? mod(...args) : mod;
}
const ci = (...parts) => parts.filter(Boolean).join("\n\n");

/**
 * ✅ FIX: Retorna área do qualificationData APENAS se tiver queixa registrada
 * Se não tem queixa, a área foi detectada do nome da clínica (errado!)
 */
function getValidQualificationArea(lead) {
    const extractedInfo = lead?.qualificationData?.extractedInfo;
    // Só considera a especialidade válida se tiver queixa explícita
    if (extractedInfo?.queixa || extractedInfo?.queixaDetalhada?.length > 0) {
        return extractedInfo?.especialidade || null;
    }
    return null; // Ignora área se não tem queixa
}

/**
 * Calcula ageGroup a partir da idade
 */
function getAgeGroup(age, unit) {
    if (unit === "dias" || unit === "meses") return "crianca";
    if (age <= 12) return "crianca";
    if (age <= 17) return "adolescente";
    return "adulto";
}


// ============================================================================
// 🧭 STATE MACHINE DE FUNIL
// ============================================================================

function hasAgeOrProfileNow(txt = "", flags = {}, ctx = {}, lead = {}) {
    const t = String(txt || "");
    const hasYears = /\b\d{1,2}\s*anos?\b/i.test(t);
    const hasMonths = /\b\d{1,2}\s*(mes|meses)\b/i.test(t);
    const mentionsBaby =
        /\b(beb[eê]|rec[eé]m[-\s]*nascid[oa]|rn)\b/i.test(t) || hasMonths;

    if (
        mentionsBaby &&
        !flags.mentionsChild &&
        !flags.mentionsTeen &&
        !flags.mentionsAdult
    ) {
        flags.mentionsChild = true;
        if (!ctx.ageGroup) ctx.ageGroup = "crianca";
    }

    // 🆕 VERIFICA TAMBÉM O LEAD (dados já salvos) + qualificationData
    return !!(
        lead?.patientInfo?.age ||
        lead?.ageGroup ||
        lead?.qualificationData?.extractedInfo?.idade ||  // ✅ FIX: verifica onde o sistema de qualificação salva
        flags.mentionsChild ||
        flags.mentionsTeen ||
        flags.mentionsAdult ||
        ctx.ageGroup ||
        hasYears ||
        hasMonths ||
        extractAgeFromText(t)
    );
}

function buildTriageSchedulingMessage({
    flags = {},
    bookingProduct = {},
    ctx = {},
    lead = {},
} = {}) {
    const knownArea =
        bookingProduct?.therapyArea ||
        flags?.therapyArea ||

        lead?.therapyArea;

    // Verifica também dados já salvos no lead
    const knownProfile = !!(
        lead?.patientInfo?.age ||
        lead?.ageGroup ||
        lead?.qualificationData?.extractedInfo?.idade ||  // ✅ FIX
        flags.mentionsChild ||
        flags.mentionsTeen ||
        flags.mentionsAdult ||
        ctx.ageGroup
    );

    const knownPeriod = !!(
        lead?.pendingPreferredPeriod ||
        lead?.autoBookingContext?.preferredPeriod ||
        ctx.preferredPeriod
    );

    // 🆕 Verifica se já tem queixa/motivo registrado
    const knownComplaint = !!(
        lead?.complaint ||
        lead?.patientInfo?.complaint ||
        lead?.autoBookingContext?.complaint ||
        ctx.complaint
    );


    // 🧠 Também verifica dados da avaliação/encaminhamento
    const extractedInfo = lead?.qualificationData?.extractedInfo || {};
    if (extractedInfo.especialidade && !knownArea) {
        knownArea = extractedInfo.especialidade;
    }
    if (extractedInfo.queixa && !knownComplaint) {
        knownComplaint = true;
    }
    if (extractedInfo.idade && !knownProfile) {
        knownProfile = true;
    }
    if (extractedInfo.disponibilidade && !knownPeriod) {
        knownPeriod = true;
    }


    const needsArea = !knownArea;
    const needsProfile = !knownProfile;
    const needsPeriod = !knownPeriod;
    const needsComplaint = !knownComplaint; // 🆕 FASE 3.1: SEMPRE precisa de queixa (prioridade #1)

    // 🆕 FASE 3.1: Ordem correta - QUEIXA → PERFIL → PERÍODO (venda psicológica primeiro)
    if (needsComplaint) {
        return "Me conta um pouquinho: o que você tem observado no dia a dia que te preocupou? 💚";
    }
    if (needsProfile) {
        return "Entendi 😊 Só pra eu te orientar direitinho: qual a idade do paciente (anos ou meses)?";
    }
    if (needsPeriod) {
        return "Perfeito! Pra eu ver as melhores opções: vocês preferem manhã ou tarde?";
    }

    return "Me conta mais um detalhe pra eu te ajudar certinho 💚";
}

/**
 * 🆕 Mapeia queixa para área terapêutica usando detectores existentes
 */
function mapComplaintToTherapyArea(complaint) {
    if (!complaint) return null;

    // 1. Usa detectAllTherapies (do therapyDetector.js) - mais preciso
    // 🛡️ Proteção contra erro em detectAllTherapies
    let detectedTherapies = [];
    try {
        detectedTherapies = detectAllTherapies(complaint) || [];
    } catch (err) {
        console.warn("[mapComplaintToTherapyArea] Erro em detectAllTherapies:", err.message);
        detectedTherapies = [];
    }

    if (detectedTherapies?.length > 0) {
        const primary = detectedTherapies[0];
        // Mapeia ID do therapyDetector para nome da área no banco
        const areaMap = {
            "neuropsychological": "neuropsicologia",
            "speech": "fonoaudiologia",
            "tongue_tie": "fonoaudiologia", // linguinha é fono
            "psychology": "psicologia",
            "occupational": "terapia_ocupacional",
            "physiotherapy": "fisioterapia",
            "music": "musicoterapia",
            "neuropsychopedagogy": "neuropsicologia",
            "psychopedagogy": "neuropsicologia", // psicopedagogia vai pra neuro
        };
        return areaMap[primary.id] || null;
    }

    // 2. Fallback: usa resolveTopicFromFlags (do flagsDetector.js)
    const flags = detectAllFlags(complaint);
    const topic = resolveTopicFromFlags(flags, complaint);
    if (topic) {
        // Mapeia topic para área
        const topicMap = {
            "neuropsicologica": "neuropsicologia",
            "fono": "fonoaudiologia",
            "teste_linguinha": "fonoaudiologia",
            "psicologia": "psicologia",
            "terapia_ocupacional": "terapia_ocupacional",
            "fisioterapia": "fisioterapia",
            "musicoterapia": "musicoterapia",
            "psicopedagogia": "neuropsicologia",
        };
        return topicMap[topic] || null;
    }

    return null;
}

function inferTherapiesFromHistory(enrichedContext = {}, lead = {}) {
    const candidates = [];

    // queixas já salvas
    if (lead?.complaint) candidates.push(lead.complaint);
    if (lead?.patientInfo?.complaint) candidates.push(lead.patientInfo.complaint);
    if (lead?.autoBookingContext?.complaint) candidates.push(lead.autoBookingContext.complaint);

    // resumo (se existir)
    if (enrichedContext?.conversationSummary) candidates.push(enrichedContext.conversationSummary);

    // últimas mensagens do usuário
    const hist = Array.isArray(enrichedContext?.conversationHistory) ? enrichedContext.conversationHistory : [];
    for (let i = hist.length - 1; i >= 0; i--) {
        const m = hist[i];
        if ((m?.role || "").toLowerCase() === "user" && typeof m?.content === "string") {
            candidates.push(m.content);
            if (candidates.length >= 6) break; // pega poucas
        }
    }

    for (const c of candidates) {
        const det = detectAllTherapies(String(c || ""));
        if (det?.length) return det;
    }
    return [];
}

function logSuppressedError(context, err) {
    console.warn(`[AMANDA-SUPPRESSED] ${context}:`, {
        message: err.message,
        stack: err.stack?.split('\n')[1]?.trim(),
        timestamp: new Date().toISOString(),
    });
}

function safeCalculateUrgency(flags, txt) {
    try {
        if (typeof calculateUrgency === "function") return calculateUrgency(flags, txt);
    } catch (_) { }
    return { pitch: "" };
}

function safeGetPriceLinesForDetectedTherapies(detectedTherapies, opts = {}) {
    try {
        if (typeof getPriceLinesForDetectedTherapies === "function") {
            return getPriceLinesForDetectedTherapies(detectedTherapies, opts) || [];
        }
    } catch (_) { }
    return [];
}

async function persistExtractedData(leadId, text, lead) {
    if (!leadId) return;
    try {
        const _n = extractName(text);
        const _a = extractAgeFromText(text);
        const _p = extractPeriodFromText(text);
        let _c = extractComplaint(text);

        // ✅ FIX: Se não extraiu padrão específico MAS o texto é descritivo, aceita como queixa
        if (!_c && text && text.length > 20 && !lead?.complaint) {
            const pareceDescricao = /\b(eu|minha|meu|estou|tenho|sinto|está|doente|problema|dificuldade|dor|mal|não consigo|fui ao|médico|otorrino|fenda|vocal|pregas|cantor|voz)\b/i.test(text);
            if (pareceDescricao) {
                _c = text.trim().substring(0, 200);
                console.log('📝 [CTX-PERSIST] Queixa extraída do texto livre:', _c.substring(0, 50));
            }
        }

        // 🆕 FIX: Busca fonte SEPARADA do valor existente (evita lógica circular)
        const _tSource = lead?.autoBookingContext?.therapyArea ||
            lead?.qualificationData?.extractedInfo?.therapyArea;
        const _tExisting = lead?.therapyArea;
        const _upd = {};
        if (_n && isValidPatientName(_n) && !lead?.patientInfo?.fullName)
            _upd['patientInfo.fullName'] = _n;
        // 🛡️ SAFE AGE UPDATE: Protege contra corrupção de idade
        if (_a) {
            const currentAge = lead?.patientInfo?.age;
            const newAge = typeof _a === 'object' ? _a.age : _a;
            const safeResult = safeAgeUpdate(currentAge, newAge, text);

            if (safeResult.age !== currentAge) {
                _upd['patientInfo.age'] = safeResult.age;
                console.log(`[SAFE-AGE] Atualizado: ${currentAge} → ${safeResult.age} (${safeResult.reason})`);
            } else if (safeResult.reason !== 'no_new_data') {
                console.log(`[SAFE-AGE] Protegido: mantido ${currentAge} (${safeResult.reason})`);
            }
        }
        if (_p && !lead?.pendingPreferredPeriod)
            _upd['pendingPreferredPeriod'] = normalizePeriod(_p);
        if (_c && !lead?.complaint)
            _upd['complaint'] = _c;
        // 🆕 FIX: Persiste therapyArea se existe fonte mas não está salvo no lead
        if (_tSource && !_tExisting) {
            _upd['therapyArea'] = _tSource;
            _upd['qualificationData.extractedInfo.therapyArea'] = _tSource;
        }
        if (Object.keys(_upd).length) {
            await safeLeadUpdate(leadId, { $set: _upd });
            // 🆕 Atualiza lead em memória também para garantir consistência
            if (_tSource && !_tExisting) lead.therapyArea = _tSource;
            // 🆕 Atualizar lead em memória para knownDataNote ler dados frescos
            if (_upd['patientInfo.fullName']) {
                lead.patientInfo = lead.patientInfo || {};
                lead.patientInfo.fullName = _upd['patientInfo.fullName'];
            }
            if (_upd['patientInfo.age'] !== undefined) {
                lead.patientInfo = lead.patientInfo || {};
                lead.patientInfo.age = _upd['patientInfo.age'];
            }
            if (_upd['pendingPreferredPeriod'])
                lead.pendingPreferredPeriod = _upd['pendingPreferredPeriod'];
            if (_upd['complaint'])
                lead.complaint = _upd['complaint'];
            console.log('✅ [CTX-PERSIST] Dados salvos e memória atualizada:', _upd);
        }
    } catch (e) {
        logSuppressedError('ctx-auto-persist', e);
    }
}

function getMissingFields(lead, extracted = {}, userText = '') {
    const missing = [];
    const hasName = lead?.patientInfo?.fullName || extracted?.patientName;
    const hasAge = lead?.patientInfo?.age || extracted?.patientAge;

    // Coleta dados de identificação primeiro (ordem natural de atendimento)
    if (!hasName) missing.push('nome do paciente');
    if (!hasAge) missing.push('idade');
    if (!lead?.pendingPreferredPeriod && !extracted?.period)
        missing.push('período (manhã ou tarde)');
    if (!lead?.therapyArea && !extracted?.therapyArea)
        missing.push('área terapêutica');

    // Queixa: só pede se já tem nome + idade E não é pergunta sobre convênio
    const isInsuranceQuery = /\b(unimed|ipasgo|amil|bradesco|sulam[eé]rica|plano|conv[eê]nio|reembolso)\b/i.test(userText || '');
    if (hasName && hasAge && !lead?.complaint && !extracted?.complaint && !isInsuranceQuery)
        missing.push('queixa principal');

    return missing;
}

// ============================================================================
// 🛡️ ANTI-LOOP: Verifica se triagem está completa
// ============================================================================
function isTriageComplete(lead) {
    if (!lead) return false;

    // 🎯 ORDEM DE TRIAGEM: área → queixa → nome → nascimento → idade → período
    const hasArea = !!lead.therapyArea;
    const hasComplaint = !!(lead.complaint || lead.primaryComplaint);
    const hasName = !!(lead.patientInfo?.fullName || lead.patientInfo?.name);
    const hasBirthDate = !!(lead.patientInfo?.birthDate);
    const hasAge = lead.patientInfo?.age !== undefined && lead.patientInfo?.age !== null;
    const hasPeriod = !!(lead.pendingPreferredPeriod || lead.qualificationData?.disponibilidade);

    const complete = hasArea && hasComplaint && hasName && hasBirthDate && hasAge && hasPeriod;

    if (complete) {
        console.log("[ANTI-LOOP] Triagem completa:", {
            area: hasArea, complaint: hasComplaint, name: hasName, 
            birthDate: hasBirthDate, age: hasAge, period: hasPeriod
        });
    }

    return complete;
}

// ============================================================================
// 🆕 REGRA 5: FILTRO DE PACOTES CONTÍNUOS + FERIADOS
// ============================================================================

/**
 * 🆕 REGRA 5: Filtra slots ocupados por pacotes contínuos e feriados
 * @param {Array} slots - Slots candidatos do findAvailableSlots
 * @param {string} therapyArea - Área de terapia
 * @returns {Promise<Array>} - Slots filtrados
 */
async function filterSlotsByRecurringPackages(slots, therapyArea) {
    if (!slots || !slots.length) return [];
    
    try {
        // 1. Remove feriados nacionais
        const slotsWithoutHolidays = slots.filter(slot => {
            const isHoliday = isNationalHoliday(slot.date);
            if (isHoliday) {
                console.log(`🗓️ [REGRA 5] Slot removido (feriado): ${slot.date} ${slot.time}`);
            }
            return !isHoliday;
        });
        
        // 2. Busca sessões de pacotes contínuos
        const startDate = slotsWithoutHolidays[0]?.date;
        const endDate = slotsWithoutHolidays[slotsWithoutHolidays.length - 1]?.date;
        
        const recurringAppointments = await Appointment.find({
            specialty: therapyArea,
            packageId: { $exists: true, $ne: null }, // Sessões com pacote
            status: { $in: ['scheduled', 'confirmed', 'completed'] }, // Não inclui canceladas
            date: { 
                $gte: new Date(startDate + 'T00:00:00'), 
                $lte: new Date(endDate + 'T23:59:59') 
            }
        }).lean();
        
        if (!recurringAppointments.length) {
            console.log(`✅ [REGRA 5] Nenhum pacote contínuo encontrado para ${therapyArea}`);
            return slotsWithoutHolidays;
        }
        
        console.log(`🔄 [REGRA 5] Encontradas ${recurringAppointments.length} sessões de pacotes`);
        
        // 3. Filtra slots ocupados por pacotes
        const filteredSlots = slotsWithoutHolidays.filter(slot => {
            const slotDateTime = new Date(`${slot.date}T${slot.time}`);
            
            const isOccupied = recurringAppointments.some(apt => {
                const aptDate = new Date(apt.date);
                return aptDate.toDateString() === slotDateTime.toDateString() &&
                       aptDate.getHours() === slotDateTime.getHours() &&
                       aptDate.getMinutes() === slotDateTime.getMinutes() &&
                       String(apt.doctorId) === String(slot.doctorId);
            });
            
            if (isOccupied) {
                console.log(`🚫 [REGRA 5] Slot bloqueado (pacote contínuo): ${slot.date} ${slot.time} - Dr(a). ${slot.doctorName}`);
            }
            
            return !isOccupied;
        });
        
        console.log(`✅ [REGRA 5] Slots disponíveis: ${filteredSlots.length}/${slots.length}`);
        return filteredSlots;
        
    } catch (err) {
        console.error('❌ [REGRA 5] Erro ao filtrar slots:', err.message);
        // Em caso de erro, retorna slots originais (fail-safe)
        return slots;
    }
}

/**
 * 🆕 Wrapper para findAvailableSlots com Regra 5
 * Busca slots e filtra pacotes contínuos + feriados
 */
async function findAvailableSlotsWithFilter(params) {
    const { therapyArea, ...otherParams } = params;
    
    // Busca slots originais
    const slotsResult = await findAvailableSlots({ therapyArea, ...otherParams });
    
    if (!slotsResult) return null;
    
    // Extrai todos os slots candidatos
    const allSlots = [
        slotsResult.primary,
        ...(slotsResult.alternativesSamePeriod || []),
        ...(slotsResult.alternativesOtherPeriod || []),
    ].filter(Boolean);
    
    // Aplica filtro de pacotes contínuos
    const filteredSlots = await filterSlotsByRecurringPackages(allSlots, therapyArea);
    
    if (!filteredSlots.length) {
        console.log('⚠️ [REGRA 5] Todos os slots foram filtrados (pacotes/feriados)');
        return null;
    }
    
    // Reconstrói objeto de resultado
    const primary = filteredSlots[0];
    const alternativesSamePeriod = filteredSlots.slice(1, 3);
    const alternativesOtherPeriod = filteredSlots.slice(3, 5);
    
    return {
        primary,
        alternativesSamePeriod,
        alternativesOtherPeriod,
        all: filteredSlots,
    };
}

// ============================================================================
// 🔥 ETAPA 1: DETECÇÃO DE INTENÇÃO + WRAPPER (sem alterar triagem ainda)
// ============================================================================

export function detectIntentPriority(message) {
    const msg = message.toLowerCase();
    
    // 1. SINTOMA/ACOLHIMENTO (mais prioritário)
    if (/(?:^|\W)(n[ãa]o fala|n[ãa]o olha|dificuldade|inquieto|agitad|birra|agress[ãa]o|agressi\w*|atraso|preocupad|ansios\w*|frustrad\w*|chor[ae]|triste|isolad|hiperativo|desatento|n[ãa]o concentra|n[ãa]o obedece|teimos|medo|ins[ôo]nia|pesadelo|enurese|encoprese|n[ãa]o come|mastiga|engasga|refluxo|constipa[çc][ãa]o)(?:\W|$)/i.test(msg)) {
        return "SINTOMA";
    }
    
    // 1.5 🔥 ALTA_INTENCAO - Lead quer agendar com urgência temporal (antes de URGENCIA)
    // Detecta: "tem hoje?", "amanhã de manhã seria bom", "sábado tem vaga"
    // ⚠️ NÃO usar \b com caracteres acentuados - word boundary não funciona com "ã"
    const altaIntencaoRegex = /\b(tem\s+(vaga|hor[áa]rio)|quer(?:o|ia)\s+agendar|marcar|encaixar|posso\s+ir|quando\s+tem|agendar\s+pra|podemos\s+marcar|vou\s+querer|tem\s+como|preciso\s+de)\b/i;
    const temporalRegex = /(?:^|\s)(hoje|amanh[ãa]|essa\s+semana|pr[óo]xima\s+semana|s[áa]bado|domingo|segunda|ter[cç]a|quarta|quinta|sexta|depois\s+de\s+amanh[ãa]|\d{1,2}[\/\-]\d{1,2})(?:\s|$|[,.!?])/i;
    const inicioComTemporal = /^\s*(hoje|amanh[ãa]|s[áa]bado|domingo|segunda|ter[cç]a|quarta|quinta|sexta|depois\s+de\s+amanh[ãa]|s[oó]\s+depois)(?:\s+(?:de|às?\s+)?(manh[ãa]|tarde|noite))?/i;
    const temVagaETemporal = /\btem\b.*\b(vaga|hor[áa]rio)\b.*(?:^|\s)(hoje|amanh[ãa]|s[áa]bado|domingo|segunda|ter[cç]a|quarta|quinta|sexta)(?:\s|$|[,.!?])/i;
    const temETemporal = /^\s*tem\b.*(?:^|\s)(hoje|amanh[ãa]|s[áa]bado|domingo)(?:\s|$|[,.!?])/i; // "Tem hoje?"
    const vagaTemporal = /\b(vaga|hor[áa]rio)\b.*(?:^|\s)(hoje|amanh[ãa]|s[áa]bado|domingo|segunda|ter[cç]a|quarta|quinta|sexta)(?:\s|$|[,.!?])/i; // "Vaga amanhã"
    
    if ((altaIntencaoRegex.test(msg) && temporalRegex.test(msg)) || inicioComTemporal.test(msg) || temVagaETemporal.test(msg) || temETemporal.test(msg) || vagaTemporal.test(msg)) {
        return "ALTA_INTENCAO";
    }
    
    // 1.5b 🔥 ALTA_INTENCAO por necessidade clara - sintoma específico + pedido de ajuda
    // Detecta: "Precisamos de ajuda para destravar o R", "Queremos ajuda com a fala"
    const pedidoAjudaRegex = /\b(precisamos? de ajuda|queremos? ajuda|gostar[íi]amos de ajuda|necessitamos? de ajuda|preciso de ajuda|quero ajuda)\b/i;
    const sintomaFonoRegex = /\b(destravar (o )?r|n[ãa]o fala|atraso (na )?fala|dificuldade (na )?fala|troca (de )?letras|lateraliz|problema (de )?fala|dist[úu]rbio (de )?fala|ajuda com a fala|fala da criança|fala do filho)\b/i;
    if (pedidoAjudaRegex.test(msg) && sintomaFonoRegex.test(msg)) {
        console.log(`[ALTA_INTENCAO] Detectado por necessidade clara (sintoma + pedido de ajuda): "${msg.substring(0, 50)}..."`);
        return "ALTA_INTENCAO";
    }
    
    // 1.6 🔥 URGENCIA (prioridade alta - detecta palavras temporais críticas)
    if (/\b(urgente|emergencia|emerg[êe]ncia|preciso logo|hoje|amanh[ãa]|agora|imediat|quanto antes|desesperad|n[ãa]o aguent|tentou tudo|j[áa] tentei|t[áa] piorando|t[áa] muito ruim)\b/i.test(msg)) {
        return "URGENCIA";
    }
    
    // 2. EXPLICAÇÃO (pedido explícito de informação)
    if (/\b(como funciona|pode me explicar|o que [ée]|qual [ée]|me explique|como [ée]|funciona como|pode explicar)\b/i.test(msg)) {
        return "EXPLICACAO";
    }
    
    // 3. FORA DO ESCOPO
    // ✅ ATUALIZADO Abr/2026: Removido 'neuropediatra' - agora temos na clínica!
    if (/\b(teste da linguinha|teste da l[íi]ngua|cirurgia|fazer cirurgia|operar|operac[ãa]o|cirurgi[ãa]o|m[ée]dico|pediatra|otorrino|psiquiatra)\b/i.test(msg)) {
        return "FORA_ESCOPO";
    }
    
    // 4. PREÇO/VALOR
    if (/\b(quanto custa|qual o pre[çc]o|qual o valor|investimento|reembolso|plano de sa[úu]de|conv[eê]nio|cart[ãa]o)\b/i.test(msg)) {
        return "PRECO";
    }
    
    // 5. AGENDAMENTO
    if (/\b(quero agendar|vou agendar|quero marcar|vou marcar|quando tem vaga|quando posso|tem hor[áa]rio|disponibilidade|posso ir|posso fazer|quero fazer a avalia[çc][ãa]o|encaixar|tem (hoje|amanh[ãa])|hoje|amanh[ãa]\s+(as|às|\d))\b/i.test(msg)) {
        return "AGENDAMENTO";
    }
    
    // 6. 🔥 FIRST_CONTACT — Topo de funil (vago, curto, aberto)
    // ⚠️ EXCLUI palavras de urgência temporal (hoje, amanhã) quando relacionadas a disponibilidade
    if (
        /^\s*(oi|ol[áa]|bom dia|boa tarde|boa noite|hey|hi)\s*[!?.]*\s*$/i.test(msg) ||
        /^(preciso|gostaria|quero|tenho interesse|vi o site|me indica(rao|ram))\s*$/i.test(msg) ||
        /\b(saber mais|orientar|ajuda|informa[çc][aã]o|d[úu]vida|conhecer|queria entender|queria saber|vi no site)\b/i.test(msg) ||
        (msg.length < 25 && 
         !/\b(fala|olha|dificuldade|pre[çc]o|valor|custa|agenda|marcar|hoje|amanh[ãa])\b/i.test(msg)) ||
        /\bpara?\s+(mim|meu filho|minha filha|crian[çc]a|beb[êe])\b/i.test(msg) ||
        /^\s*(fono|psico|to|fisio|terapia|neuro)\w*\s*\.?\s*$/i.test(msg)
    ) {
        return "FIRST_CONTACT";
    }
    
    return "DEFAULT";
}

/**
 * Wrapper de triagem — intercepta respostas hardcoded quando force flags ativas
 * Retorna null se deve deixar IA responder, ou a mensagem se pode prosseguir
 */
function handleTriagemResponse(message, context) {
    const flags = context?.forceFlags || {};
    
    // 🔴 Se não há force flags críticas → permite passar
    if (!flags.forceExplainFirst && !flags.forceEmpathy && !flags.forceRedirect && !flags.forcePrice && !flags.forceFirstContact && !flags.forceUrgencia && !flags.forceUrgency && !flags.forceHighIntent) {
        return message;
    }
    
    // 🟢 ALTA_INTENCAO: NÃO bloqueia - deixa passar com contexto especial
    // A diferença é que em vez de retornar null (IA genérica), permite o fluxo
    // mas com flags de contexto para guiar a resposta
    if (flags.forceHighIntent) {
        console.log("🎯 [TRIAGEM WRAPPER] ALTA_INTENCAO detectada → Fluxo com slots imediatos");
        // NÃO retorna null - permite que o fluxo continue normalmente
        // O contexto.offerSlotsImmediately será verificado no fluxo principal
        return message;
    }
    
    // 🔴 URGENCIA: prioridade máxima - sempre vai para IA com acolhimento + agilidade
    if (flags.forceUrgencia) {
        console.log("🛑 [TRIAGEM WRAPPER] Bloqueado: forceUrgencia → IA (prioridade máxima)");
        return null;
    }
    
    // 🟡 Agendamento puro pode passar se não houver conflito OU urgência
    if (flags.forceScheduling && !flags.forceExplainFirst && !flags.forceEmpathy && !flags.forceFirstContact && !flags.forceUrgencia) {
        // Mas se for agendamento com urgência (hoje/amanhã), bypassa para IA
        if (flags.forceUrgency) {
            console.log("🛑 [TRIAGEM WRAPPER] Bloqueado: forceScheduling + forceUrgency → IA");
            return null;
        }
        return message;
    }
    
    // 🔴 FIRST_CONTACT: sempre deixa IA responder com acolhimento
    if (flags.forceFirstContact) {
        console.log("🛑 [TRIAGEM WRAPPER] Bloqueado: forceFirstContact → IA");
        return null;
    }
    
    // 🔴 Bloqueia e deixa IA responder
    if (flags.forceExplainFirst) {
        console.log("🛑 [TRIAGEM WRAPPER] Bloqueado: forceExplainFirst → IA");
        return null;
    }
    if (flags.forceEmpathy) {
        console.log("🛑 [TRIAGEM WRAPPER] Bloqueado: forceEmpathy → IA");
        return null;
    }
    if (flags.forceRedirect) {
        console.log("🛑 [TRIAGEM WRAPPER] Bloqueado: forceRedirect → IA");
        return null;
    }
    if (flags.forcePrice) {
        console.log("🛑 [TRIAGEM WRAPPER] Bloqueado: forcePrice → IA");
        return null;
    }
    
    return message;
}

// ============================================================================
// 🎯 ORQUESTRADOR PRINCIPAL
// ============================================================================

export async function getOptimizedAmandaResponse({
    content,
    userText,
    lead = {},
    context = {},
    messageId = null,
}) {
    const text = userText || content || "";
    const _decisionStart = Date.now();
    let decisionLogData = null;

    // 🔥 PRÉ-COMPUTA DECISÃO PARA OBSERVABILIDADE (independente de early returns)
    try {
        const intentPriority = detectIntentPriority(text);
        const forceFlags = {
            forceExplainFirst: intentPriority === "EXPLICACAO",
            forceEmpathy: intentPriority === "SINTOMA" || intentPriority === "URGENCIA",
            forceScheduling: intentPriority === "AGENDAMENTO",
            forceRedirect: intentPriority === "FORA_ESCOPO",
            forcePrice: intentPriority === "PRECO",
            forceFirstContact: intentPriority === "FIRST_CONTACT",
            forceUrgencia: intentPriority === "URGENCIA",
            forceHighIntent: intentPriority === "ALTA_INTENCAO",
            forceUrgency: /(?:^|\s)(hoje|amanh[ãa]|urgente|desesperad[oa]?|preciso logo|quanto antes|tem vaga|tem hor[áa]rio)(?:\s|$|[,.!?])/i.test(text.toLowerCase()),
        };
        const flags = detectAllFlags(text, lead);
        const detectorResults = extractDetectorResults(flags);
        const currentState = lead.triageStep || lead.stage || 'IDLE';
        const decision = resolveDecision({
            forceFlags,
            detectorResults,
            currentState,
            messageIndex: lead.messagesCount || lead.messageCount || 0,
            enrichedContext: { lead, context },
            businessRules: {},
            contextModifiers: {}
        });
        decisionLogData = { flags, decision };
    } catch (err) {
        console.warn('[AmandaMetrics] Falha ao pré-computar decisão:', err.message);
    }

    let result;
    let hasError = false;
    let errorMessage = null;

    try {
        result = await _getOptimizedAmandaResponseInternal({
            content, userText, lead, context, messageId
        });
    } catch (err) {
        hasError = true;
        errorMessage = err.message;
        throw err; // re-lança para não mudar comportamento externo
    } finally {
        // 🔥 LOG SEMPRE EXECUTA — independente de early returns ou erro
        if (decisionLogData) {
            logDecision({
                leadId: lead._id,
                text: text.substring(0, 100),
                flags: decisionLogData.flags,
                decision: decisionLogData.decision,
                latencyMs: Date.now() - _decisionStart,
                currentState: lead.triageStep || lead.stage || 'IDLE',
                orchestrator: 'AmandaOrchestrator',
                ...(hasError ? { error: errorMessage } : {}),
            });
        } else if (hasError) {
            // fallback se pré-computação falhou mas execução também falhou
            logDecision({
                leadId: lead._id,
                text: text.substring(0, 100),
                flags: {},
                decision: { action: 'unknown', domain: 'unknown', reason: 'error', systemConfidence: 0 },
                latencyMs: Date.now() - _decisionStart,
                currentState: lead.triageStep || lead.stage || 'IDLE',
                orchestrator: 'AmandaOrchestrator',
                error: errorMessage,
            });
        }
    }

    if (!result || result === null || (typeof result === 'object' && !result.text)) {
        console.error('🚨 [GUARD CRÍTICO] Resposta nula detectada, usando fallback de emergência');
        return {
            text: `Oi! Entendi que você está buscando informações sobre nossos serviços 💚\n\nPara te ajudar melhor, qual especialidade você procura (Fonoaudiologia, Psicologia, Terapia Ocupacional, Fisioterapia ou Neuropsicologia) e qual o nome do paciente?`,
            type: 'text',
            _fallback: true
        };
    }

    return result;
}

async function _getOptimizedAmandaResponseInternal({
    content,
    userText,
    lead = {},
    context = {},
    messageId = null,
}) {
    const text = userText || content || "";
    const normalized = text.toLowerCase().trim();

    const SCHEDULING_REGEX =
        /\b(agendar|marcar|consulta|atendimento|avalia[cç][aã]o)\b|\b(qual\s+dia|qual\s+hor[áa]rio|tem\s+hor[áa]rio|dispon[ií]vel|disponivel|essa\s+semana)\b/i;

    console.log(`🎯 [ORCHESTRATOR] Processando: "${text}"`);

    // 🔥 ETAPA 1: DETECÇÃO DE INTENÇÃO (sem alterar triagem ainda)
    const intentPriority = detectIntentPriority(text);
    console.log(`🔥 [INTENT DETECTION] Prioridade: ${intentPriority}`);
    
    if (!context) context = {};
    context.intentPriority = intentPriority;
    
    // Detecta urgência na mensagem independente do intent principal
    const msg = text.toLowerCase();
    // ⚠️ Não usar \b com caracteres acentuados - word boundary não funciona com "ã"
    const hasUrgency = /(?:^|\s)(hoje|amanh[ãa]|urgente|desesperad[oa]?|preciso logo|quanto antes|tem vaga|tem hor[áa]rio)(?:\s|$|[,.!?])/i.test(msg);
    
    context.forceFlags = {
        forceExplainFirst: intentPriority === "EXPLICACAO",
        forceEmpathy: intentPriority === "SINTOMA" || intentPriority === "URGENCIA" || hasUrgency,
        forceScheduling: intentPriority === "AGENDAMENTO",
        forceRedirect: intentPriority === "FORA_ESCOPO",
        forcePrice: intentPriority === "PRECO",
        forceFirstContact: intentPriority === "FIRST_CONTACT",
        forceUrgencia: intentPriority === "URGENCIA",
        forceHighIntent: intentPriority === "ALTA_INTENCAO",  // 🆕 REGRA 1: Alta intenção
        forceUrgency: hasUrgency  // Novo flag para agendamento com urgência
    };
    
    // 🧠 CLINICAL MAPPER: Detecta specialty por sintomas ANTES do priority resolver
    const clinicalResolution = resolveClinicalArea(text);
    if (clinicalResolution.area && clinicalResolution.confidence >= 0.7) {
        console.log(`[CLINICAL MAPPER] Specialty detectada: ${clinicalResolution.area} (${clinicalResolution.condition}, conf: ${clinicalResolution.confidence})`);
        
        // Força contexto de PATIENT_CARE quando detecta specialty
        context.detectedSpecialty = clinicalResolution.area;
        context.detectedCondition = clinicalResolution.condition;
        context.clinicalConfidence = clinicalResolution.confidence;
        
        // Se não tem therapyArea no lead ainda, força empatia + direcionamento
        if (!lead?.therapyArea) {
            context.forceFlags.forcePatientCare = true;
            context.forceFlags.forceEmpathy = true;
            console.log(`[CLINICAL MAPPER] Forçando PATIENT_CARE para: ${clinicalResolution.area}`);
        }
    }
    
    // 🎯 TEMPLATE OURO - PRIORIDADE ABSOLUTA: Resposta direcionada quando ClinicalMapper detectou specialty
    // Isso garante que NUNCA perguntemos "qual área" quando já sabemos por sintomas
    // 🔧 THRESHOLD: 0.7 (ajustado de 0.8 para aumentar cobertura sem perder precisão)
    if (context.detectedSpecialty && !lead?.therapyArea && clinicalResolution.confidence >= 0.7) {
        console.log(`[TEMPLATE OURO - EARLY RETURN] Resposta direcionada para: ${context.detectedSpecialty} (conf: ${clinicalResolution.confidence})`);
        return buildDirectedResponse(context.detectedSpecialty, context.detectedCondition);
    }
    
    // 🆕 REGRA 1: Configurar contexto para ALTA_INTENCAO
    if (context.forceFlags.forceHighIntent) {
        context.offerSlotsImmediately = true;
        context.skipGenericGreeting = true;
        console.log("🎯 [ALTA_INTENCAO] Contexto configurado: offerSlotsImmediately=true");
    }

    // 🛡️ ANTI-LOOP GUARD: Verifica se triagem já está completa antes de qualquer coisa
    if (lead?._id && isTriageComplete(lead)) {
        console.log("🛡️ [ANTI-LOOP] Triagem completa detectada no início - pulando para slots");

        // Atualiza triageStep se necessário
        if (lead.triageStep !== 'done') {
            await safeLeadUpdate(lead._id, {
                $set: { triageStep: 'done', stage: 'engajado' }
            });
        }

        // Busca e oferece slots imediatamente (🆕 REGRA 5: com filtro de pacotes/feriados)
        const slots = await findAvailableSlotsWithFilter({
            therapyArea: lead.therapyArea,
            patientAge: lead.patientInfo?.age,
            preferredPeriod: lead.pendingPreferredPeriod
        });

        if (slots && slots.all?.length > 0) {
            const { message: slotMenu } = buildSlotMenuMessage(slots);
            return ensureSingleHeart(slotMenu + "\n\nQual funciona melhor? 💚");
        } else {
            return ensureSingleHeart(
                `Perfeito! Já tenho todos os dados 💚\n\n` +
                `Infelizmente não encontrei horários disponíveis. ` +
                `Vou pedir para nossa equipe entrar em contato!`
            );
        }
    }

    // 🔍 MONITORAMENTO: Detecta inconsistência estado vs dados (sem bloquear)
    if (lead?.triageStep === "done" && !isTriageComplete(lead)) {
        console.warn("⚠️ [STATE-INCONSISTENT] triageStep=done mas dados incompletos:", {
            therapyArea: !!lead.therapyArea,
            hasName: !!(lead.patientInfo?.fullName || lead.patientInfo?.name),
            hasAge: lead.patientInfo?.age != null,
            hasPeriod: !!(lead.pendingPreferredPeriod || lead.qualificationData?.disponibilidade),
            hasComplaint: !!(lead.complaint || lead.primaryComplaint)
        });
    }

    // ➕ integrar inbound do chat com followups
    if (lead?._id) {
        handleInboundMessageForFollowups(lead._id).catch((err) =>
            console.warn("[FOLLOWUP-REALTIME] erro:", err.message),
        );
    }

    // =========================================================================
    // 🆕 PASSO 0: REFRESH DO LEAD (SEMPRE BUSCA DADOS ATUALIZADOS)
    // =========================================================================
    if (lead?._id) {
        try {
            const freshLead = await Leads.findById(lead._id).select('+triageStep complaint therapyArea patientInfo qualificationData conversationSummary');
            if (freshLead) {
                lead = freshLead;
                console.log("🔄 [REFRESH] Lead atualizado:", {
                    therapyArea: lead.therapyArea || null,
                    patientInfoName: lead.patientInfo?.fullName || null,
                    patientInfoAge: lead.patientInfo?.age || null,
                    qualificationNome: lead.qualificationData?.extractedInfo?.nome || null,
                    qualificationIdade: lead.qualificationData?.extractedInfo?.idade || lead.qualificationData?.idade || null,
                    hasSummary: !!lead.conversationSummary,
                });
            } else {
                console.warn("⚠️ [REFRESH] Lead não encontrado no banco:", lead._id);
            }
        } catch (err) {
            console.error("❌ [REFRESH] Erro ao buscar lead:", err.message);
        }
    } else {
        console.warn("⚠️ [REFRESH] Lead sem _id:", lead);
    }

    // 🔄 SINCRONIZAÇÃO: Copia dados do qualificationData para patientInfo se necessário
    if (lead?.qualificationData?.extractedInfo) {
        const syncUpdates = {};
        if (!lead.patientInfo?.fullName && lead.qualificationData.extractedInfo.nome) {
            syncUpdates['patientInfo.fullName'] = lead.qualificationData.extractedInfo.nome;
            lead.patientInfo = lead.patientInfo || {};
            lead.patientInfo.fullName = lead.qualificationData.extractedInfo.nome;
        }
        if (!lead.patientInfo?.age && lead.qualificationData.extractedInfo.idade) {
            syncUpdates['patientInfo.age'] = lead.qualificationData.extractedInfo.idade;
            lead.patientInfo = lead.patientInfo || {};
            lead.patientInfo.age = lead.qualificationData.extractedInfo.idade;
        }
        if (!lead.complaint && lead.qualificationData.extractedInfo.queixa) {
            syncUpdates['complaint'] = lead.qualificationData.extractedInfo.queixa;
            lead.complaint = lead.qualificationData.extractedInfo.queixa;
        }
        if (!lead.therapyArea && lead.qualificationData.extractedInfo.especialidade) {
            syncUpdates['therapyArea'] = lead.qualificationData.extractedInfo.especialidade;
            lead.therapyArea = lead.qualificationData.extractedInfo.especialidade;
        }
        if (Object.keys(syncUpdates).length > 0) {
            await safeLeadUpdate(lead._id, { $set: syncUpdates });
            console.log('🔄 [SYNC] Dados sincronizados do qualificationData:', Object.keys(syncUpdates));
        }
    }

    // 💾 Persiste dados extraídos ANTES de qualquer early return
    await persistExtractedData(lead._id, text, lead);

    // =========================================================================
    // 🆕 ENTITY-DRIVEN SIMPLIFICADO (NOVO FLUXO PRINCIPAL)
    // =========================================================================
    console.log(`🧠 [AMANDA-SÊNIOR] Iniciando análise entity-driven...`);

    // 🧠 RECUPERA CONTEXTO ENRIQUECIDO (memória da Amanda)
    let enrichedContext = null;
    if (lead?._id) {
        try {
            enrichedContext = await enrichLeadContext(lead._id);
            console.log('🧠 [CONTEXT] Memória recuperada:', {
                name: enrichedContext?.name,
                patientAge: enrichedContext?.patientAge,
                therapyArea: enrichedContext?.therapyArea,
                preferredTime: enrichedContext?.preferredTime,
                primaryComplaint: enrichedContext?.primaryComplaint?.substring(0, 50),
                hasSummary: !!enrichedContext?.conversationSummary,
            });
        } catch (err) {
            console.warn('[CONTEXT] Erro ao enriquecer contexto:', err.message);
        }
    }

    // 🎯 PROPAGA FORCE FLAGS para enrichedContext (para IA respeitar)
    if (enrichedContext) {
        enrichedContext.intentPriority = context.intentPriority;
        enrichedContext.forceFlags = context.forceFlags;
    }

    // 🔄 PRE-ENCHIMENTO: Usa dados da memória se o lead ainda não tem
    if (enrichedContext) {
        // Preenche nome do paciente
        if (!lead.patientInfo?.fullName && enrichedContext.name) {
            lead.patientInfo = lead.patientInfo || {};
            lead.patientInfo.fullName = enrichedContext.name;
            console.log('[CONTEXT] Nome recuperado da memória:', enrichedContext.name);
        }
        // Preenche idade
        if (!lead.patientInfo?.age && enrichedContext.patientAge) {
            lead.patientInfo = lead.patientInfo || {};
            lead.patientInfo.age = enrichedContext.patientAge;
            console.log('[CONTEXT] Idade recuperada da memória:', enrichedContext.patientAge);
        }
        // Preenche período
        if (!lead.pendingPreferredPeriod && enrichedContext.preferredTime) {
            lead.pendingPreferredPeriod = enrichedContext.preferredTime;
            console.log('[CONTEXT] Período recuperado da memória:', enrichedContext.preferredTime);
        }
        // Preenche therapyArea
        if (!lead.therapyArea && enrichedContext.therapyArea) {
            lead.therapyArea = enrichedContext.therapyArea;
            console.log('[CONTEXT] Área recuperada da memória:', enrichedContext.therapyArea);
        }
        // Preenche queixa
        if (!lead.complaint && enrichedContext.primaryComplaint) {
            lead.complaint = enrichedContext.primaryComplaint;
            console.log('[CONTEXT] Queixa recuperada da memória:', enrichedContext.primaryComplaint?.substring(0, 50));
        }
    }

    const amandaAnalysis = await processMessageLikeAmanda(text, lead, enrichedContext);

    console.log('📊 [AMANDA] Analysis:', {
        therapyArea: amandaAnalysis.extracted.therapyArea,
        therapyAreaFromLead: lead?.therapyArea,
        missing: amandaAnalysis.missing,
        status: amandaAnalysis.serviceStatus,
        hasAll: amandaAnalysis.hasAll,
        hasSummary: !!lead?.conversationSummary,
        summaryPreview: lead?.conversationSummary?.substring(0, 100)
    });

    // 3.1 SERVIÇO NÃO DISPONÍVEL → Responde direto
    if (amandaAnalysis.serviceStatus === 'not_available') {
        return ensureSingleHeart(amandaAnalysis.serviceMessage);
    }

    // 3.2 LIMITE DE IDADE → Responde direto
    if (amandaAnalysis.serviceStatus === 'age_limit') {
        return ensureSingleHeart(amandaAnalysis.serviceMessage);
    }

    // 3.3 LEGACY REMOVED — preço agora roteado pelo DecisionResolver → RULE → ResponseBuilder

    // LEGACY REMOVED — asksPlans e asksLocation → DecisionResolver → RULE → ResponseBuilder

    // 🧠 INTERPRETAÇÃO: Resposta sobre objetivo da neuropsicologia (laudo vs acompanhamento)
    const isNeuroContext = lead?.therapyArea === 'neuropsicologia' || amandaAnalysis.extracted.therapyArea === 'neuropsicologia';
    const isAnsweringNeuroObjective = lead?.stage === 'triagem_neuro_objetivo' || lead?.neuroObjectiveAsked;

    if (isNeuroContext && isAnsweringNeuroObjective && !lead?.wantsLaudo !== undefined) {
        const wantsLaudo = /\b(laudo|avaliação completa|neuropsic|10 sessões|dez sessões|2\.000|dois mil|2000)\b/i.test(text);
        const wantsAcompanhamento = /\b(terapia|terapias|acompanhamento|tratamento|sessões semanais|200 reais|duzentos|semanal)\b/i.test(text);

        if (wantsLaudo && !wantsAcompanhamento) {
            console.log('[AMANDA] Quer LAUDO → Explica e continua neuropsicologia');
            await safeLeadUpdate(lead._id, {
                $set: {
                    wantsLaudo: true,
                    neuroObjetivo: 'laudo',
                    stage: 'triagem_agendamento'
                }
            }).catch(() => { });
            // Responde com explicação enxuta e continua triagem
            return ensureSingleHeart(
                `Perfeito! A **Avaliação Neuropsicológica** avalia funções como atenção, memória, linguagem e raciocínio. ` +
                `São 10 sessões (1x por semana, 50min cada), a partir de 2 anos. ` +
                `Ao final emitimos um laudo completo para escola e médicos 💚\n\n` +
                `💰 *Valores:* R$ 2.000 em até 6x no cartão, ou R$ 1.700 à vista\n\n` +
                `Pra seguir com o agendamento, qual o **nome completo** do paciente?`
            );
        } else if (wantsAcompanhamento && !wantsLaudo) {
            console.log('[AMANDA] Quer ACOMPANHAMENTO → Redireciona para psicologia');
            await safeLeadUpdate(lead._id, {
                $set: {
                    wantsLaudo: false,
                    neuroObjetivo: 'acompanhamento',
                    therapyArea: 'psicologia', // Muda para psicologia
                    stage: 'triagem_agendamento'
                }
            }).catch(() => { });
            // Atualiza a análise para refletir a mudança de área
            amandaAnalysis.extracted.therapyArea = 'psicologia';
            if (context.forceFlags?.forceExplainFirst || context.forceFlags?.forceEmpathy) {
                console.log('🔥 [BYPASS] neuro redirect com force flag → IA');
            } else {
                return buildSimpleResponse(amandaAnalysis.missing, amandaAnalysis.extracted, lead, enrichedContext);
            }
        } else if (wantsLaudo && wantsAcompanhamento) {
            // Ambos - explica e pergunta prioridade (formato Ana)
            return ensureSingleHeart(
                `Perfeito! 😊💚\n\n` +
                `A **Avaliação Neuropsicológica** analisa funções como atenção, memória, linguagem e raciocínio.\n\n` +
                `São 10 sessões (1x por semana, 50 minutos cada), para crianças a partir de 2 anos.\n` +
                `Ao final, emitimos um laudo completo, que pode ser utilizado na escola e com médicos 💚\n\n` +
                `💰 *Valores:*\n` +
                `💳 R$ 2.000,00 em até 6x no cartão\n` +
                `💵 R$ 1.700,00 à vista\n\n` +
                `Você prefere já iniciarmos a avaliação com laudo ou deseja começar diretamente o acompanhamento terapêutico? 💚`
            );
        }
        // Se não entendeu, continua com a triagem normal
    }

    // 🆕 CASO ESPECIAL: Multi terapias → Resposta específica
    if (amandaAnalysis.extracted.flags.multidisciplinary ||
        /precisa\s+de\s+tudo|fono.*psico|psico.*fono|todas.*área|todas.*especialidade/i.test(text)) {
        console.log('[AMANDA] Multi terapias detectadas - respondendo...');
        return ensureSingleHeart(
            `Que bom que vocês estão buscando cuidado completo! 💚\n\n` +
            `Aqui na Fono Inova temos uma equipe **multiprofissional integrada**: Fono, Psico, TO, Fisio e Neuropsicologia. ` +
            `Todas se comunicam e trabalham com planos individualizados.\n\n` +
            `Pra eu direcionar certinho: qual área você quer começar? ` +
            `A gente pode agendar uma primeira avaliação e, conforme for, integrar com as outras especialidades. Qual faz mais sentido pra vocês agora?`
        );
    }

    // 3.4 TRIAGEM: Falta dados → Pergunta contextual
    if (amandaAnalysis.serviceStatus === 'available' && !amandaAnalysis.hasAll && amandaAnalysis.extracted.therapyArea) {
        // Salva therapyArea no lead se ainda não tem
        if (!lead?.therapyArea && amandaAnalysis.extracted.therapyArea) {
            await safeLeadUpdate(lead._id, {
                $set: {
                    therapyArea: amandaAnalysis.extracted.therapyArea,
                    stage: 'triagem_agendamento'
                }
            });
        }

        // 🧠 CASO ESPECIAL: Neuropsicologia → Sondar objetivo (laudo vs acompanhamento)
        const isNeuro = amandaAnalysis.extracted.therapyArea === 'neuropsicologia' || lead?.therapyArea === 'neuropsicologia';
        const alreadyAskedObjective = lead?.neuroObjectiveAsked || lead?.neuroObjetivoSondado;
        const hasObjectiveInfo = lead?.neuroObjetivo || lead?.wantsLaudo !== undefined;

        if (isNeuro && !alreadyAskedObjective && !hasObjectiveInfo) {
            console.log('[AMANDA] Neuropsicologia detectada - sondando objetivo...');
            await safeLeadUpdate(lead._id, {
                $set: { neuroObjectiveAsked: true, stage: 'triagem_agendamento' }
            }).catch(() => { });

            const neuroFlags = amandaAnalysis.extracted.flags || {};
            const neuroText = text || '';
            const wantsEvaluationExplicit = /\b(laudo|avalia[çc][aã]o|diagn[oó]stico|teste\s+de\s+qi)\b/i.test(neuroText);
            const schoolRequested = /escola\s+(pediu|solicitou|indicou|pedi)/i.test(neuroText);
            const isDiscoveryContext =
                (neuroFlags.mentionsInvestigation && !wantsEvaluationExplicit) ||
                /\b(investig|suspeita|achamos\s+que|fase\s+de|acho\s+que|pode\s+ser|possibilidade|estamos\s+descobrindo)\b/i.test(neuroText);

            if (schoolRequested || wantsEvaluationExplicit) {
                // Pedido explícito de laudo/avaliação (tem prioridade sobre contexto de investigação)
                return ensureSingleHeart(
                    `Entendi! Neuropsicologia 💚\n\n` +
                    `Só pra eu direcionar certinho: vocês estão buscando a **avaliação completa com laudo** ` +
                    `ou **acompanhamento terapêutico**?`
                );
            }

            // Contexto de investigação/descoberta sem pedido explícito → explica sem jargão
            return ensureSingleHeart(
                `Entendo, é um momento importante 💚\n\n` +
                `Vocês estão buscando chegar num **diagnóstico** (avaliação completa que gera um laudo)` +
                ` ou já têm diagnóstico e querem começar as **terapias**?`
            );
        }

        // 🆕 MODO LP: Se tem contexto de landing page, usa IA para resposta humanizada
        if (context?.source === 'lp' && context?.lpPage) {
            console.log('[AMANDA] Modo LP ativo - usando IA para resposta humanizada');
            // Deixa o fluxo continuar para chamar a IA com contexto LP no prompt
        } else if (context.forceFlags?.forceExplainFirst || context.forceFlags?.forceEmpathy || context.forceFlags?.forceRedirect) {
            console.log('🔥 [BYPASS] buildSimpleResponse com force flag → IA');
            // Deixa fluxo continuar para IA
        } else {
            // Fluxo normal: resposta programática rápida
            return buildSimpleResponse(amandaAnalysis.missing, amandaAnalysis.extracted, lead, enrichedContext);
        }
    }

    // 🆕 VERIFICAÇÃO: Emprego/Currículo (antes de perguntar qual área)
    // 🔒 GUARD: Só detecta emprego se NÃO houver contexto de paciente (proteção contra "meu filho" → emprego)
    const isEmploymentSafe = isSafeEmploymentIntent(text);
    if ((amandaAnalysis.extracted.flags.wantsPartnershipOrResume ||
        amandaAnalysis.extracted.flags.wantsJobOrInternship) && isEmploymentSafe) {
        const jobArea = amandaAnalysis.extracted.flags.jobArea ||
            amandaAnalysis.extracted.therapyArea ||
            'nossa equipe';

        console.log('[AMANDA] Emprego/Currículo detectado - área:', jobArea);

        // Atualiza lead para não perder o contexto
        await safeLeadUpdate(lead._id, {
            $set: {
                reason: "parceria_profissional",
                stage: "parceria_profissional",
                "qualificationData.intent": "parceria_profissional",
                "qualificationData.areaInteresse": jobArea
            },
            $addToSet: { flags: "parceria_profissional" }
        }).catch(() => { });

        const areaTexto = jobArea !== 'nossa equipe' ? ` (${jobArea})` : '';

        return ensureSingleHeart(
            `Que bom que você quer fazer parte da nossa equipe${areaTexto}! 🥰💚\n\n` +
            "Os currículos são recebidos **exclusivamente por e-mail**:\n" +
            "📩 **contato@clinicafonoinova.com.br**\n\n" +
            "No assunto, coloque sua área de atuação (ex: Terapeuta Ocupacional).\n\n" +
            "Em breve nossa equipe entra em contato! 😊💚"
        );
    }

    // 🆕 DETECÇÃO DE ESPECIALIDADE POR TEXTO (Fallback antes do BYPASS)
    // ⚠️ SÓ ativa quando: é EXPLICACAO/FIRST_CONTACT + não detectou área + não é emprego/preço/fora_escopo
    const isEmpregoOuParceria = /\b(emprego|trabalhar|vaga|curriculo|cv|parceria|colaborar|estagio)\b/i.test(text);
    const isPerguntaPreco = /\b(quanto|custa|valor|preco|reembolso|convenio|plano)\b/i.test(text);
    // ✅ ATUALIZADO Abr/2026: Removido 'neuropediatra' - agora temos na clínica!
    const isForaEscopo = /\b(cirurgia|medico|pediatra|otorrino|psiquiatra)\b/i.test(text);
    
    console.log(`[DEBUG ESPECIALIDADE] Emprego:${isEmpregoOuParceria} Preco:${isPerguntaPreco} Fora:${isForaEscopo}`);
    console.log(`[DEBUG ESPECIALIDADE] Flags:`, JSON.stringify(context.forceFlags));
    console.log(`[DEBUG ESPECIALIDADE] forceExplainFirst:`, context.forceFlags?.forceExplainFirst);
    console.log(`[DEBUG ESPECIALIDADE] forceFirstContact:`, context.forceFlags?.forceFirstContact);
    console.log(`[DEBUG ESPECIALIDADE] therapyArea:`, amandaAnalysis.extracted.therapyArea);
    
    const deveExecutar = !isEmpregoOuParceria && !isPerguntaPreco && !isForaEscopo && 
        (context.forceFlags?.forceExplainFirst || context.forceFlags?.forceFirstContact) &&
        !amandaAnalysis.extracted.therapyArea;
    
    console.log(`[DEBUG ESPECIALIDADE] deveExecutar:`, deveExecutar);
    
    if (deveExecutar) {
        
        const especialidadeDetectada = 
            /\bterapia ocupacional\b/i.test(text) ? 'terapia_ocupacional' :
            /\bto\b/i.test(text) && !/\bato\b|\bestou\b|\btoda\b|\btodo\b/i.test(text) ? 'terapia_ocupacional' :
            /\bpsicolog(ia|a)\b/i.test(text) && !/\bpsicopedagogia\b/i.test(text) ? 'psicologia' :
            /\bfonoaudiolog\b/i.test(text) || /\bfono\b/i.test(text) && !/\bfonograma|\btelefone/i.test(text) ? 'fonoaudiologia' :
            null;
        
        console.log(`[DEBUG ESPECIALIDADE] Detectada: ${especialidadeDetectada}`);
        
        if (especialidadeDetectada) {
            const areaNamesEsp = {
                fonoaudiologia: 'Fonoaudiologia',
                psicologia: 'Psicologia', 
                terapia_ocupacional: 'Terapia Ocupacional'
            };
            const areaNomeEsp = areaNamesEsp[especialidadeDetectada];
            
            console.log(`🎯 [ESPECIALIDADE DETECTADA] ${areaNomeEsp} - Usando fallback programático (protegido)`);
            return ensureSingleHeart(
                `Oi! Entendi que você busca **${areaNomeEsp}** 💚\n\n` +
                `Para te ajudar melhor, qual o **nome** e **idade** do paciente?` +
                `\n\nAssim consigo verificar a melhor forma de atendimento para vocês! 😊`
            );
        }
    } else {
        console.log(`[DEBUG ESPECIALIDADE] Não passou nas condições - pulando fallback`);
    }

    // 🆕 REGRA 3 & 4: ALTA_INTENCAO/URGENCIA sem therapyArea → Resposta rápida com slots
    if ((context.forceFlags?.forceHighIntent || context.forceFlags?.forceUrgency) && 
        !amandaAnalysis.extracted.therapyArea && !lead?.therapyArea) {
        
        console.log("🚀 [ALTA_INTENCAO/URGENCIA] Lead quer agendar urgente sem área definida");
        
        // 🆕 REGRA 3: Tenta inferir área do histórico ou texto
        const inferredArea = inferAreaFromContext(text, enrichedContext, amandaAnalysis.extracted.flags) || 
            (/\b(fala|voz|gagueira|l[ií]ngua|linguinha|fono)\b/i.test(text) ? 'fonoaudiologia' :
             /\b(comportamento|emo[cç][aã]o|ansiedade|psico)\b/i.test(text) ? 'psicologia' :
             /\b(motor|coordena[cç][aã]o|sensorial|to\b)\b/i.test(text) ? 'terapia_ocupacional' : null);
        
        if (inferredArea) {
            // Salva área inferida e continua para buscar slots
            await safeLeadUpdate(lead._id, { 
                $set: { therapyArea: inferredArea, stage: 'triagem_agendamento' } 
            }).catch(() => {});
            lead.therapyArea = inferredArea;
            amandaAnalysis.extracted.therapyArea = inferredArea;
            console.log(`🎯 [INFERÊNCIA] Área inferida: ${inferredArea}`);
        } else {
            // 🆕 REGRA 4: Template de resposta rápida - oferece múltiplas áreas
            const periodoSolicitado = extractPeriodFromText(text) || 
                (/\b(manh[ãa]|manha)\b/i.test(text) ? 'manhã' : 
                 /\b(tarde)\b/i.test(text) ? 'tarde' : null);
            
            const diaSolicitado = /\b(hoje)\b/i.test(text) ? 'hoje' :
                /\b(amanh[ãa]|amanha)\b/i.test(text) ? 'amanhã' :
                /\b(s[áa]bado)\b/i.test(text) ? 'sábado' :
                /\b(domingo)\b/i.test(text) ? 'domingo' : 'esse período';
            
            return ensureSingleHeart(
                `Entendi que você precisa de um horário ${diaSolicitado}${periodoSolicitado ? ' de ' + periodoSolicitado : ''}! 💚\n\n` +
                `Temos vagas em várias áreas. Pra te mostrar os melhores horários, ` +
                `qual especialidade você precisa: **Fonoaudiologia**, **Psicologia**, **Terapia Ocupacional**, **Fisioterapia** ou **Neuropsicologia**?\n\n` +
                `Ou se preferir, posso verificar em todas as áreas ao mesmo tempo! 😊`
            );
        }
    }

    // 3.5 SEM THERAPY AREA → Resposta contextual baseada em flags e sintomas
    if (!amandaAnalysis.extracted.therapyArea && !lead?.therapyArea) {
        const flags35 = amandaAnalysis.extracted.flags || {};
        
        // 🆕 PRIORITY RESOLVER: Tenta resolver área do contexto antes de perguntar
        const areaResolution = resolveBestArea({ 
            message: text, 
            lead: lead, 
            pageSource: context.pageSource 
        });
        
        if (areaResolution.area && areaResolution.confidence >= 0.7) {
            const areaNames35 = {
                fonoaudiologia: 'Fonoaudiologia',
                psicologia: 'Psicologia',
                terapia_ocupacional: 'Terapia Ocupacional',
                fisioterapia: 'Fisioterapia',
                neuropsicologia: 'Neuropsicologia'
            };
            const areaNome35 = areaNames35[areaResolution.area] || areaResolution.area;
            console.log(`[PRIORITY RESOLVER] Área resolvida: ${areaResolution.area} (conf: ${areaResolution.confidence}, source: ${areaResolution.source})`);
            return ensureSingleHeart(`Oi! Entendi que você busca **${areaNome35}** 💚\n\nPara te ajudar melhor, qual o **nome** e **idade** do paciente?`);
        }
        
        const contextHint35 = hasContextHint(text);

        if (contextHint35) {
            const areaNames35 = {
                fonoaudiologia: 'Fonoaudiologia',
                psicologia: 'Psicologia',
                terapia_ocupacional: 'Terapia Ocupacional',
                fisioterapia: 'Fisioterapia',
                neuropsicologia: 'Neuropsicologia'
            };
            const areaNome35 = areaNames35[contextHint35] || contextHint35;
            return ensureSingleHeart(`Pelo que você descreveu, parece que a área de **${areaNome35}** pode ajudar 💚\n\nÉ isso mesmo, ou está buscando outra especialidade?`);
        }

        // (Decisões emocionais/agendamento tratadas pelo DecisionResolver)

        const wrapped = handleTriagemResponse(`Olá! 💚 Me conta o que você está buscando — assim consigo te direcionar para a especialidade certa!`, context);
        if (wrapped) return ensureSingleHeart(wrapped);
        console.log('🔥 [BYPASS] default firstContact com force flag → IA');
    }

    // 3.6 COMPLETO → HARD RETURN: Oferece slots IMEDIATAMENTE
    if (amandaAnalysis.hasAll && amandaAnalysis.serviceStatus === 'available') {
        console.log("✅ [AMANDA] Triagem completa! Oferecendo slots...");

        // Busca slots reais do banco
        const slots = await findAvailableSlots({
            therapyArea: amandaAnalysis.extracted.therapyArea || lead?.therapyArea,
            patientAge: amandaAnalysis.extracted.patientAge || lead?.patientInfo?.age,
            preferredPeriod: amandaAnalysis.extracted.preferredPeriod || lead?.pendingPreferredPeriod
        });

        if (slots && slots.length > 0) {
            const { message: slotMenu } = buildSlotMenuMessage(slots);
            return ensureSingleHeart(slotMenu + "\n\nQual funciona melhor? 💚");
        } else {
            // Sem slots disponíveis - avisa humano
            return ensureSingleHeart(
                `Perfeito! Já tenho todos os dados 💚\n\n` +
                `Infelizmente não encontrei horários disponíveis para ${amandaAnalysis.extracted.therapyArea} ` +
                `no período da ${amandaAnalysis.extracted.preferredPeriod || 'tarde'}.\n\n` +
                `Vou pedir para nossa equipe entrar em contato para encontrar o melhor horário!`
            );
        }
    }

    // 🚫 BLOQUEIO: Fluxo legado NÃO deve executar quando hasAll=true
    // Isso previne loops e corrupção de dados
    console.log("🔄 [AMANDA] Usando fluxo legado apenas para casos parciais...");

    // =========================================================================
    // 🆕 PASSO 0.6: CONTEXTO ENRIQUECIDO JÁ RECUPERADO ACIMA
    // O enrichedContext foi obtido na fase entity-driven
    // =========================================================================

    if (enrichedContext?.isFirstContact && lead?._id) {
        manageLeadCircuit(lead._id, 'initial').catch(err =>
            console.error('[CIRCUIT] Erro ao agendar initial:', err.message)
        );
    }

    // 🆕 DETECÇÃO COM DETECTORES CONTEXTUAIS (ConfirmationDetector, InsuranceDetector, PriceDetector, SchedulingDetector)
    // Usa adapter pattern para manter compatibilidade com flags legacy
    const flags = detectWithContextualDetectors(text, lead, enrichedContext);
    console.log("🚩 FLAGS DETECTADAS:", flags);

    // ═════════════════════════════════════════════════════════════════════════════
    // 🧠 DECISION RESOLVER v2.0 - Decisão unificada
    // ═════════════════════════════════════════════════════════════════════════════
    
    const _decisionStart = Date.now();
    const decision = resolveDecision({
        forceFlags: context.forceFlags,
        detectorResults: extractDetectorResults(flags),
        currentState: lead.triageStep || lead.stage || 'IDLE',
        messageIndex: enrichedContext?.conversationHistory?.filter(m => m.role === 'user').length || 0,
        enrichedContext
    });

    console.log("🧠 DECISION:", {
        action: decision.action,
        domain: decision.domain,
        confidence: decision.systemConfidence.toFixed(2),
        reason: decision.reason
    });
    
    // Executa baseado na decisão
    switch (decision.action) {
        case 'RULE': {
            // RULE: Resposta programática via ResponseBuilder
            if (canAutoRespond(flags)) {
                const response = buildResponseFromFlags(flags, {
                    therapyArea: lead?.therapyArea || flags.therapyArea
                });
                if (response) return ensureSingleHeart(response);
            }
            // Se ResponseBuilder não retornou, continua para fluxo legado
            break;
        }
        case 'HYBRID': {
            // HYBRID: Injeta contexto para IA
            enrichedContext.decision = decision;
            break;
        }
        case 'AI':
        default: {
            // AI: Continua fluxo normal
            break;
        }
    }
    
    // ═════════════════════════════════════════════════════════════════════════════
    // FIM DECISION RESOLVER
    // ═════════════════════════════════════════════════════════════════════════════

    // 📊 Log detecções contextuais (quando ativas)
    if (flags._confirmation) {
        console.log("✅ [CONFIRMATION] Detecção contextual:", {
            meaning: flags._confirmation.semanticMeaning,
            confidence: flags._confirmation.confidence,
            requiresValidation: flags._confirmation.requiresValidation
        });
    }
    if (flags._insurance) {
        console.log("🏥 [INSURANCE] Detecção contextual:", {
            plan: flags._insurance.plan,
            intentType: flags._insurance.intentType,
            confidence: flags._insurance.confidence
        });
    }
    if (flags._price) {
        console.log("💰 [PRICE] Detecção contextual:", {
            type: flags._price.priceType,
            confidence: flags._price.confidence,
            hasObjection: flags._price.hasObjection
        });
    }
    if (flags._scheduling) {
        console.log("📅 [SCHEDULING] Detecção contextual:", {
            type: flags._scheduling.schedulingType,
            confidence: flags._scheduling.confidence,
            hasUrgency: flags._scheduling.hasUrgency,
            period: flags._scheduling.preferredPeriod
        });
    }

    // =========================================================================
    // 🆕 PASSO 0.5: VALIDAÇÃO DE SERVIÇOS (Bloqueia serviços que não existem)
    // =========================================================================
    console.log("🩺 [VALIDATION] Verificando serviço solicitado...");

    // Extrai contexto para respostas personalizadas
    const responseContext = extractContextForResponse(text, lead);

    // Usa ClinicalEligibility para validação completa
    const age = lead?.patientInfo?.age || extractAgeFromText(text);
    const eligibilityCheck = await clinicalEligibility.validate({
        therapy: lead?.therapyArea,
        age: age,
        text: text,
        clinicalHistory: lead?.clinicalHistory || {}
    });

    if (eligibilityCheck.blocked) {
        console.log("🚫 [VALIDATION] Serviço bloqueado:", eligibilityCheck.reason);
        return ensureSingleHeart(eligibilityCheck.message);
    }

    // Validação adicional de serviços específicos com contexto
    const serviceValidation = validateServiceRequest(text);
    if (!serviceValidation.valid) {
        console.log("🚫 [VALIDATION] Serviço inválido:", serviceValidation.requested);

        // Gera mensagem humanizada com contexto
        let humanizedMessage = serviceValidation.message;
        if (serviceValidation.isMedicalSpecialty) {
            const medical = MEDICAL_SPECIALTIES.find(m => m.name === serviceValidation.requested);
            if (medical) {
                humanizedMessage = buildMedicalSpecialtyResponse(medical, responseContext);
            }
        } else if (serviceValidation.requested) {
            const config = VALID_SERVICES[Object.keys(VALID_SERVICES).find(k => VALID_SERVICES[k].name === serviceValidation.requested)];
            if (config) {
                humanizedMessage = buildUnavailableServiceResponse(config, responseContext);
            }
        }

        // Se tem redirecionamento, salva no lead para contexto futuro
        if (serviceValidation.redirect && lead?._id) {
            await safeLeadUpdate(lead._id, {
                $set: {
                    "qualificationData.redirectedFrom": serviceValidation.requested,
                    "qualificationData.suggestedAlternative": serviceValidation.redirect,
                    "qualificationData.redirectContext": responseContext
                }
            }).catch(() => { });
        }

        return ensureSingleHeart(humanizedMessage);
    }

    // =========================================================================
    // 🛡️ GUARD: Anti-spam "encaminhei pra equipe"
    // =========================================================================
    if (
        lead?.autoBookingContext?.handoffSentAt &&
        /^(ok|obrigad[oa]?|aguardo|t[aá]\s*bom|blz|certo|perfeito|valeu|show)$/i.test(text.trim())
    ) {
        console.log("🤝 [HANDOFF]", {
            reason: "sem_slot | erro | fluxo",
            lead: lead._id
        });

        console.log("[GUARD] Anti-spam: cliente confirmou, silenciando");
        return ensureSingleHeart("Perfeito! Qualquer dúvida, é só chamar 💚");
    }

    // =========================================================================
    // 🛡️ GUARD: awaitingResponseFor — "Sim" com contexto de pergunta pendente
    // ✅ FIX: Quando Amanda pergunta algo e o usuário confirma, retomar o contexto
    // certo em vez de cair no handler genérico.
    // =========================================================================
    const isSimpleConfirmation = /^(sim|pode|ok|claro|fechado|quero|gostaria|s|yep|yes|tá\s*bom|ta\s*bom)$/i.test(text.trim());
    const awaiting = lead?.awaitingResponseFor;

    if (awaiting && isSimpleConfirmation) {
        const now = Date.now();
        const ageMs = now - (awaiting.timestamp || 0);
        const isValid = ageMs < 30 * 60 * 1000; // válido por 30 minutos

        if (isValid) {
            console.log("✅ [AWAITING] Confirmação recebida para:", awaiting.type);

            // Limpa o estado antes de processar
            await safeLeadUpdate(lead._id, {
                $unset: { awaitingResponseFor: "" }
            }).catch(e => console.warn("[AWAITING] Erro ao limpar estado:", e.message));
            lead.awaitingResponseFor = null;

            if (awaiting.type === 'package_detail') {
                const area = awaiting.area || lead?.therapyArea || 'avaliação';
                const PACKAGES = {
                    fonoaudiologia: "Nosso pacote mensal de fonoaudiologia inclui **4 sessões/mês por R$ 560** (R$ 140/sessão). A avaliação inicial não entra no pacote — é separada. Quer que eu veja um horário pra avaliação? 💚",
                    psicologia: "O acompanhamento psicológico é **R$ 150/sessão**. Muitas famílias fazem sessões semanais. A avaliação inicial é o primeiro passo. Quer agendar? 💚",
                    terapia_ocupacional: "Nosso pacote mensal de TO é **4 sessões/mês por R$ 560** (R$ 140/sessão). Quer que eu veja horários disponíveis? 💚",
                    neuropsicologia: "A avaliação neuropsicológica completa é **R$ 2.000 (até 6x)** e inclui ~10 sessões com laudo final. É um investimento único — diferente de terapia contínua. Quer agendar uma conversa pra tirar dúvidas? 💚",
                    fisioterapia: "Nosso pacote mensal de fisioterapia é **4 sessões/mês por R$ 560**. Quer que eu veja horários? 💚",
                };
                return ensureSingleHeart(
                    PACKAGES[area] || "Nosso pacote mensal inclui 4 sessões por R$ 560 (R$ 140/sessão). Quer que eu veja horários disponíveis? 💚"
                );
            }

            if (awaiting.type === 'schedule_confirmation' || awaiting.type === 'show_slots') {
                // Força o flag de agendamento para continuar o fluxo de slots
                flags.wantsSchedule = true;
                console.log("🗓️ [AWAITING] Redirecionando para fluxo de slots");
                // Não retorna — deixa o fluxo de slots continuar abaixo
            }

            if (awaiting.type === 'schedule_today') {
                flags.wantsSchedule = true;
                flags.mentionsUrgency = true;
                console.log("⚡ [AWAITING] Redirecionando para slots urgentes (hoje)");
                // Não retorna — deixa o fluxo de urgência continuar
            }

            if (awaiting.type === 'insurance_followup') {
                return ensureSingleHeart(
                    "Ótimo! 💚 Então vamos por conta própria mesmo — você solicita o reembolso depois direto pelo app do plano. Eu forneço a nota fiscal e todos os documentos necessários.\n\nQual período fica melhor pra vocês: **manhã ou tarde**? 😊"
                );
            }
        } else {
            // Estado expirado — limpa silenciosamente
            await safeLeadUpdate(lead._id, {
                $unset: { awaitingResponseFor: "" }
            }).catch(() => { });
            lead.awaitingResponseFor = null;
            console.log("⏰ [AWAITING] Estado expirado, ignorando");
        }
    }

    // =========================================================================
    // 🛡️ GUARD: Preço tem prioridade SEMPRE
    // =========================================================================
    const asksPrice = /(pre[çc]o|valor|quanto\s*(custa|[eé]))/i.test(text);
    if (asksPrice && lead?.status === "agendado") {
        console.log("[GUARD] Cliente perguntou preço PÓS-agendamento");
        const knownArea = lead?.therapyArea || "avaliacao";
        // Busca preço dinâmico da área
        const pricing = getTherapyPricing(knownArea);
        let priceText;
        if (pricing) {
            if (pricing.incluiLaudo) {
                priceText = `A avaliação neuropsicológica completa é **${formatPrice(pricing.avaliacao)}** (até 6x).`;
            } else {
                priceText = `A avaliação de ${pricing.descricao.toLowerCase()} é **${formatPrice(pricing.avaliacao)}**.`;
            }
        } else {
            priceText = "A avaliação inicial é **R$ 200**.";
        }
        return ensureSingleHeart(priceText);
    }

    // =========================================================================
    // 🆕 PASSO 1: FLUXO DE COLETA DE DADOS DO PACIENTE (PÓS-ESCOLHA DE SLOT)
    // =========================================================================
    console.log("🔍 [PASSO 1 CHECK]", {
        pendingPatientInfoForScheduling: lead?.pendingPatientInfoForScheduling,
        hasLeadId: !!lead?._id,
    });

    // ✅ FIX: Usar flags já calculados (mais abrangentes que regex local)
    // Antes: regex própria não capturava "fica em Anápolis", "são de Anápolis", etc.

    // ✅ NOVO: Verificar perguntas sobre plano ANTES de localização
    const asksInsurance = flags?.asksPlans ||
        flags?.mentionsReembolso ||
        /(conv[eê]nio|plano\s*(de\s*)?sa[uú]de|unimed|ipasgo|hapvida|bradesco|amil|sulamerica|reembolso)/i.test(text.normalize('NFC'));

    const asksLocation = flags?.asksAddress || flags?.asksLocation ||
        /(endere[çc]o|onde\s+fica|localiza(?:ç|c)(?:a|ã)o)/i.test(text.normalize('NFC'));

    // ✅ NOVO: Se perguntar sobre plano, NÃO envia localização (deixa fluxo normal responder)
    if (asksLocation && !asksInsurance) {
        const coords = {
            latitude: -16.3334217,
            longitude: -48.9488967,
            name: "Clínica Fono Inova",
            address: "Av. Minas Gerais, 405 - Jundiaí, Anápolis - GO, 75110-770",
            url: "https://www.google.com/maps/dir//Av.+Minas+Gerais,+405+-+Jundiaí,+Anápolis+-+GO,+75110-770/@-16.3315712,-48.9488384,14z"
        };

        // 1️⃣ envia o pin real (mensagem type: "location")
        await sendLocationMessage({
            to: lead.contact.phone,
            lead: lead._id,
            contactId: lead.contact._id,
            latitude: coords.latitude,
            longitude: coords.longitude,
            name: coords.name,
            address: coords.address,
            url: coords.url,
            sentBy: "amanda",
        });

        await new Promise(res => setTimeout(res, 800));

        // 2️⃣ envia a mensagem de texto complementar
        await sendTextMessage({
            to: lead.contact.phone,
            text: `Claro! 📍 Aqui está nossa localização:\n\n**${coords.name}**\n${coords.address}\n\n🗺️ ${coords.url}`,
            lead: lead._id,
            contactId: lead.contact._id,
            sentBy: "amanda",
        });

        return null;
    } else if (asksInsurance) {
        console.log("🛡️ [PASSO 1] Pergunta sobre plano detectada - bypassing location");
        // Não retorna - deixa o fluxo normal responder sobre planos
    }

    if (lead?.pendingPatientInfoForScheduling && lead?._id) {
        console.log("📝 [ORCHESTRATOR] Lead está pendente de dados do paciente");

        const step = lead.pendingPatientInfoStep || "name";
        const chosenSlot = lead.pendingChosenSlot;


        // 🛡️ ESCAPE: Detecta perguntas importantes durante coleta
        const asksPrice = /(pre[çc]o|valor|quanto\s*(custa|[eé]))/i.test(text);

        if (asksPrice) {
            const area = lead?.therapyArea || "avaliacao";
            const pricing = getTherapyPricing(area);
            let priceText;
            if (pricing) {
                priceText = formatPrice(pricing.avaliacao);
            } else {
                priceText = "R$ 200";
            }
            const nextStep = step === "name" ? "nome completo" : "data de nascimento";
            return ensureSingleHeart(`A avaliação é **${priceText}**. Pra confirmar o horário, preciso só do **${nextStep}** 💚`);
        }

        if (step === "name") {
            // 🛡️ FIX: nome já coletado (wamid duplicado / msg re-processada)
            if (lead?.patientInfo?.fullName) {
                await safeLeadUpdate(lead._id, {
                    $set: { pendingPatientInfoStep: "birth" }
                }).catch(err => logSuppressedError('autoAdvanceStep', err));
                return ensureSingleHeart("Obrigada! Agora me manda a **data de nascimento** (dd/mm/aaaa)");
            }

            const name = extractName(text);
            // 📌 Salva como info clínica inferida (não operacional)
            if (name && !lead?.patientInfo?.fullName) {
                await safeLeadUpdate(lead._id, {
                    $set: { "autoBookingContext.inferredName": name }
                }).catch(err => logSuppressedError("inferredName", err));
            }
            if (!name) {
                return ensureSingleHeart("Pra eu confirmar certinho: qual o **nome completo** do paciente?");
            }
            await safeLeadUpdate(lead._id, {
                $set: { "patientInfo.fullName": name, pendingPatientInfoStep: "birth" }
            }).catch(err => logSuppressedError('safeLeadUpdate', err));
            return ensureSingleHeart("Obrigada! Agora me manda a **data de nascimento** (dd/mm/aaaa)");
        }

        if (step === "birth") {
            const birthDate = extractBirth(text);
            if (!birthDate) {
                return ensureSingleHeart("Me manda a **data de nascimento** no formato **dd/mm/aaaa**");
            }

            // Busca dados atualizados
            const updated = await Leads.findById(lead._id).select('+triageStep complaint').lean().catch(() => null);
            const fullName = updated?.patientInfo?.fullName;
            const phone = updated?.contact?.phone;

            if (!fullName || !chosenSlot) {
                return ensureSingleHeart("Perfeito! Só mais um detalhe: confirma pra mim o **nome completo** do paciente?");
            }

            // Salva data de nascimento
            await safeLeadUpdate(lead._id, {
                $set: { "patientInfo.birthDate": birthDate }
            }).catch(err => logSuppressedError('safeLeadUpdate', err));


            // 🆕 TENTA AGENDAR
            console.log("🚀 [ORCHESTRATOR] Tentando agendar após coletar dados do paciente");
            const bookingResult = await autoBookAppointment({
                lead: updated,
                chosenSlot,
                patientInfo: { fullName, birthDate, phone }
            });

            if (bookingResult.success) {
                await safeLeadUpdate(lead._id, {
                    $set: {
                        status: "agendado",
                        stage: "paciente",
                        patientId: bookingResult.patientId,
                    },
                    $unset: {
                        pendingSchedulingSlots: "",
                        pendingChosenSlot: "",
                        pendingPatientInfoForScheduling: "",
                        pendingPatientInfoStep: "",
                        autoBookingContext: "",
                        teaQuestionAsked: "", // Limpa flag de pergunta TEA
                        awaitingTherapyConfirmation: "", // Limpa confirmação de área
                        hasMedicalReferral: "", // Limpa flag de pedido médico
                    },
                }).catch(err => logSuppressedError('safeLeadUpdate', err));

                // 🆕 FASE 4: Registra conversão no Learning Loop
                // Atualiza todos os feedbacks pendentes deste lead
                recordOutcome({
                    leadId: lead._id,
                    converted: true,
                    specificMetrics: {
                        bookingType: 'auto',
                        hadObjections: false, // Pode ser inferido dos feedbacks
                        therapyArea: lead.therapyArea
                    }
                }).catch(err => console.warn('[TRACKING] Erro ao registrar outcome:', err.message));

                await Followup.updateMany(
                    { lead: lead._id, status: "scheduled" },
                    {
                        $set: {
                            status: "canceled",
                            canceledReason: "agendamento_confirmado_amanda",
                        },
                    },
                ).catch(err => logSuppressedError('safeLeadUpdate', err));

                const humanDate = formatDatePtBr(chosenSlot.date);
                const humanTime = String(chosenSlot.time || "").slice(0, 5);

                // ✅ Mensagem de confirmação acolhedora
                return ensureSingleHeart(`Que maravilha! 🎉 Tudo certo!\n\n📅 **${humanDate}** às **${humanTime}**\n👩‍⚕️ Com **${chosenSlot.doctorName}**\n\nVocês vão adorar conhecer a clínica! Qualquer dúvida, é só me chamar 💚`);
            } else if (bookingResult.code === "TIME_CONFLICT") {
                await safeLeadUpdate(lead._id, {
                    $set: { pendingChosenSlot: null, pendingPatientInfoForScheduling: false }
                }).catch(err => logSuppressedError('safeLeadUpdate', err));
                return ensureSingleHeart("Esse horário acabou de ser preenchido 😕 A equipe vai te enviar novas opções em instantes");
            } else {
                return ensureSingleHeart("Deixa eu verificar isso direitinho pra você. Só um instante 💚");
            }
        }
    }

    // 🔁 Anti-resposta duplicada por messageId
    if (messageId) {
        const lastResponse = recentResponses.get(messageId);
        if (lastResponse && Date.now() - lastResponse < 5000) {
            console.warn(`[ORCHESTRATOR] Resposta duplicada bloqueada para ${messageId}`);
            return null;
        }
        recentResponses.set(messageId, Date.now());

        if (recentResponses.size > 100) {
            const oldest = [...recentResponses.entries()].sort((a, b) => a[1] - b[1])[0];
            recentResponses.delete(oldest[0]);
        }
    }

    // ✅ CONTEXTO UNIFICADO e FLAGS já foram inicializados no PASSO 0.6 (linhas ~1320+)
    // enrichedContext e flags estão disponíveis para uso a partir deste ponto

    // 🆕 FASE 4: RASTREAMENTO DE DETECÇÕES (Learning Loop)
    // Registra cada detecção para análise de efetividade
    const trackingPromises = [];

    if (flags._confirmation) {
        trackingPromises.push(
            trackDetection({
                detector: 'confirmation',
                pattern: flags._confirmation.type || 'general',
                text,
                confidence: flags._confirmation.confidence,
                lead,
                messageId: null, // Será preenchido depois se disponível
                strategicHint: null // Será preenchido pela FASE 3
            }).catch(err => console.warn('[TRACKING] Erro ao rastrear confirmation:', err.message))
        );
    }

    if (flags._insurance) {
        trackingPromises.push(
            trackDetection({
                detector: 'insurance',
                pattern: flags._insurance.intentType || 'question',
                text,
                confidence: flags._insurance.confidence,
                lead,
                messageId: null,
                strategicHint: null
            }).catch(err => console.warn('[TRACKING] Erro ao rastrear insurance:', err.message))
        );
    }

    if (flags._price) {
        trackingPromises.push(
            trackDetection({
                detector: 'price',
                pattern: flags._price.priceType || 'question',
                text,
                confidence: flags._price.confidence,
                lead,
                messageId: null,
                strategicHint: null
            }).catch(err => console.warn('[TRACKING] Erro ao rastrear price:', err.message))
        );
    }

    if (flags._scheduling) {
        trackingPromises.push(
            trackDetection({
                detector: 'scheduling',
                pattern: flags._scheduling.schedulingType || 'request',
                text,
                confidence: flags._scheduling.confidence,
                lead,
                messageId: null,
                strategicHint: null
            }).catch(err => console.warn('[TRACKING] Erro ao rastrear scheduling:', err.message))
        );
    }

    // Executa tracking em paralelo (non-blocking)
    if (trackingPromises.length > 0) {
        Promise.all(trackingPromises).catch(() => { }); // Fire and forget
    }

    // 🆕 FASE 3: ENRIQUECIMENTO ESTRATÉGICO DO CONTEXTO
    // NÃO intercepta fluxo, apenas adiciona insights ao enrichedContext existente
    const strategicEnhancements = buildStrategicContext(flags, lead, enrichedContext);

    // Adiciona strategicHints ao enrichedContext (não substitui, enriquece)
    enrichedContext.strategicHints = strategicEnhancements.strategicHints;
    enrichedContext._enrichment = strategicEnhancements._enrichment;

    logStrategicEnrichment(enrichedContext, flags);

    // =========================================================================
    // 🆕 ENRIQUECIMENTO DE CONTEXTO ADICIONAL (Manual Intent, TEA Status, Scheduling)
    // =========================================================================

    // 1. Detecta intenção manual (endereço, planos, preço genérico, saudação)
    const manualIntent = detectManualIntent(text);
    if (manualIntent) {
        enrichedContext.manualIntent = manualIntent;
        console.log("🎯 [MANUAL INTENT] Detectado:", manualIntent);
    }

    // 2. Calcula status TEA (laudo_confirmado | suspeita | desconhecido)
    const teaStatus = computeTeaStatus(flags, text);
    if (teaStatus && teaStatus !== "desconhecido") {
        enrichedContext.teaStatus = teaStatus;
        console.log("🧩 [TEA STATUS]:", teaStatus);
    }

    // =========================================================================
    // 🩺 DECISÃO CLÍNICA: Investigação TEA - Pergunta objetivo
    // =========================================================================
    // Se detectou investigação/suspeita de TEA, pergunta direto o objetivo
    const needsTeaQuestion =
        flags.mentionsInvestigation &&
        flags.mentionsTEA_TDAH &&
        !lead?.teaQuestionAsked &&
        !lead?.therapyArea;

    if (needsTeaQuestion) {
        console.log("🩺 [CLINICAL DECISION] Investigacao TEA detectada, perguntando objetivo");

        await safeLeadUpdate(lead._id, {
            $set: { teaQuestionAsked: true }
        }).catch(() => { });

        return ensureSingleHeart(
            `Entendo que estão em fase de descoberta 💚\n\n` +
            `Vocês querem o **laudo de TEA** ou querem fazer **acompanhamento terapêutico**?`
        );
    }

    // 🩺 Interpreta a resposta
    if (lead?.teaQuestionAsked && flags.mentionsTEA_TDAH) {
        const wantsLaudo =
            /\b(laudo|neuropsic|avalia[cç][aã]o\s+neuro|neuropediatra|escola|relat[oó]rio|10\s+sess[õo]es|dez\s+sess[õo]es|2000|dois\s+mil)\b/i.test(text);

        const wantsAcompanhamento =
            /\b(terapia|terapias|psic[oó]loga|acompanhamento|tratamento|sess[õo]es|200\s+reais|duzentos)\b/i.test(text);

        if (wantsLaudo && !wantsAcompanhamento) {
            console.log("🩺 [CLINICAL DECISION] Quer LAUDO → Neuropsicológica");
            await safeLeadUpdate(lead._id, {
                $set: {
                    therapyArea: "neuropsicologia",
                    "qualificationData.extractedInfo.especialidade": "neuropsicologia",
                    teaQuestionAsked: null
                }
            }).catch(() => { });
            flags.therapyArea = "neuropsicologia";

            // Já explica e vai direto pro agendamento
            return ensureSingleHeart(
                `Perfeito! Pra laudo de TEA, fazemos a avaliação neuropsicológica 💚\n\n` +
                `São ~10 sessões, investimento R$ 2.000 (até 6x). O laudo é válido pra escola e médicos.\n\n` +
                `Prefere manhã ou tarde?`
            );
        } else if (wantsAcompanhamento && !wantsLaudo) {
            console.log("🩺 [CLINICAL DECISION] Quer ACOMPANHAMENTO → Psicologia");
            await safeLeadUpdate(lead._id, {
                $set: {
                    therapyArea: "psicologia",
                    "qualificationData.extractedInfo.especialidade": "psicologia",
                    teaQuestionAsked: null
                }
            }).catch(() => { });
            flags.therapyArea = "psicologia";

            const psicoPricing = getTherapyPricing('psicologia');
            const fonoPricing = getTherapyPricing('fonoaudiologia');
            const psicoPrice = psicoPricing ? formatPrice(psicoPricing.avaliacao) : 'R$ 200';
            const fonoPrice = fonoPricing ? formatPrice(fonoPricing.avaliacao) : 'R$ 250';
            return ensureSingleHeart(
                `Ótimo! O acompanhamento terapêutico é um ótimo caminho 💚\n\n` +
                `Avaliação inicial psicologia ${psicoPrice}, fonoaudiologia ${fonoPrice}. Começamos com psicologia e podemos integrar com fono/TO depois.\n\n` +
                `Prefere manhã ou tarde?`
            );
        }
        // Se ambíguo, deixa o fluxo normal tratar
    }

    // 3. Verifica se deve oferecer agendamento (contexto acumulado)
    const shouldOffer = shouldOfferScheduling({
        therapyArea: flags.therapyArea,
        patientAge: lead?.patientInfo?.age || flags.ageGroup,
        complaint: flags.hasPain || flags.topic,
        bookingOffersCount: lead?.bookingOffersCount || 0,
        emotionalContext: {
            interests: flags.wantsSchedule ? ['booking'] : [],
            objections: flags.mentionsPriceObjection ? ['price'] : []
        }
    });
    enrichedContext.shouldOfferScheduling = shouldOffer;
    console.log("📅 [SCHEDULING DECISION]:", shouldOffer);

    // ============================================================
    // 🧭 TRIAGEM AMANDA 2.0 — USANDO triageStep DO SCHEMA
    // ============================================================

    const hasImplicitInterest =
        flags.hasPain ||
        flags.mentionsChild ||
        /consulta|avalia[cç][aã]o|atendimento/i.test(text) ||
        extractAgeFromText(text);

    // 🛡️ FLAGS que DEVEM BYPASS da triagem (lead fez pergunta específica)
    const hasSpecificIntent =
        flags.asksPrice ||
        flags.insistsPrice ||
        flags.asksPlans ||
        flags.mentionsReembolso ||
        flags.mentionsTEA_TDAH ||
        flags.asksAboutAfterHours ||
        flags.mentionsPriceObjection ||
        flags.wantsPartnershipOrResume ||
        flags.asksAddress ||
        flags.asksLocation ||
        /psicopedagog/i.test(text) ||
        /linguinha|fren[uú]lo|freio\s*ling/i.test(text) ||
        /ne[iu]ropsico/i.test(text) ||
        /dificuldade.*(escola|ler|escrever|aprendizagem|leitura|escrita)/i.test(text) ||
        /escola.*(dificuldade|problema|nota|rendimento)/i.test(text) ||
        /(conv[eê]nio|plano\s*(de\s*)?sa[uú]de|unimed|ipasgo|hapvida|bradesco|amil)/i.test(text);

    // 🎯 INICIALIZAÇÃO DA TRIAGEM: Só roda quando lead não tem triageStep definido
    const shouldInitTriage = lead?._id && 
        !lead.triageStep && 
        !lead.pendingSchedulingSlots && 
        !lead.pendingPatientInfoForScheduling &&
        lead.stage !== "paciente";
    
    if (shouldInitTriage) {
        // Verifica se é novo lead ou lead existente sem triagem completa
        const hasCompleteData = lead.therapyArea && 
            lead.complaint && 
            lead.patientInfo?.fullName && 
            lead.patientInfo?.birthDate &&
            lead.patientInfo?.age &&
            lead.pendingPreferredPeriod;
        
        // Se já tem dados completos, marca como done
        if (hasCompleteData) {
            console.log("📝 [TRIAGEM] Lead com dados completos, marcando como done");
            await safeLeadUpdate(lead._id, { 
                $set: { triageStep: "done", stage: "engajado" } 
            });
            lead.triageStep = "done";
        } else if (lead.therapyArea) {
            // Tem área mas falta dados → inicia triagem na etapa correta
            let initialStep = "ask_complaint"; // Default: começa perguntando queixa
            
            if (!lead.complaint) {
                initialStep = "ask_complaint";
            } else if (!lead.patientInfo?.fullName) {
                initialStep = "ask_name";
            } else if (!lead.patientInfo?.birthDate) {
                initialStep = "ask_birthDate";
            } else if (!lead.patientInfo?.age) {
                initialStep = "ask_age";
            } else if (!lead.pendingPreferredPeriod) {
                initialStep = "ask_period";
            } else {
                initialStep = "done";
            }
            
            console.log(`🔄 [TRIAGEM] Lead existente sem triageStep. Iniciando em: ${initialStep}`);
            await safeLeadUpdate(lead._id, { 
                $set: { triageStep: initialStep, stage: "triagem_agendamento" } 
            });
            lead.triageStep = initialStep;
        }
    }
    
    // 🎯 Fluxo normal de inicialização para novos leads
    if (
        lead?._id &&
        hasImplicitInterest &&
        !hasSpecificIntent &&
        !lead.triageStep &&
        !lead.pendingSchedulingSlots &&
        !lead.pendingPatientInfoForScheduling &&
        lead.stage !== "paciente"
    ) {
        // ✅ FIX: Tentar extrair dados da PRIMEIRA mensagem para não perguntar de novo
        const extractedAge = extractAgeFromText(text);
        const extractedName = extractName(text);
        const extractedPeriod = extractPeriodFromText(text);
        const extractedComplaint = extractComplaint(text);

        console.log("🔄 [TRIAGEM] Iniciando triagem - dados extraídos:", {
            age: extractedAge?.age || extractedAge,
            name: extractedName,
            period: extractedPeriod,
            complaint: extractedComplaint
        });

        // Determinar qual step iniciar baseado nos dados já extraídos
        let initialStep = "ask_period";
        const updateData = {
            triageStep: "ask_period",
            stage: "triagem_agendamento"
        };

        // Se já tem período, vai direto para ask_name
        if (extractedPeriod) {
            initialStep = "ask_name";
            updateData.triageStep = "ask_name";
            updateData.pendingPreferredPeriod = normalizePeriod(extractedPeriod);
            console.log("📝 [TRIAGEM] Período já informado, pulando para ask_name");
        }

        // Se já tem nome também, salva e continua
        if (extractedName) {
            updateData["patientInfo.fullName"] = extractedName;
            if (extractedPeriod) {
                initialStep = "ask_age";
                updateData.triageStep = "ask_age";
                console.log("📝 [TRIAGEM] Nome já informado, pulando para ask_age");
            }
        }

        // Se já tem idade também, salva e continua
        if (extractedAge) {
            const ageValue = typeof extractedAge === 'object' ? extractedAge.age : extractedAge;
            const ageUnit = typeof extractedAge === 'object' ? extractedAge.unit : 'anos';
            updateData["patientInfo.age"] = ageValue;
            updateData["patientInfo.ageUnit"] = ageUnit;
            updateData["qualificationData.idade"] = ageValue;
            updateData["qualificationData.idadeRange"] = ageValue <= 3 ? '0-3' :
                ageValue <= 6 ? '4-6' :
                    ageValue <= 12 ? '7-12' : '13+';

            if (extractedPeriod && extractedName) {
                initialStep = "ask_complaint";
                updateData.triageStep = "ask_complaint";
                console.log("📝 [TRIAGEM] Idade já informada, pulando para ask_complaint");
            }
        }

        // Se já tem queixa também, salva e finaliza
        if (extractedComplaint && extractedPeriod && extractedName && extractedAge) {
            updateData.complaint = extractedComplaint;
            initialStep = "done";
            updateData.triageStep = "done";
            updateData.stage = "engajado";
            console.log("📝 [TRIAGEM] Queixa já informada, finalizando triagem");
        }

        console.log(`🔄 [TRIAGEM] Iniciando na etapa: ${initialStep}`);
        const updateResult = await safeLeadUpdate(lead._id, { $set: updateData });

        if (updateResult) {
            console.log("✅ [TRIAGEM] triageStep salvo com sucesso:", updateResult.triageStep);
            lead.triageStep = initialStep; // ✅ mantém em memória o step correto
        } else {
            console.warn("⚠️ [TRIAGEM] Falha ao salvar triageStep");
            lead.triageStep = "ask_period"; // Fallback só se falhar
        }
    }

    // ============================================================
    // ▶️ CONDUÇÃO DA TRIAGEM (ANTI-LIMBO + ANTI-LOOP)
    // ============================================================

    if (lead?.triageStep === "ask_period") {
        // 🛡️ ANTI-LOOP: Se já tem período, não pergunta de novo
        if (lead.pendingPreferredPeriod || lead.qualificationData?.disponibilidade) {
            console.log("🛡️ [ANTI-LOOP] Tem período mas triageStep=ask_period, corrigindo...");
            await safeLeadUpdate(lead._id, { $set: { triageStep: "ask_name" } });
            return ensureSingleHeart("Ótimo! 💚 Qual o **nome do paciente**?");
        }

        // 🛡️ Se o lead fez pergunta específica DURANTE a triagem,
        // não retornar "manhã ou tarde?" — deixar o Claude responder
        const hasSpecificIntentNow =
            flags.asksPrice ||
            flags.insistsPrice ||
            flags.asksPlans ||
            flags.mentionsReembolso ||
            flags.mentionsTEA_TDAH ||
            flags.asksAboutAfterHours ||
            flags.mentionsPriceObjection ||
            flags.wantsPartnershipOrResume ||
            flags.asksAddress ||
            flags.asksLocation ||
            flags.asksSpecialtyAvailability ||    // ✅ FIX: "Vcs tem psicólogo?" bypass
            flags.mentionsInsuranceObjection ||   // ✅ FIX: objeção de plano bypass
            /psicopedagog/i.test(text) ||
            /linguinha|fren[uú]lo|freio\s*ling/i.test(text) ||
            /ne[iu]ropsico/i.test(text) ||
            /dificuldade.*(escola|ler|escrever|aprendizagem|leitura|escrita)/i.test(text) ||
            /escola.*(dificuldade|problema|nota|rendimento)/i.test(text) ||
            /(conv[eê]nio|plano\s*(de\s*)?sa[uú]de|unimed|ipasgo|hapvida|bradesco|amil)/i.test(text) ||
            // ✅ FIX: Usuário fazendo pergunta de disponibilidade ("tem psicólogo?", "atende X?")
            /\b(tem|voc[eê]s\s+t[eê]m|atendem|oferecem)\s+(psic[oó]log|fonoaudi|fisioterap|terapeu|neuropsic)/i.test(text);

        if (hasSpecificIntentNow) {
            console.log("🛡️ [TRIAGEM] Bypass: lead tem pergunta específica, seguindo para IA");
            // NÃO retorna — deixa seguir para o Claude com clinicWisdom
        } else {
            const period = extractPeriodFromText(text);

            // ✅ FIX: Greedy data extraction — salvar dados de perfil MESMO quando o
            // usuário não respondeu o período. Ex: "Infantil pra menino de 12 anos de"
            // Antes: ignorava tudo e repetia "manhã ou tarde?"
            // Agora: salva o que chegou e pede só o que falta
            const ageExtracted = extractAgeFromText(text);
            const nameExtracted = extractName(text);
            const updateData = {};

            if (ageExtracted && !lead?.patientInfo?.age) {
                // ✅ FIX: Extrair número do objeto (evita CastError)
                const ageValue = typeof ageExtracted === 'object' ? ageExtracted.age : ageExtracted;
                updateData["patientInfo.age"] = ageValue;  // ✅ Number puro
                updateData["qualificationData.idade"] = ageValue;
                updateData["qualificationData.idadeRange"] = ageValue <= 3 ? '0-3' :
                    ageValue <= 6 ? '4-6' :
                        ageValue <= 12 ? '7-12' : '13+';
                console.log("📝 [TRIAGEM] Greedy: idade extraída durante ask_period:", ageValue);
            }
            if (nameExtracted && !lead?.patientInfo?.fullName) {
                updateData["patientInfo.fullName"] = nameExtracted;
                console.log("📝 [TRIAGEM] Greedy: nome extraído durante ask_period:", nameExtracted);
            }

            if (Object.keys(updateData).length > 0) {
                await safeLeadUpdate(lead._id, { $set: updateData });
                lead = { ...lead, patientInfo: { ...lead.patientInfo, ...updateData } };
            }

            if (!period) {
                // ✅ FIX: Detecta saudação pura (ex: "Bom dia!") e responde adequadamente
                const isPureGreeting = PURE_GREETING_REGEX.test(text.trim());

                if (isPureGreeting) {
                    const wrapped = handleTriagemResponse(
                        "Olá! 😊 Tudo bem? Pra eu organizar certinho, vocês preferem **manhã ou tarde**?",
                        context
                    );
                    if (wrapped) return ensureSingleHeart(wrapped);
                    console.log("🔥 [BYPASS] saudação com force flag → IA");
                }

                const wrapped = handleTriagemResponse(
                    "Pra eu organizar certinho, vocês preferem **manhã ou tarde**?",
                    context
                );
                if (wrapped) return ensureSingleHeart(wrapped);
                console.log("🔥 [BYPASS] ask_period com force flag → IA");
            }

            await safeLeadUpdate(lead._id, {
                $set: {
                    pendingPreferredPeriod: normalizePeriod(period),
                    triageStep: "ask_name"  // ✅ Era ask_profile, agora ask_name
                }
            });

            const wrapped = handleTriagemResponse("Ótimo! 💚 Qual o **nome do paciente**?", context);
            if (wrapped) return ensureSingleHeart(wrapped);
            console.log("🔥 [BYPASS] período confirmado com force flag → IA");
        } // fecha else do bypass
    }

    // ============================================================
    // ▶️ STEP: ask_name (coleta nome)
    // ============================================================
    if (lead?.triageStep === "ask_name") {
        // 🛡️ ANTI-LOOP: Se já tem nome, não pergunta de novo
        if (lead.patientInfo?.fullName || lead.patientInfo?.name) {
            console.log("🛡️ [ANTI-LOOP] Tem nome mas triageStep=ask_name, corrigindo...");
            await safeLeadUpdate(lead._id, { $set: { triageStep: "ask_age" } });
            return ensureSingleHeart(
                "Obrigada! 💚 E qual a **idade** dele(a)? (anos ou meses)"
            );
        }

        const name = extractName(text);
        if (!name) {
            return ensureSingleHeart(
                "Pode me dizer, por favor, o **nome do paciente**? 😊"
            );
        }

        await safeLeadUpdate(lead._id, {
            $set: {
                "patientInfo.fullName": name,
                triageStep: "ask_age"  // ✅ Vai para ask_age, não ask_complaint
            }
        });

        return ensureSingleHeart(
            "Obrigada! 💚 E qual a **idade** dele(a)? (anos ou meses)"
        );
    }

    // ============================================================
    // ▶️ STEP: ask_age (coleta idade)
    // ============================================================
    if (lead?.triageStep === "ask_age") {
        // 🛡️ ANTI-LOOP: Se já tem idade, não pergunta de novo
        if (lead.patientInfo?.age !== undefined && lead.patientInfo?.age !== null) {
            console.log("🛡️ [ANTI-LOOP] Tem idade mas triageStep=ask_age, corrigindo...");
            await safeLeadUpdate(lead._id, { $set: { triageStep: "ask_complaint" } });
            return ensureSingleHeart(
                "Obrigada! 💚 Agora me conta: qual a principal preocupação/queixa? 💚"
            );
        }

        const age = extractAgeFromText(text);
        if (!age) {
            return ensureSingleHeart(
                "Me conta a **idade** dele(a), por favor 😊 (anos ou meses)"
            );
        }

        // ✅ FIX: Extrair número do objeto (evita CastError)
        const ageValue = typeof age === 'object' ? age.age : age;
        const ageUnit = typeof age === 'object' ? age.unit : 'anos';

        // ✅ FIX: Sincronizar patientInfo.age com qualificationData.idade
        const idadeRange = ageValue <= 3 ? '0-3' :
            ageValue <= 6 ? '4-6' :
                ageValue <= 12 ? '7-12' : '13+';

        await safeLeadUpdate(lead._id, {
            $set: {
                "patientInfo.age": ageValue,  // ✅ Number puro, não objeto
                "patientInfo.ageUnit": ageUnit,
                "qualificationData.idade": ageValue,
                "qualificationData.idadeRange": idadeRange,
                triageStep: "ask_complaint",  // ✅ Vai perguntar queixa agora
                stage: "triagem_agendamento"
            }
        });

        return ensureSingleHeart(
            "Obrigada! 💚 Agora me conta: qual a principal preocupação/queixa que vocês têm observado? 💚"
        );
    }

    // ============================================================
    // ▶️ STEP: ask_complaint (coleta queixa - NOVO STEP CORRETO!)
    // ============================================================
    if (lead?.triageStep === "ask_complaint") {
        // 🛡️ ANTI-LOOP: Se já tem queixa, verifica se tem TODOS os dados antes de oferecer slots
        if (lead.complaint || lead.primaryComplaint) {
            console.log("🛡️ [ANTI-LOOP] Tem queixa mas triageStep=ask_complaint, verificando dados completos...");
            
            // 🔴 CRITICAL FIX: Verificar se tem nome e data de nascimento antes de oferecer slots
            const hasName = !!(lead.patientInfo?.fullName || lead.patientInfo?.name);
            const hasBirthDate = !!(lead.patientInfo?.birthDate);
            
            if (!hasName || !hasBirthDate) {
                console.log("⚠️ [TRIAGEM] Faltam dados obrigatórios:", { 
                    hasName, 
                    hasBirthDate,
                    nome: lead.patientInfo?.fullName,
                    nascimento: lead.patientInfo?.birthDate 
                });
                
                // Ativa coleta de dados do paciente
                await safeLeadUpdate(lead._id, { 
                    $set: { 
                        triageStep: "done",
                        stage: "engajado",
                        pendingPatientInfoForScheduling: true,
                        pendingPatientInfoStep: hasName ? "birth" : "name"
                    } 
                });
                
                if (!hasName) {
                    return ensureSingleHeart("Perfeito! 💚 Pra eu confirmar o agendamento, qual o **nome completo** do paciente?");
                } else {
                    return ensureSingleHeart("Obrigado! 💚 Agora me manda a **data de nascimento** (dd/mm/aaaa)");
                }
            }
            
            // ✅ Tem todos os dados, pode oferecer slots
            await safeLeadUpdate(lead._id, {
                $set: { triageStep: "done", stage: "engajado" }
            });

            // Busca slots (🆕 REGRA 5: com filtro de pacotes/feriados)
            const slots = await findAvailableSlotsWithFilter({
                therapyArea: lead.therapyArea,
                patientAge: lead.patientInfo?.age,
                preferredPeriod: lead.pendingPreferredPeriod
            });

            if (slots && slots.all?.length > 0) {
                const { message: slotMenu } = buildSlotMenuMessage(slots);
                return ensureSingleHeart(slotMenu + "\n\nQual funciona melhor? 💚");
            } else {
                return ensureSingleHeart(
                    `Perfeito! Já tenho todas as informações 💚\n\n` +
                    `Vou verificar a melhor disponibilidade e retorno já já!`
                );
            }
        }

        let complaint = extractComplaint(text);

        // ✅ FIX: Se não extraiu padrão específico MAS o texto é descritivo (explicação longa),
        // aceita o próprio texto como queixa
        if (!complaint && text && text.length > 20 && !text.match(/^(sim|não|nao|ok|tá|ta|ok\s|bom|boa|oi|olá|ola|hey)$/i)) {
            // Verifica se parece uma descrição de sintoma/problema
            const pareceDescricao = /\b(eu|minha|meu|estou|tenho|sinto|está|doente|problema|dificuldade|dor|mal|não consigo|não consigo|fui ao|médico|otorrino)\b/i.test(text);
            if (pareceDescricao) {
                complaint = text.trim().substring(0, 200); // Limita a 200 chars
                console.log("📝 [TRIAGEM] Queixa extraída do texto livre:", complaint.substring(0, 50));
            }
        }

        // Se não extraiu queixa claramente, pergunta
        if (!complaint || complaint.length < 3) {
            const wrapped = handleTriagemResponse(
                "Me conta um pouquinho: o que você tem observado no dia a dia que te preocupou? 💚",
                context
            );
            if (wrapped) return ensureSingleHeart(wrapped);
            console.log("🔥 [BYPASS] ask_complaint sem queixa com force flag → IA");
        }

        // Salva queixa e finaliza triagem
        await safeLeadUpdate(lead._id, {
            $set: {
                complaint: complaint,
                triageStep: "done",
                stage: "engajado"
            }
        });

        return ensureSingleHeart(
            "Perfeito 😊 Já repassei essas informações pra nossa equipe.\n" +
            "Em breve entramos em contato com os **horários disponíveis** 💚"
        );
    }

    // dentro de getOptimizedAmandaResponse(), depois de detectar área terapêutica:
    if (
        (lead?.therapyArea === "psicologia" || flags?.therapyArea === "psicologia") &&
        (lead?.patientInfo?.age > 16 ||
            lead?.qualificationData?.extractedInfo?.idade > 16)
    ) {
        return ensureSingleHeart(
            "Atualmente atendemos **psicologia apenas infantil e adolescentes até 16 anos** 💚.\n" +
            "Mas temos outras áreas que podem ajudar, como **fonoaudiologia** ou **terapia ocupacional**. Quer que eu te explique mais?"
        );
    }

    // ===============================
    // 🔒 CONTEXTO SALVO NO LEAD
    // ===============================
    const savedIntent = lead?.qualificationData?.intent || null;
    const savedArea = lead?.therapyArea || null;
    const savedStage = lead?.stage || null;

    console.log("[CTX] intent:", savedIntent);
    console.log("[CTX] area:", savedArea);
    console.log("[CTX] stage:", savedStage);

    // ===============================
    // 💰 FLUXO COMERCIAL (NÃO RESETAR)
    // ===============================
    if (
        savedIntent === "informacao_preco" &&
        savedArea &&
        !flags.wantsSchedule
    ) {
        console.log("[FLOW] Comercial ativo (persistido)");

        // Busca preço dinâmico da área
        const pricingArea = getTherapyPricing(savedArea);
        let priceText;
        if (pricingArea) {
            if (pricingArea.incluiLaudo) {
                priceText = `A avaliação neuropsicológica é **${formatPrice(pricingArea.avaliacao)} (até 6x)**.`;
            } else {
                priceText = `A avaliação inicial de ${pricingArea.descricao.toLowerCase()} é **${formatPrice(pricingArea.avaliacao)}**.`;
            }
        } else {
            priceText = "A avaliação inicial é **R$ 200**.";
        }

        // ✅ FIX: Salvar estado — quando user confirmar com "Sim", saberemos que é sobre pacotes
        await safeLeadUpdate(lead._id, {
            $set: {
                awaitingResponseFor: {
                    type: 'package_detail',
                    area: savedArea,
                    timestamp: Date.now()
                }
            }
        }).catch(e => console.warn("[AWAITING] Erro ao salvar estado:", e.message));

        // ✅ FIX Bug #4: remover "sim" duplicado do template
        return ensureSingleHeart(
            `Perfeito! 😊\n\n${priceText}\n\n` +
            `Trabalhamos com **pacotes mensais** 💚 Quer que eu te explique as opções?`
        );
    }

    // ===============================
    // 🚫 NÃO PERGUNTAR O QUE JÁ SABEMOS
    // ===============================
    if (savedArea && flags.askTherapyArea) {
        console.log("[BLOCK] área já definida");
        flags.askTherapyArea = false;
    }

    if (savedIntent && flags.askIntent) {
        console.log("[BLOCK] intenção já definida");
        flags.askIntent = false;
    }

    // (Parceria/Currículo tratado pelo DecisionResolver + ResponseBuilder)

    // (Validações emocionais e respostas curtas tratadas pelo DecisionResolver)
    if (lead?._id) {
        const $set = {};
        if (flags.topic) $set.topic = flags.topic; // ou "qualificationData.topic"
        if (flags.teaStatus) $set["qualificationData.teaStatus"] = flags.teaStatus;

        if (Object.keys($set).length) {
            await safeLeadUpdate(lead._id, { $set });
        }
    }
    // (Desambiguação parceria/emprego tratada pelo DecisionResolver)

    const psychologicalCue = determinePsychologicalFollowup({
        toneMode: enrichedContext.toneMode,
        stage: lead.stage,
        flags,
    });

    if (psychologicalCue) {
        enrichedContext.customInstruction = [
            psychologicalCue,
            enrichedContext.customInstruction,
        ].filter(Boolean).join("\n\n");
    }


    const closureBlock = buildValueAnchoredClosure({
        toneMode: enrichedContext.toneMode,
        stage: lead.stage,
        urgencyLevel: enrichedContext.urgencyLevel,
        therapyArea: lead.therapyArea,
    });

    if (closureBlock) {
        enrichedContext.customInstruction = [
            enrichedContext.customInstruction,
            closureBlock
        ].filter(Boolean).join("\n\n");
    }


    // =========================================================================
    // 🧠 LEARNING INJECTION (Novo fluxo v2)
    // =========================================================================
    let learnings = null;
    try {
        const { getActiveLearnings } = await import("../services/LearningInjector.js");
        learnings = await getActiveLearnings();
        if (learnings) {
            console.log("🧠 [ORCHESTRATOR] Injetando insights de aprendizado no prompt");
        }
    } catch (err) {
        console.warn("⚠️ [ORCHESTRATOR] Falha ao injetar learnings:", err.message);
    }

    // ============================================================
    // 🔹 INTEGRAÇÃO DO TONE MODE (PREMIUM / ACOLHIMENTO)
    // ============================================================
    if (enrichedContext?.toneMode) {
        console.log("[AmandaAI] Aplicando toneMode →", enrichedContext.toneMode);

        // Injeta no systemPrompt dinâmico
        const toneInstruction = enrichedContext.toneMode === "premium"
            ? DYNAMIC_MODULES.consultoriaModeContext
            : DYNAMIC_MODULES.acolhimentoModeContext;

        if (toneInstruction) {
            enrichedContext.customInstruction = [
                toneInstruction,
                enrichedContext.customInstruction,
            ]
                .filter(Boolean)
                .join("\n\n");
        }
    }

    const historyLen = Array.isArray(enrichedContext.conversationHistory)
        ? enrichedContext.conversationHistory.length
        : enrichedContext.messageCount || 0;

    const msgCount = historyLen + 1;
    enrichedContext.messageCount = msgCount;

    // =========================================================================
    // 🧠 ANÁLISE INTELIGENTE DO LEAD (UMA VEZ SÓ) - MOVIDO PARA DEPOIS DE enrichedContext
    // =========================================================================
    let leadAnalysis = null;
    try {
        leadAnalysis = await analyzeLeadMessage({
            text,
            lead,
            history: enrichedContext.conversationHistory || [],
        });
        console.log("[INTELLIGENCE]", {
            score: leadAnalysis.score,
            segment: leadAnalysis.segment.label,
            intent: leadAnalysis.intent.primary,
            urgencia: leadAnalysis.extractedInfo?.urgencia,
            bloqueio: leadAnalysis.extractedInfo?.bloqueioDecisao,
        });
    } catch (err) {
        console.warn("[INTELLIGENCE] Falhou (não crítico):", err.message);
    }

    // Logo após a análise, se tiver dados novos:
    if (leadAnalysis && lead?._id) {
        const updateFields = {};
        const { extractedInfo: extracted, score, segment } = leadAnalysis;

        // Idade (se não tinha)
        if (extracted.idade && !lead.patientInfo?.age) {
            updateFields["patientInfo.age"] = extracted.idade;
            updateFields.ageGroup = extracted.idadeRange?.includes("adulto") ? "adulto"
                : extracted.idadeRange?.includes("adolescente") ? "adolescente"
                    : "crianca";
        }

        // Queixa (se não tinha)
        if (extracted.queixa && !lead.complaint) {
            updateFields.complaint = extracted.queixa;
            updateFields["patientInfo.complaint"] = extracted.queixaDetalhada?.join(", ");
        }

        // Especialidade → therapyArea
        if (extracted.especialidade && !lead.therapyArea) {
            const areaMap = {
                fonoaudiologia: "fonoaudiologia",
                psicologia: "psicologia",
                terapia_ocupacional: "terapia_ocupacional",
                neuropsicologia: "neuropsicologia",
                psicopedagogia: "neuropsicologia",
            };
            updateFields.therapyArea = areaMap[extracted.especialidade] || null;
        }

        // Disponibilidade → pendingPreferredPeriod
        if (extracted.disponibilidade && !lead.pendingPreferredPeriod) {
            updateFields.pendingPreferredPeriod = normalizePeriod(extracted.disponibilidade);
        }

        // Score e Segment (SEMPRE atualiza)
        updateFields.conversionScore = score;
        updateFields.segment = segment.label;
        updateFields.lastAnalyzedAt = new Date();

        // Urgência alta → flag
        if (extracted.urgencia === "alta") {
            updateFields.isUrgent = true;
        }

        // Salva
        if (Object.keys(updateFields).length > 0) {
            await safeLeadUpdate(lead._id, { $set: updateFields }).catch(err =>
                console.warn("[INTELLIGENCE] Erro ao salvar:", err.message)
            );
            console.log("[INTELLIGENCE] Lead atualizado:", Object.keys(updateFields));
        }
    }
    // Disponibiliza globalmente no contexto
    enrichedContext.leadAnalysis = leadAnalysis;

    // =========================================================================
    // 🆕 AJUSTE DE BLOQUEIO DE DECISÃO - MOVIDO PARA DEPOIS DE enrichedContext
    // =========================================================================
    if (leadAnalysis?.extracted?.bloqueioDecisao) {
        const bloqueio = leadAnalysis.extracted.bloqueioDecisao;

        // Se vai consultar família → não pressionar
        if (bloqueio === "consultar_terceiro") {
            enrichedContext.customInstruction =
                "O lead precisa consultar a família antes de decidir. " +
                "Seja compreensiva, ofereça informações úteis para ele levar, " +
                "e pergunte se pode entrar em contato amanhã para saber a decisão.";
        }

        // Se vai avaliar preço → reforçar valor
        if (bloqueio === "avaliar_preco") {
            enrichedContext.customInstruction =
                "O lead está avaliando o preço. Reforce o VALOR do serviço " +
                "(não o preço), mencione que a avaliação inicial já direciona " +
                "o tratamento, e que emitimos nota para reembolso.";
        }

        // Se vai ajustar rotina → oferecer flexibilidade
        if (bloqueio === "ajustar_rotina") {
            enrichedContext.customInstruction =
                "O lead precisa organizar a agenda. Mostre flexibilidade " +
                "de horários (manhã E tarde), mencione que dá para remarcar " +
                "com 24h de antecedência, e pergunte se prefere agendar " +
                "mais pro final do mês.";
        }
    }

    // =========================================================================
    // 🆕 PASSO 0: DETECTA ESCOLHA A/B/C QUANDO AMANDA JÁ OFERECEU SLOTS
    // =========================================================================
    const isSlotChoice = /^[A-F]$/i.test(text.trim()) || /\bop[çc][aã]o\s*([A-F])\b/i.test(text);
    const hasQualificationComplete = !!(
        getValidQualificationArea(lead) &&
        lead?.qualificationData?.extractedInfo?.idade &&
        lead?.qualificationData?.extractedInfo?.disponibilidade
    );

    // Se lead responde só "A" ou "a" e tem triagem completa mas sem slots salvos
    if (isSlotChoice && hasQualificationComplete && !lead?.pendingSchedulingSlots?.primary) {
        console.log("[PASSO 0] ✅ Detectou escolha de slot sem pendingSchedulingSlots - buscando slots...");

        const therapyArea = getValidQualificationArea(lead);
        const period = lead?.qualificationData?.extractedInfo?.disponibilidade;

        try {
            const slots = await findAvailableSlotsWithFilter({
                therapyArea,
                preferredPeriod: period,
                daysAhead: 30,
                maxOptions: 2,
            });

            if (slots?.primary) {
                // Processa a escolha
                const allSlots = [
                    slots.primary,
                    ...(slots.alternativesSamePeriod || []),
                    ...(slots.alternativesOtherPeriod || []),
                ].filter(Boolean);

                const letterMatch = text.trim().toUpperCase().match(/^([A-F])$/);
                const chosenLetter = letterMatch ? letterMatch[1] : null;
                const letterIndex = chosenLetter ? "ABCDEF".indexOf(chosenLetter) : -1;
                const chosenSlot = letterIndex >= 0 && letterIndex < allSlots.length ? allSlots[letterIndex] : null;

                if (chosenSlot) {
                    // Salva slot escolhido e ativa coleta de nome
                    console.log("💾 [PASSO 0] Salvando pendingPatientInfoForScheduling: true");

                    const updateResult = await safeLeadUpdate(lead._id, {
                        $set: {
                            pendingSchedulingSlots: slots,
                            pendingChosenSlot: chosenSlot,
                            pendingPatientInfoForScheduling: true,
                            pendingPatientInfoStep: "name",
                            therapyArea: therapyArea,
                            stage: "interessado_agendamento",
                            // ✅ FIX: Substitui objeto inteiro ao invés de campos dentro de null
                            autoBookingContext: {
                                active: true,
                                lastOfferedSlots: slots,
                                mappedTherapyArea: therapyArea,
                                lastSlotsShownAt: new Date(), // ← 🆕 timestamp para TTL
                            },
                        },
                    }, { new: true }).catch((err) => {
                        console.error("❌ [PASSO 0] Erro ao salvar:", err.message);
                        return null;
                    });

                    if (updateResult) {
                        console.log("✅ [PASSO 0] Salvo com sucesso:", {
                            pendingPatientInfoForScheduling: updateResult.pendingPatientInfoForScheduling,
                            pendingPatientInfoStep: updateResult.pendingPatientInfoStep,
                        });
                    }

                    // Atualiza contexto local para IA gerar resposta
                    enrichedContext.pendingSchedulingSlots = slots;
                    enrichedContext.pendingChosenSlot = chosenSlot;
                    enrichedContext.stage = "interessado_agendamento";

                    // 🤖 Deixa a IA gerar resposta acolhedora pedindo nome do paciente
                    const aiResponse = await callAmandaAIWithContext(
                        `O cliente escolheu a opção ${chosenLetter} (${formatSlot(chosenSlot)}).`,
                        lead,
                        {
                            ...enrichedContext,
                            customInstruction: ci(useModule("slotChosenAskName", formatSlot(chosenSlot))),
                        },
                        flags,
                        null
                    );
                    return ensureSingleHeart(aiResponse);
                } else {
                    // Não entendeu a escolha - salva slots e pede pra escolher
                    await safeLeadUpdate(lead._id, {
                        $set: {
                            pendingSchedulingSlots: slots,
                            therapyArea: therapyArea,
                            stage: "interessado_agendamento",
                            autoBookingContext: {
                                active: true,
                                lastOfferedSlots: slots,
                                mappedTherapyArea: therapyArea,
                                lastSlotsShownAt: new Date(), // ← 🆕 timestamp para TTL
                            },
                        }
                    });

                    enrichedContext.pendingSchedulingSlots = slots;
                    enrichedContext.stage = "interessado_agendamento";

                    // 🤖 Deixa a IA explicar as opções novamente
                    const aiResponse = await callAmandaAIWithContext(
                        `O cliente respondeu "${text}" mas não entendi qual opção ele quer.`,
                        lead,
                        {
                            ...enrichedContext,
                            customInstruction: ci(useModule("slotChoiceNotUnderstood"))
                        },
                        flags,
                        null
                    );
                    return ensureSingleHeart(aiResponse);
                }
            }
        } catch (err) {
            console.error("[PASSO 0] Erro ao buscar slots:", err.message);
        }
    }


    // 🔹 Captura a resposta ao período (quando Amanda perguntou "manhã ou tarde?")
    if (
        lead?._id &&
        !lead?.pendingSchedulingSlots?.primary
    ) {
        const preferredPeriod = extractPeriodFromText(text);

        if (preferredPeriod) {
            console.log("🎯 [ORCHESTRATOR] Usuário escolheu período:", preferredPeriod);

            // ✅ FIX: pega área do lead - PRIORIZA qualificationData.extractedInfo.especialidade
            const therapyArea =
                getValidQualificationArea(lead) ||  // ✅ PRIORIDADE!
                lead?.therapyArea ||

                flags?.therapyArea ||
                null;

            console.log("🎯 [ORCHESTRATOR] Área para buscar slots:", therapyArea);

            // se não tem área ainda, não dá pra buscar slots
            if (!therapyArea) {
                await safeLeadUpdate(lead._id, {
                    $set: { "autoBookingContext.awaitingPeriodChoice": false },
                });
                return ensureSingleHeart(
                    "Olá! 😊 Pra eu puxar os horários certinho: é pra qual área (Fono, Psicologia, TO, Fisio ou Neuropsico)?"
                );
            }


            // ✅ FIX: Sincroniza therapyArea se qualificationData tem área diferente
            const qualificationArea = getValidQualificationArea(lead);
            if (qualificationArea && lead?.therapyArea !== qualificationArea) {
                await safeLeadUpdate(lead._id, {
                    $set: { therapyArea: qualificationArea }
                }).catch(err => logSuppressedError('safeLeadUpdate', err));
            }
            // desarma “aguardando período” e salva o período real
            await safeLeadUpdate(lead._id, {
                $set: {
                    "autoBookingContext.awaitingPeriodChoice": false,
                    pendingPreferredPeriod: preferredPeriod,  // ✅ FIX: fonte única
                },
            }).catch(err => logSuppressedError('safeLeadUpdate', err));

            try {
                const slots = await findAvailableSlotsWithFilter({
                    therapyArea,
                    preferredPeriod,
                    daysAhead: 30,
                    maxOptions: 2,
                });

                // se achou slots, salva no lead pra ativar o PASSO 2
                if (slots?.primary) {
                    await safeLeadUpdate(lead._id, {
                        $set: {
                            pendingSchedulingSlots: slots,
                            stage: "interessado_agendamento",
                            "autoBookingContext.lastSlotsShownAt": new Date(), // ← 🆕 timestamp para TTL
                        },
                    }).catch(err => logSuppressedError('safeLeadUpdate', err));

                    const { message } = buildSlotMenuMessage(slots);
                    return ensureSingleHeart(message);
                }

                return ensureSingleHeart(
                    `Pra **${preferredPeriod === "manhã" ? "manhã" : preferredPeriod === "tarde" ? "tarde" : "noite"}** não encontrei vaga agora 😕 Quer me dizer qual dia da semana fica melhor?`
                );
            } catch (err) {
                console.error("[ORCHESTRATOR] Erro ao buscar slots do período:", err.message);
                return ensureSingleHeart(
                    "Vamos ver os horários disponíveis. Você prefere **manhã** ou **tarde**? 💚"
                );
            }
        }
    }

    // =========================================================================
    // 🆕 PASSO 2: PROCESSAMENTO DE ESCOLHA DE SLOT (QUANDO JÁ TEM SLOTS PENDENTES)
    // =========================================================================
    // ⚠️ IMPORTANTE: Se já está coletando dados do paciente, NÃO processar aqui
    if (lead?.pendingPatientInfoForScheduling) {
        console.log("⏭️ [PASSO 2] Pulando - já está coletando dados do paciente");
        // Deixa o fluxo continuar para o PASSO 1 processar
    } else if (
        lead?._id &&
        (lead?.pendingSchedulingSlots?.primary || enrichedContext?.pendingSchedulingSlots?.primary)
    ) {
        const rawSlots =
            lead?.pendingSchedulingSlots ||
            enrichedContext?.pendingSchedulingSlots ||
            null;


        const safeRawSlots = rawSlots && typeof rawSlots === "object" ? rawSlots : {};
        const slotsCtx = {
            ...safeRawSlots,
            all: [
                safeRawSlots.primary,
                ...(safeRawSlots.alternativesSamePeriod || []),
                ...(safeRawSlots.alternativesOtherPeriod || []),
            ].filter(Boolean),
        };

        const onlyOne = slotsCtx.all.length === 1 ? slotsCtx.all[0] : null;
        const isYes = /\b(sim|confirmo|pode|ok|pode\s+ser|fechado|beleza)\b/i.test(text);
        const isNo = /\b(n[aã]o|nao|prefiro\s+outro|outro\s+hor[aá]rio)\b/i.test(text);

        // 🆕 Usuário pediu outro período?
        const wantsDifferentPeriod = extractPeriodFromText(text);
        const currentPeriod = lead?.autoBookingContext?.preferredPeriod || null;

        if (wantsDifferentPeriod && wantsDifferentPeriod !== currentPeriod) {
            console.log(`🔄 [ORCHESTRATOR] Usuário quer período diferente: ${wantsDifferentPeriod}`);

            const therapyArea = lead?.therapyArea;

            try {
                const newSlots = await findAvailableSlots({
                    therapyArea,
                    preferredPeriod: wantsDifferentPeriod,
                    daysAhead: 30,
                    maxOptions: 2,
                });

                if (newSlots?.primary) {
                    await safeLeadUpdate(lead._id, {
                        $set: {
                            pendingSchedulingSlots: newSlots,
                            pendingPreferredPeriod: wantsDifferentPeriod,
                            pendingChosenSlot: null
                        }
                    }).catch(err => logSuppressedError('safeLeadUpdate', err));

                    const { optionsText, letters } = buildSlotMenuMessage(newSlots);
                    const periodLabel = wantsDifferentPeriod === "manhã" ? "manhã" : wantsDifferentPeriod === "tarde" ? "tarde" : "noite";
                    return ensureSingleHeart(`Perfeito! Pra **${periodLabel}**, tenho essas opções:\n\n${optionsText}\n\nQual você prefere? (${letters.join(" ou ")})`);
                } else {
                    const periodLabel = wantsDifferentPeriod === "manhã" ? "manhã" : wantsDifferentPeriod === "tarde" ? "tarde" : "noite";
                    const { optionsText, letters } = buildSlotMenuMessage(rawSlots);
                    return ensureSingleHeart(`Pra **${periodLabel}** não encontrei vaga agora 😕 Tenho essas outras opções:\n\n${optionsText}\n\nAlguma serve pra você?`);
                }
            } catch (err) {
                console.error("[ORCHESTRATOR] Erro ao buscar novos slots:", err.message);
            }
        }

        if (onlyOne && isYes) {
            await safeLeadUpdate(lead._id, {
                $set: { pendingChosenSlot: onlyOne, pendingPatientInfoForScheduling: true, pendingPatientInfoStep: "name" },
            }).catch(err => logSuppressedError('safeLeadUpdate', err));
            return ensureSingleHeart("Perfeito! Pra eu confirmar, me manda o **nome completo** do paciente");
        }

        if (onlyOne && isNo) {
            return ensureSingleHeart("Sem problema! Você prefere **manhã ou tarde**?");
        }

        // ✅ NOVO: Lead não quer nenhuma das opções oferecidas
        const wantsOtherOptions = /\b(nenhum(a)?|outr[oa]s?\s+(hor[aá]rio|op[çc][aã]o)|n[aã]o\s+gostei|n[aã]o\s+serve|n[aã]o\s+d[aá]|diferente)\b/i.test(text);

        if (isNo || wantsOtherOptions) {
            console.log("[PASSO 2] 🔄 Lead quer outras opções...");

            const therapyArea = lead?.therapyArea;
            const currentPeriod = lead?.autoBookingContext?.preferredPeriod || lead?.pendingPreferredPeriod;

            try {
                // Busca com maxOptions=6 para dar mais alternativas
                const moreSlots = await findAvailableSlots({
                    therapyArea,
                    preferredPeriod: currentPeriod,
                    daysAhead: 30,
                    maxOptions: 6,  // ✅ Mais opções quando pede "outro"
                });

                if (moreSlots?.primary) {
                    // Filtra os que já foram oferecidos
                    const previouslyOffered = slotsCtx.all.map(s => `${s.date}-${s.time}`);
                    const newOptions = [
                        moreSlots.primary,
                        ...(moreSlots.alternativesSamePeriod || []),
                        ...(moreSlots.alternativesOtherPeriod || []),
                    ].filter(s => !previouslyOffered.includes(`${s.date}-${s.time}`)).slice(0, 4);

                    if (newOptions.length > 0) {
                        const newSlotsCtx = {
                            primary: newOptions[0],
                            alternativesSamePeriod: newOptions.slice(1, 3),
                            alternativesOtherPeriod: newOptions.slice(3),
                            all: newOptions,
                            maxOptions: newOptions.length,
                        };

                        await safeLeadUpdate(lead._id, {
                            $set: {
                                pendingSchedulingSlots: newSlotsCtx,
                                pendingChosenSlot: null,
                                "autoBookingContext.lastSlotsShownAt": new Date(), // ← 🆕 timestamp para TTL
                            }
                        }).catch(err => logSuppressedError('safeLeadUpdate', err));

                        const { optionsText, letters } = buildSlotMenuMessage(newSlotsCtx);
                        return ensureSingleHeart(`Sem problema! Tenho mais essas opções:\n\n${optionsText}\n\nQual você prefere? (${letters.join(", ")})`);
                    }
                }

                // Não tem mais opções disponíveis
                return ensureSingleHeart("No momento são só essas opções que tenho 😕 Você prefere mudar de **período** (manhã/tarde) ou **dia da semana**?");
            } catch (err) {
                console.error("[PASSO 2] Erro ao buscar mais slots:", err.message);
                return ensureSingleHeart("Deixa eu verificar os horários. Você prefere de **manhã ou tarde**? 💚");
            }
        }

        const cleanedReply = String(text || "").trim();

        // só vale se for "A" sozinho (com pontuação opcional) OU "opção A"
        const letterOnly = cleanedReply.match(
            /^([A-F])(?:[).,;!?])?(?:\s+(?:por\s+favor|pf|por\s+gentileza))?$/i
        );
        const optionLetter = cleanedReply.match(/\bop[çc][aã]o\s*([A-F])\b/i);

        // evita cair em "A partir ..." (mas mantém "opção A" funcionando)
        const startsWithAPartir = /^\s*a\s+partir\b/i.test(cleanedReply);

        const hasLetterChoice =
            Boolean(letterOnly || optionLetter) && !(startsWithAPartir && !optionLetter);


        const looksLikeChoice =
            hasLetterChoice ||
            /\b(\d{1,2}:\d{2})\b/.test(text) ||
            /\b(segunda|ter[çc]a|quarta|quinta|sexta|s[aá]bado|domingo)\b/i.test(text) ||
            /\b(manh[ãa]|cedo|tarde|noite)\b/i.test(text);

        const { message: menuMsg, optionsText } = buildSlotMenuMessage(slotsCtx);

        const preferredDateStr = extractPreferredDateFromText(text);
        const wantsFromDate = preferredDateStr && (
            /\b(a\s+partir|depois|ap[oó]s)\b/i.test(text) ||
            // Se o usuário mandou SÓ a data ou "dia DD/MM", assumimos que quer ESSA data ou a partir dela
            /^(dia\s+)?\d{1,2}[\/\-]\d{1,2}(\d{2,4})?$/i.test(text.trim()) ||
            /\b(dia\s+)(\d{1,2}[\/\-]\d{1,2})\b/i.test(text)
        );

        if (wantsFromDate) {
            const therapyArea = lead?.therapyArea;
            const currentPeriod = lead?.autoBookingContext?.preferredPeriod || lead?.pendingPreferredPeriod || null;

            try {
                // Busca slots a partir da data pedida (preferredDate faz searchStart = data pedida)
                const pool = await findAvailableSlots({
                    therapyArea,
                    preferredDate: preferredDateStr,
                    preferredPeriod: currentPeriod,
                    daysAhead: 60,
                    maxOptions: 5,
                });

                if (pool?.primary) {
                    const all = [
                        pool.primary,
                        ...(pool.alternativesSamePeriod || []),
                        ...(pool.alternativesOtherPeriod || []),
                    ].filter(Boolean);

                    const newSlotsCtx = {
                        primary: all[0],
                        alternativesSamePeriod: all.slice(1, 3),
                        alternativesOtherPeriod: all.slice(3, 5),
                        all: all.slice(0, 5),
                        maxOptions: Math.min(all.length, 5),
                    };

                    await safeLeadUpdate(lead._id, {
                        $set: {
                            pendingSchedulingSlots: newSlotsCtx,
                            pendingChosenSlot: null,
                            "autoBookingContext.lastSlotsShownAt": new Date(),
                        }
                    }).catch(err => logSuppressedError("safeLeadUpdate", err));

                    const { optionsText, letters } = buildSlotMenuMessage(newSlotsCtx);
                    const allowed = letters.slice(0, newSlotsCtx.all.length).join(" ou ");

                    // Se o primeiro slot é exatamente na data pedida ou após
                    const isExactDate = all[0]?.date === preferredDateStr;
                    const label = isExactDate
                        ? `No dia **${formatDatePtBr(preferredDateStr)}**, tenho:`
                        : `Não tenho vaga no dia **${formatDatePtBr(preferredDateStr)}**, mas o próximo disponível é:`;

                    return ensureSingleHeart(
                        `${label}\n\n${optionsText}\n\nQual você prefere? (${allowed}) 💚`
                    );
                }

                // Nenhum slot em 60 dias — fallback sem filtro de data
                const anySlot = await findAvailableSlots({
                    therapyArea,
                    preferredPeriod: null,
                    daysAhead: 30,
                    maxOptions: 2,
                });
                if (anySlot?.primary) {
                    const { optionsText, letters } = buildSlotMenuMessage(anySlot);
                    await safeLeadUpdate(lead._id, { $set: { pendingSchedulingSlots: anySlot } })
                        .catch(err => logSuppressedError("safeLeadUpdate", err));
                    return ensureSingleHeart(
                        `A partir de **${formatDatePtBr(preferredDateStr)}** não encontrei vaga 😕 As próximas disponíveis são:\n\n${optionsText}\n\nQual você prefere? (${letters.join(" ou ")}) 💚`
                    );
                }

                return ensureSingleHeart(
                    `Não encontrei vagas disponíveis no momento 😕 Posso avisar assim que abrir um horário. Qual período você prefere — **manhã ou tarde**? 💚`
                );
            } catch (err) {
                console.error("[PASSO 2] Erro ao aplicar filtro por data:", err.message);
            }
        }

        // =========================================================================
        // 🔥 HANDLER MODULAR: Usuário quer mais opções / alternativas
        // Detecta: "mais cedo", "outro horário", "nenhuma serve", etc.
        // =========================================================================
        const isAskingForAlternatives = flags.wantsMoreOptions ||
            /\b(mais\s+cedo|mais\s+tarde|outro\s+hor[áa]rio|outra\s+op[çc][aã]o|nenhuma\s+serve|tem\s+outro|tem\s+mais)\b/i.test(normalized);

        if (isAskingForAlternatives && slotsCtx?.all?.length > 0) {
            console.log("[ALTERNATIVES] Usuário pediu alternativas. Buscando slots em outro período...");

            const requestedPeriod = extractPeriodFromText(text);
            const currentPeriod = lead?.autoBookingContext?.preferredPeriod ||
                (slotsCtx.primary ? getTimePeriod(slotsCtx.primary.time) : null);

            // Se pediu período específico diferente do atual, busca nesse período
            const targetPeriod = requestedPeriod && requestedPeriod !== currentPeriod ? requestedPeriod : null;

            if (targetPeriod || !requestedPeriod) {
                try {
                    const therapyArea = lead?.therapyArea ||
                        lead?.autoBookingContext?.mappedTherapyArea ||
                        lead?.autoBookingContext?.therapyArea;

                    if (therapyArea) {
                        const alternativeSlots = await findAvailableSlots({
                            therapyArea,
                            preferredPeriod: targetPeriod || (currentPeriod === "manhã" ? "tarde" : "manhã"),
                            daysAhead: 30,
                            maxOptions: 3,
                        });

                        if (alternativeSlots?.primary) {
                            // Salva novos slots
                            await safeLeadUpdate(lead._id, {
                                $set: {
                                    pendingSchedulingSlots: alternativeSlots,
                                    pendingChosenSlot: null,
                                    "autoBookingContext.preferredPeriod": targetPeriod || (currentPeriod === "manhã" ? "tarde" : "manhã"),
                                    "autoBookingContext.lastSlotsShownAt": new Date(), // ← 🆕 timestamp para TTL
                                }
                            }).catch(err => logSuppressedError("safeLeadUpdate", err));

                            const { optionsText, letters } = buildSlotMenuMessage(alternativeSlots);
                            const periodLabel = targetPeriod === "manhã" ? "de manhã" : targetPeriod === "tarde" ? "à tarde" : "em outros horários";

                            return ensureSingleHeart(
                                `Claro! Encontrei essas opções ${periodLabel}:\n\n${optionsText}\n\nQual você prefere? (${letters.join(" ou ")}) 💚`
                            );
                        } else {
                            return ensureSingleHeart(
                                `Não encontrei vagas ${targetPeriod === "manhã" ? "de manhã" : targetPeriod === "tarde" ? "à tarde" : "nesses critérios"} 😕\n\nPosso verificar outro período ou dia da semana pra você?`
                            );
                        }
                    }
                } catch (err) {
                    console.error("[ALTERNATIVES] Erro ao buscar alternativas:", err.message);
                }
            }
        }

        if (!looksLikeChoice) {
            // 🆕 FIX CRÍTICO: Revalida slots antes de mostrar (previne overbooking)
            const SLOT_TTL_MS = 20 * 60 * 1000; // 20 minutos
            const lastShown = lead?.autoBookingContext?.lastSlotsShownAt ?? lead?.updatedAt;
            const slotsAreStale = !lastShown || (Date.now() - new Date(lastShown).getTime() > SLOT_TTL_MS);

            if (slotsAreStale) {
                console.log(`⏰ [PASSO 2] Slots stale (lastShown: ${lastShown || 'nunca'}) — revalidando em tempo real...`);
                try {
                    const therapyArea = lead?.therapyArea || lead?.autoBookingContext?.mappedTherapyArea;
                    const preferredPeriod = lead?.pendingPreferredPeriod || lead?.autoBookingContext?.preferredPeriod;

                    if (therapyArea) {
                        const freshSlots = await findAvailableSlots({
                            therapyArea,
                            preferredPeriod,
                            daysAhead: 30,
                            maxOptions: 3
                        });

                        if (freshSlots?.primary) {
                            // Atualiza slots e timestamp
                            await safeLeadUpdate(lead._id, {
                                $set: {
                                    pendingSchedulingSlots: freshSlots,
                                    "autoBookingContext.lastSlotsShownAt": new Date(),
                                }
                            }).catch(err => logSuppressedError('refreshSlots', err));

                            const { message: freshMsg } = buildSlotMenuMessage(freshSlots);
                            console.log("✅ [PASSO 2] Slots revalidados e atualizados");
                            return ensureSingleHeart(freshMsg);
                        } else {
                            console.warn("⚠️ [PASSO 2] Revalidação retornou vazio — mantendo slots antigos como fallback");
                        }
                    }
                } catch (err) {
                    console.error("[PASSO 2] Erro ao revalidar slots:", err.message);
                    // 🛡️ FALLBACK SEGURO: mostra slots antigos se revalidação falhar
                }
            }

            return ensureSingleHeart(menuMsg);
        }

        let chosen = pickSlotFromUserReply(text, slotsCtx, { strict: true });

        if (!chosen) {
            const preferPeriod = extractPeriodFromText(text);

            const slotHour = (s) => {
                const h = parseInt(String(s?.time || "").slice(0, 2), 10);
                return Number.isFinite(h) ? h : null;
            };

            const matchesPeriod = (s, p) => {
                const h = slotHour(s);
                if (h === null) return false;
                if (p === "manhã") return h < 12;
                if (p === "tarde") return h >= 12 && h < 18;
                if (p === "noite") return h >= 18;
                return true;
            };

            const sortKey = (s) => `${s.date}T${String(s.time).slice(0, 5)}`;
            const earliest = slotsCtx.all
                .slice()
                .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))[0];

            if (preferPeriod && earliest) {
                const hasPreferred = slotsCtx.all.some((s) => matchesPeriod(s, preferPeriod));
                if (!hasPreferred) {
                    // ===============================
                    // PATCH 3 - NÃO CHUTAR HORÁRIO
                    // ===============================
                    if (
                        !/^[A-Fa-f]$/.test(normalized.trim()) &&
                        !/\b\d{1,2}:\d{2}\b/.test(text) &&
                        !/\b(segunda|ter[çc]a|quarta|quinta|sexta|s[aá]bado|domingo)\b/i.test(text)
                    ) {
                        console.log("🛡️ [PATCH 3] Bloqueando chute de horário");

                        return ensureSingleHeart(
                            "Me diz certinho qual opção você prefere 😊\n" +
                            "Pode responder com **A, B, C...**"
                        );
                    }


                    // 🛡️ GUARD PREMIUM — só ativa coleta operacional se houve escolha por LETRA
                    const choseByLetter = /^[A-Fa-f]$/.test(normalized.trim());

                    if (!choseByLetter) {
                        console.log("🛡️ [GUARD] Usuário não escolheu por letra, bloqueando ativação precoce");

                        return ensureSingleHeart(
                            "Perfeito 💚 Vou te mostrar as opções certinhas pra você escolher, tá bom?"
                        );
                    }

                    await safeLeadUpdate(lead._id, {
                        $set: { pendingChosenSlot: earliest, pendingPatientInfoForScheduling: true, pendingPatientInfoStep: "name" },
                    }).catch(err => logSuppressedError('safeLeadUpdate', err));

                    const prefLabel =
                        preferPeriod === "manhã" ? "de manhã" : preferPeriod === "tarde" ? "à tarde" : "à noite";

                    return ensureSingleHeart(`Entendi que você prefere ${prefLabel}. Hoje não tenho vaga ${prefLabel}; o mais cedo disponível é **${formatSlot(earliest)}**.\n\nPra eu confirmar, me manda o **nome completo** do paciente`);
                }
            }

            return ensureSingleHeart(`Não consegui identificar qual você escolheu 😅\n\n${optionsText}\n\nResponda A-F ou escreva o dia e a hora`);
        }

        // 🛡️ VALIDAÇÃO CRÍTICA: Verifica se o slot ainda está disponível antes de confirmar
        console.log("🔍 [PASSO 2] Validando disponibilidade do slot escolhido:", chosen);
        const validation = await validateSlotStillAvailable(chosen, {
            therapyArea: lead?.therapyArea,
            preferredPeriod: lead?.pendingPreferredPeriod,
        });

        if (!validation.isValid) {
            console.log("⚠️ [PASSO 2] Slot não está mais disponível:", validation.reason);

            // Se tem slots frescos, mostra novas opções
            if (validation.freshSlots?.primary) {
                await safeLeadUpdate(lead._id, {
                    $set: {
                        pendingSchedulingSlots: validation.freshSlots,
                        pendingChosenSlot: null,
                    },
                }).catch(err => logSuppressedError('safeLeadUpdate', err));

                const { optionsText: freshOptions, letters } = buildSlotMenuMessage(validation.freshSlots);
                return ensureSingleHeart(
                    `Essa vaga acabou de ser preenchida 😕\n\n` +
                    `Mas encontrei novas opções:\n\n${freshOptions}\n\n` +
                    `Qual você prefere? (${letters.join(", ")}) 💚`
                );
            }

            // Se não tem slots frescos, pede para tentar outro período
            return ensureSingleHeart(
                `Essa vaga acabou de ser preenchida 😕\n\n` +
                `Pode me dizer se prefere **manhã, tarde ou noite**? Assim busco outras opções pra você 💚`
            );
        }

        console.log("✅ [PASSO 2] Slot validado, prosseguindo com coleta de dados");

        await safeLeadUpdate(lead._id, {
            $set: { pendingChosenSlot: chosen, pendingPatientInfoForScheduling: true, pendingPatientInfoStep: "name" },
        }).catch(err => logSuppressedError('safeLeadUpdate', err));

        return ensureSingleHeart("Perfeito! Pra eu confirmar esse horário, me manda o **nome completo** do paciente");
    }

    // 🔎 Data explícita no texto
    const parsedDateStr = extractPreferredDateFromText(text);
    if (parsedDateStr) flags.preferredDate = parsedDateStr;

    const bookingProduct = mapFlagsToBookingProduct({ ...flags, text }, lead);

    if (!flags.therapyArea && bookingProduct?.therapyArea) {
        flags.therapyArea = bookingProduct.therapyArea;
    }

    // 🧠 RECUPERAÇÃO DE CONTEXTO: Se mensagem atual é genérica (só "agendar", "avaliação")
    // mas temos conversationSummary, tenta inferir terapia do histórico
    const isGenericMessage =
        /\b(agendar|marcar|avalia[cç][aã]o|consulta|atendimento)\b/i.test(text) &&
        !flags.therapyArea &&
        !bookingProduct?.therapyArea;

    if (isGenericMessage && enrichedContext?.conversationSummary && !flags.therapyArea) {
        console.log("🧠 [CONTEXT RECOVERY] Mensagem genérica detectada, tentando recuperar terapia do resumo...");

        const summary = enrichedContext.conversationSummary.toLowerCase();

        // Mapeia terapias mencionadas no resumo
        const therapyFromSummary =
            /terapia ocupacional|terapeuta ocupacional|\bto\b|ocupacional|integração sensorial|sensorial|coordenação motora|motricidade|avd|pinça|lateralidade|canhoto|reflexos/i.test(summary) ? "terapia_ocupacional" :
                /fonoaudiologia|\bfono\b|linguagem|fala|voz|deglutição|miofuncional|linguinha|freio|frenulo|gagueira|tartamudez|fluência|engasgar|amamentação|succao|sucção/i.test(summary) ? "fonoaudiologia" :
                    /psicologia(?!.*pedagogia)|\bpsic[oó]logo|comportamento|ansiedade|depressão|birra|agressivo|não dorme|medo|fobia|enurese|encoprese|toc|ritual/i.test(summary) ? "psicologia" :
                        /neuropsicologia|neuropsi|avaliação neuropsicológica|laudo|teste de qi|funções executivas|memória|superdotação|tea|autismo|espectro autista/i.test(summary) ? "neuropsicologia" :
                            /fisioterapia|\bfisio\b|atraso motor|não engatinhou|não andou|andar na ponta|pé torto|torticolo|prematuro|hipotonia|hipertonia|espasticidade|equilíbrio/i.test(summary) ? "fisioterapia" :
                                /musicoterapia|música|musical|ritmo|estimulação musical/i.test(summary) ? "musicoterapia" :
                                    /psicopedagogia|reforço escolar|dificuldade escolar|alfabetização|dislexia|discalculia/i.test(summary) ? "psicopedagogia" :
                                        null;

        if (therapyFromSummary) {
            console.log(`🧠 [CONTEXT RECOVERY] Terapia recuperada do resumo: ${therapyFromSummary}`);
            flags.therapyArea = therapyFromSummary;

            // Também salva no lead para persistir
            if (lead?._id && !lead.therapyArea) {
                await safeLeadUpdate(lead._id, {
                    $set: { therapyArea: therapyFromSummary }
                }).catch(() => { });
                lead.therapyArea = therapyFromSummary;
            }
        }
    }

    // 🔧 Garante que therapyArea seja string (pode vir como objeto de detectAllTherapies)
    const normalizeTherapyArea = (area) => {
        if (!area) return null;
        if (typeof area === 'string') return area;
        if (typeof area === 'object' && area.id) {
            // Mapeia ID do therapyDetector para nome da área no banco
            const areaMap = {
                "neuropsychological": "neuropsicologia",
                "speech": "fonoaudiologia",
                "tongue_tie": "fonoaudiologia",
                "psychology": "psicologia",
                "occupational": "terapia_ocupacional",
                "physiotherapy": "fisioterapia",
                "music": "musicoterapia",
                "neuropsychopedagogy": "neuropsicologia",
                "psychopedagogy": "neuropsicologia",
            };
            return areaMap[area.id] || area.name || null;
        }
        return null;
    };

    const resolvedTherapyArea =
        normalizeTherapyArea(flags.therapyArea) || normalizeTherapyArea(lead?.therapyArea) || null;

    // -------------------------------------------------------------------
    // 🔄 Sincronização de áreas (clínica vs. agenda)
    // -------------------------------------------------------------------
    if (resolvedTherapyArea) {
        // Define no contexto o que a IA vai usar pra conversa
        enrichedContext.therapyArea = resolvedTherapyArea;

        if (lead?._id) {
            // 1️⃣ Área de agenda (usada pra slots)
            Leads.findByIdAndUpdate(
                lead._id,
                {
                    $set: {
                        "autoBookingContext.therapyArea": resolvedTherapyArea,
                        "autoBookingContext.active": true,
                    },
                },
            ).catch(() => { });

            // 2️⃣ Área clínica (só grava se vier de fonte explícita)
            const canPersistClinical =
                bookingProduct?._explicitArea === true ||
                Boolean(getValidQualificationArea(lead));

            if (canPersistClinical && lead?.therapyArea !== resolvedTherapyArea) {
                Leads.findByIdAndUpdate(
                    lead._id,
                    { $set: { therapyArea: resolvedTherapyArea } },
                ).catch(() => { });
            }
        }
    }

    const stageFromContext = enrichedContext.stage || lead?.stage || "novo";

    const isPurePriceQuestion =
        flags.asksPrice &&
        !flags.mentionsPriceObjection &&
        !flags.wantsSchedule;

    if (isPurePriceQuestion) {
        // 0) tenta detectar terapias pela mensagem atual
        let detectedTherapies = [];
        try {
            detectedTherapies = detectAllTherapies(text) || [];
        } catch (_) {
            detectedTherapies = [];
        }

        // 1) se não detectou nada na mensagem, tenta pelo histórico/resumo/queixas salvas
        if (!detectedTherapies.length) {
            detectedTherapies = inferTherapiesFromHistory(enrichedContext, lead) || [];
        }

        // 2) tenta montar preço usando o detector (fonte mais confiável quando existe)
        let priceText = "";
        if (detectedTherapies.length) {
            const priceLines = safeGetPriceLinesForDetectedTherapies(detectedTherapies);
            priceText = (priceLines || []).join(" ").trim();
        }

        // 3) fallback por área conhecida (lead/context), mas SEM pegar qualificationData “solto”
        // (usa getValidQualificationArea que você já fez pra não pegar área errada quando não tem queixa)
        const knownArea =
            lead?.therapyArea ||

            getValidQualificationArea(lead) ||
            flags?.therapyArea ||
            enrichedContext?.therapyArea ||
            null;

        // 3) fallback por área conhecida - usando pricing.js
        if (!priceText && knownArea) {
            const pricingKnown = getTherapyPricing(knownArea);
            if (pricingKnown) {
                if (pricingKnown.incluiLaudo) {
                    priceText = `A avaliação neuropsicológica completa (pacote) é **${formatPrice(pricingKnown.avaliacao)} (até 6x)**.`;
                } else {
                    priceText = `A avaliação inicial de ${pricingKnown.descricao.toLowerCase()} é **${formatPrice(pricingKnown.avaliacao)}**.`;
                }
            }
        }

        // 4) fallback por ID de terapia detectada (quando detectAllTherapies achou algo mas priceLines veio vazio)
        // Mapeia therapy IDs para chaves do pricing
        const THERAPY_ID_MAP = {
            speech: 'fonoaudiologia',
            tongue_tie: 'fonoaudiologia',
            psychology: 'psicologia',
            occupational: 'terapia_ocupacional',
            physiotherapy: 'fisioterapia',
            music: 'musicoterapia',
            psychopedagogy: 'psicopedagogia',
            neuropsychological: 'neuropsicologia',
            neuropsychopedagogy: 'fonoaudiologia',
        };

        if (!priceText && detectedTherapies.length) {
            const t0 = detectedTherapies[0]?.id;
            const pricingKey = THERAPY_ID_MAP[t0];
            if (pricingKey) {
                const pricingDetected = getTherapyPricing(pricingKey);
                if (pricingDetected) {
                    if (t0 === 'tongue_tie') {
                        priceText = `O **Teste da Linguinha** (avaliação do frênulo lingual) custa **${formatPrice(pricingDetected.avaliacao)}**.`;
                    } else if (pricingDetected.incluiLaudo) {
                        priceText = `A avaliação neuropsicológica completa (pacote) é **${formatPrice(pricingDetected.avaliacao)} (até 6x)**.`;
                    } else {
                        priceText = `A avaliação inicial de ${pricingDetected.descricao.toLowerCase()} é **${formatPrice(pricingDetected.avaliacao)}**.`;
                    }
                }
            }
        }

        // 5) fallback final (nunca devolve vazio)
        if (!priceText) {
            priceText =
                "A avaliação inicial é **R$ 200**. Se você me disser se é pra **Fono**, **Psicologia**, **TO**, **Fisio** ou **Neuropsico**, eu te passo o certinho 💚";
            return ensureSingleHeart(priceText);
        }

        const urgency = safeCalculateUrgency(flags, text);
        const urgencyPitch =
            (urgency && urgency.pitch && String(urgency.pitch).trim()) ||
            "Entendi! Vou te passar certinho 😊";

        return ensureSingleHeart(
            `${urgencyPitch} ${priceText} Se você quiser, eu posso ver horários pra você quando fizer sentido 💚`
        );
    }

    logBookingGate(flags, bookingProduct);

    // 🧠 Análise inteligente
    let analysis = null;
    try {
        analysis = await analyzeLeadMessage({
            text,
            lead,
            history: enrichedContext.conversationHistory || [],
        });
    } catch (err) {
        console.warn("[ORCHESTRATOR] leadIntelligence falhou no orquestrador:", err.message);
    }

    const wantsPlan = /\b(unimed|plano|conv[eê]nio|ipasgo|amil|bradesco)\b/i.test(text);

    const isHardPlanCondition =
        /\b(s[oó]\s*se|apenas\s*se|somente\s*se|quero\s+continuar\s+se)\b.*\b(unimed|plano|conv[eê]nio|ipasgo|amil|bradesco)\b/i.test(text);


    // 🔍 [LEGACY] REMOVIDO: Bloco manual de planos que retornava "Consulte a equipe"
    // Agora o AmandaAI usa o clinicWisdom.js (CONVENIO_WISDOM) para responder corretamente.

    // if (wantsPlan && lead?.acceptedPrivateCare !== true) {
    //    ... removido ...
    // }

    // 🔀 Atualiza estágio
    const newStage = nextStage(stageFromContext, {
        flags,
        intent: analysis?.intent || {},
        extracted: analysis?.extracted || {},
        score: analysis?.score ?? lead?.conversionScore ?? 50,
        isFirstMessage: enrichedContext.isFirstContact,
        messageCount: msgCount,
        lead,
    });

    enrichedContext.stage = newStage;

    const isSchedulingLikeText = GENERIC_SCHEDULE_EVAL_REGEX.test(normalized) || SCHEDULING_REGEX.test(normalized);


    // 🛡️ BLOQUEIO: se triagem ainda não terminou, NÃO entra em fluxo antigo
    if (lead?.triageStep && lead.triageStep !== "done") {
        console.log("🛑 [GUARD] Triagem ativa, bloqueando fluxo antigo - usando resposta programática");
        // 🆕 CORREÇÃO: Em vez de retornar null, usa buildSimpleResponse para continuar a triagem
        const analysis = amandaAnalysis || { missing: ['name'], extracted: {} };
        return buildSimpleResponse(analysis.missing || ['name'], analysis.extracted || {}, lead, enrichedContext);
    }

    const inActiveSchedulingState = !!(
        lead?.pendingSchedulingSlots?.primary ||
        lead?.pendingChosenSlot ||
        lead?.pendingPatientInfoForScheduling ||
        lead?.stage === "interessado_agendamento" ||
        enrichedContext?.stage === "interessado_agendamento"
    );

    // “sinal AGORA” (não depende de dados salvos)
    const schedulingSignalNow = !!(
        flags.wantsSchedule ||
        isSchedulingLikeText ||
        /\b(agenda|agendar|marcar|hor[aá]rio|data|vaga|dispon[ií]vel|essa\s+semana|semana\s+que\s+vem)\b/i.test(text) ||
        // ✅ FIX: Detecta menção a dia específico (dia DD)
        /\b(dia\s+)(\d{1,2})\b/i.test(text) ||
        /\b(\d{1,2}[\/\-]\d{1,2})\b/.test(text)
    );



    const wantsScheduling =
        flags.wantsSchedule ||
        isSchedulingLikeText ||
        schedulingSignalNow;

    if (
        flags.inSchedulingFlow &&
        /^(sim|pode|ok|claro|fechado)$/i.test(text.trim())
    ) {
        flags.wantsSchedule = true;
    }

    console.log("🧠 [YES-CONTEXT]", {
        text,
        inSchedulingFlow: flags.inSchedulingFlow,
        lastStage: lead?.stage,
        hasPendingSlots: !!lead?.pendingSchedulingSlots,
    });

    const primaryIntent = analysis?.intent?.primary;

    // só desvia se NÃO estiver em agendamento ativo e o texto não parece de agendamento
    const isInfoIntent =
        primaryIntent === "apenas_informacao" ||
        primaryIntent === "pesquisa_preco";

    if (
        isInfoIntent &&
        !inActiveSchedulingState &&
        !flags.wantsSchedule &&
        !flags.wantsSchedulingNow &&
        !isSchedulingLikeText
    ) {
        const aiResponse = await callAmandaAIWithContext(
            text,
            lead,
            {
                ...enrichedContext,
                customInstruction:
                    "A pessoa quer só orientação/informação agora. " +
                    "Responda de forma humana e acolhedora (1 frase validando). " +
                    "NÃO puxe triagem (idade/queixa/período) e NÃO pressione avaliação. " +
                    "No final, ofereça uma opção leve: 'se você quiser, eu vejo horários depois' ou 'posso te orientar no próximo passo'.",
            },
            flags,
            analysis
        );

        return ensureSingleHeart(enforceClinicScope(aiResponse, text));
    }

    console.log("🚦 [SCHEDULING-GATE]", {
        wantsScheduling,
        stage: lead?.stage,
        flags,
    });

    if (wantsScheduling) {
        // 🛡️ Proteção contra erro em detectAllTherapies
        let detectedTherapies = [];
        try {
            detectedTherapies = detectAllTherapies(text) || [];
        } catch (err) {
            console.warn("[ORCHESTRATOR] Erro em detectAllTherapies:", err.message);
            detectedTherapies = [];
        }

        // 🧠 VERIFICAÇÃO DE CONSISTÊNCIA: Se lead tem therapyArea salva mas mensagem atual 
        // não detectou nada específico, confirma se é a mesma área
        const hasLeadTherapyArea = lead?.therapyArea &&
            lead.therapyArea !== "psicologia" && // Default muitas vezes
            lead.therapyArea !== "avaliacao";

        const isGenericSchedulingRequest =
            /\b(agendar|marcar|avalia[cç][aã]o|consulta)\b/i.test(text) &&
            detectedTherapies.length === 0 &&
            !flags.therapyArea;

        if (isGenericSchedulingRequest && hasLeadTherapyArea && !lead?.therapyAreaConfirmed) {
            console.log(`🧠 [AREA CONFIRMATION] Lead tem therapyArea: ${lead.therapyArea}, mensagem genérica, confirmando...`);

            // Marca que precisa confirmar
            await safeLeadUpdate(lead._id, {
                $set: { awaitingTherapyConfirmation: true }
            }).catch(() => { });

            const areaLabels = {
                fonoaudiologia: "Fonoaudiologia",
                psicologia: "Psicologia",
                terapia_ocupacional: "Terapia Ocupacional",
                fisioterapia: "Fisioterapia",
                neuropsicologia: "Neuropsicologia",
                musicoterapia: "Musicoterapia"
            };

            return ensureSingleHeart(
                `Vi aqui que da última vez conversamos sobre **${areaLabels[lead.therapyArea] || lead.therapyArea}** 💚\n\n` +
                `É isso mesmo que você quer agendar?\n\n` +
                `E me conta: você tem algum **pedido médico, encaminhamento ou relatório da escola**? ` +
                `Isso ajuda a gente a entender melhor como podemos ajudar.`
            );
        }

        // Se está confirmando a área e pedido médico
        if (lead?.awaitingTherapyConfirmation) {
            const confirmedYes = /\b(sim|isso|mesmo|correto|certo|yes|s)\b/i.test(text);
            const wantsDifferent = /\b(n[aã]o|outra|diferente|mudar|trocar|psic[oó]loga?|fono|terapia ocupacional|to|fisio|neuro)\b/i.test(text);

            // Detecta se tem pedido médico/encaminhamento na resposta
            const hasMedicalReferral =
                /\b(tenho|sim|receita|pedido|encaminhamento|relat[oó]rio|laudo|escola|m[eé]dico|neuropediatra|m[eé]dica)\b/i.test(text);

            const hasNoReferral =
                /\b(n[aã]o\s+tenho|n[aã]o|sem|ainda\s+n[aã]o)\b/i.test(text);

            if (confirmedYes && !wantsDifferent) {
                console.log(`🧠 [AREA CONFIRMATION] Confirmação positiva, usando: ${lead.therapyArea}`);

                if (hasMedicalReferral) {
                    console.log("🧠 [MEDICAL REFERRAL] Paciente TEM pedido médico/encaminhamento");
                    await safeLeadUpdate(lead._id, {
                        $set: {
                            therapyAreaConfirmed: true,
                            awaitingTherapyConfirmation: false,
                            hasMedicalReferral: true
                        }
                    }).catch(() => { });
                    flags.therapyArea = lead.therapyArea;
                    flags.hasMedicalReferral = true;

                    // Tem pedido médico, pode ir direto para agendamento
                    return ensureSingleHeart(
                        `Perfeito! Com o encaminhamento, conseguimos direcionar melhor o atendimento 💚\n\n` +
                        `Qual período funciona melhor pra vocês: manhã ou tarde?`
                    );

                } else if (hasNoReferral) {
                    console.log("🧠 [MEDICAL REFERRAL] Paciente NÃO tem pedido médico");
                    await safeLeadUpdate(lead._id, {
                        $set: {
                            therapyAreaConfirmed: true,
                            awaitingTherapyConfirmation: false,
                            hasMedicalReferral: false
                        }
                    }).catch(() => { });
                    flags.therapyArea = lead.therapyArea;
                    flags.hasMedicalReferral = false;

                    // Não tem pedido médico, pergunta a queixa primeiro
                    return ensureSingleHeart(
                        `Entendido! 💚\n\n` +
                        `Sem problema se não tiver encaminhamento. Me conta: ` +
                        `qual a principal queixa ou dificuldade que vocês estão observando? ` +
                        `Isso ajuda a preparar a avaliação da melhor forma.`
                    );
                } else {
                    // Não respondeu sobre pedido médico, segue normal
                    await safeLeadUpdate(lead._id, {
                        $set: {
                            therapyAreaConfirmed: true,
                            awaitingTherapyConfirmation: false
                        }
                    }).catch(() => { });
                    flags.therapyArea = lead.therapyArea;
                }

            } else if (wantsDifferent) {
                console.log("🧠 [AREA CONFIRMATION] Usuário quer área diferente, seguindo...");
                await safeLeadUpdate(lead._id, {
                    $unset: { awaitingTherapyConfirmation: "" }
                }).catch(() => { });
                // Deixa o fluxo normal detectar a nova área
            }
        }

        // ✅ FIX: Só considera área do lead se tiver queixa registrada
        const hasValidLeadArea = lead?.therapyArea &&
            (lead?.qualificationData?.extractedInfo?.queixa ||
                lead?.qualificationData?.extractedInfo?.queixaDetalhada?.length > 0 ||
                lead?.patientInfo?.complaint ||
                lead?.autoBookingContext?.complaint);

        // ✅ FIX: Verifica área em TODAS as fontes (mensagem atual + lead COM queixa + qualificationData COM queixa + enrichedContext)
        const hasArea = detectedTherapies.length > 0 ||
            flags.therapyArea ||
            enrichedContext?.therapyArea ||           // ← 🆕 contexto/summary
            hasValidLeadArea ||
            getValidQualificationArea(lead);

        // ✅ FIX: Verifica idade em TODAS as fontes (incluindo enrichedContext)
        const hasAge = /\b\d{1,2}\s*(anos?|mes(es)?)\b/i.test(text) ||
            enrichedContext?.patientAge ||            // ← 🆕 contexto/summary
            lead?.patientInfo?.age ||
            lead?.ageGroup ||
            lead?.qualificationData?.extractedInfo?.idade;

        // ✅ FIX: Verifica período em TODAS as fontes (incluindo enrichedContext)
        const hasPeriod = extractPeriodFromText(text) ||
            enrichedContext?.preferredTime ||         // ← 🆕 contexto/summary
            lead?.pendingPreferredPeriod ||
            lead?.autoBookingContext?.preferredPeriod ||
            lead?.qualificationData?.extractedInfo?.disponibilidade;

        console.log("[BLOCO_INICIAL] hasArea:", hasArea, "| hasAge:", hasAge, "| hasPeriod:", hasPeriod, "| hasValidLeadArea:", hasValidLeadArea);

        // 1) falta área/queixa
        const instrComplaint = ci(
            useModule("schedulingTriageRules"),
            useModule("triageAskComplaint")
        );

        // 2) tem área mas falta idade
        const instrAge = (areaName) => ci(
            useModule("schedulingTriageRules"),
            useModule("triageAskAge", areaName)
        );

        // 3) tem área+idade mas falta período
        const instrPeriod = ci(
            useModule("schedulingTriageRules"),
            useModule("triageAskPeriod")
        );

        // ✅ FIX: Se tem TUDO, delega pro PASSO 3/4 (não retorna aqui)
        if (hasArea && hasAge && hasPeriod) {
            console.log("[BLOCO_INICIAL] ✅ Triagem completa, delegando pro PASSO 3...");
            // Não retorna, deixa continuar pro PASSO 3/4
        }
        // 1️⃣ Nenhuma queixa/área detectada ainda (com ou sem idade)
        else if (!hasArea) {
            // 🤖 IA gera pergunta de queixa de forma acolhedora
            const aiResponse = await callAmandaAIWithContext(
                text,
                lead,
                {
                    ...enrichedContext,
                    customInstruction: instrComplaint
                },
                flags,
                null
            );
            return ensureSingleHeart(aiResponse);
        }
        // 2️⃣ Queixa/área detectada → pedir idade se ainda não tem
        else if (hasArea && !hasAge) {
            const areaName = detectedTherapies[0]?.name ||
                getValidQualificationArea(lead) ||
                (hasValidLeadArea ? lead?.therapyArea : null) ||
                "área ideal";

            // 🤖 IA gera confirmação de área + pedido de idade
            const aiResponse = await callAmandaAIWithContext(
                text,
                lead,
                {
                    ...enrichedContext,
                    customInstruction: instrAge(areaName)
                },
                flags,
                null
            );
            return ensureSingleHeart(aiResponse);
        }
        // 3️⃣ Já tem área e idade, falta período → perguntar período
        else if (hasArea && hasAge && !hasPeriod) {
            const areaName = detectedTherapies[0]?.name ||
                getValidQualificationArea(lead) ||
                (hasValidLeadArea ? lead?.therapyArea : null) ||
                flags.therapyArea ||
                "área indicada";

            // 🧠 Ativa estado aguardando resposta de período
            if (lead?._id) {
                await safeLeadUpdate(lead._id, {
                    $set: {
                        "autoBookingContext.awaitingPeriodChoice": true,
                    },
                }).catch(err => logSuppressedError('safeLeadUpdate', err));
            }

            // 🤖 IA gera transição para agendamento + pedido de período
            const aiResponse = await callAmandaAIWithContext(
                text,
                lead,
                {
                    ...enrichedContext,
                    customInstruction: instrPeriod
                },
                flags,
                null
            );
            return ensureSingleHeart(aiResponse);
        }
    }
    // ✅ Se tem tudo, continua pro PASSO 3/4

    // 🦴🍼 Gate osteopata (físio bebê)
    const babyContext =
        /\b\d{1,2}\s*(mes|meses)\b/i.test(text) || /\b(beb[eê]|rec[eé]m[-\s]*nascid[oa]|rn)\b/i.test(text);

    const therapyAreaForGate =
        enrichedContext.therapyArea ||
        flags.therapyArea ||
        bookingProduct?.therapyArea ||

        lead?.therapyArea ||
        null;

    const shouldOsteoGate =
        Boolean(lead?._id) &&
        wantsScheduling &&
        babyContext &&
        wantsScheduling &&
        therapyAreaForGate === "fisioterapia" &&
        !lead?.autoBookingContext?.osteopathyOk;

    if (shouldOsteoGate) {
        const mentionsOsteo = /\b(osteopata|osteopatia|osteo)\b/i.test(text);

        const saidYes =
            (/\b(sim|s\b|ja|j[aá]|passou|consultou|avaliou|foi)\b/i.test(text) && mentionsOsteo) ||
            /\b(osteop)\w*\s+(indicou|encaminhou|orientou)\b/i.test(text) ||
            /\bfoi\s+o\s+osteop\w*\s+que\s+indicou\b/i.test(text);

        const saidNo =
            (/\b(n[aã]o|nao|ainda\s+n[aã]o|ainda\s+nao|nunca)\b/i.test(text) &&
                (mentionsOsteo || /\bpassou\b/i.test(text))) ||
            /\b(n[aã]o|nao)\s+passou\b/i.test(text);

        const gatePending = Boolean(lead?.autoBookingContext?.osteopathyGatePending);

        if (gatePending) {
            if (saidYes) {
                await safeLeadUpdate(lead._id, {
                    $set: { "autoBookingContext.osteopathyOk": true },
                    $unset: { "autoBookingContext.osteopathyGatePending": "" },
                }).catch(err => logSuppressedError('safeLeadUpdate', err));
            } else if (saidNo) {
                await safeLeadUpdate(lead._id, {
                    $set: { "autoBookingContext.osteopathyOk": false },
                    $unset: { "autoBookingContext.osteopathyGatePending": "" },
                }).catch(err => logSuppressedError('safeLeadUpdate', err));

                return ensureSingleHeart(
                    "Perfeito 😊 Só pra alinhar: no caso de bebê, a triagem inicial precisa ser com nosso **Osteopata**. Depois da avaliação dele (e se ele indicar), a gente já encaminha pra Fisioterapia certinho. Você quer agendar a avaliação com o Osteopata essa semana ou na próxima?",
                );
            } else {
                return ensureSingleHeart(
                    "Só pra eu te direcionar certinho: o bebê **já passou pelo Osteopata** e foi ele quem indicou a Fisioterapia?",
                );
            }
        } else {
            if (!mentionsOsteo) {
                await safeLeadUpdate(lead._id, {
                    $set: { "autoBookingContext.osteopathyGatePending": true },
                }).catch(err => logSuppressedError('safeLeadUpdate', err));

                return ensureSingleHeart(
                    "Só pra eu te direcionar certinho: o bebê **já passou pelo Osteopata** e foi ele quem indicou a Fisioterapia?",
                );
            }

            if (saidYes) {
                await safeLeadUpdate(lead._id, {
                    $set: { "autoBookingContext.osteopathyOk": true },
                    $unset: { "autoBookingContext.osteopathyGatePending": "" },
                }).catch(err => logSuppressedError('safeLeadUpdate', err));
            }
        }
    }

    const RESCHEDULE_REGEX =
        /\b(remarcar|reagendar|novo\s+hor[aá]rio|trocar\s+hor[aá]rio)\b/i;

    const RESISTS_SCHEDULING_REGEX =
        /\b(s[oó]\s+pesquisando|s[oó]\s+estou\s+pesquisando|mais\s+pra\s+frente|depois\s+eu\s+vejo|agora\s+n[aã]o\s+consigo|por\s+enquanto\s+n[aã]o|s[oó]\s+queria\s+saber\s+os\s+valores?)\b/i;

    const isResistingScheduling =
        flags.visitLeadCold ||
        RESISTS_SCHEDULING_REGEX.test(normalized) ||
        analysis?.intent?.primary === "apenas_informacao" ||
        analysis?.intent?.primary === "pesquisa_preco";

    const shouldUseVisitFunnel =
        msgCount >= 4 &&
        isResistingScheduling &&
        !flags.wantsSchedule &&
        !flags.wantsSchedulingNow &&
        (newStage === "novo" || newStage === "pesquisando_preco" || newStage === "engajado") &&
        !enrichedContext.pendingSchedulingSlots &&
        !lead?.pendingPatientInfoForScheduling;

    const hasProfile =
        hasAgeOrProfileNow(text, flags, enrichedContext, lead) ||
        /\b(meu|minha)\s+(filh[oa]|crian[çc]a)\b/i.test(text);

    if (/\b(meu|minha)\s+(filh[oa]|crian[çc]a)\b/i.test(text)) {
        flags.mentionsChild = true;
    }

    const hasArea = !!(
        bookingProduct?.therapyArea ||
        flags?.therapyArea ||

        lead?.therapyArea
    );

    if (bookingProduct?.product === "multi_servico") {
        return ensureSingleHeart(
            "Perfeito! Só confirmando: você quer **Fisioterapia** e **Teste da Linguinha**, certo? Quer agendar **primeiro qual dos dois**?",
        );
    }

    if (/precisa\s+de\s+tudo|fono.*psico|psico.*fono/i.test(text.replace(/(?:cl[ií]nica\s+)?fono\s+inova/gi, ''))) {
        flags.multidisciplinary = true;
        flags.therapyArea = "multiprofissional";
    }

    if (RESCHEDULE_REGEX.test(normalized)) {
        return ensureSingleHeart(
            "Claro! Vamos remarcar 😊 Você prefere **manhã ou tarde** e qual **dia da semana** fica melhor pra você?"
        );
    }

    // =========================================================================
    // 🆕 PASSO 3: TRIAGEM - SALVA DADOS IMEDIATAMENTE E VERIFICA O QUE FALTA
    // =========================================================================
    if (wantsScheduling && lead?._id && !lead?.pendingPatientInfoForScheduling) {
        console.log("[TRIAGEM] Verificando dados necessários...");

        // 🆕 SALVA DADOS DETECTADOS IMEDIATAMENTE
        const updateData = {};

        // ✅ FIX: Detecta período e salva em pendingPreferredPeriod (FONTE ÚNICA)
        const periodDetected = extractPeriodFromText(text);
        if (periodDetected && !lead?.pendingPreferredPeriod) {
            updateData.pendingPreferredPeriod = normalizePeriod(periodDetected);
            console.log("[TRIAGEM] ✅ Período detectado e salvo:", normalizePeriod(periodDetected));
        }

        // Detecta e salva idade
        const ageDetected = extractAgeFromText(text);
        if (ageDetected && !lead?.patientInfo?.age && !lead?.qualificationData?.extractedInfo?.idade) {
            updateData["patientInfo.age"] = ageDetected.age;
            updateData["patientInfo.ageUnit"] = ageDetected.unit;
            updateData.ageGroup = getAgeGroup(ageDetected.age, ageDetected.unit);
            console.log("[TRIAGEM] ✅ Idade detectada e salva:", ageDetected.age, ageDetected.unit);
        }

        // ✅ Se veio "Imagem enviada: ... solicitação para avaliação neuropsicológica"
        if (/imagem enviada:/i.test(text) && /(avalia[çc][aã]o\s+neuro|neuropsico)/i.test(text)) {
            updateData["qualificationData.extractedInfo.especialidade"] = "avaliacao_neuropsicologica";
            updateData["qualificationData.extractedInfo.queixa"] = "Encaminhamento para avaliação neuropsicológica.";
            updateData["qualificationData.extractedInfo.hasMedicalReferral"] = true;

            // e já seta a área coerente com seu mapper (neuropsico → psicologia)
            updateData.therapyArea = "psicologia";
            updateData["autoBookingContext.mappedTherapyArea"] = "psicologia";
            updateData["autoBookingContext.therapyArea"] = "psicologia";
            updateData["autoBookingContext.active"] = true;
        }


        // ✅ FIX: Detecta área - PRIORIZA qualificationData.extractedInfo.especialidade
        const qualificationArea = getValidQualificationArea(lead);
        let areaDetected = qualificationArea || bookingProduct?.therapyArea;

        // Se não veio de nenhum lugar, tenta mapear da queixa na mensagem
        if (!areaDetected && !lead?.therapyArea) {
            areaDetected = mapComplaintToTherapyArea(text);
            if (areaDetected) {
                console.log("[TRIAGEM] ✅ Área mapeada da queixa:", areaDetected);
                updateData["patientInfo.complaint"] = text;
                updateData["autoBookingContext.complaint"] = text;
            }
        }

        // ✅ FIX: Sincroniza therapyArea se qualificationData tem área diferente
        if (qualificationArea && lead?.therapyArea !== qualificationArea) {
            updateData.therapyArea = qualificationArea;
            updateData["autoBookingContext.mappedTherapyArea"] = qualificationArea;
            areaDetected = qualificationArea;
            console.log("[TRIAGEM] ✅ Sincronizando área do qualificationData:", qualificationArea);
        } else if (areaDetected && !lead?.therapyArea) {
            updateData.therapyArea = areaDetected;
            updateData["autoBookingContext.mappedTherapyArea"] = areaDetected;
            console.log("[TRIAGEM] ✅ Área salva:", areaDetected);
        }

        // Detecta menção de criança
        if (/\b(filh[oa]|crian[çc]a|beb[êe]|menin[oa])\b/i.test(text) && !lead?.ageGroup) {
            updateData.ageGroup = "crianca";
            flags.mentionsChild = true;
            console.log("[TRIAGEM] ✅ Menção de criança detectada");
        }

        // Salva no banco se tiver algo pra salvar
        if (Object.keys(updateData).length > 0) {
            await safeLeadUpdate(lead._id, { $set: updateData }).catch((err) => {
                console.error("[TRIAGEM] Erro ao salvar:", err.message);
            });
            // Atualiza objeto local
            if (updateData["patientInfo.age"]) {
                lead.patientInfo = lead.patientInfo || {};
                lead.patientInfo.age = updateData["patientInfo.age"];
            }
            if (updateData.ageGroup) lead.ageGroup = updateData.ageGroup;
            if (updateData.therapyArea) lead.therapyArea = updateData.therapyArea;
            if (updateData.pendingPreferredPeriod) lead.pendingPreferredPeriod = updateData.pendingPreferredPeriod;
        }

        // ✅ FIX: Verifica o que ainda falta - INCLUI qualificationData como fonte
        const hasProfileNow = hasAgeOrProfileNow(text, flags, enrichedContext, lead) ||
            ageDetected ||
            lead?.qualificationData?.extractedInfo?.idade;
        const hasAreaNow = !!(lead?.therapyArea ||
            areaDetected ||
            bookingProduct?.therapyArea ||
            getValidQualificationArea(lead));
        const hasPeriodNow = !!(lead?.pendingPreferredPeriod ||
            lead?.autoBookingContext?.preferredPeriod ||
            lead?.qualificationData?.extractedInfo?.disponibilidade ||
            periodDetected);

        console.log("[TRIAGEM] Estado após salvar:", {
            hasProfile: hasProfileNow,
            hasArea: hasAreaNow,
            hasPeriod: hasPeriodNow
        });

        // Se ainda falta algo, pergunta (1 pergunta por vez)
        if (!hasProfileNow || !hasAreaNow || !hasPeriodNow) {
            return ensureSingleHeart(
                buildTriageSchedulingMessage({ flags, bookingProduct, ctx: enrichedContext, lead }),
            );
        }

        // =========================================================================
        // 🆕 PASSO 4: TRIAGEM COMPLETA - BUSCA SLOTS
        // =========================================================================
        console.log("[ORCHESTRATOR] ✅ Triagem completa! Buscando slots...");

        // ✅ FIX: Inclui qualificationData.extractedInfo.especialidade como fonte
        const therapyAreaForSlots = lead?.therapyArea ||
            areaDetected ||
            bookingProduct?.therapyArea ||
            getValidQualificationArea(lead);
        const preferredPeriod = lead?.pendingPreferredPeriod ||
            lead?.autoBookingContext?.preferredPeriod ||
            lead?.qualificationData?.extractedInfo?.disponibilidade ||
            periodDetected;

        console.log("[ORCHESTRATOR] Buscando slots para:", { therapyAreaForSlots, preferredPeriod });

        try {
            const dateFilter = lead?.pendingPreferredDate || flags.preferredDate || null;
            const periodToUse = dateFilter ? null : preferredPeriod;

            console.log("[ORCHESTRATOR] dateFilter:", dateFilter, "periodToUse:", periodToUse);

            const availableSlots = await findAvailableSlots({
                therapyArea: therapyAreaForSlots,
                preferredDate: dateFilter || undefined,
                preferredPeriod: periodToUse,
                daysAhead: dateFilter ? 60 : 30,
                maxOptions: 2,
            });

            if (!availableSlots?.primary) {
                // Tenta sem filtro de período/data
                const fallbackSlots = await findAvailableSlots({
                    therapyArea: therapyAreaForSlots,
                    preferredPeriod: null,
                    daysAhead: 30,
                    maxOptions: 2,
                });

                if (fallbackSlots?.primary) {
                    await safeLeadUpdate(lead._id, {
                        $set: {
                            pendingSchedulingSlots: fallbackSlots,
                            "autoBookingContext.active": true,
                            stage: "interessado_agendamento"
                        }
                    }).catch(err => logSuppressedError('safeLeadUpdate', err));

                    const periodLabel = preferredPeriod === "manhã" ? "manhã" : preferredPeriod === "tarde" ? "tarde" : "noite";
                    const { optionsText, letters } = buildSlotMenuMessage(fallbackSlots);
                    return ensureSingleHeart(`Pra **${periodLabel}** não encontrei vaga agora 😕\n\nTenho essas opções em outros horários:\n\n${optionsText}\n\nQual você prefere? (${letters.join(" ou ")})`);
                }

                return ensureSingleHeart("No momento não achei horários certinhos pra essa área. Me diga: prefere manhã ou tarde, e qual dia da semana fica melhor?");
            }

            // Urgência
            const urgencyLevel =
                enrichedContext?.urgency?.level || enrichedContext?.urgencyLevel || "NORMAL";

            if (urgencyLevel && availableSlots) {
                try {
                    const flatSlots = [
                        availableSlots.primary,
                        ...(availableSlots.alternativesSamePeriod || []),
                        ...(availableSlots.alternativesOtherPeriod || []),
                    ].filter(Boolean);

                    const prioritized = urgencyScheduler(flatSlots, urgencyLevel).slice(0, 6);

                    if (prioritized.length) {
                        availableSlots.primary = prioritized[0];
                        availableSlots.alternativesSamePeriod = prioritized.slice(1, 4);
                        availableSlots.alternativesOtherPeriod = prioritized.slice(4, 6);
                    }

                    console.log(`🔎 Urgência aplicada (${urgencyLevel}) → ${prioritized.length} slots priorizados`);
                } catch (err) {
                    console.error("Erro ao aplicar urgência:", err);
                }
            }

            await safeLeadUpdate(lead._id, {
                $set: {
                    pendingSchedulingSlots: availableSlots,
                    urgencyApplied: urgencyLevel,
                    "autoBookingContext.active": true,
                    "autoBookingContext.mappedTherapyArea": therapyAreaForSlots,
                    "autoBookingContext.mappedProduct": bookingProduct?.product,
                    "autoBookingContext.lastSlotsShownAt": new Date(), // ← 🆕 timestamp para TTL
                },
            }).catch(err => logSuppressedError('safeLeadUpdate', err));

            enrichedContext.pendingSchedulingSlots = availableSlots;

            const { message: menuMsg, optionsText, ordered, letters } = buildSlotMenuMessage(availableSlots);

            if (!menuMsg || !ordered?.length) {
                return ensureSingleHeart(
                    "No momento não encontrei horários disponíveis. Quer me dizer se prefere manhã ou tarde, e qual dia da semana fica melhor?"
                );
            }

            const allowed = letters.slice(0, ordered.length).join(", ");

            console.log("✅ [ORCHESTRATOR] Slots encontrados:", {
                primary: availableSlots?.primary ? formatSlot(availableSlots.primary) : null,
                alternatives: availableSlots?.alternativesSamePeriod?.length || 0,
            });

            const urgencyPrefix =
                urgencyLevel === "ALTA"
                    ? "Entendo a urgência do caso. Separei os horários mais próximos pra você 👇\n\n"
                    : urgencyLevel === "MEDIA"
                        ? "Pra não atrasar o cuidado, organizei boas opções de horário 👇\n\n"
                        : "";

            return ensureSingleHeart(
                `${urgencyPrefix}Tenho esses horários no momento:\n\n${optionsText}\n\nQual você prefere? (${allowed})`
            );

        } catch (err) {
            console.error("❌ [ORCHESTRATOR] Erro ao buscar slots:", err?.message || err);
            return ensureSingleHeart("Vou verificar os horários disponíveis. Você prefere **manhã ou tarde** e qual **dia da semana** fica melhor? 💚");
        }
    }

    if (shouldUseVisitFunnel) {
        const visitAnswer = await callVisitFunnelAI({
            text,
            lead,
            context: enrichedContext,
            flags,
        });

        const scopedVisit = enforceClinicScope(visitAnswer, text);
        return ensureSingleHeart(scopedVisit);
    }

    // 1) Manual Response (desativado - já funciona via entity-driven)
    // const manualAnswer = tryManualResponse(normalized, enrichedContext, flags, lead);
    // if (manualAnswer) return ensureSingleHeart(manualAnswer);

    // 2) TDAH
    if (isTDAHQuestion(text)) {
        try {
            const tdahAnswer = await getTDAHResponse(text);
            if (tdahAnswer) return ensureSingleHeart(tdahAnswer);
        } catch (err) {
            console.warn("[ORCHESTRATOR] Erro em getTDAHResponse, seguindo fluxo normal:", err.message);
        }
    }

    // 3) Equivalência
    if (isAskingAboutEquivalence(text)) {
        const equivalenceAnswer = buildEquivalenceResponse();
        return ensureSingleHeart(equivalenceAnswer);
    }

    // 4) Detecção de terapias
    let therapies = [];
    try {
        therapies = detectAllTherapies(text) || [];
    } catch (err) {
        console.warn("[ORCHESTRATOR] Erro em detectAllTherapies:", err.message);
        therapies = [];
    }

    // IA com terapias
    if (Array.isArray(therapies) && therapies.length > 0) {
        // ✅ FIX: Persiste a área detectada no lead para contexto futuro (ex: "Qual valor?")
        if (lead && !lead.therapyArea) {
            const primaryTherapy = therapies[0]?.id;
            const areaMap = {
                "neuropsychological": "neuropsicologia",
                "speech": "fonoaudiologia",
                "tongue_tie": "fonoaudiologia",
                "psychology": "psicologia",
                "occupational": "terapia_ocupacional",
                "physiotherapy": "fisioterapia",
                "music": "musicoterapia",
                "neuropsychopedagogy": "neuropsicologia",
                "psychopedagogy": "neuropsicologia",
            };
            const mappedArea = areaMap[primaryTherapy];

            if (mappedArea) {
                console.log(`💾 [ORCHESTRATOR] Persistindo área detectada: ${mappedArea}`);
                await safeLeadUpdate(lead._id, {
                    $set: { therapyArea: mappedArea }
                }).catch(err => console.warn("[ORCHESTRATOR] Erro ao salvar área:", err.message));

                // Atualiza objeto local
                lead.therapyArea = mappedArea;
            }
        }

        try {
            const therapyAnswer = await callClaudeWithTherapyData({
                therapies,
                flags,
                userText: text,
                lead,
                context: enrichedContext,
                analysis,
            });

            const scoped = enforceClinicScope(therapyAnswer, text);
            return ensureSingleHeart(scoped);
        } catch (err) {
            console.error("[ORCHESTRATOR] Erro em callClaudeWithTherapyData, caindo no fluxo geral:", err);
        }
    }

    // 🆕 SIDE INTENT HANDLER: Se está em scheduling e pergunta algo lateral, responde e retoma
    const inScheduling = lead?.stage === 'interessado_agendamento' ||
        ['ask_name', 'ask_age', 'ask_period'].includes(lead?.triageStep);

    if (inScheduling) {
        // SIDE INTENT: Responde pergunta lateral e retoma agendamento
        const isSideIntent = flags.asksPrice || flags.asksPlans || flags.asksAddress || flags.asksLocation;

        if (isSideIntent) {
            console.log("🔄 [SIDE-INTENT] Respondendo pergunta lateral durante scheduling");

            // Detecta emoção
            const emotionalState = detectEmotionalState(text);

            // Determina próximo passo do agendamento
            let nextStep;
            if (lead?.triageStep === 'ask_name') nextStep = "Pode me confirmar o nome completo da criança? 💚";
            else if (lead?.triageStep === 'ask_age') nextStep = "Qual a idade dela? (anos ou meses)";
            else if (lead?.triageStep === 'ask_period') nextStep = "Prefere atendimento de manhã ou tarde?";
            else if (!lead?.patientInfo?.fullName) nextStep = "Pode me confirmar o nome completo da criança? 💚";
            else if (!lead?.patientInfo?.age) nextStep = "Qual a idade?";
            else nextStep = "Posso confirmar o horário para você?";

            // Responde pela IA (com RNs)
            const sideAnswer = await callAmandaAIWithContext(text, lead, enrichedContext, flags, analysis);

            // Monta resposta híbrida
            const parts = [];
            if (emotionalState?.isAnxious) parts.push(`Oi! Respira... 🌸`);
            else if (emotionalState?.isSad) parts.push(`Entendo que isso pode ser difícil... 💚`);
            parts.push(sideAnswer.trim());
            parts.push(`\n\n${nextStep}`);

            return ensureSingleHeart(enforceClinicScope(parts.join('\n'), text));
        }
    }

    // Fluxo geral
    console.log(`[DEBUG FLUXO] Etapa 1 - Chamando IA...`);
    const genericAnswer = await callAmandaAIWithContext(text, lead, enrichedContext, flags, analysis);
    console.log(`[DEBUG FLUXO] Etapa 2 - IA respondeu:`, genericAnswer?.substring ? genericAnswer.substring(0, 50) + '...' : genericAnswer);

    // 🆕 FALLBACK OBRIGATÓRIO: Se IA não respondeu ou retornou null, usa resposta programática
    console.log(`[DEBUG FLUXO] Etapa 3 - Verificando fallback... genericAnswer:`, !!genericAnswer);
    if (!genericAnswer || genericAnswer === 'null' || genericAnswer === null) {
        console.log('⚠️ [FALLBACK CRÍTICO] IA não respondeu ou retornou null. Usando resposta programática de segurança.');
        
        // Tenta usar buildSimpleResponse com os dados disponíveis
        if (amandaAnalysis && amandaAnalysis.missing) {
            console.log('[DEBUG FLUXO] Etapa 4 - Usando buildSimpleResponse');
            return buildSimpleResponse(amandaAnalysis.missing, amandaAnalysis.extracted || {}, lead, enrichedContext);
        }
        
        // Último recurso: resposta genérica de acolhimento
        const areaHint = enrichedContext?.therapyArea || lead?.therapyArea;
        const areaNames = {
            fonoaudiologia: 'Fonoaudiologia',
            psicologia: 'Psicologia',
            terapia_ocupacional: 'Terapia Ocupacional',
            to: 'Terapia Ocupacional',
            fisioterapia: 'Fisioterapia',
            neuropsicologia: 'Neuropsicologia'
        };
        const areaDisplay = areaHint ? (areaNames[areaHint] || areaHint) : null;
        
        console.log('[DEBUG FLUXO] Etapa 5 - areaDisplay:', areaDisplay);
        if (areaDisplay) {
            return ensureSingleHeart(`Oi! Entendi que você busca **${areaDisplay}** 💚\n\nPara te ajudar melhor, qual o nome e idade do paciente?`);
        }
        
        console.log('[DEBUG FLUXO] Etapa 6 - Usando resposta genérica');
        return ensureSingleHeart(`Oi! Bem-vindo(a) à Fono Inova 💚\n\nMe conta: qual especialidade você busca? Temos Fonoaudiologia, Psicologia, Terapia Ocupacional, Fisioterapia e Neuropsicologia.`);
    }

    const finalScoped = enforceClinicScope(genericAnswer, text);
    return ensureSingleHeart(finalScoped);
}


/**
 * 🔥 FUNIL INICIAL: AVALIAÇÃO → VISITA (se recusar)
 */
async function callVisitFunnelAI({ text, lead, context = {}, flags = {} }) {
    const stage = context.stage || lead?.stage || "novo";

    const systemContext = buildSystemContext(flags, text, stage, context);
    const dynamicSystemPrompt = buildDynamicSystemPrompt(systemContext);

    const messages = [];

    if (context.conversationSummary) {
        messages.push({
            role: "user",
            content: `📋 CONTEXTO ANTERIOR:\n\n${context.conversationSummary}\n\n---\n\nMensagens recentes abaixo:`,
        });
        messages.push({
            role: "assistant",
            content:
                "Entendi o contexto. Vou seguir o funil de AVALIAÇÃO INICIAL como primeiro passo e, se o lead não quiser avaliação agora, ofereço VISITA PRESENCIAL leve como alternativa.",
        });
    }

    if (context.conversationHistory?.length) {
        const safeHistory = context.conversationHistory.map((msg) => ({
            role: msg.role || "user",
            content:
                typeof msg.content === "string"
                    ? msg.content
                    : JSON.stringify(msg.content),
        }));
        messages.push(...safeHistory);
    }

    const visitPrompt = `
        ${text}

        🎯 MODO ACOLHIMENTO + PRÓXIMO PASSO (SEM PRESSÃO)

        OBJETIVO:
        - Apoiar a mãe/pai com linguagem humana.
        - Não “empurrar” avaliação. Ofereça como opção quando houver abertura.

        ROTEIRO:
        1) ACOLHIMENTO (1 frase)
        - Valide a preocupação: "Entendo como isso preocupa" / "Você fez certo em buscar ajuda".

        2) PERMISSÃO (1 frase)
        - "Posso te fazer 2 perguntinhas rápidas pra te orientar melhor?"

        3) CLAREZA (1 pergunta por vez)
        - Pergunte a principal queixa OU idade (o que fizer mais sentido pelo texto).

        4) PRÓXIMO PASSO COM DUAS OPÇÕES (SEM PRESSÃO)
        - Opção leve: "Se quiser, você pode vir conhecer a clínica / tirar dúvidas rapidinho."
        - Opção completa: "E se você preferir, a avaliação inicial já direciona o melhor caminho."

        REGRAS:
        - Não inventar horários.
        - Não falar de preço a menos que perguntem.
        - validar + pedir permissão + oferecer 2 opções (visita leve OU avaliação).
        - não insistir se a pessoa sinalizar que só quer entender.
        - Tom: humano, calmo, acolhedor. 2–4 frases no máximo.
        `.trim();


    messages.push({ role: "user", content: visitPrompt });

    const textResp = await callAI({
        systemPrompt: dynamicSystemPrompt,
        messages,
        maxTokens: 300,
        temperature: 0.6,
    });

    return (
        textResp ||
        "Posso te ajudar a escolher um dia pra visitar a clínica? 💚"
    );
}

/**
 * 📖 MANUAL
 */
function tryManualResponse(normalizedText, context = {}, flags = {}, lead = {}) {
    const { isFirstContact, messageCount = 0 } = context;

    // 🌍 ENDEREÇO / LOCALIZAÇÃO
    const askedLocation = /\b(endere[cç]o|onde fica|local|mapa|como chegar)\b/.test(normalizedText);
    const askedPrice =
        /(pre[çc]o|preco|valor(es)?|quanto\s+custa|custa\s+quanto|qual\s+o\s+valor|qual\s+[eé]\s+o\s+valor)/i.test(normalizedText);

    // ✅ Pergunta "valor + onde fica" na mesma mensagem → responde os dois
    if (askedLocation && askedPrice) {
        const area = inferAreaFromContext(normalizedText, context, flags);
        const addr = getManual("localizacao", "endereco");

        if (!area) {
            return (
                addr +
                "\n\nSobre valores: me diz se é pra **Fono**, **Psicologia**, **TO**, **Fisioterapia** ou **Neuropsicológica** que eu já te passo certinho."
            );
        }

        return addr + "\n\n" + getManual("valores", "avaliacao");
    }

    if (askedLocation) {
        const coords = getManual("localizacao", "coords");
        const addrText = getManual("localizacao", "endereco");

        // Se o cliente pediu só o local, envia o pin de localização real
        if (coords?.latitude && coords?.longitude) {
            sendLocationMessage({
                to: lead.contact.phone,
                lead: lead._id,
                contactId: lead.contact._id,
                latitude: coords.latitude,
                longitude: coords.longitude,
                name: coords.name,
                address: coords.address,
                url: coords.url,
                sentBy: "amanda"
            });
        }

        // E ainda retorna texto normal no chat
        return addrText;
    }

    // 💳🩺 PLANO / CONVÊNIO (inclui Bradesco)
    if (/\b(plano|conv[eê]nio|unimed|ipasgo|amil|bradesco)\b/i.test(normalizedText)) {
        if (/\bbradesco\b/i.test(normalizedText)) {
            return getManual("planos_saude", "bradesco_reembolso");
        }
        return getManual("planos_saude", "credenciamento");
    }

    // 💰 PREÇO GENÉRICO (sem área explícita)
    if (
        /(pre[çc]o|preco|valor(es)?|quanto\s+custa|custa\s+quanto|qual\s+o\s+valor|qual\s+é\s+o\s+valor)/i
            .test(normalizedText) &&
        !/\b(neuropsic|fono|fonoaudiolog|psicolog|psicopedagog|terapia|fisio|musico)/i
            .test(normalizedText)
    ) {
        const area = inferAreaFromContext(normalizedText, context, flags);

        if (!area) {
            return "Pra te passar o valor certinho, seria pra Fono, Psicologia, TO, Fisioterapia ou Neuropsicológica? 💚";
        }

        return getManual("valores", "avaliacao");
    }

    // 👋 SAUDAÇÃO PURA
    if (PURE_GREETING_REGEX.test(normalizedText)) {
        // 🛡️ FIX: usa messageCount do context OU histórico de interações do lead
        const totalMsgs = messageCount || context?.recentMessages?.length || 0;
        if (isFirstContact && totalMsgs <= 1) {
            return getManual("saudacao");
        }

        return "Oi! 😊 Me conta, posso te ajudar com mais alguma coisa? 💚";
    }

    // 💼 CURRÍCULO / VAGA / TRABALHO
    if (
        /\b(curr[ií]culo|curriculo|cv\b|trabalhar|emprego|trampo|estágio|estagio)\b/.test(
            normalizedText,
        )
    ) {
        // Detecta a área mencionada para personalizar
        const areaMatch = normalizedText.match(/\b(fono|psicolog|terapeuta ocupacional|to\b|fisio|neuro|musicoterapia)\b/);
        const areaMencionada = areaMatch ? areaMatch[0] : null;

        let areaTexto = areaMencionada ? ` (${areaMencionada})` : '';

        return (
            `Que bom que você quer fazer parte da nossa equipe${areaTexto}! 🥰💚\n\n` +
            "Os currículos são recebidos **exclusivamente por e-mail**:\n" +
            "📩 **contato@clinicafonoinova.com.br**\n\n" +
            "No assunto, coloque sua área de atuação (ex: Terapeuta Ocupacional).\n\n" +
            "Em breve nossa equipe entra em contato! 😊💚"
        );
    }

    // 📱 INSTAGRAM / REDES
    if (
        /\b(insta(gram)?|rede[s]?\s+social(is)?|perfil\s+no\s+instagram)\b/.test(
            normalizedText,
        )
    ) {
        return "Claro! Você pode acompanhar nosso trabalho no Instagram pelo perfil **@clinicafonoinova**. 💚";
    }

    return null;
}


/**
 * 🔍 HELPER: Infere área pelo contexto
 */
function inferAreaFromContext(normalizedText, context = {}, flags = {}) {
    const t = (normalizedText || "").toLowerCase();

    const historyArray = Array.isArray(context.conversationHistory)
        ? context.conversationHistory
        : [];

    const historyTexts = historyArray.map((msg) =>
        (typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content)
        ).toLowerCase(),
    );

    const AREA_DEFS = [
        {
            id: "fonoaudiologia",
            regex: /\b(fono(?![\s-]?inova)|fonoaudiolog(?:ia|o|a)|fonoaudiólog(?:o|a)|audiolog(?:ia|o|a)|audiólog(?:o|a)|linguagem|fala|voz|deglutição|mastigação|motricidade orofacial|miofuncional|linguinha|freio|frenulo|lábio leporino|fenda palatina|respiração oral|voz rouca|gagueira|tartamudez|fluência|engasgar|amamentação|succao|sucção|s[ií]ndrome\s+de\s+down|trissomia)\b/i
        },
        {
            id: "terapia_ocupacional",
            regex: /\b(terapia\s+ocupacional|terapeuta\s+ocupacional|t\.?\s*o\.?|\bto\b|ocupacional|integração sensorial|sensorial|coordenação motora|motricidade|avd|atividades de vida diária|pinça|lateralidade|canhoto|destro|reflexos|alimentação|vestir|banho)\b/i
        },
        {
            id: "fisioterapia",
            regex: /\b(fisioterapia|fisio|fisioterapeuta|atraso motor|desenvolvimento motor|não engatinhou|não andou|andar na ponta|pé torto|torticolo|assimetria|prematuro|hipotonia|hipertonia|espasticidade|fortalecimento|equilíbrio|cair|tropeça|postura|escoliose|engatinhar)\b/i
        },
        {
            id: "psicopedagogia",
            regex: /\b(psicopedagogia|psicopedagogo|reforço escolar|acompanhamento escolar|dificuldade escolar|alfabetização|adaptação curricular|dislexia|discalculia)\b/i
        },
        {
            id: "psicologia",
            regex: /\b(psicolog(?:ia|o|a)|psicoterapia|comportamento|ansiedade|depressão|medo|fobia|birra|não obedece|agressivo|não dorme|insônia|pesadelo|enurese|encoprese|autolesão|toc|ritual|hiperativid|tdah|tda)(?!\s*pedagog|.*neuro)\b/i
        },
        {
            id: "neuropsicologia",
            regex: /\b(neuropsicolog(?:ia|o|a)|neuropsi|avaliação neuropsicológica|laudo|teste de qi|funções executivas|memória|superdotação|altas habilidades|neurodesenvolvimento|tea|autismo|espectro autista)\b/i
        },
        {
            id: "musicoterapia",
            regex: /\b(musicoterapia|musicoterapeuta|música|musical|ritmo|melodia|instrumento musical|estimulação musical)\b/i
        },
    ];

    const detectAreaInText = (txt) => {
        if (!txt) return null;
        const found = AREA_DEFS.filter((a) => a.regex.test(txt)).map((a) => a.id);
        if (found.length === 1) return found[0];
        return null;
    };

    if (flags.therapyArea) return flags.therapyArea;
    if (context.therapyArea) return context.therapyArea;

    const areaNow = detectAreaInText(t);
    if (areaNow) return areaNow;

    const recentTexts = historyTexts.slice(-5).reverse();
    for (const txt of recentTexts) {
        const area = detectAreaInText(txt);
        if (area) return area;
    }

    const combined = [t, ...historyTexts].join(" ");
    const fallbackArea = detectAreaInText(combined);
    if (fallbackArea) return fallbackArea;

    // 🆕 CLINICAL MAPPER: Detecta área por sintomas quando regex não pegou
    const clinicalInference = resolveClinicalArea(t);
    if (clinicalInference && clinicalInference.confidence >= 0.7) {
        console.log(`[CLINICAL MAPPER] Área inferida por sintoma: ${clinicalInference.area} (${clinicalInference.condition})`);
        return clinicalInference.area;
    }

    return null;
}

/**
 * 🤖 IA COM DADOS DE TERAPIAS + HISTÓRICO COMPLETO
 */
async function callClaudeWithTherapyData({
    therapies,
    flags,
    userText,
    lead,
    context,
    analysis: passedAnalysis = null,
}) {
    const { getTherapyData } = await import("../utils/therapyDetector.js");


    const therapiesInfo = therapies
        .map((t) => {
            const data = getTherapyData(t.id);
            if (!data) {
                return `${t.name.toUpperCase()}: (sem dados cadastrados ainda)`;
            }
            return `${t.name.toUpperCase()}: ${data.explanation} | Preço: ${data.price}`;
        })
        .join("\n");

    const {
        stage,
        messageCount,
        isPatient,
        needsUrgency,
        daysSinceLastContact,
        conversationHistory,
        conversationSummary,
        shouldGreet,
    } = context;

    const systemContext = buildSystemContext(flags, userText, stage, context);
    const dynamicSystemPrompt = buildDynamicSystemPrompt(systemContext);

    let ageContextNote = "";
    if (conversationHistory && conversationHistory.length > 0) {
        const historyText = conversationHistory
            .map((msg) =>
                typeof msg.content === "string"
                    ? msg.content
                    : JSON.stringify(msg.content),
            )
            .join(" \n ")
            .toLowerCase();

        const ageMatch = historyText.match(/(\d{1,2})\s*anos\b/);
        if (ageMatch) {
            const detectedAge = parseInt(ageMatch[1], 10);
            if (!isNaN(detectedAge)) {
                const detectedAgeGroup =
                    detectedAge < 12 ? "criança" : detectedAge < 18 ? "adolescente" : "adulto";

                ageContextNote += `\nPERFIL_IDADE: já foi informado no histórico que o paciente é ${detectedAgeGroup} e tem ${detectedAge} anos. NÃO pergunte a idade novamente; use essa informação.`;
            }
        }

        if (/crian[çc]a|meu filho|minha filha|minha criança|minha crianca/.test(historyText)) {
            ageContextNote +=
                "\nPERFIL_IDADE: o histórico deixa claro que o caso é de CRIANÇA. NÃO pergunte novamente se é para criança ou adulto; apenas siga a partir dessa informação.";
        }
    }

    const patientStatus = isPatient
        ? "\n⚠️ PACIENTE ATIVO - Tom próximo!"
        : "";
    const urgencyNote = needsUrgency
        ? `\n🔥 ${daysSinceLastContact} dias sem falar - reative com calor!`
        : "";

    let analysis = passedAnalysis;
    let intelligenceNote = "";

    if (!analysis) {
        try {
            analysis = await analyzeLeadMessage({
                text: userText,
                lead,
                history: conversationHistory || [],
            });
        } catch (err) {
            console.warn("⚠️ leadIntelligence falhou (não crítico):", err.message);
        }
    }

    if (analysis?.extracted) {
        const { idade, urgencia, queixa } = analysis.extracted;
        const { primary, sentiment } = analysis.intent || {};

        intelligenceNote = "\n📊 PERFIL INTELIGENTE:";
        if (idade) intelligenceNote += `\n- Idade: ${idade} anos`;
        if (queixa) intelligenceNote += `\n- Queixa: ${queixa}`;
        if (urgencia) intelligenceNote += `\n- Urgência: ${urgencia}`;
        if (primary) intelligenceNote += `\n- Intenção: ${primary}`;
        if (sentiment) intelligenceNote += `\n- Sentimento: ${sentiment}`;
        if (urgencia === "alta") {
            intelligenceNote +=
                "\n🔥 ATENÇÃO: Caso de urgência ALTA detectado - priorize contexto temporal!";
        }
    }

    const messages = [];

    if (conversationSummary) {
        messages.push({
            role: "user",
            content: `📋 CONTEXTO DE CONVERSAS ANTERIORES:\n\n${conversationSummary}\n\n---\n\nAs mensagens abaixo são a continuação RECENTE desta conversa:`,
        });
        messages.push({
            role: "assistant",
            content:
                "Entendi o contexto completo. Vou continuar a conversa de forma natural, lembrando de tudo que foi discutido.",
        });
    }

    if (conversationHistory && conversationHistory.length > 0) {
        const safeHistory = conversationHistory.map((msg) => ({
            role: msg.role || "user",
            content:
                typeof msg.content === "string"
                    ? msg.content
                    : JSON.stringify(msg.content),
        }));
        messages.push(...safeHistory);
    }
    const { mentionsOrelhinha } = detectNegativeScopes(userText);

    if (mentionsOrelhinha) {
        const detected = detectAllTherapies(userText);
        const hasLinguinha = detected.some(t => t.id === "tongue_tie");

        return hasLinguinha
            ? ensureSingleHeart(TESTE_LINGUINHA_WISDOM.teste.explicacao_humanizada)
            : "O teste da orelhinha (triagem auditiva/TAN) nós não realizamos aqui. Mas podemos te ajudar com avaliação e terapias (Fono, Psico, TO, Fisio…). O que você está buscando exatamente: avaliação, terapia ou um exame específico? 💚";
    }

    // 💸 LEGACY REMOVED: Preço agora é tratado pelo DecisionResolver
    // Se action='RULE' → ResponseBuilder responde automaticamente
    // Se action='HYBRID/AI' → fluxo continua com contexto enriquecido
    // Mantido para referência: value pitch logic movida para ResponseBuilder
    /*
    if (flags.asksPrice) {
        const insights = await getLatestInsights();
        ...
    }
    */

    // 🧠 Monta nota sobre dados já coletados (evita perguntar de novo)
    // ✅ USA DADOS NORMALIZADOS DO CONTEXTO (não apenas do lead cru)
    const knownDataNote = (() => {
        const parts = [];
        // Usa dados normalizados do contexto (que busca em múltiplas fontes)
        // 🛠️ FIX: usa 'context' (parâmetro da função), não 'safeContext' (ainda não definido aqui)
        const ctx = context || {};
        const fullName = lead?.patientInfo?.fullName;
        const age = ctx.patientAge ?? lead?.patientInfo?.age ?? lead?.patientAge;
        const birthday = lead?.patientInfo?.birthday;
        const complaint = ctx.primaryComplaint ?? ctx.complaint ?? lead?.complaint;
        const therapyArea = ctx.therapyArea ?? lead?.therapyArea;
        const period = ctx.preferredTime ?? lead?.pendingPreferredPeriod;

        if (fullName) parts.push(`nome: "${fullName}"`);
        if (age) parts.push(`idade: ${age}`);
        if (birthday) parts.push(`nascimento: ${birthday}`);
        if (complaint) parts.push(`queixa: "${complaint}"`);
        if (therapyArea) parts.push(`área: ${therapyArea}`);
        if (period) parts.push(`período: ${period}`);
        return parts.length ? `\n\n🧠 JÁ SABEMOS — NÃO PERGUNTE NOVAMENTE: ${parts.join(' | ')}` : '';
    })();

    const _missing = getMissingFields(lead, {}, userText);
    const missingFieldsNote = _missing.length
        ? `\n\n📍 AINDA FALTA COLETAR (1 por vez, de forma natural): ${_missing.join(', ')}`
        : `\n\n✅ DADOS COMPLETOS — foque em confirmar agendamento.`;

    const currentPrompt = `${userText}${knownDataNote}${missingFieldsNote}

📊 CONTEXTO DESTA MENSAGEM:
TERAPIAS DETECTADAS:
${therapiesInfo}

FLAGS: Preço=${flags.asksPrice} | Agendar=${flags.wantsSchedule}
ESTÁGIO: ${stage} (${messageCount} msgs totais)${patientStatus}${urgencyNote}${ageContextNote}${intelligenceNote}

🎯 INSTRUÇÕES CRÍTICAS:
1. ${shouldGreet ? "✅ Pode cumprimentar naturalmente se fizer sentido" : "🚨 NÃO USE SAUDAÇÕES (Oi/Olá) - conversa está ativa"}
2. ${conversationSummary ? "🧠 Você TEM o resumo completo acima - USE esse contexto!" : "📜 Leia TODO o histórico de mensagens acima antes de responder"}
3. 🚨 NÃO PERGUNTE o que JÁ foi informado/discutido (idade, se é criança/adulto, área principal etc.)
4. Responda de forma acolhedora, focando na dúvida real.
5. Máximo 2–3 frases, tom natural e humano, como uma recepcionista experiente.
6. Exatamente 1 💚 no final.`;

    messages.push({
        role: "user",
        content: currentPrompt,
    });

    const textResp = await callAI({
        systemPrompt: dynamicSystemPrompt,
        messages,
        maxTokens: 300,
        temperature: 0.7,
    });

    return textResp || "Como posso te ajudar? 💚";
}

/**
 * 🤖 IA COM CONTEXTO INTELIGENTE + CACHE MÁXIMO
 */
async function callAmandaAIWithContext(
    userText,
    lead,
    context = {},
    flagsFromOrchestrator = {},
    analysisFromOrchestrator = null,
) {


    const safeContext = context || {};
    const {
        stage = "novo",
        messageCount = 0,
        mentionedTherapies = [],
        isPatient = false,
        needsUrgency = false,
        daysSinceLastContact = 0,
        conversationHistory = [],
        conversationSummary = null,
        shouldGreet = false,  // 🛡️ FIX: default seguro — só sauda se enrichedContext mandar true
        customInstruction = null,
        toneMode = "acolhimento",
    } = safeContext;

    let toneInstruction = "";

    if (toneMode === "premium") {
        toneInstruction = DYNAMIC_MODULES.consultoriaModeContext || "";
    } else {
        toneInstruction = DYNAMIC_MODULES.acolhimentoModeContext || "";
    }


    const flags =
        flagsFromOrchestrator && Object.keys(flagsFromOrchestrator).length
            ? flagsFromOrchestrator
            : detectAllFlags(userText, lead, context);

    const therapyAreaForScheduling =
        context.therapyArea ||
        flags.therapyArea ||

        lead?.therapyArea;

    const hasAgeOrProfile =
        flags.mentionsChild ||
        flags.mentionsTeen ||
        flags.mentionsAdult ||
        context.ageGroup ||
        lead?.ageGroup ||
        lead?.patientInfo?.age ||
        lead?.qualificationData?.extractedInfo?.idade ||  // ✅ FIX
        /\d+\s*anos?\b/i.test(userText);

    let scheduleInfoNote = "";

    if (stage === "interessado_agendamento") {
        scheduleInfoNote =
            "No WhatsApp, considere que o telefone de contato principal já é o número desta conversa. " +
            "Para agendar, você precisa garantir: nome completo do paciente e um dia/período preferido. " +
            "Só peça outro telefone se a pessoa fizer questão de deixar um número diferente.";

        if (!therapyAreaForScheduling && !hasAgeOrProfile) {
            scheduleInfoNote +=
                " Ainda faltam: área principal (fono, psico, TO etc.) e se é criança/adolescente/adulto.";
        } else if (!therapyAreaForScheduling) {
            scheduleInfoNote +=
                " Ainda falta descobrir a área principal (fono, psico, TO etc.).";
        } else if (!hasAgeOrProfile) {
            scheduleInfoNote +=
                " Ainda falta deixar claro se é criança, adolescente ou adulto.";
        }
    }

    const systemContext = buildSystemContext(flags, userText, stage, context);
    let dynamicSystemPrompt = buildDynamicSystemPrompt(systemContext);

    // HYBRID: injeta contexto estratégico do DecisionResolver no prompt
    if (safeContext?.decision?.action === 'HYBRID') {
        const d = safeContext.decision;
        dynamicSystemPrompt += `\n\n[DECISÃO ESTRATÉGICA]\n` +
            `- Confiança: ${(d.systemConfidence * 100).toFixed(0)}%\n` +
            `- Domínio: ${d.domain || 'desconhecido'}\n` +
            `- Razão: ${d.reason || ''}\n` +
            `Calibre sua resposta: seja mais assertivo na condução, menos genérico, foque em converter para agendamento se o contexto permitir.`;
    }

    const therapiesContext =
        mentionedTherapies.length > 0
            ? `\n🎯 TERAPIAS DISCUTIDAS: ${mentionedTherapies.join(", ")}`
            : "";

    let historyAgeNote = "";
    if (conversationHistory && conversationHistory.length > 0) {
        const historyText = conversationHistory
            .map((msg) =>
                typeof msg.content === "string"
                    ? msg.content
                    : JSON.stringify(msg.content),
            )
            .join(" \n ")
            .toLowerCase();

        const ageMatch = historyText.match(/(\d{1,2})\s*anos\b/);
        if (ageMatch) {
            const age = parseInt(ageMatch[1], 10);
            if (!isNaN(age)) {
                const group = age < 12 ? "criança" : age < 18 ? "adolescente" : "adulto";
                historyAgeNote += `\nPERFIL_IDADE_HISTÓRICO: já foi informado que o paciente é ${group} e tem ${age} anos. NÃO pergunte a idade novamente.`;
            }
        }

        if (/crian[çc]a|meu filho|minha filha|minha criança|minha crianca/.test(historyText)) {
            historyAgeNote +=
                "\nPERFIL_IDADE_HISTÓRICO: o histórico mostra que o caso é de CRIANÇA. NÃO volte a perguntar se é para criança ou adulto.";
        }
    }

    let ageProfileNote = "";
    if (flags.mentionsChild) {
        ageProfileNote =
            "PERFIL: criança (fale com o responsável, não pergunte de novo se é criança ou adulto).";
    } else if (flags.mentionsTeen) {
        ageProfileNote = "PERFIL: adolescente.";
    } else if (flags.mentionsAdult) {
        ageProfileNote = "PERFIL: adulto falando de si.";
    }

    let stageInstruction = "";
    switch (stage) {
        case "novo":
            stageInstruction = "Seja acolhedora. Pergunte necessidade antes de preços.";
            break;

        case "triagem_agendamento":
            stageInstruction =
                "Lead quer agendar, mas ainda falta TRIAGEM. Faça 1–2 perguntas no máximo para descobrir: " +
                "1) qual área (fono/psico/TO/fisio/neuropsico) e 2) para quem (criança/adolescente/adulto). " +
                "Não ofereça horários e não fale de valores agora. Seja direta e humana.";
            break;

        case "pesquisando_preco":
            stageInstruction =
                "Lead já perguntou valores. Use VALOR→PREÇO→ENGAJAMENTO.";
            break;
        case "engajado":
            stageInstruction = `Lead trocou ${messageCount} msgs. Seja mais direta.`;
            break;
        case "interessado_agendamento":
            if (flags.wantsSchedule || flags.choseSlot || context.pendingSchedulingSlots) {
                stageInstruction =
                    "Lead já demonstrou que QUER AGENDAR e a mensagem fala de horário/vaga/dia. " +
                    "O sistema já te mostra horários REAIS disponíveis: use apenas esses. " +
                    "Seu objetivo é ajudar a pessoa a escolher um dos horários e coletar os dados mínimos " +
                    "do paciente: nome completo e data de nascimento. " +
                    "Considere que o telefone de contato principal é o número desta conversa (WhatsApp); " +
                    "só peça outro telefone se a pessoa quiser deixar um número diferente.";
            } else {
                stageInstruction =
                    "Esse lead já mostrou interesse em agendar em algum momento, mas a mensagem atual é mais " +
                    "dúvida do que pedido de horário. Responda a dúvida e, se fizer sentido, lembre de forma leve " +
                    "que dá pra agendar uma avaliação quando a família se sentir pronta, sem pressionar.";
            }
            break;

        case "paciente":
            stageInstruction = "PACIENTE ATIVO! Tom próximo.";
            break;
    }

    const patientNote = isPatient ? "\n⚠️ PACIENTE - seja próxima!" : "";
    const urgencyNote = needsUrgency
        ? `\n🔥 ${daysSinceLastContact} dias sem contato - reative!`
        : "";

    let analysis = analysisFromOrchestrator;
    let intelligenceNote = "";
    if (!analysis) {
        try {
            analysis = await analyzeLeadMessage({
                text: userText,
                lead,
                history: conversationHistory || [],
            });
        } catch (err) {
            console.warn("⚠️ leadIntelligence falhou (não crítico):", err.message);
        }
    }

    if (analysis?.extracted) {
        const { idade, urgencia, queixa } = analysis.extracted;
        intelligenceNote = `\n📊 PERFIL: Idade ${idade || "?"} | Urgência ${urgencia || "normal"
            } | Queixa ${queixa || "geral"}`;
        if (urgencia === "alta") {
            intelligenceNote += "\n🔥 URGÊNCIA ALTA DETECTADA!";
        }
    }

    const insights = await getLatestInsights();
    let openingsNote = "";
    let closingNote = "";

    if (insights?.data?.bestOpeningLines?.length) {
        const examples = insights.data.bestOpeningLines
            .slice(0, 3)
            .map((o) => `- "${o.text}"`)
            .join("\n");

        openingsNote = `\n💡 EXEMPLOS DE ABERTURA QUE FUNCIONARAM:\n${examples}`;
    }

    if (insights?.data?.successfulClosingQuestions?.length) {
        const examples = insights.data.successfulClosingQuestions
            .slice(0, 5)
            .map((q) => `- "${q.question}"`)
            .join("\n");

        closingNote = `\n💡 PERGUNTAS DE FECHAMENTO QUE LEVARAM A AGENDAMENTO:\n${examples}\nUse esse estilo (sem copiar exatamente).`;
    }

    let slotsInstruction = "";

    if (context.pendingSchedulingSlots?.primary) {
        const slots = context.pendingSchedulingSlots;

        const allSlots = (slots.all && slots.all.length
            ? slots.all
            : [
                slots.primary,
                ...(slots.alternativesSamePeriod || []),
            ]
        ).filter(Boolean);

        const periodStats = { morning: 0, afternoon: 0, evening: 0 };

        for (const s of allSlots) {
            const hour = parseInt(s.time.slice(0, 2), 10);
            if (hour < 12) periodStats.morning++;
            else if (hour < 18) periodStats.afternoon++;
            else periodStats.evening++;
        }

        const slotsText = [
            `1️⃣ ${formatSlot(slots.primary)}`,
            ...slots.alternativesSamePeriod.slice(0, 2).map((s, i) =>
                `${i + 2}️⃣ ${formatSlot(s)}`,
            ),
        ].join("\n");

        slotsInstruction = `
🎯 HORÁRIOS REAIS DISPONÍVEIS:
${slotsText}

PERÍODOS:
- Manhã: ${periodStats.morning}
- Tarde: ${periodStats.afternoon}
- Noite: ${periodStats.evening}

REGRAS CRÍTICAS:
- Se o paciente pedir "de manhã" e Manhã = 0:
  → Explique que, pra essa área, no momento as vagas estão concentradas nos horários acima
    (normalmente à tarde/noite) e ofereça 1–3 opções reais.
- Só diga que "tem de manhã" se Manhã > 0.
- Ofereça no máximo 2-3 desses horários.
- NÃO invente horário diferente.
- Fale sempre "dia + horário" (ex.: quinta às 14h).
- Pergunte qual o lead prefere.
`;
    } else if (stage === "interessado_agendamento") {
        slotsInstruction = `
⚠️ Ainda não conseguimos buscar horários disponíveis.
${useModule("noNameBeforeSlotRule")}
- NÃO peça nome do paciente ainda.
- Pergunte qual DIA DA SEMANA fica melhor.
- NÃO diga "vou encaminhar pra equipe".
`;
    }

    // 📚 CONSULTA BASE DE CONHECIMENTO REAL
    // 🆕 Se InsuranceDetector detectou plano específico, usa como topic
    let resolvedTopic = resolveTopicFromFlags(flags) || therapyAreaForScheduling;

    // 🏥 PRIORIZA PLANO ESPECÍFICO detectado (Unimed, Ipasgo, etc.)
    if (flags._insurance?.isSpecific && flags._insurance?.wisdomKey) {
        console.log(`🏥 [WISDOM] Usando plano específico: ${flags._insurance.wisdomKey}`);
        // Usa o wisdom específico do plano (se existir em clinicWisdom.js)
        resolvedTopic = flags._insurance.wisdomKey;
    }

    const { wisdomBlock, wisdom: wisdomData } = getWisdomForContext(resolvedTopic, flags);

    // 🆕 MONTA CONTEXTO ADICIONAL (Manual Intent, TEA Status, Scheduling Decision)
    let additionalContext = "";

    if (safeContext.manualIntent) {
        additionalContext += `\n🎯 INTENÇÃO DETECTADA: ${safeContext.manualIntent.intent} (${safeContext.manualIntent.category})`;
    }

    if (safeContext.teaStatus && safeContext.teaStatus !== "desconhecido") {
        const teaContextMap = {
            "laudo_confirmado": "Paciente tem laudo de TEA confirmado - prioridade e acolhimento especial",
            "suspeita": "Família suspeita de TEA - ainda sem laudo, necessidade de orientação",
        };
        additionalContext += `\n🧩 CONTEXTO TEA: ${teaContextMap[safeContext.teaStatus] || safeContext.teaStatus}`;
    }

    if (safeContext.shouldOfferScheduling !== undefined) {
        additionalContext += safeContext.shouldOfferScheduling
            ? "\n📅 MOMENTO: Contexto propício para oferecer agendamento se fizer sentido"
            : "\n📅 MOMENTO: Ainda não é hora de pressionar agendamento - foco em informação";
    }

    // 🆕 REGRA 6: Instrução específica para URGÊNCIA/ALTA_INTENCAO
    if (safeContext.forceUrgency || safeContext.forceHighIntent) {
        additionalContext += `\n\n🚨 URGÊNCIA/ALTA INTENÇÃO DETECTADA — REGRAS ESPECÍFICAS:` +
            `\n- NÃO use "Me conta o que você está buscando" ou saudações genéricas` +
            `\n- NÃO peça para repetir nome/idade se já estiver no lead` +
            `\n- OFEREÇA horários disponíveis IMEDIATAMENTE ou peça a especialidade de forma direta` +
            `\n- Se não tiver no dia/período solicitado, ofereça a alternativa mais próxima` +
            `\n- Mantenha tom acolhedor mas ÁGIL — o lead quer resolver logo`;
    }

    // 🧠 Monta nota sobre dados já coletados (evita perguntar de novo)
    const knownDataNote = (() => {
        const parts = [];
        if (lead?.patientInfo?.fullName) parts.push(`nome: "${lead.patientInfo.fullName}"`);
        if (lead?.patientInfo?.age) parts.push(`idade: ${lead.patientInfo.age}`);
        if (lead?.patientInfo?.birthday) parts.push(`nascimento: ${lead.patientInfo.birthday}`);
        if (lead?.complaint) parts.push(`queixa: "${lead.complaint}"`);
        if (lead?.therapyArea) parts.push(`área: ${lead.therapyArea}`);
        if (lead?.pendingPreferredPeriod) parts.push(`período: ${lead.pendingPreferredPeriod}`);
        return parts.length ? `\n\n🧠 JÁ SABEMOS — NÃO PERGUNTE NOVAMENTE: ${parts.join(' | ')}` : '';
    })();

    const _missing = getMissingFields(lead, {}, userText);
    const missingFieldsNote = _missing.length
        ? `\n\n📍 AINDA FALTA COLETAR (1 por vez, de forma natural): ${_missing.join(', ')}`
        : `\n\n✅ DADOS COMPLETOS — foque em confirmar agendamento.`;

    const currentPrompt = `${userText}${knownDataNote}${missingFieldsNote}
${wisdomBlock ? `
📚 REGRAS DA CLÍNICA (OBRIGATÓRIO — use esses dados exatos):
${wisdomBlock}
` : ''}
                                    CONTEXTO:
                                    LEAD: ${lead?.name || "Desconhecido"} | ESTÁGIO: ${stage} (${messageCount} msgs)${therapiesContext}${patientNote}${urgencyNote}${intelligenceNote}${additionalContext}
                                    ${ageProfileNote ? `PERFIL_IDADE: ${ageProfileNote}` : ""}${historyAgeNote}
                                    ${scheduleInfoNote ? `\n${scheduleInfoNote}` : ""}${openingsNote}${closingNote}

                                    INSTRUÇÕES:
                                    - ${stageInstruction}
                                    ${slotsInstruction ? `- ${slotsInstruction}` : ""}
                                    ${toneInstruction ? `\n🎭 TOM DE CONDUÇÃO (OBRIGATÓRIO):\n${toneInstruction}` : ""}

                                    ${customInstruction ? `\n🎯 INSTRUÇÃO ESPECÍFICA:\n${customInstruction}` : ""}


                                    REGRAS:
                                    - ${shouldGreet ? "Pode cumprimentar" : "🚨 NÃO use Oi/Olá - conversa ativa"}
                                    - ${conversationSummary ? "🧠 USE o resumo acima" : "📜 Leia histórico acima"}
                                    - 🚨 NÃO pergunte o que já foi dito (principalmente idade, se é criança/adulto e a área principal)
                                    - Em fluxos de AGENDAMENTO (WhatsApp):
                                    - Considere que o telefone de contato principal já é o número desta conversa.
                                    - Garanta que você tenha: nome completo do paciente + dia/período preferido.
                                    - Só peça outro telefone se a pessoa quiser deixar um número diferente.
                                    - Depois que tiver esses dados, faça UMA única mensagem dizendo que vai encaminhar o agendamento pra equipe.

                                    - 1-3 frases, tom humano
                                    - 1 💚 final`;

    const messages = [];

    if (conversationSummary) {
        messages.push({
            role: "user",
            content: `📋 CONTEXTO ANTERIOR:\n\n${conversationSummary}\n\n---\n\nMensagens recentes abaixo:`,
        });
        messages.push({
            role: "assistant",
            content: "Entendi o contexto. Continuando...",
        });
    }

    if (conversationHistory && conversationHistory.length > 0) {
        const safeHistory = conversationHistory.map((msg) => ({
            role: msg.role || "user",
            content:
                typeof msg.content === "string"
                    ? msg.content
                    : JSON.stringify(msg.content),
        }));
        messages.push(...safeHistory);
    }

    messages.push({
        role: "user",
        content: currentPrompt,
    });

    const textResp = await callAI({
        systemPrompt: dynamicSystemPrompt,
        messages,
        maxTokens: 300,
        temperature: 0.6,
    });

    if (/encaminh(ar|ei|o).*equipe/i.test(textResp)) {
        await safeLeadUpdate(lead._id, {
            $set: { "autoBookingContext.handoffSentAt": new Date().toISOString() }
        });
    }

    // 🛡️ ENFORCEMENT LAYER — sempre ativo
    // Valida blocos estruturais: preço, plano, localização, slots inventados
    // strictMode: true aplica fallback automático em violações críticas
    const enforcementResult = enforceStructuralRules(textResp, {
        flags,
        lead,
        userText: userText
    }, {
        strictMode: true,   // ✅ FIX: ativo para garantir "nunca inventar horário/opção"
        logViolations: true
    });

    if (enforcementResult.wasEnforced) {
        console.log('🚨 [ENFORCEMENT] Fallback aplicado — resposta original violou RN');
        return enforcementResult.response;
    }

    // Log de score para monitoramento
    if (enforcementResult.validation.stats.totalRulesChecked > 0) {
        console.log(`✅ [ENFORCEMENT] Score: ${(enforcementResult.validation.score * 100).toFixed(0)}% (${enforcementResult.validation.stats.passedRules}/${enforcementResult.validation.stats.totalRulesChecked} regras)`);
    }

    return textResp || "Como posso te ajudar? 💚";
}

function normalizeClaudeMessages(messages = []) {
    return messages.map((m) => ({
        role: m.role,
        content:
            typeof m.content === "string"
                ? [{ type: "text", text: m.content }]
                : m.content,
    }));
}


/**
 * 🔒 REGRA DE ESCOPO DA CLÍNICA
 */
function enforceClinicScope(aiText = "", userText = "") {
    if (!aiText) return aiText;

    const t = aiText.toLowerCase();
    const u = (userText || "").toLowerCase();
    const combined = `${u} ${t}`;

    const isHearingExamContext =
        /(teste\s+da\s+orelhinha|triagem\s+auditiva(\s+neonatal)?|\bTAN\b|emiss(ões|oes)?\s+otoac(u|ú)stic(as)?|exame\s+auditivo|audiometria|bera|peate)/i
            .test(combined);

    const isFrenuloOrLinguinha =
        /\b(fr[eê]nulo|freio\s+lingual|fr[eê]nulo\s+lingual|teste\s+da\s+linguinha|linguinha)\b/i.test(
            combined,
        );
    const mentionsOrelhinha =
        /(teste\s+da\s+orelhinha|triagem\s+auditiva(\s+neonatal)?|\bTAN\b)/i.test(combined);

    if (mentionsOrelhinha) {
        return ensureSingleHeart(
            "O teste da orelhinha (triagem auditiva) nós **não realizamos** aqui. " +
            "A gente faz avaliação fonoaudiológica, fonoterapia e o Teste da Linguinha. " +
            "Quer que eu te explique sobre algum desses? 💚"
        );
    }
    const mentionsRPGorPilates = /\brpg\b|pilates/i.test(combined);

    if (isHearingExamContext && !isFrenuloOrLinguinha) {
        return (
            "Aqui na Clínica Fono Inova nós **não realizamos exames de audição** " +
            "(como audiometria ou BERA/PEATE). Nosso foco é na **avaliação e terapia fonoaudiológica**. " +
            "Podemos agendar uma avaliação para entender melhor o caso e, se necessário, te orientar " +
            "sobre onde fazer o exame com segurança. 💚"
        );
    }

    if (mentionsRPGorPilates) {
        return (
            "Na Fono Inova, a Fisioterapia é voltada para **atendimento terapêutico clínico**, " +
            "e não trabalhamos com **RPG ou Pilates**. Se você quiser, podemos agendar uma avaliação " +
            "para entender direitinho o caso e indicar a melhor forma de acompanhamento. 💚"
        );
    }

    const isPostSurgeryVoice =
        /\b(rouquid[aã]o|perda\s+de\s+voz|voz\s+rouca|afonia)\b/i.test(combined) &&
        /\b(p[oó]s[-\s]?(cirurgia|operat[oó]rio)|ap[oó]s\s+(a\s+)?cirurgia|depois\s+da\s+cirurgia|intuba[çc][aã]o|entuba[çc][aã]o|cirurgia\s+de\s+tireoide)\b/i.test(combined);

    if (isPostSurgeryVoice) {
        return (
            "Aqui na Fono Inova **não trabalhamos com reabilitação vocal pós-cirúrgica** " +
            "(como após intubação ou cirurgia de tireoide). " +
            "Nosso foco é em casos de rouquidão por uso excessivo da voz, " +
            "alterações vocais em professores, cantores, etc. " +
            "Se precisar de indicação de especialista pra esse caso, posso tentar te ajudar! 💚"
        );
    }

    return aiText;
}


const buildSystemContext = (flags, text = "", stage = "novo", context = {}) => ({
    isHotLead: flags.visitLeadHot || stage === "interessado_agendamento",
    isColdLead: flags.visitLeadCold || stage === "novo",
    
    // 🆕 Contexto LP (Landing Page)
    source: context?.source,
    lpPage: context?.lpPage,
    lpIntent: context?.lpIntent,

    negativeScopeTriggered: /audiometria|bera|rpg|pilates/i.test(text),

    priceObjectionTriggered:
        flags.mentionsPriceObjection ||
        /outra\s+cl[ií]nica|mais\s+(barato|em\s+conta)|encontrei.*barato|vou\s+fazer\s+l[aá]|n[aã]o\s+precisa\s+mais|muito\s+caro|caro\s+demais/i.test(
            text,
        ),

    insuranceObjectionTriggered:
        flags.mentionsInsuranceObjection ||
        /queria\s+(pelo|usar)\s+plano|s[oó]\s+atendo\s+por\s+plano|particular\s+[eé]\s+caro|pelo\s+conv[eê]nio/i.test(
            text,
        ),

    timeObjectionTriggered:
        flags.mentionsTimeObjection ||
        /n[aã]o\s+tenho\s+tempo|sem\s+tempo|correria|agenda\s+cheia/i.test(text),

    otherClinicObjectionTriggered:
        flags.mentionsOtherClinicObjection ||
        /j[aá]\s+(estou|tô)\s+(vendo|fazendo)|outra\s+cl[ií]nica|outro\s+profissional/i.test(
            text,
        ),

    teaDoubtTriggered:
        flags.mentionsDoubtTEA ||
        /ser[aá]\s+que\s+[eé]\s+tea|suspeita\s+de\s+(tea|autismo)|muito\s+novo\s+pra\s+saber/i.test(
            text,
        ),
});

// ============================================================================
// 🆕 ENTITY-DRIVEN SIMPLIFICADO (NOVA IMPLEMENTAÇÃO)
// ============================================================================

/**
 * 🧠 AMANDA SÊNIOR - Processamento Entity-Driven
 * Extrai tudo → Valida → Decide → Responde
 */
async function processMessageLikeAmanda(text, lead = {}, enrichedContext = null) {
    console.log('🧠 [AMANDA-SÊNIOR] Analisando:', text.substring(0, 50));

    // 1. EXTRAÇÃO MÁXIMA
    // 🔥 USA flagsDetector.js COMPLETO (detectAllFlags — mais rico que deriveFlagsFromText)
    const fullFlags = detectAllFlags(text);

    const extracted = {
        responsibleName: null,
        patientName: null,
        patientAge: null,
        patientAgeUnit: 'anos',
        complaint: null,
        therapyArea: null,
        preferredPeriod: null,
        intent: 'informacao',
        flags: {
            // Flags básicas (sempre presentes)
            asksPrice: fullFlags.asksPrice,
            wantsSchedule: fullFlags.wantsSchedule,
            mentionsChild: fullFlags.mentionsChild || fullFlags.ageGroup === 'crianca',
            asksPlans: fullFlags.asksPlans,
            asksLocation: fullFlags.asksLocation,

            // 🔥 FLAGS DO flagsDetector.js que estavam sendo IGNORADAS
            wantsPartnershipOrResume: fullFlags.wantsPartnershipOrResume,
            wantsJobOrInternship: fullFlags.wantsJobOrInternship,
            jobArea: fullFlags.jobArea,
            hasProfessionalIntro: fullFlags.hasProfessionalIntro,
            hasJobContext: fullFlags.hasJobContext,
            hasCurriculumTerms: fullFlags.hasCurriculumTerms,

            // Outras flags importantes
            mentionsTEA_TDAH: fullFlags.mentionsTEA_TDAH,
            mentionsPriceObjection: fullFlags.mentionsPriceObjection,
            mentionsInsuranceObjection: fullFlags.mentionsInsuranceObjection,
            mentionsTimeObjection: fullFlags.mentionsTimeObjection,
            mentionsOtherClinicObjection: fullFlags.mentionsOtherClinicObjection,
            mentionsDoubtTEA: fullFlags.mentionsDoubtTEA,
            mentionsInvestigation: fullFlags.mentionsInvestigation,
            mentionsLaudo: fullFlags.mentionsLaudo,
            mentionsNeuropediatra: fullFlags.mentionsNeuropediatra,
            mentionsUrgency: fullFlags.mentionsUrgency,
            isEmotional: fullFlags.isEmotional,
            isHotLead: fullFlags.isHotLead,
            isJustBrowsing: fullFlags.isJustBrowsing,
            givingUp: fullFlags.givingUp,
            refusesOrDenies: fullFlags.refusesOrDenies,
            confirmsData: fullFlags.confirmsData,
            alreadyScheduled: fullFlags.alreadyScheduled,
            wantsCancel: fullFlags.wantsCancel,
            wantsReschedule: fullFlags.wantsReschedule,
            saysThanks: fullFlags.saysThanks,
            saysBye: fullFlags.saysBye,

            // Flags de idade
            mentionsBaby: fullFlags.mentionsBaby,
            mentionsTeen: fullFlags.mentionsTeen,
            mentionsAdult: fullFlags.mentionsAdult,
            ageGroup: fullFlags.ageGroup,

            // Logs para debug
            _rawFlags: fullFlags // Mantém referência completa para debug
        }
    };

    console.log('[FLAGS-DETECTOR] Flags extraídos:', Object.entries(extracted.flags)
        .filter(([k, v]) => v === true || (typeof v === 'string' && v))
        .reduce((a, [k, v]) => { a[k] = v; return a; }, {}));

    // 🔧 EXTRAÇÃO DE NOME - Múltiplos padrões
    const namePatterns = [
        // Padrão 1: "Ele se chama Pedro Henrique"
        { regex: /(?:ele|ela|a criança|o paciente|meu filho|minha filha|meu bebê|minha bebê)\s+(?:se\s+)?chama\s+([A-ZÀ-Ü][a-zà-ú]+(?:\s+[A-ZÀ-Ü][a-zà-ú]+){0,2})/i, group: 1 },
        // Padrão 2: "O nome dela é Ana Clara" / "O nome é João" / "O nome dela é Maria"
        { regex: /(?:o\s+)?nome\s+(?:d[ea]l[ea]|da criança|do paciente)(?:\s+é)?\s+([A-ZÀ-Ü][a-zà-ú]+(?:\s+[A-ZÀ-Ü][a-zà-ú]+){0,2})/i, group: 1 },
        // Padrão 2b: "O nome é Pedro" (sem "dela/dele")
        { regex: /(?:o\s+)?nome\s+é\s+([A-ZÀ-Ü][a-zà-ú]+(?:\s+[A-ZÀ-Ü][a-zà-ú]+){0,2})/i, group: 1 },
        // Padrão 3: "Sou o João" / "Me chamo Maria"
        { regex: /(?:sou|me chamo)\s+(?:o|a)?\s+([A-ZÀ-Ü][a-zà-ú]+(?:\s+[A-ZÀ-Ü][a-zà-ú]+){0,2})/i, group: 1 },
        // Padrão 4: "nome: Pedro" / "nome - Maria"
        { regex: /nome\s*[:\-\.]\s*([A-ZÀ-Ü][a-zà-ú]+(?:\s+[A-ZÀ-Ü][a-zà-ú]+){0,2})/i, group: 1 },
        // Padrão 5: Nome no início + idade ("Maria tem 7 anos")
        { regex: /^([A-ZÀ-Ü][a-zà-ú]+(?:\s+[A-ZÀ-Ü][a-zà-ú]+)?)\s+(?:tem|tem\s+|faz|fez|completou|vai fazer)\s+\d+/i, group: 1 },
        // Padrão 6: "...pra minha filha Julia..."
        { regex: /(?:pra|para)\s+(?:minha|meu)\s+(?:filha|filho)\s+([A-ZÀ-Ü][a-zà-ú]+)/i, group: 1 },
        // Padrão 7: "...minha filha se chama Julia..."
        { regex: /(?:minha|meu)\s+(?:filha|filho|criança)\s+(?:se\s+)?(?:chama|é)\s+([A-ZÀ-Ü][a-zà-ú]+(?:\s+[A-ZÀ-Ü][a-zà-ú]+){0,2})/i, group: 1 }
    ];

    for (const pattern of namePatterns) {
        const match = text.match(pattern.regex);
        if (match && match[pattern.group]) {
            const name = match[pattern.group].trim();
            // Valida: nome deve ter pelo menos 2 caracteres e não ser número
            if (name.length >= 2 && !/^\d+$/.test(name)) {
                extracted.patientName = name;
                console.log(`[NAME-EXTRACTION] Nome extraído: "${name}" (padrão: ${pattern.regex.toString().substring(0, 50)}...)`);
                break;
            }
        }
    }

    // Extrai idade
    const ageMatch = text.match(/(\d+)\s*(anos?|meses?)/i);
    if (ageMatch) {
        extracted.patientAge = parseInt(ageMatch[1]);
        extracted.patientAgeUnit = ageMatch[2].toLowerCase().startsWith('m') ? 'meses' : 'anos';
        if (extracted.patientAge <= 12) extracted.flags.mentionsChild = true;
    }

    // Extrai período
    if (/\bmanh[ãa]\b/i.test(text)) extracted.preferredPeriod = 'manha';
    else if (/\btarde\b/i.test(text)) extracted.preferredPeriod = 'tarde';
    else if (/\bnoite\b/i.test(text)) extracted.preferredPeriod = 'noite';

    // Extrai therapyArea - PRIMEIRO: usa therapyDetector (detectAllTherapies)
    let detectedTherapies = [];
    try {
        detectedTherapies = detectAllTherapies(text) || [];
    } catch (err) {
        console.warn('[processMessageLikeAmanda] Erro em detectAllTherapies:', err.message);
        detectedTherapies = [];
    }

    if (detectedTherapies.length > 0) {
        // Mapeia ID do therapyDetector para nome da área no banco
        const areaMap = {
            'neuropsychological': 'neuropsicologia',
            'speech': 'fonoaudiologia',
            'tongue_tie': 'fonoaudiologia',
            'psychology': 'psicologia',
            'occupational': 'terapia_ocupacional',
            'physiotherapy': 'fisioterapia',
            'music': 'musicoterapia',
            'neuropsychopedagogy': 'neuropsicologia', // Mapeia para neuro
            'psychopedagogy': 'neuropsicologia' // Mapeia para neuro
        };
        extracted.therapyArea = areaMap[detectedTherapies[0].id] || null;
    }

    // 🔧 EXTRAÇÃO DE QUEIXA → ÁREA TERAPÊUTICA (mapeamento expandido)
    const complaintToArea = [
        // FONOAUDIOLOGIA
        { patterns: [/\b(não fala|fala pouco|atraso na fala|atraso de fala|demora pra falar|demora para falar|não pronuncia|troca letras|troca sons|gaguej|gagueira|engasga|engasgando|baba muito|baba demais|mamar|amamentação|freio da língua|frenulo|linguinha|lábio leporino|fenda palatina|fissura|lábio|palato|respira pela boca|respirar pela boca|nariz aberto|voz rouca|rouquidão|pregas vocais)\b/i], area: 'fonoaudiologia' },
        // NEUROPSICOLOGIA
        { patterns: [/\b(autismo|tea\b|transtorno do espectro|espectro autista|tdah|déficit de atenção|hiperativid|desatento|não para quieto|não consegue ficar quieto|agitação|neuropsi|neuropsicologia|avaliação neuropsicológica|avaliação neuropsicologica|laudo|teste de qi|funções executivas|memória|atenção|concentração|dificuldade de aprendizagem|dislexia|discalculia|dificuldade para ler|dificuldade para escrever|problema na escola|rendimento escolar|nota baixa|reprovação|reprovou|superdotação|superdotado|altas habilidades|tdah|tda|deficit de atenção|hiperatividade)\b/i], area: 'neuropsicologia' },
        // PSICOLOGIA
        { patterns: [/\b(psicologia|comportamento|birra|birras|não obedece|desobedece|agressivo|agressividade|bate em|bateu|morde|ansiedade|ansiosa|ansioso|medo|temor|fobia|depressão|depressivo|triste|choroso|não dorme|insônia|pesadelo|reclama|reclamação|birra|birração|não aceita|teimosia|birrento|queima roupa|encoprese|enurese|xixi na cama|faz xixi na cama|se borra|autolesão|automutilação|toc|transtorno obsessivo|ritual)\b/i], area: 'psicologia' },
        // TERAPIA OCUPACIONAL
        { patterns: [/\b(terapia ocupacional|terapeuta ocupacional|\bto\b|integração sensorial|sensorial|sensoriais|hipersensível|hipersensibilidade|textura|barulho|luz|cheiro|intolerância sensorial|evita contato|não gosta de toque|coordenação motora|coordenação|motricidade|motora|segurar lápis|amarrar cadarço|botão|zíper|escova dentes|tomar banho|banho|vestir|vestir-se|alimentação|comer sozinho|pinça|lateralidade|esquerda|canhoto|canhota|dominância|reflexos|primitivo)\b/i], area: 'terapia_ocupacional' },
        // FISIOTERAPIA
        { patterns: [/\b(fisioterapia|\bfisio\b|fisio|atraso motor|desenvolvimento motor|não engatinhou|não andou|começou a andar tarde|andar na ponta|andar de ponta|pé torto|torto|torticolo|torticolis|assimetria|preferência lateral|prematuro|prematuridade|hipotonia|hipertonia|espasticidade|flacidez|fortalecimento|equilíbrio|cair|cai muito|tropeça|postura|escoliose|cifose|posição sentada|sentar|engatinhar|rolar)\b/i], area: 'fisioterapia' },
        // PSICOPEDAGOGIA → Mapeia para neuropsicologia
        { patterns: [/\b(psicopedagogia|psicopedagogo|psicopedagoga|dificuldade escolar|dificuldade de aprendizagem|dificuldade para ler|dificuldade para escrever|dislexia|discalculia|disgrafia|tdah escolar|atraso escolar|baixo rendimento|não aprende|não consegue aprender|repetiu|reprovação|escrita|leitura|matemática|cálculo|interpretação|texto)\b/i], area: 'neuropsicologia' }
    ];

    // Só deriva da queixa se não detectou área explicitamente
    if (!extracted.therapyArea) {
        for (const mapping of complaintToArea) {
            for (const pattern of mapping.patterns) {
                if (pattern.test(text)) {
                    extracted.therapyArea = mapping.area;
                    extracted.complaint = text.substring(0, 100); // Salva a queixa
                    console.log(`[COMPLAINT-DETECTION] Queixa detectada: "${text.substring(0, 50)}..." → Área: ${mapping.area}`);
                    break;
                }
            }
            if (extracted.therapyArea) break;
        }
    }

    // 🔧 DETECÇÃO: Multi terapias / Multiprofissional (com validação)
    // Só ativa se NÃO for uma correção (quando usuário está trocando de área)
    const isCorrection = /\b(não|correção|troca|mudei|desculpe|errado|queria)\b.*\b(fono|psico|neuro|to|fisio)/i.test(text);
    const hasMultipleExplicit = /\b(precisa\s+de\s+tudo|todas\s+(?:as\s+)?áreas?|todas\s+(?:as\s+)?especialidades?|equipe\s+mult|multi\s*profissional)\b/i.test(text);
    // Strip nome da clínica antes de checar combinações — evita false positive "Fono Inova...neuropsicológica"
    const textSemClinica = text.replace(/(?:cl[ií]nica\s+)?fono\s+inova/gi, '');
    const hasMultipleCombination = /\b(fono.*psico|psico.*fono|fono.*to|to.*fono|neuro.*fono|fono.*neuro)\b/i.test(textSemClinica);

    if (!isCorrection && (hasMultipleExplicit || hasMultipleCombination)) {
        extracted.flags.multidisciplinary = true;
        extracted.therapyArea = "multiprofissional";
        console.log('[AMANDA-SÊNIOR] Multi terapias detectadas - therapyArea: multiprofissional');
    } else if (isCorrection && hasMultipleCombination) {
        console.log('[AMANDA-SÊNIOR] Correção de área detectada - ignorando multiprofissional');
    }

    // Detecta intenção
    if (extracted.flags.wantsSchedule) extracted.intent = 'agendar';
    else if (extracted.flags.asksPrice) extracted.intent = 'preco';
    else if (extracted.flags.asksPlans) extracted.intent = 'plano';

    // 2. VALIDAÇÃO DE SERVIÇO
    const VALID_AREAS = ['fonoaudiologia', 'psicologia', 'terapia_ocupacional', 'fisioterapia', 'musicoterapia', 'neuropsicologia', 'psicopedagogia'];

    let serviceStatus = 'available';
    let serviceMessage = null;

    if (extracted.therapyArea && !VALID_AREAS.includes(extracted.therapyArea)) {
        serviceStatus = 'not_available';
        serviceMessage = `Não temos ${extracted.therapyArea}. Temos fonoaudiologia, psicologia, terapia ocupacional... Quer saber mais?`;
    }

    // Validação idade psicologia
    if (extracted.therapyArea === 'psicologia' && extracted.patientAge > 16) {
        serviceStatus = 'age_limit';
        serviceMessage = 'Atendemos psicologia apenas até 16 anos. Temos neuropsicologia para adultos 💚';
    }

    // 3. FALLBACK: Se não detectou therapyArea do texto atual, usa a do lead
    if (!extracted.therapyArea && lead?.therapyArea) {
        console.log(`[CTX-RECOVERY] therapyArea recuperado do Lead: ${lead.therapyArea}`);
        extracted.therapyArea = lead.therapyArea;
    }

    // Fallback para enrichedContext (memória da Amanda)
    if (!extracted.therapyArea && enrichedContext?.therapyArea) {
        console.log(`[CTX-RECOVERY] therapyArea recuperado do Contexto: ${enrichedContext.therapyArea}`);
        extracted.therapyArea = enrichedContext.therapyArea;
    }

    // 3.5 DERIVA therapyArea do conversationSummary (se ainda não tem)
    if (!extracted.therapyArea && lead?.conversationSummary) {
        console.log('[AMANDA-SÊNIOR] Tentando derivar therapyArea do summary...');
        const summary = lead.conversationSummary.toLowerCase();
        const inferredArea =
            /fonoaudiologia|fono|\bteste da linguinha\b/i.test(summary) ? 'fonoaudiologia' :
                /neuropsicologia|neuropsi|avaliação neuropsicológica/i.test(summary) ? 'neuropsicologia' :
                    /psicologia(?!.*pedagogia)|\bpsic[oó]logo/i.test(summary) ? 'psicologia' :
                        /terapia ocupacional|terapeuta ocupacional|\bto\b|ocupacional/i.test(summary) ? 'terapia_ocupacional' :
                            /fisioterapia|\bfisio/i.test(summary) ? 'fisioterapia' :
                                /psicopedagogia|neuropsicopedagogia/i.test(summary) ? 'neuropsicologia' :
                                    /musicoterapia/i.test(summary) ? 'musicoterapia' :
                                        null;
        if (inferredArea) {
            console.log('[AMANDA-SÊNIOR] TherapyArea inferida do summary:', inferredArea);
            extracted.therapyArea = inferredArea;
        }
    }

    // 4. DERIVA therapyArea da queixa salva (se não detectou na mensagem atual E não tem no lead)
    if (!extracted.therapyArea && lead?.complaint) {
        console.log('[AMANDA-SÊNIOR] Tentando derivar therapyArea da queixa:', lead.complaint);
        try {
            const therapiesFromComplaint = detectAllTherapies(lead.complaint) || [];
            console.log('[AMANDA-SÊNIOR] Therapies detectadas na queixa:', therapiesFromComplaint);
            if (therapiesFromComplaint.length > 0) {
                const areaMap = {
                    'neuropsychological': 'neuropsicologia',
                    'speech': 'fonoaudiologia',
                    'tongue_tie': 'fonoaudiologia',
                    'psychology': 'psicologia',
                    'occupational': 'terapia_ocupacional',
                    'physiotherapy': 'fisioterapia',
                    'music': 'musicoterapia',
                    'neuropsychopedagogy': 'neuropsicologia',
                    'psychopedagogy': 'neuropsicologia'
                };
                extracted.therapyArea = areaMap[therapiesFromComplaint[0].id] || null;
                console.log('[AMANDA-SÊNIOR] TherapyArea derivada da queixa:', extracted.therapyArea);
            } else {
                // Fallback: verificação direta na string da queixa
                const complaintLower = lead.complaint.toLowerCase();
                if (/neuropsi|avaliação neuropsicológica/.test(complaintLower)) {
                    extracted.therapyArea = 'neuropsicologia';
                    console.log('[AMANDA-SÊNIOR] TherapyArea derivada via fallback:', extracted.therapyArea);
                } else if (/fonoaudiologia|fono|avaliação fonoaudiológica/.test(complaintLower)) {
                    extracted.therapyArea = 'fonoaudiologia';
                    console.log('[AMANDA-SÊNIOR] TherapyArea derivada via fallback:', extracted.therapyArea);
                } else if (/psicologia|psicólogo|psicóloga/.test(complaintLower)) {
                    extracted.therapyArea = 'psicologia';
                    console.log('[AMANDA-SÊNIOR] TherapyArea derivada via fallback:', extracted.therapyArea);
                } else if (/to\b|terapia ocupacional|terapeuta ocupacional/.test(complaintLower)) {
                    extracted.therapyArea = 'terapia_ocupacional';
                    console.log('[AMANDA-SÊNIOR] TherapyArea derivada via fallback:', extracted.therapyArea);
                } else if (/fisio|fisioterapia/.test(complaintLower)) {
                    extracted.therapyArea = 'fisioterapia';
                    console.log('[AMANDA-SÊNIOR] TherapyArea derivada via fallback:', extracted.therapyArea);
                }
            }
        } catch (err) {
            console.warn('[processMessageLikeAmanda] Erro ao derivar therapyArea da queixa:', err.message);
        }
    }

    // 4. O QUE FALTA? (Considera dados do lead + contexto enriquecido + extraído do texto)
    const hasPeriod = lead?.pendingPreferredPeriod ||
        lead?.preferredTime ||
        lead?.autoBookingContext?.preferredPeriod ||
        enrichedContext?.preferredTime ||
        lead?.qualificationData?.disponibilidade ||
        lead?.qualificationData?.extractedInfo?.preferredPeriod ||
        extracted.preferredPeriod;

    // Log de recuperação de período
    if (!extracted.preferredPeriod && hasPeriod) {
        const recoveredPeriod = lead?.pendingPreferredPeriod || lead?.preferredTime || lead?.autoBookingContext?.preferredPeriod || enrichedContext?.preferredTime;
        console.log(`[CTX-RECOVERY] preferredPeriod recuperado: ${recoveredPeriod}`);
    }

    const hasName = (isValidPatientName(lead?.patientInfo?.fullName) && lead?.patientInfo?.fullName) ||
        (isValidPatientName(lead?.patientInfo?.name) && lead?.patientInfo?.name) ||
        (isValidPatientName(enrichedContext?.name) && enrichedContext?.name) ||
        (isValidPatientName(lead?.qualificationData?.extractedInfo?.nome) && lead?.qualificationData?.extractedInfo?.nome) ||
        (isValidPatientName(lead?.qualificationData?.extractedInfo?.name) && lead?.qualificationData?.extractedInfo?.name) ||
        extracted.patientName;

    // Log de recuperação de nome
    if (!extracted.patientName && hasName) {
        const recoveredName = lead?.patientInfo?.fullName || lead?.patientInfo?.name || enrichedContext?.name || lead?.qualificationData?.extractedInfo?.nome;
        console.log(`[CTX-RECOVERY] patientName recuperado: ${recoveredName}`);
    }

    const hasAge = lead?.patientInfo?.age ||
        lead?.patientAge ||
        enrichedContext?.patientAge ||
        lead?.qualificationData?.extractedInfo?.idade ||
        lead?.qualificationData?.extractedInfo?.age ||
        lead?.qualificationData?.idade ||
        extracted.patientAge;

    // Log de recuperação de idade
    if (!extracted.patientAge && hasAge) {
        const recoveredAge = lead?.patientInfo?.age || lead?.patientAge || enrichedContext?.patientAge || lead?.qualificationData?.extractedInfo?.idade;
        console.log(`[CTX-RECOVERY] patientAge recuperado: ${recoveredAge}`);
    }

    const hasComplaint = lead?.complaint ||
        enrichedContext?.primaryComplaint ||
        lead?.qualificationData?.extractedInfo?.queixa ||
        extracted.complaint;

    const hasTherapyArea = lead?.therapyArea ||
        enrichedContext?.therapyArea ||
        lead?.qualificationData?.extractedInfo?.especialidade ||
        extracted.therapyArea;

    // 🔴 CRITICAL FIX: Verificar data de nascimento
    const hasBirthDate = !!(lead?.patientInfo?.birthDate);

    // 🎯 ORDEM DE TRIAGEM (prioridade = acolhimento → dados → agendamento)
    const missing = [];
    if (!hasTherapyArea && serviceStatus === 'available') missing.push('therapyArea');
    if (!hasComplaint) missing.push('complaint');        // 1️⃣ Acolhimento: queixa primeiro
    if (!hasName) missing.push(extracted.responsibleName ? 'patientName' : 'name');  // 2️⃣ Nome
    if (!hasBirthDate) missing.push('birthDate');        // 3️⃣ Data nascimento
    if (!hasAge) missing.push('age');                    // 4️⃣ Idade
    if (!hasPeriod) missing.push('period');              // 5️⃣ Período (último antes de slots)

    console.log('[AMANDA-SÊNIOR] Checking lead data:', {
        hasName: !!hasName,
        hasAge: !!hasAge,
        hasPeriod: !!hasPeriod,
        hasTherapyArea: !!hasTherapyArea,
        hasComplaint: !!hasComplaint,
        patientInfoName: lead?.patientInfo?.fullName,
        enrichedName: enrichedContext?.name,
        qualificationNome: lead?.qualificationData?.extractedInfo?.nome,
        patientInfoAge: lead?.patientInfo?.age,
        enrichedAge: enrichedContext?.patientAge,
        qualificationIdade: lead?.qualificationData?.extractedInfo?.idade || lead?.qualificationData?.idade,
        missing: missing
    });

    return {
        extracted,
        missing,
        serviceStatus,
        serviceMessage,
        hasAll: missing.length === 0 && serviceStatus === 'available'
    };
}

/**
 * 🎯 TEMPLATE OURO: Resposta direcionada (empatia + área + CTA)
 * Usado quando ClinicalMapper detecta specialty com alta confiança
 */
function buildDirectedResponse(area, condition = null) {
    const areaNames = {
        fonoaudiologia: 'Fonoaudiologia',
        psicologia: 'Psicologia',
        terapia_ocupacional: 'Terapia Ocupacional',
        fisioterapia: 'Fisioterapia',
        neuropsicologia: 'Neuropsicologia',
        musicoterapia: 'Musicoterapia'
    };
    
    const areaName = areaNames[area] || area;
    
    // Frases de empatia contextual baseadas na condição
    const empathyMap = {
        'fala_tardia': 'Entendo sua preocupação com o desenvolvimento da fala 💚',
        'dislexia': 'Compreendo a importância de investigar as dificuldades de leitura 💚',
        'tea': 'Entendo que buscar orientação é o primeiro passo 💚',
        'tdah': 'Compreendo os desafios da atenção e inquietação 💚',
        'motricidade': 'Entendo sua preocupação com o desenvolvimento motor 💚',
        'sensorial': 'Compreendo as dificuldades sensoriais que vocês enfrentam 💚',
        'default': 'Entendo sua preocupação 💚'
    };
    
    const empathy = empathyMap[condition] || empathyMap['default'];
    
    return ensureSingleHeart(
        `${empathy}\n\n` +
        `Pelo que você descreveu, a **${areaName}** pode ajudar bastante nesse caso.\n\n` +
        `Você prefere que eu te explique como funciona ou já quer ver os horários disponíveis? 😊`
    );
}

/**
 * Constrói resposta simples baseada no que falta
 */
function buildSimpleResponse(missing, extracted, lead, enrichedContext = null) {
    const [first] = missing;
    const respName = extracted.responsibleName || lead?.responsibleName;
    const patientName = extracted.patientName ||
        lead?.patientInfo?.fullName ||
        enrichedContext?.name ||
        lead?.qualificationData?.extractedInfo?.nome;
    const age = extracted.patientAge ||
        lead?.patientInfo?.age ||
        enrichedContext?.patientAge ||
        lead?.qualificationData?.extractedInfo?.idade ||
        lead?.qualificationData?.idade;

    // 🔧 NOVO: Recupera área terapêutica do contexto para personalizar respostas
    const currentArea = extracted.therapyArea ||
        lead?.therapyArea ||
        enrichedContext?.therapyArea ||
        lead?.qualificationData?.extractedInfo?.therapyArea;

    // Nome amigável da área para exibição
    const areaDisplayNames = {
        'psicologia': 'Psicologia',
        'psicologia_infantil': 'Psicologia Infantil',
        'fonoaudiologia': 'Fonoaudiologia',
        'fono': 'Fonoaudiologia',
        'terapia_ocupacional': 'Terapia Ocupacional',
        'to': 'Terapia Ocupacional',
        'fisioterapia': 'Fisioterapia',
        'fisio': 'Fisioterapia',
        'neuropsicologia': 'Neuropsicologia',
        'neuropsi': 'Neuropsicologia',
        'musicoterapia': 'Musicoterapia'
    };
    const areaDisplay = currentArea ? (areaDisplayNames[currentArea] || currentArea) : null;

    console.log('[buildSimpleResponse] Building response:', {
        firstMissing: first,
        hasPatientName: !!patientName,
        hasAge: !!age,
        hasArea: !!currentArea,
        area: areaDisplay,
        patientNameValue: patientName,
        ageValue: age
    });

    switch (first) {
        case 'therapyArea': {
            const flagsBSR = extracted.flags || {};
            if (flagsBSR.isEmotional || flagsBSR.mentionsUrgency) {
                return ensureSingleHeart(`${respName ? 'Oi ' + respName + '! ' : 'Oi! '}Entendo sua preocupação, estou aqui pra ajudar 💚\n\nQual especialidade você busca? Temos Fonoaudiologia, Psicologia, Terapia Ocupacional, Fisioterapia ou Neuropsicologia.`);
            }
            if (flagsBSR.wantsSchedule || flagsBSR.isHotLead) {
                return ensureSingleHeart(`${respName ? 'Oi ' + respName + '! ' : ''}Ótimo, vou te ajudar a agendar! 💚\n\nQual especialidade você busca? Temos Fonoaudiologia, Psicologia, Terapia Ocupacional, Fisioterapia ou Neuropsicologia.`);
            }
            return ensureSingleHeart(`Oi${respName ? ' ' + respName : ''}! 💚 Me conta o que você busca — assim te direciono para a especialidade certa. Temos Fonoaudiologia, Psicologia, Terapia Ocupacional, Fisioterapia ou Neuropsicologia.`);
        }

        case 'period':
            // 🔧 Melhorado: Contextualiza com área terapêutica quando disponível
            let contextMsg = '';
            if (areaDisplay && patientName) {
                contextMsg = `Oi! Entendi que é para **${areaDisplay}**, ${patientName.split(' ')[0]}. 💚\n\n`;
            } else if (areaDisplay) {
                contextMsg = `Oi! Entendi que é para **${areaDisplay}**. 💚\n\n`;
            } else if (respName && age) {
                contextMsg = `Oi ${respName}! Entendi que ${patientName || 'o paciente'} tem ${age} anos. 💚\n\n`;
            } else {
                contextMsg = `Oi${respName ? ' ' + respName : ''}! 💚\n`;
            }
            return ensureSingleHeart(contextMsg + "Pra eu organizar, prefere **manhã ou tarde**? 😊");

        case 'name':
        case 'patientName':
            // 🔧 Melhorado: Contextualiza com área terapêutica quando disponível
            if (areaDisplay && respName) {
                return ensureSingleHeart(`Oi ${respName}! Entendi que é para **${areaDisplay}**. Qual o **nome completo** do paciente? 💚`);
            } else if (areaDisplay) {
                return ensureSingleHeart(`Oi! Entendi que é para **${areaDisplay}**. Qual o **nome completo** do paciente? 💚`);
            } else if (respName) {
                return ensureSingleHeart(`Oi ${respName}! Entendi que é para seu filho(a). Qual o **nome completo** da criança? 💚`);
            }
            return ensureSingleHeart("Oi! Pra eu organizar, qual o **nome completo** do paciente? 😊");

        case 'age':
            // 🔧 Melhorado: Contextualiza com área terapêutica quando disponível
            if (areaDisplay && patientName) {
                return ensureSingleHeart(`Perfeito, ${patientName}! Entendi que é para **${areaDisplay}**. 💚 E qual a **idade**? (anos ou meses)`);
            } else if (patientName) {
                return ensureSingleHeart(`Perfeito, ${patientName}! 💚 E qual a **idade**? (anos ou meses)`);
            } else if (areaDisplay) {
                return ensureSingleHeart(`Oi! Entendi que é para **${areaDisplay}**. 💚 Qual a **idade** do paciente? (anos ou meses)`);
            }
            return ensureSingleHeart("Qual a **idade** do paciente? (anos ou meses) 😊");

        case 'complaint':
            // 🎯 PRIMEIRO CONTATO - Acolhimento antes de tudo
            if (areaDisplay) {
                return ensureSingleHeart(`Oi! Seja bem-vindo(a) à Fono Inova 💚\n\nEntendi que você busca **${areaDisplay}**. Me conta um pouquinho: o que vocês têm observado que te preocupou? Estou aqui para ouvir e ajudar a encontrar o melhor caminho 😊`);
            }
            return ensureSingleHeart(`Oi! Seja bem-vindo(a) à Fono Inova 💚\n\nFique à vontade para me contar: o que te trouxe até aqui? Qual a principal preocupação que vocês têm? Estou aqui para ajudar 😊`);
        
        case 'birthDate':
            // Data de nascimento após nome
            if (patientName) {
                return ensureSingleHeart(`Obrigado, ${patientName.split(' ')[0]}! 💚 Agora me manda a **data de nascimento** (dd/mm/aaaa) pra eu organizar certinho 😊`);
            }
            return ensureSingleHeart(`Obrigado! 💚 Agora me manda a **data de nascimento** (dd/mm/aaaa)`);

        default:
            return ensureSingleHeart("Pra eu organizar, prefere **manhã ou tarde**? 😊");
    }
}

export default getOptimizedAmandaResponse;