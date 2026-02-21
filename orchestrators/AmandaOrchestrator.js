
import "dotenv/config";
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
    pickSlotFromUserReply
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
import { buildSlotMenuMessage } from "../utils/slotMenuBuilder.js";
import callAI from "../services/IA/Aiproviderservice.js";
import { clinicalEligibility } from "../domain/policies/ClinicalEligibility.js";
import { canAutoRespond, buildResponseFromFlags, getTherapyInfo } from '../services/ResponseBuilder.js';
import { CLINIC_KNOWLEDGE } from '../knowledge/clinicKnowledge.js';

const recentResponses = new Map();

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
    
    // Mapeamentos comuns
    fono: { alias: "fonoaudiologia" },
    to: { alias: "terapia_ocupacional" },
    fisio: { alias: "fisioterapia" },
    neuropsico: { alias: "neuropsicologia" },
    psicopedagogia: { name: "Psicopedagogia", available: false, redirectTo: "neuropsicologia", reason: "Sem profissional ativo" },
};

// Especialidades médicas que NÃO oferecemos
const MEDICAL_SPECIALTIES = [
    { terms: ['neuropediatra', 'neurologista', 'neurologia'], name: 'Neurologista', redirect: 'neuropsicologia' },
    { terms: ['pediatra', 'pediatria'], name: 'Pediatra', redirect: 'fonoaudiologia' },
    { terms: ['psiquiatra', 'psiquiatria'], name: 'Psiquiatra', redirect: 'psicologia' },
    { terms: ['cardiologista', 'ortopedista', 'dermatologista'], name: null, redirect: null },
];

/**
 * 🩺 Valida se o serviço solicitado existe na clínica
 * Retorna: { valid: boolean, service: string, message?: string, redirect?: string }
 */
function validateServiceRequest(text = "") {
    const normalized = text.toLowerCase();
    
    // 1. Verificar especialidades médicas primeiro
    for (const medical of MEDICAL_SPECIALTIES) {
        if (medical.terms.some(term => normalized.includes(term))) {
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
                    `É uma avaliação completa das funções cerebrais — atenção, memória, linguagem, raciocínio. Muitas famílias que buscam ${name} descobrem que a neuropsicologia é exatamente o que precisam!`,
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
`.trim(),

    neuroPsychContext: `
📚 REGRAS NEUROPSICOLOGIA (DIFERENTE DAS OUTRAS ÁREAS):
- NÃO existe "avaliação inicial avulsa" separada.
- O PRODUTO É: "Avaliação Neuropsicológica Completa".
- ESTRUTURA: Pacote de ~10 sessões (Entrevista + Testes + Laudo).
- PREÇO: R$ 2.000 (até 6x).
- Atendemos CRIANÇAS (a partir de 4 anos) e ADULTOS.
`.trim(),

    psycoContext: `
🧠 CONTEXTO PSICOLOGIA:
- Atendimento **exclusivo para CRIANÇAS e ADOLESCENTES até 16 anos**.
- Foco: comportamento, emoções, habilidades sociais e orientação aos pais.
- NÃO realizamos atendimentos de psicologia para adultos.
`.trim(),

    psychopedContext: `
📝 CONTEXTO PSICOPEDAGOGIA:
- Foco: Dificuldades de aprendizagem, atenção, memória, rendimento escolar.
- ADULTOS: Preparação para cursos, concursos e faculdade.
- Anamnese inicial: R$ 200.
- Pacote mensal: R$ 160/sessão (~R$ 640/mês).
`.trim(),

    physioContext: `
🏃 CONTEXTO FISIOTERAPIA:
- Foco: Atendimento terapêutico CLÍNICO.
- NÃO fazemos RPG ou Pilates.
- Infantil: Desenvolvimento motor, postura, equilíbrio.
- Adulto: Reabilitação funcional, dor crônica, mobilidade.
- BOBATH: Usamos abordagem neurofuncional quando indicado.
`.trim(),

    occupationalContext: `
🖐️ CONTEXTO TERAPIA OCUPACIONAL:
- Foco: Integração sensorial, coordenação, autonomia.
- Infantil: AVDs, escrita, organização sensorial.
- Adulto: Rotina, independência, habilidades funcionais.
`.trim(),

    musicTherapyContext: `
🎵 CONTEXTO MUSICOTERAPIA:
- Foco: Regulação emocional, interação social, desenvolvimento global.
- Infantil: Expressão, comunicação não-verbal, vínculo.
- Adulto: Ansiedade, relaxamento, foco.
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
- Use o tom leve e explicativo: "A avaliação é R$200 e é o primeiro passo pra entender o que a criança precisa 💚"
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
    if (unit === "meses") return "crianca";
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
    const detectedTherapies = detectAllTherapies(complaint);
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
    const flags = deriveFlagsFromText(complaint);
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
        const _c = extractComplaint(text);
        const _upd = {};
        if (_n && isValidPatientName(_n) && !lead?.patientInfo?.fullName)
            _upd['patientInfo.fullName'] = _n;
        if (_a && !lead?.patientInfo?.age)
            _upd['patientInfo.age'] = typeof _a === 'object' ? _a.age : _a;
        if (_p && !lead?.pendingPreferredPeriod)
            _upd['pendingPreferredPeriod'] = _p;
        if (_c && !lead?.complaint)
            _upd['complaint'] = _c;
        if (Object.keys(_upd).length) {
            await safeLeadUpdate(leadId, { $set: _upd });
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
    const normalized = text.toLowerCase().trim();

    const SCHEDULING_REGEX =
        /\b(agendar|marcar|consulta|atendimento|avalia[cç][aã]o)\b|\b(qual\s+dia|qual\s+hor[áa]rio|tem\s+hor[áa]rio|dispon[ií]vel|disponivel|essa\s+semana)\b/i;

    console.log(`🎯 [ORCHESTRATOR] Processando: "${text}"`);

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
            const freshLead = await Leads.findById(lead._id).lean();
            if (freshLead) {
                lead = freshLead;
                console.log("🔄 [REFRESH] Lead atualizado:", {
                    pendingPatientInfoForScheduling: lead.pendingPatientInfoForScheduling,
                    pendingPatientInfoStep: lead.pendingPatientInfoStep,
                    pendingChosenSlot: lead.pendingChosenSlot ? "SIM" : "NÃO",
                    pendingSchedulingSlots: lead.pendingSchedulingSlots?.primary ? "SIM" : "NÃO",
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

    // 💾 Persiste dados extraídos ANTES de qualquer early return
    await persistExtractedData(lead._id, text, lead);

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
            }).catch(() => {});
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
    // 🛡️ GUARD: Preço tem prioridade SEMPRE
    // =========================================================================
    const asksPrice = /(pre[çc]o|valor|quanto\s*(custa|[eé]))/i.test(text);
    if (asksPrice && lead?.status === "agendado") {
        console.log("[GUARD] Cliente perguntou preço PÓS-agendamento");
        const knownArea = lead?.therapyArea || "avaliacao";
        const PRICE_AREA = {
            fonoaudiologia: "A avaliação de fonoaudiologia é **R$ 200**.",
            psicologia: "A avaliação de psicologia é **R$ 200**.",
            terapia_ocupacional: "A avaliação de terapia ocupacional é **R$ 200**.",
            fisioterapia: "A avaliação de fisioterapia é **R$ 200**.",
            musicoterapia: "A avaliação de musicoterapia é **R$ 200**.",
            psicopedagogia: "A avaliação psicopedagógica é **R$ 200**.",
            neuropsicologia: "A avaliação neuropsicológica completa é **R$ 2.000** (até 6x).",
        };
        const priceText = PRICE_AREA[knownArea] || "A avaliação inicial é **R$ 200**.";
        return ensureSingleHeart(priceText);
    }

    // =========================================================================
    // 🆕 PASSO 1: FLUXO DE COLETA DE DADOS DO PACIENTE (PÓS-ESCOLHA DE SLOT)
    // =========================================================================
    console.log("🔍 [PASSO 1 CHECK]", {
        pendingPatientInfoForScheduling: lead?.pendingPatientInfoForScheduling,
        hasLeadId: !!lead?._id,
    });

    const asksLocation = /(endere[çc]o|onde\s+fica|localiza(?:ç|c)(?:a|ã)o)/i.test(text.normalize('NFC'));
    if (asksLocation) {
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
    }

    if (lead?.pendingPatientInfoForScheduling && lead?._id) {
        console.log("📝 [ORCHESTRATOR] Lead está pendente de dados do paciente");

        const step = lead.pendingPatientInfoStep || "name";
        const chosenSlot = lead.pendingChosenSlot;


        // 🛡️ ESCAPE: Detecta perguntas importantes durante coleta
        const asksPrice = /(pre[çc]o|valor|quanto\s*(custa|[eé]))/i.test(text);

        if (asksPrice) {
            const area = lead?.therapyArea || "avaliacao";
            const prices = {
                fonoaudiologia: "R$ 200",
                psicologia: "R$ 200",
                neuropsicologia: "R$ 2.000 (até 6x)",
            };
            const price = prices[area] || "R$ 200";
            const nextStep = step === "name" ? "nome completo" : "data de nascimento";
            return ensureSingleHeart(`A avaliação é **${price}**. Pra confirmar o horário, preciso só do **${nextStep}** 💚`);
        }

        if (step === "name") {
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
            const updated = await Leads.findById(lead._id).lean().catch(() => null);
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

    // ✅ CONTEXTO UNIFICADO (leadContext.js tem tudo: mode, toneMode, urgencyLevel)
    const enrichedContext = lead?._id
        ? await enrichLeadContext(lead._id)
        : {
            stage: "novo",
            isFirstContact: true,
            messageCount: 0,
            conversationHistory: [],
            conversationSummary: null,
            shouldGreet: true,
            mode: 'commercial',
            toneMode: 'acolhimento',
            urgencyLevel: 'NORMAL',
            ...context
        };

    if (enrichedContext.isFirstContact && lead?._id) {
        manageLeadCircuit(lead._id, 'initial').catch(err =>
            console.error('[CIRCUIT] Erro ao agendar initial:', err.message)
        );
    }

    // 🆕 DETECÇÃO COM DETECTORES CONTEXTUAIS (ConfirmationDetector, InsuranceDetector, PriceDetector, SchedulingDetector)
    // Usa adapter pattern para manter compatibilidade com flags legacy
    const flags = detectWithContextualDetectors(text, lead, enrichedContext);
    console.log("🚩 FLAGS DETECTADAS:", flags);

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
        Promise.all(trackingPromises).catch(() => {}); // Fire and forget
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

    if (
        lead?._id &&
        hasImplicitInterest &&
        !hasSpecificIntent &&
        !lead.triageStep &&
        !lead.pendingSchedulingSlots &&
        !lead.pendingPatientInfoForScheduling &&
        lead.stage !== "paciente"
    ) {
        await safeLeadUpdate(lead._id, {
            $set: {
                triageStep: "ask_period",
                stage: "triagem_agendamento"
            }
        });
        lead.triageStep = "ask_period"; // mantém em memória
    }

    // ============================================================
    // ▶️ CONDUÇÃO DA TRIAGEM (ANTI-LIMBO)
    // ============================================================

    if (lead?.triageStep === "ask_period") {
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
            /psicopedagog/i.test(text) ||
            /linguinha|fren[uú]lo|freio\s*ling/i.test(text) ||
            /ne[iu]ropsico/i.test(text) ||
            /dificuldade.*(escola|ler|escrever|aprendizagem|leitura|escrita)/i.test(text) ||
            /escola.*(dificuldade|problema|nota|rendimento)/i.test(text) ||
            /(conv[eê]nio|plano\s*(de\s*)?sa[uú]de|unimed|ipasgo|hapvida|bradesco|amil)/i.test(text);

        if (hasSpecificIntentNow) {
            console.log("🛡️ [TRIAGEM] Bypass: lead tem pergunta específica, seguindo para IA");
            // NÃO retorna — deixa seguir para o Claude com clinicWisdom
        } else {
            const period = extractPeriodFromText(text);
            if (!period) {
                return ensureSingleHeart(
                    "Olá! 😊 Pra eu organizar certinho, vocês preferem **manhã ou tarde**?"
                );
            }

            await safeLeadUpdate(lead._id, {
                $set: {
                    pendingPreferredPeriod: period,
                    triageStep: "ask_profile"
                }
            });

            return ensureSingleHeart("Ótimo! 💚 Qual o **nome do paciente**?");
        } // fecha else do bypass
    }

    if (lead?.triageStep === "ask_profile") {
        const name = extractName(text);
        if (!name) {
            return ensureSingleHeart(
                "Pode me dizer, por favor, o **nome do paciente**? 😊"
            );
        }

        await safeLeadUpdate(lead._id, {
            $set: {
                "patientInfo.fullName": name,
                triageStep: "ask_complaint"
            }
        });

        return ensureSingleHeart(
            "Obrigada! 💚 E qual a **idade** dele(a)? (anos ou meses)"
        );
    }

    if (lead?.triageStep === "ask_complaint") {
        const age = extractAgeFromText(text);
        if (!age) {
            return ensureSingleHeart(
                "Me conta a **idade** dele(a), por favor 😊 (anos ou meses)"
            );
        }

        await safeLeadUpdate(lead._id, {
            $set: {
                "patientInfo.age": age,
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

        const PRICE_BY_AREA = {
            fonoaudiologia: "A avaliação inicial de fonoaudiologia é **R$ 200**.",
            psicologia: "A avaliação inicial de psicologia é **R$ 200**.",
            terapia_ocupacional: "A avaliação inicial de terapia ocupacional é **R$ 200**.",
            fisioterapia: "A avaliação inicial de fisioterapia é **R$ 200**.",
            musicoterapia: "A avaliação inicial de musicoterapia é **R$ 200**.",
            psicopedagogia: "A avaliação psicopedagógica é **R$ 200**.",
            neuropsicologia: "A avaliação neuropsicológica é **R$ 2.000 (até 6x)**.",
        };

        const priceText =
            PRICE_BY_AREA[savedArea] ||
            "A avaliação inicial é **R$ 200**.";

        return ensureSingleHeart(
            `Perfeito! 😊\n\n${priceText}\n\n` +
            `Sim, trabalhamos com **pacotes mensais** sim 💚 ` +
            `Quer que eu te explique as opções?`
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

    // 🔥 PRIORIDADE: PARCERIA / CURRÍCULO
    if (flags.partnership) {
        console.log("🤝 [PARTNERSHIP FLOW] Ativado");

        return {
            text: `Que bom seu interesse! 💚  

Os currículos são recebidos exclusivamente por e-mail:
📩 contato@clinicafonoinova.com.br  

No assunto, coloque sua área de atuação (ex: Terapeuta Ocupacional).

Em breve nossa equipe entra em contato 😊`
        };
    }

    // ===============================
    // ETAPA A - VALIDAÇÃO EMOCIONAL
    // ===============================
    const hasComplaint =
        lead?.complaint ||
        lead?.patientInfo?.complaint ||
        lead?.autoBookingContext?.complaint ||
        lead?.qualificationData?.extractedInfo?.queixa;

    const userExpressedPain =
        flags?.hasPain ||
        /não anda|não fala|atraso|preocupado|preocupação|dificuldade/i.test(text);

    if (userExpressedPain && !lead?.qualificationData?.painAcknowledged) {

        await safeLeadUpdate(lead._id, {
            $set: { "qualificationData.painAcknowledged": true }
        }).catch(() => { });

        return ensureSingleHeart(
            "Entendo sua preocupação 💚\n\n" +
            "Quando envolve desenvolvimento infantil isso realmente deixa a gente apreensivo.\n" +
            "Você fez muito bem em buscar orientação cedo."
        );
    }

    if (
        /^[sS]im$/.test(text.trim()) &&
        !SCHEDULING_REGEX.test(text)
    ) {
        return ensureSingleHeart(
            "Perfeito 💚\n\n" +
            "Me conta só mais um pouquinho pra eu te orientar certinho."
        );
    }
    if (lead?._id) {
        const $set = {};
        if (flags.topic) $set.topic = flags.topic; // ou "qualificationData.topic"
        if (flags.teaStatus) $set["qualificationData.teaStatus"] = flags.teaStatus;

        if (Object.keys($set).length) {
            await safeLeadUpdate(lead._id, { $set });
        }
    }
    // 🛡️ VERIFICAÇÃO DE DESAMBIGUAÇÃO: "vaga" pode ser consulta OU emprego
    if (flags.wantsPartnershipOrResume) {
        const normalizedText = flags.normalizedText || text.toLowerCase();
        
        // Se ambos forem detectados, verificar contexto para decidir
        if (flags.wantsSchedule) {
            // Contextos que indicam agendamento de consulta (não emprego)
            const schedulingContext = /\b(dias|hor[áa]rio|consulta|agendar|marcar|disponibilidade|atendimento|tem\s+vaga|quais\s+os\s+dias)\b/i.test(normalizedText);
            // Contextos que indicam emprego/parceria
            const jobContext = /\b(vaga\s+(de\s+)?(trabalho|emprego)|curriculo|cv|parceria|enviar\s+curr[ií]culo|trabalhar\s+(com|na)\s+voc[eê]s)\b/i.test(normalizedText);
            
            if (schedulingContext && !jobContext) {
                console.log("[DISAMBIGUATION] wantsSchedule + wantsPartnershipOrResume → Contexto indica AGENDAMENTO, ignorando parceria");
                // Não retorna, deixa o fluxo continuar para busca de slots reais
            } else {
                // É realmente sobre parceria/emprego
                await safeLeadUpdate(lead._id, {
                    $set: {
                        reason: "parceria_profissional",
                        stage: "parceria_profissional",
                        "qualificationData.intent": "parceria_profissional",
                    },
                    $addToSet: { flags: "parceria_profissional" },
                });
                return ensureSingleHeart(
                    "Que bom! 😊\n\nParcerias e currículos nós recebemos **exclusivamente por e-mail**.\nPode enviar para **contato@clinicafonoinova.com.br** (no assunto, coloque sua área).\n\nSe quiser, já me diga também sua cidade e disponibilidade 🙂 💚"
                );
            }
        } else {
            // Só tem parceria, sem conflito
            await safeLeadUpdate(lead._id, {
                $set: {
                    reason: "parceria_profissional",
                    stage: "parceria_profissional",
                    "qualificationData.intent": "parceria_profissional",
                },
                $addToSet: { flags: "parceria_profissional" },
            });
            return ensureSingleHeart(
                "Que bom! 😊\n\nParcerias e currículos nós recebemos **exclusivamente por e-mail**.\nPode enviar para **contato@clinicafonoinova.com.br** (no assunto, coloque sua área).\n\nSe quiser, já me diga também sua cidade e disponibilidade 🙂 💚"
            );
        }
    }

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
            const periodMap = { manha: "manhã", tarde: "tarde", noite: "noite" };
            updateFields.pendingPreferredPeriod = periodMap[extracted.disponibilidade];
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
            const slots = await findAvailableSlots({
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
                const slots = await findAvailableSlots({
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
                const pool = await findAvailableSlots({
                    therapyArea,
                    preferredPeriod: currentPeriod,
                    daysAhead: 60,
                    maxOptions: 10,
                });

                if (pool?.primary) {
                    const all = [
                        pool.primary,
                        ...(pool.alternativesSamePeriod || []),
                        ...(pool.alternativesOtherPeriod || []),
                    ].filter(Boolean);

                    const filtered = all.filter(s => String(s.date) >= String(preferredDateStr));

                    if (filtered.length) {
                        const newSlotsCtx = {
                            primary: filtered[0],
                            alternativesSamePeriod: filtered.slice(1, 3),
                            alternativesOtherPeriod: filtered.slice(3, 5),
                            all: filtered.slice(0, 5),
                            maxOptions: Math.min(filtered.length, 5),
                        };

                        await safeLeadUpdate(lead._id, { $set: { pendingSchedulingSlots: newSlotsCtx, pendingChosenSlot: null } })
                            .catch(err => logSuppressedError("safeLeadUpdate", err));

                        const { optionsText, letters } = buildSlotMenuMessage(newSlotsCtx);
                        const allowed = letters.slice(0, newSlotsCtx.all.length).join(" ou ");

                        return ensureSingleHeart(
                            `Perfeito! A partir de **${formatDatePtBr(preferredDateStr)}**, tenho essas opções:\n\n${optionsText}\n\nQual você prefere? (${allowed}) 💚`
                        );
                    }
                }

                return ensureSingleHeart(
                    `Entendi 😊 A partir de **${formatDatePtBr(preferredDateStr)}** não encontrei vaga nas opções atuais. Você prefere **manhã ou tarde** e qual **dia da semana** fica melhor? 💚`
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

        const PRICE_BY_AREA = {
            fonoaudiologia: "A avaliação inicial de fonoaudiologia é **R$ 200**.",
            psicologia: "A avaliação inicial de psicologia é **R$ 200**.",
            terapia_ocupacional: "A avaliação inicial de terapia ocupacional é **R$ 200**.",
            fisioterapia: "A avaliação inicial de fisioterapia é **R$ 200**.",
            musicoterapia: "A avaliação inicial de musicoterapia é **R$ 200**.",
            psicopedagogia: "A avaliação psicopedagógica (anamnese inicial) é **R$ 200**.",
            neuropsicologia: "A avaliação neuropsicológica completa (pacote) é **R$ 2.000 (até 6x)**.",
        };

        if (!priceText && knownArea && PRICE_BY_AREA[knownArea]) {
            priceText = PRICE_BY_AREA[knownArea];
        }

        // 4) fallback por ID de terapia detectada (quando detectAllTherapies achou algo mas priceLines veio vazio)
        const PRICE_BY_THERAPY_ID = {
            speech: "A avaliação inicial de fonoaudiologia é **R$ 200**.",
            tongue_tie: "O **Teste da Linguinha** (avaliação do frênulo lingual) custa **R$ 200**.",
            psychology: "A avaliação inicial de psicologia é **R$ 200**.",
            occupational: "A avaliação inicial de terapia ocupacional é **R$ 200**.",
            physiotherapy: "A avaliação inicial de fisioterapia é **R$ 200**.",
            music: "A avaliação inicial de musicoterapia é **R$ 200**.",
            psychopedagogy: "A avaliação psicopedagógica (anamnese inicial) é **R$ 200**.",
            neuropsychological: "A avaliação neuropsicológica completa (pacote) é **R$ 2.000 (até 6x)**.",
            neuropsychopedagogy: "A avaliação inicial é **R$ 200**.",
        };

        if (!priceText && detectedTherapies.length) {
            const t0 = detectedTherapies[0]?.id;
            if (t0 && PRICE_BY_THERAPY_ID[t0]) {
                priceText = PRICE_BY_THERAPY_ID[t0];
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
        console.log("🛑 [GUARD] Triagem ativa, bloqueando fluxo antigo");
        return null;
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
        const detectedTherapies = detectAllTherapies(text);

        // ✅ FIX: Só considera área do lead se tiver queixa registrada
        const hasValidLeadArea = lead?.therapyArea &&
            (lead?.qualificationData?.extractedInfo?.queixa ||
                lead?.qualificationData?.extractedInfo?.queixaDetalhada?.length > 0 ||
                lead?.patientInfo?.complaint ||
                lead?.autoBookingContext?.complaint);

        // ✅ FIX: Verifica área em TODAS as fontes (mensagem atual + lead COM queixa + qualificationData COM queixa)
        const hasArea = detectedTherapies.length > 0 ||
            flags.therapyArea ||
            hasValidLeadArea ||
            getValidQualificationArea(lead);

        // ✅ FIX: Verifica idade em TODAS as fontes
        const hasAge = /\b\d{1,2}\s*(anos?|mes(es)?)\b/i.test(text) ||
            lead?.patientInfo?.age ||
            lead?.ageGroup ||
            lead?.qualificationData?.extractedInfo?.idade;

        // ✅ FIX: Verifica período em TODAS as fontes (incluindo qualificationData)
        const hasPeriod = extractPeriodFromText(text) ||
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

    if (/precisa\s+de\s+tudo|fono.*psico|psico.*fono/i.test(text)) {
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
            updateData.pendingPreferredPeriod = periodDetected;
            console.log("[TRIAGEM] ✅ Período detectado e salvo:", periodDetected);
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
            // ✅ FIX: Se tiver data específica (flags.preferredDate), filtra no findAvailableSlots
            const dateFilter = lead?.pendingPreferredDate || flags.preferredDate || null;

            // Se tiver data, podemos ignorar preferredPeriod para ser mais específico
            const periodToUse = dateFilter ? null : preferredPeriod;

            const availableSlots = await findAvailableSlots({
                therapyArea: therapyAreaForSlots,
                preferredPeriod: periodToUse,
                daysAhead: 30,
                maxOptions: 2,
            });

            // ✅ FIX: Se buscou por período mas temos data específica, filtra client-side
            if (dateFilter && availableSlots?.primary) {
                // Nota: findAvailableSlots retorna pool. 
                // Se quisermos filtrar exato:
                // Implementar lógica de filtro aqui se necessário, ou confiar que o usuário vai escolher
            }

            if (!availableSlots?.primary) {
                // Tenta sem filtro de período
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
                contextPack?.urgency?.level || enrichedContext?.urgency?.level || "NORMAL";

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

    // 1) Manual
    // 1) [LEGACY] REMOVIDO: Manual Response (retornava "Consulte a equipe")
    // const manualAnswer = tryManualResponse(normalized, enrichedContext, flags);
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

    // Fluxo geral
    const genericAnswer = await callAmandaAIWithContext(text, lead, enrichedContext, flags, analysis);

    const finalScoped = enforceClinicScope(genericAnswer, text);
    return ensureSingleHeart(finalScoped);
}


/**
 * 🔥 FUNIL INICIAL: AVALIAÇÃO → VISITA (se recusar)
 */
async function callVisitFunnelAI({ text, lead, context = {}, flags = {} }) {
    const stage = context.stage || lead?.stage || "novo";

    const systemContext = buildSystemContext(flags, text, stage);
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
function tryManualResponse(normalizedText, context = {}, flags = {}) {
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
        if (isFirstContact || !messageCount) {
            return getManual("saudacao");
        }

        return "Oi! Que bom falar com você de novo 😊 Me conta, deu tudo certo com o agendamento ou ficou mais alguma dúvida? 💚";
    }

    // 💼 CURRÍCULO / VAGA / TRABALHO
    if (
        /\b(curr[ií]culo|curriculo|cv\b|trabalhar|emprego|trampo)\b/.test(
            normalizedText,
        )
    ) {
        return (
            "Que bom que você tem interesse em trabalhar com a gente! 🥰\n\n" +
            "Os currículos são recebidos **exclusivamente por e-mail**.\n" +
            "Por favor, envie seu currículo para **contato@clinicafonoinova.com.br**, " +
            "colocando no assunto a área em que você tem interesse.\n\n" +
            "Se quiser conhecer melhor nosso trabalho, é só acompanhar a clínica também no Instagram: **@clinicafonoinova** 💚"
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
        { id: "fonoaudiologia", regex: /\b(fono|fonoaudiolog(?:ia|o)?)\b/ },
        { id: "terapia_ocupacional", regex: /\b(terapia\s+ocupacional|t\.?\s*o\.?)\b/ },
        { id: "fisioterapia", regex: /\bfisio|fisioterap\b/ },
        { id: "psicopedagogia", regex: /\bpsicopedagog\b/ },
        { id: "psicologia", regex: /\b(psicolog(?:ia|o)?)(?!\s*pedagog|.*neuro)\b/i },
        { id: "neuropsicologia", regex: /\bneuropsicolog(?:ia|o)?\b/i },
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

    const systemContext = buildSystemContext(flags, userText, stage);
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

    // 💸 Se pediu PREÇO → usa value pitch + insights
    if (flags.asksPrice) {
        const insights = await getLatestInsights();
        let learnedContext = "";

        if (insights?.data?.effectivePriceResponses) {
            const scenario = stage === "novo" ? "first_contact" : "engaged";
            const bestResponse = insights.data.effectivePriceResponses.find(
                (r) => r.scenario === scenario,
            );
            if (bestResponse) {
                learnedContext = `\n💡 PADRÃO DE SUCESSO: "${bestResponse.response}"`;
            }
        }

        const enrichedFlags = { ...flags, text: userText, rawText: userText };
        const prompt = buildUserPromptWithValuePitch(enrichedFlags);
        console.log("💰 [PRICE PROMPT] Usando buildUserPromptWithValuePitch");

        messages.push({
            role: "user",
            content: prompt + learnedContext + intelligenceNote + patientStatus + urgencyNote,
        });

        const textResp = await callAI({
            systemPrompt: dynamicSystemPrompt,
            messages,
            maxTokens: 300,
            temperature: 0.7,
        });

        return textResp || "Como posso te ajudar? 💚";
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
        shouldGreet = true,
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

    const systemContext = buildSystemContext(flags, userText, stage);
    const dynamicSystemPrompt = buildDynamicSystemPrompt(systemContext);

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

    // 🛡️ ENFORCEMENT LAYER (opcional via env var)
    // Valida blocos estruturais sem congelar texto
    const ENABLE_ENFORCEMENT = process.env.ENABLE_ENFORCEMENT === 'true';

    if (ENABLE_ENFORCEMENT) {
        const enforcementResult = enforceStructuralRules(textResp, {
            flags,
            lead,
            userText: text
        }, {
            strictMode: false,  // false = só loga, não força fallback
            logViolations: true
        });

        if (enforcementResult.wasEnforced) {
            console.log('🚨 [ENFORCEMENT] Fallback aplicado');
            return enforcementResult.response;
        }

        // Log de score (mesmo sem enforcement)
        if (enforcementResult.validation.stats.totalRulesChecked > 0) {
            console.log(`✅ [ENFORCEMENT] Score: ${(enforcementResult.validation.score * 100).toFixed(0)}% (${enforcementResult.validation.stats.passedRules}/${enforcementResult.validation.stats.totalRulesChecked} regras)`);
        }
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


const buildSystemContext = (flags, text = "", stage = "novo") => ({
    isHotLead: flags.visitLeadHot || stage === "interessado_agendamento",
    isColdLead: flags.visitLeadCold || stage === "novo",

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

export default getOptimizedAmandaResponse;