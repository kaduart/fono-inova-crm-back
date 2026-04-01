// back/tests/amanda/amandaTestMode.js
/**
 * Amanda Test Mode
 * 
 * Modo de teste para Amanda que permite processamento síncrono e determinístico.
 * Remove dependências de async, filas, Redis e timeouts.
 * 
 * IMPORTANTE: Este módulo só deve ser usado em testes (NODE_ENV=test)
 */

import { deriveFlagsFromText } from '../../utils/flagsDetector.js';
import { detectAllTherapies } from '../../utils/therapyDetector.js';
import { extractName, extractAgeFromText, extractComplaint } from '../../utils/patientDataExtractor.js';
import { extractPreferredDateFromText } from '../../utils/dateParser.js';

// ============================================================================
// 🧠 PROCESSAMENTO SÍNCRONO
// ============================================================================

/**
 * Processa mensagem de forma síncrona (sem async externo)
 * @param {string} text - Mensagem do usuário
 * @param {Object} leadContext - Contexto do lead
 * @returns {Object} Resultado do processamento
 */
export function processMessageSync(text, leadContext = {}) {
  const startTime = Date.now();
  
  // 1. EXTRAÇÃO DE FLAGS (síncrono)
  const flags = deriveFlagsFromText(text);
  
  // 2. DETECÇÃO DE TERAPIA (síncrono)
  const therapies = detectAllTherapies(text);
  const extractedTherapy = extractTherapyFromText(text);
  
  // 3. EXTRAÇÃO DE ENTIDADES (síncrono)
  const extracted = {
    name: extractName(text),
    age: extractAgeFromText(text),
    complaint: extractComplaint(text),
    preferredDate: extractPreferredDateFromText(text),
    therapyArea: therapies.primary || extractedTherapy || leadContext.therapyArea
  };

  // 4. DETERMINAÇÃO DE INTENT (síncrono, baseado em regras)
  const intent = determineIntent(flags, extracted, text);
  
  // 5. CONSTRUÇÃO DE RESPOSTA (síncrono)
  const response = buildTestResponse(intent, flags, extracted, leadContext);
  
  const processingTime = Date.now() - startTime;
  
  return {
    intent,
    flags,
    extracted,
    response,
    processingTime,
    confidence: calculateConfidence(flags, extracted),
    timestamp: new Date().toISOString()
  };
}

/**
 * Determina intent baseado em flags e entidades extraídas
 * @param {Object} flags - Flags detectadas
 * @param {Object} extracted - Entidades extraídas
 * @param {string} text - Texto original
 * @returns {string} Intent identificada
 */
function determineIntent(flags, extracted, text) {
  const lowerText = text.toLowerCase();
  
  // PRIORIDADE 1: Intents de ação imediata
  if (flags.wantsSchedule || flags.wantsBooking || /agendar|marcar|quando tem|tem vaga/i.test(lowerText)) {
    return 'AGENDAMENTO';
  }
  
  if (flags.wantsCancel || /cancelar|desmarcar|não vou conseguir/i.test(lowerText)) {
    return 'CANCELAMENTO';
  }
  
  if (flags.wantsReschedule || /remarcar|adiar|mudar.*horário/i.test(lowerText)) {
    return 'REMARCAMENTO';
  }
  
  // PRIORIDADE 2: Intents comerciais
  if (flags.asksPrice || /quanto custa|valor|preço|tarifa/i.test(lowerText)) {
    return 'PERGUNTA_PRECO';
  }
  
  if (flags.asksPlans || /convênio|plano de saúde|amil|unimed|bradesco/i.test(lowerText)) {
    return 'PERGUNTA_CONVENIO';
  }
  
  if (flags.asksLocation || /onde fica|endereço|localização|como chegar/i.test(lowerText)) {
    return 'PERGUNTA_LOCALIZACAO';
  }
  
  // PRIORIDADE 3: Intents de informação
  if (flags.mentionsTEA_TDAH || /autismo|tea|tdah|hiperatividade|deficit/i.test(lowerText)) {
    return 'INFORMACAO_TEA_TDAH';
  }
  
  if (flags.mentionsLaudo || /laudo|avaliação|diagnóstico|parecer/i.test(lowerText)) {
    return 'INFORMACAO_LAUDO';
  }
  
  // PRIORIDADE 4: Intents de trabalho/parceria
  if (flags.wantsPartnershipOrResume || /parceria|convênio|indicação/i.test(lowerText)) {
    return 'PROPOSTA_PARCERIA';
  }
  
  if (flags.wantsJobOrInternship || /emprego|trabalho|estágio|vaga/i.test(lowerText)) {
    return 'CANDIDATURA_VAGA';
  }
  
  // PRIORIDADE 5: Intents de despedida
  if (flags.saysThanks || /obrigado|obrigada|agradeço|valeu/i.test(lowerText)) {
    return 'AGRADECIMENTO';
  }
  
  if (flags.saysBye || /tchau|até mais|até logo|adeus/i.test(lowerText)) {
    return 'DESPEDIDA';
  }
  
  // PRIORIDADE 6: Confirmação/validação
  if (flags.confirmsData || /sim|confirmo|está certo|correto/i.test(lowerText)) {
    return 'CONFIRMACAO';
  }
  
  if (flags.refusesOrDenies || /não|negativo|de jeito nenhum/i.test(lowerText)) {
    return 'RECUSA';
  }
  
  // DEFAULT: Informação genérica
  return 'INFORMACAO';
}

/**
 * Constrói resposta baseada em templates (síncrono)
 * @param {string} intent - Intent identificada
 * @param {Object} flags - Flags detectadas
 * @param {Object} extracted - Entidades extraídas
 * @param {Object} context - Contexto do lead
 * @returns {string} Resposta da Amanda
 */
function buildTestResponse(intent, flags, extracted, context) {
  const responses = {
    'AGENDAMENTO': () => {
      if (!extracted.therapyArea) {
        return 'Oi! 💚 Vou te ajudar a agendar. Qual especialidade você precisa? Temos Fonoaudiologia, Psicologia, Terapia Ocupacional, Fisioterapia ou Neuropsicologia.';
      }
      if (!extracted.name) {
        return `Perfeito! Para ${extracted.therapyArea}, preciso do nome completo do paciente.`;
      }
      if (!extracted.age) {
        return `Obrigado! E qual a idade de ${extracted.name}?`;
      }
      return `Entendido! ${extracted.name}, ${extracted.age} anos, ${extracted.therapyArea}. Vou verificar as melhores opções de horário para você. 💚`;
    },
    
    'CANCELAMENTO': () => 'Entendi que precisa cancelar. Posso ajudar a remarcar para outro dia? 💚',
    
    'REMARCAMENTO': () => 'Claro! Vou ajudar a remarcar. Qual seria o melhor dia e horário para você? 💚',
    
    'PERGUNTA_PRECO': () => {
      if (extracted.therapyArea) {
        return `Os valores para ${extracted.therapyArea} variam conforme o profissional. Posso agendar uma avaliação para discutir isso com mais detalhes? 💚`;
      }
      return 'Os valores variam por especialidade. Qual área você precisa? Posso passar informações mais precisas. 💚';
    },
    
    'PERGUNTA_CONVENIO': () => 'Trabalhamos com vários convênios! Para verificar a cobertura específica, preciso saber qual especialidade você precisa. 💚',
    
    'PERGUNTA_LOCALIZACAO': () => 'Ficamos em [ENDERECO_CLINICA]. Temos estacionamento fácil e acesso para cadeirantes. 💚',
    
    'INFORMACAO_TEA_TDAH': () => 'Temos uma equipe especializada em TEA e TDAH! Inclui neuropediatra, psicólogos e terapeutas ocupacionais. Quer agendar uma avaliação? 💚',
    
    'INFORMACAO_LAUDO': () => 'Fazemos laudos multidisciplinares completos. O processo envolve avaliação em várias áreas. Posso explicar melhor ou agendar? 💚',
    
    'PROPOSTA_PARCERIA': () => 'Agradecemos o contato! Encaminhei sua proposta para nossa equipe comercial. Eles entrarão em contato em breve. 💚',
    
    'CANDIDATURA_VAGA': () => 'Recebemos seu interesse! Por favor, envie seu currículo para [EMAIL_RH] com o assunto "Vaga - [Área]". 💚',
    
    'AGRADECIMENTO': () => 'Por nada! 💚 Estou aqui sempre que precisar.',
    
    'DESPEDIDA': () => 'Até logo! 💚 Qualquer coisa é só chamar.',
    
    'CONFIRMACAO': () => 'Perfeito! 💚 Vou confirmar aqui.',
    
    'RECUSA': () => 'Entendido, sem problemas! 💚 Se mudar de ideia ou tiver outras dúvidas, estou por aqui.',
    
    'INFORMACAO': () => {
      if (flags.isEmotional || flags.mentionsUrgency) {
        return 'Entendo sua preocupação... 💚 Estou aqui para ajudar. Me conta um pouco mais sobre a situação?';
      }
      // Se tem contexto de terapia e detectamos nome, assumimos que é continuação de agendamento
      if (context.therapyArea && extracted.name) {
        return `Perfeito, ${extracted.name}! 💚 E qual a idade? (anos ou meses)`;
      }
      return 'Oi! 💚 Seja bem-vindo à Fono Inova. Como posso ajudar você hoje?';
    }
  };
  
  const builder = responses[intent] || responses['INFORMACAO'];
  return builder();
}

/**
 * Calcula confiança da detecção
 * @param {Object} flags - Flags detectadas
 * @param {Object} extracted - Entidades extraídas
 * @returns {number} Confiança (0-1)
  */
function calculateConfidence(flags, extracted) {
  let score = 0.5; // Base
  
  // +0.2 se detectou terapia
  if (extracted.therapyArea) score += 0.2;
  
  // +0.1 se detectou nome
  if (extracted.name) score += 0.1;
  
  // +0.1 se detectou idade
  if (extracted.age) score += 0.1;
  
  // +0.1 se tem flags fortes
  if (flags.wantsSchedule || flags.asksPrice || flags.wantsCancel) score += 0.1;
  
  return Math.min(score, 1.0);
}

// ============================================================================
// 🔧 EXTRAÇÃO DE TERAPIA (helper específico para test mode)
// ============================================================================

/**
 * Extrai área terapêutica mencionada no texto
 * @param {string} text - Texto do usuário
 * @returns {string|null} Área terapêutica detectada
 */
function extractTherapyFromText(text) {
  const lowerText = text.toLowerCase();
  
  const therapyPatterns = [
    { pattern: /fonoaudiologia|fono|fono(?:audiologia)?/i, name: 'fonoaudiologia' },
    { pattern: /psicologia|psic[oó]loga?|psicopedagogia/i, name: 'psicologia' },
    { pattern: /terapia ocupacional|t\.?o\.?|ocupacional/i, name: 'terapia_ocupacional' },
    { pattern: /fisioterapia|fisio|fisioterapeuta/i, name: 'fisioterapia' },
    { pattern: /neuropsicologia|neuropsic[oó]/i, name: 'neuropsicologia' },
    { pattern: /musicoterapia|musicoterapeuta/i, name: 'musicoterapia' },
    { pattern: /neuropediatra|neuropediatria/i, name: 'neuropediatria' }
  ];
  
  for (const { pattern, name } of therapyPatterns) {
    if (pattern.test(lowerText)) {
      return name;
    }
  }
  
  return null;
}

// ============================================================================
// 🔧 UTILITÁRIOS DE TESTE
// ============================================================================

/**
 * Cria mock de lead para testes
 * @param {Object} overrides - Sobrescrições
 * @returns {Object} Lead mockado
 */
export function createMockLead(overrides = {}) {
  return {
    _id: `test-lead-${Date.now()}`,
    phone: '5511999999999',
    name: 'Test Lead',
    stage: 'new',
    qualificationData: {
      extractedInfo: {}
    },
    conversationHistory: [],
    ...overrides
  };
}

/**
 * Simula conversação completa
 * @param {Array<string>} messages - Mensagens em sequência
 * @returns {Array<Object>} Resultados de cada mensagem
 */
export function simulateConversation(messages) {
  const results = [];
  let context = {};
  
  for (const message of messages) {
    const result = processMessageSync(message, context);
    results.push(result);
    
    // Atualiza contexto para próxima iteração
    context = {
      ...context,
      lastIntent: result.intent,
      therapyArea: result.extracted.therapyArea || context.therapyArea,
      patientName: result.extracted.name || context.patientName
    };
  }
  
  return results;
}

export default {
  processMessageSync,
  createMockLead,
  simulateConversation
};
