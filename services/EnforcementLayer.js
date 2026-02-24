/**
 * 🛡️ ENFORCEMENT LAYER (Structural)
 *
 * Valida blocos estruturais obrigatórios nas respostas da Amanda,
 * SEM congelar o texto (mantém liberdade de linguagem).
 *
 * 🎯 FILOSOFIA:
 * - Valida ESTRUTURA, não FRASES
 * - Exemplo: "Resposta de preço deve conter R$ + número + contexto"
 * - NÃO hardcoda: "A avaliação custa R$200"
 * - Permite: "R$200 é o valor da primeira consulta" ✅
 * - Permite: "A gente cobra R$ 200 pra avaliação inicial" ✅
 *
 * 📊 IMPACTO ESPERADO:
 * - Garante informações críticas sempre presentes
 * - Mantém naturalidade e variação de linguagem
 * - Reduz omissões em respostas importantes
 */

/**
 * 🎯 REGRAS ESTRUTURAIS
 */
const STRUCTURAL_RULES = {
  // 💰 PREÇO: Deve conter valor em reais + contexto
  price: {
    name: 'Resposta de Preço',
    validators: [
      {
        name: 'valor_em_reais',
        test: (text) => /R\$\s*\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?/i.test(text),
        errorMessage: 'Resposta sobre preço deve incluir valor em R$'
      },
      {
        name: 'contexto_do_valor',
        test: (text) => {
          // Deve mencionar o que é esse valor (serviço ou descrição)
          const hasContext = /(avalia[çc][aã]o|consulta|sess[aã]o|pacote|mensalidade|tratamento|investimento|primeira|inicial)/i.test(text);
          return hasContext;
        },
        errorMessage: 'Resposta sobre preço deve contextualizar o valor (avaliação, consulta, etc.)'
      }
    ],
    requiredWhen: (flags) => flags.asksPrice || flags.insistsPrice
  },

  // 🏥 PLANO DE SAÚDE: Deve mencionar aceite/não aceite + plano específico (se perguntado)
  insurance: {
    name: 'Resposta sobre Plano',
    validators: [
      {
        name: 'menciona_aceitacao',
        test: (text) => {
          // Deve deixar claro se aceita ou não (precisa ser específico)
          const hasPositive = /(aceita(mos)?|atende(mos)?)\s+(plano|conv[eê]nio|unimed|ipasgo|amil|bradesco)/i.test(text);
          const hasReimbursement = /(emite(imos)?|reembolso|nota\s+fiscal)/i.test(text);
          const hasWorksWith = /trabalha(mos)?\s+(com|pelo)\s+(plano|conv[eê]nio|unimed|ipasgo)/i.test(text);
          const hasNegative = /n[aã]o\s+(aceita|atende|trabalha)\s+(plano|conv[eê]nio)/i.test(text);
          return hasPositive || hasReimbursement || hasWorksWith || hasNegative;
        },
        errorMessage: 'Resposta sobre plano deve deixar claro se aceita ou não'
      },
      {
        name: 'plano_especifico',
        test: (text, context) => {
          // Se perguntou sobre plano específico, deve mencioná-lo
          const askedPlan = context.flags?._insurance?.plan;
          if (!askedPlan || askedPlan === 'generic') {
            return true; // Não aplicável
          }

          // Verifica se resposta menciona o plano específico
          const planRegex = new RegExp(`\\b${askedPlan}\\b`, 'i');
          return planRegex.test(text);
        },
        errorMessage: 'Se perguntou sobre plano específico, deve mencioná-lo na resposta',
        optional: true  // Aviso, não erro crítico
      }
    ],
    requiredWhen: (flags) => flags.asksPlans || flags._insurance?.detected
  },

  // 📅 AGENDAMENTO: Deve ter próximo passo claro
  scheduling: {
    name: 'Resposta sobre Agendamento',
    validators: [
      {
        name: 'proximo_passo',
        test: (text) => {
          // Deve indicar próximo passo: pedir dados, mostrar slots, ou encaminhar
          const hasNextStep = /(nome|idade|data\s+de\s+nascimento|qual\s+(o\s+)?dia|manh[aã]|tarde|hor[aá]rio|encaminh|equipe\s+vai)/i.test(text);
          return hasNextStep;
        },
        errorMessage: 'Resposta sobre agendamento deve indicar próximo passo claro'
      }
    ],
    requiredWhen: (flags) => flags.wantsSchedule || flags.mentionsScheduling
  },

  // ✅ CONFIRMAÇÃO: Deve validar o que foi confirmado (se ambíguo)
  confirmation: {
    name: 'Resposta a Confirmação',
    validators: [
      {
        name: 'valida_contexto',
        test: (text, context) => {
          // Se confirmação era ambígua (baixa confiança), resposta deve validar
          const wasAmbiguous = context.flags?._confirmation?.requiresValidation;
          if (!wasAmbiguous) {
            return true; // Não aplicável
          }

          // Verifica se resposta clarifica (pergunta ou confirma explicitamente)
          const clarifies = /(confirma|certinho|pra eu entender|voc[eê]\s+quis\s+dizer|s[eé]rio|isso\s+mesmo)/i.test(text);
          return clarifies;
        },
        errorMessage: 'Confirmação ambígua deve ser validada na resposta',
        optional: true  // Aviso
      }
    ],
    requiredWhen: (flags) => flags._confirmation?.requiresValidation
  },

  // 📍 LOCALIZAÇÃO: Deve ter endereço completo
  location: {
    name: 'Resposta sobre Localização',
    validators: [
      {
        name: 'endereco_completo',
        test: (text) => {
          // Deve ter rua + bairro + cidade OU link do maps
          const hasFullAddress = /(Av\.|Rua|R\.).*Jundiaí.*An[aá]polis|maps\.google\.com|goo\.gl\/maps/i.test(text);
          return hasFullAddress;
        },
        errorMessage: 'Resposta sobre localização deve incluir endereço completo ou link do maps'
      }
    ],
    requiredWhen: (flags) => flags.asksLocation || flags.asksAddress
  },

  // 🚫 HORÁRIO INVENTADO: Nunca confirmar horário específico sem ter slots reais
  // RN: Amanda NUNCA deve mencionar "às 10h", "dia 15", "segunda às 14h" etc.
  // a menos que o slot tenha sido retornado por findAvailableSlots()
  no_hallucinated_slots: {
    name: 'Horário sem Base Real',
    validators: [
      {
        name: 'sem_horario_inventado',
        test: (text, context) => {
          const hasPendingSlots = !!(
            context.lead?.pendingSchedulingSlots?.length ||
            context.lead?.pendingChosenSlot
          );

          // Se tem slots reais retornados pelo sistema, tudo bem mencionar horários
          if (hasPendingSlots) return true;

          // Detecta menção a horário específico (ex: "às 10h", "14:30", "dia 15")
          const hasSpecificTime = /\b(às\s+\d{1,2}h|\d{2}:\d{2}|dia\s+\d{1,2}\b|segunda|terça|quarta|quinta|sexta).*\b(horário|vaga|disponível|encaixar)/i.test(text);

          // Se tem horário específico sem slots reais → violação
          return !hasSpecificTime;
        },
        errorMessage: 'Amanda mencionou horário específico sem slots reais do sistema'
      }
    ],
    requiredWhen: (flags, lead) => !!(flags.wantsSchedule || flags.mentionsUrgency)
  },

  // 🎯 AREA TERAPÊUTICA: Deve mencionar a especialidade (se identificada)
  therapy_area: {
    name: 'Resposta sobre Área Terapêutica',
    validators: [
      {
        name: 'menciona_especialidade',
        test: (text, context) => {
          const detectedArea = context.flags?.therapyArea || context.lead?.therapyArea;
          if (!detectedArea) {
            return true; // Não aplicável
          }

          // Mapeia área para termos aceitáveis
          const areaTerms = {
            fonoaudiologia: /fono(audiolog|terapia)?/i,
            psicologia: /psic(olog|oter)/i,
            terapia_ocupacional: /terapia\s+ocupacional|t\.?o\./i,
            neuropsicologia: /neuropsic/i,
            fisioterapia: /fisio(terap)?/i,
            musicoterapia: /musico(terap)?/i
          };

          const termRegex = areaTerms[detectedArea];
          return termRegex ? termRegex.test(text) : true;
        },
        errorMessage: 'Se área terapêutica foi identificada, deve mencioná-la na resposta',
        optional: true
      }
    ],
    requiredWhen: (flags, lead) => !!(flags.therapyArea || lead?.therapyArea)
  }
};

/**
 * 🛡️ VALIDA RESPOSTA DA AMANDA
 *
 * @param {string} amandaResponse - Resposta gerada pela Amanda
 * @param {object} context - Contexto da conversa
 * @param {object} context.flags - Flags detectadas
 * @param {object} context.lead - Lead do MongoDB
 * @param {string} context.userText - Mensagem do usuário
 *
 * @returns {object} Resultado da validação
 */
export function validateResponse(amandaResponse, context = {}) {
  const { flags = {}, lead = {}, userText = '' } = context;

  const violations = [];
  const warnings = [];
  let passedRules = 0;
  let totalRulesChecked = 0;

  // 🔍 Verifica cada regra estrutural
  for (const [ruleKey, rule] of Object.entries(STRUCTURAL_RULES)) {
    // Verifica se regra é aplicável
    if (!rule.requiredWhen(flags, lead)) {
      continue;  // Pula se não aplicável
    }

    totalRulesChecked++;

    // 🧪 Testa cada validador da regra
    let rulePassed = true;

    for (const validator of rule.validators) {
      const passed = validator.test(amandaResponse, context);

      if (!passed) {
        rulePassed = false;

        const violation = {
          rule: rule.name,
          validator: validator.name,
          message: validator.errorMessage,
          severity: validator.optional ? 'warning' : 'error'
        };

        if (validator.optional) {
          warnings.push(violation);
        } else {
          violations.push(violation);
        }
      }
    }

    if (rulePassed) {
      passedRules++;
    }
  }

  // 📊 Resultado
  const isValid = violations.length === 0;
  const score = totalRulesChecked > 0 ? (passedRules / totalRulesChecked) : 1.0;

  return {
    isValid,
    score,
    violations,
    warnings,
    stats: {
      totalRulesChecked,
      passedRules,
      failedRules: totalRulesChecked - passedRules
    }
  };
}

/**
 * 🚨 FALLBACK BUILDER (quando validação falha)
 *
 * Constrói mensagem de fallback que garante informação crítica,
 * mas ainda mantém naturalidade.
 */
export function buildFallback(violation, context = {}) {
  const { flags = {}, lead = {} } = context;

  // 💰 Fallback de preço
  if (violation.rule === 'Resposta de Preço') {
    const area = flags.therapyArea || lead.therapyArea || 'avaliacao';
    const prices = {
      fonoaudiologia: 'R$ 200',
      psicologia: 'R$ 200',
      terapia_ocupacional: 'R$ 200',
      neuropsicologia: 'R$ 2.000 (até 6x)',
      fisioterapia: 'R$ 200',
      musicoterapia: 'R$ 200'
    };

    const price = prices[area] || 'R$ 200';
    return `A avaliação inicial é **${price}** 💚\n\nQuer que eu te explique como funciona o atendimento?`;
  }

  // 🏥 Fallback de plano
  if (violation.rule === 'Resposta sobre Plano') {
    const plan = flags._insurance?.plan || 'plano';
    return `Com o ${plan} a gente **emite nota fiscal pra reembolso** 💚\n\nQuer saber mais sobre como funciona?`;
  }

  // 📅 Fallback de agendamento
  if (violation.rule === 'Resposta sobre Agendamento') {
    return `Pra eu organizar certinho, me conta: vocês preferem **manhã ou tarde**? 💚`;
  }

  // 📍 Fallback de localização
  if (violation.rule === 'Resposta sobre Localização') {
    return `📍 **Av. Minas Gerais, 405 - Jundiaí, Anápolis - GO**\n\n🗺️ https://maps.google.com/?q=-16.3334217,-48.9488967`;
  }

  // ⚠️ Fallback genérico
  return `Me conta mais um pouquinho pra eu te ajudar certinho 💚`;
}

/**
 * 📊 ENFORCEMENT MIDDLEWARE (para usar no orchestrator)
 *
 * Valida resposta e, se necessário, aplica fallback ou log
 */
export function enforce(amandaResponse, context = {}, options = {}) {
  const {
    strictMode = false,        // Se true, força fallback em caso de violação
    logViolations = true       // Se true, loga violações
  } = options;

  // 🛡️ Valida
  const validation = validateResponse(amandaResponse, context);

  // 📊 Log
  if (logViolations && (validation.violations.length > 0 || validation.warnings.length > 0)) {
    console.log('🛡️ [ENFORCEMENT] Validação:', {
      isValid: validation.isValid,
      score: validation.score,
      violations: validation.violations.length,
      warnings: validation.warnings.length
    });

    if (validation.violations.length > 0) {
      validation.violations.forEach(v => {
        console.warn(`❌ [ENFORCEMENT] ${v.rule} - ${v.validator}: ${v.message}`);
      });
    }

    if (validation.warnings.length > 0) {
      validation.warnings.forEach(w => {
        console.warn(`⚠️ [ENFORCEMENT] ${w.rule} - ${w.validator}: ${w.message}`);
      });
    }
  }

  // 🚨 Fallback se strict mode e houve violações críticas
  if (strictMode && !validation.isValid && validation.violations.length > 0) {
    console.log('🚨 [ENFORCEMENT] Aplicando fallback (strict mode)');
    const firstViolation = validation.violations[0];
    return {
      response: buildFallback(firstViolation, context),
      wasEnforced: true,
      validation
    };
  }

  // ✅ Retorna resposta original
  return {
    response: amandaResponse,
    wasEnforced: false,
    validation
  };
}

/**
 * 📈 ESTATÍSTICAS DE ENFORCEMENT (para monitoramento)
 */
export function getEnforcementStats() {
  return {
    totalRules: Object.keys(STRUCTURAL_RULES).length,
    rules: Object.entries(STRUCTURAL_RULES).map(([key, rule]) => ({
      key,
      name: rule.name,
      validators: rule.validators.length,
      hasOptionalValidators: rule.validators.some(v => v.optional)
    }))
  };
}

export default {
  validateResponse,
  buildFallback,
  enforce,
  getEnforcementStats,
  STRUCTURAL_RULES
};
