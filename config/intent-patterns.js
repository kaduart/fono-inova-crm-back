/**
 * 🎯 CONFIGURAÇÃO DE PADRÕES DE INTENÇÃO
 *
 * FILOSOFIA:
 * - Padrões BASE: extraídos manualmente de conversas reais
 * - Padrões LEARNED: populados automaticamente via análise de conversas (inicialmente vazio)
 * - CONTEXT: variações contextuais comuns
 *
 * IMPORTANTE:
 * - Não adicionar padrões sem evidência de conversas reais
 * - Cada padrão deve ter comentário explicando DE ONDE veio
 * - Peso (weight) indica confiança: 1.0 = alta, 0.5 = média, 0.3 = baixa
 *
 * 📊 DADOS REAIS (whatsapp_export_2026-02-13.txt):
 * - 6,434 mensagens de 279 conversas analisadas
 * - CONFIRMATION: 373 ocorrências (26.3%) ← PRIORIDADE #1
 * - SCHEDULING: 306 ocorrências (21.6%)
 * - INSURANCE: 261 ocorrências (18.4%) ← Unimed: 103x (39.5%)
 * - PRICE: 234 ocorrências (16.5%)
 */

export const INTENT_PATTERNS = {
  // =========================================================================
  // INTENÇÃO: PREÇO
  // 📊 Volume: 234 ocorrências (16.5%) - 4º lugar
  // =========================================================================
  price: {
    description: 'Lead pergunta sobre valores, preços ou custos',
    frequency: 234,
    volumePercentage: 16.5,
    base: [
      {
        pattern: /\b(pre[çc]o|val(?:or|ores)|quanto\s*custa)\b/i,
        weight: 1.0,
        source: 'conversas_reais_2025',
        examples: ['qual o preço', 'valor da consulta', 'quanto custa']
      },
      {
        pattern: /\b(or[çc]amento|investimento|custo|taxa)\b/i,
        weight: 0.9,
        source: 'conversas_reais_2025',
        examples: ['qual o orçamento', 'custo mensal']
      },
      {
        pattern: /\b(mensal(?:idade)?|pacote|tabela\s+de\s+pre[çc]os?)\b/i,
        weight: 0.8,
        source: 'conversas_reais_2025',
        examples: ['mensalidade', 'tem pacote']
      },
      {
        pattern: /\b(me\s+passa\s+o\s+valor|qual\s+(?:o|é)\s+valor)\b/i,
        weight: 1.0,
        source: 'conversas_reais_2025',
        examples: ['me passa o valor', 'qual é o valor']
      },
      {
        pattern: /r\$\s*\d+(?:[.,]\d{2})?|\$\$+/i,
        weight: 0.7,
        source: 'conversas_reais_2025',
        examples: ['R$ 200', '$$']
      }
    ],
    learned: [],
    contextual: {
      insistent: {
        pattern: /(s[oó]|apenas)\s*o\s*pre[çc]o|fala\s*o\s*valor|me\s*diz\s*o\s*pre[çc]o/i,
        weight: 1.0,
        flag: 'insistsPrice'
      }
    }
  },

  // =========================================================================
  // INTENÇÃO: AGENDAMENTO
  // 📊 Volume: 306 ocorrências (21.6%) - 2º lugar
  // =========================================================================
  scheduling: {
    description: 'Lead quer agendar, marcar ou verificar disponibilidade',
    frequency: 306,
    volumePercentage: 21.6,
    base: [
      {
        pattern: /\b(agendar|marcar|agendamento|remarcar|consultar)\b/i,
        weight: 1.0,
        source: 'conversas_reais_2025',
        examples: ['quero agendar', 'marcar consulta']
      },
      {
        pattern: /\b(teria\s+vaga|tem\s+vaga|tem\s+hor[áa]rio|conseguir\s+um\s+hor[áa]rio)\b/i,
        weight: 0.9,
        source: 'conversas_reais_2025',
        examples: ['tem vaga', 'tem horário disponível']
      },
      {
        pattern: /\b(quero\s+(uma?\s+)?consult|preciso\s+marc|posso\s+(agendar|marc))\b/i,
        weight: 1.0,
        source: 'conversas_reais_2025',
        examples: ['quero uma consulta', 'preciso marcar']
      },
      {
        pattern: /\b(quando\s+posso\s+(ir|marc)|tem\s+disponibilidade)\b/i,
        weight: 0.8,
        source: 'conversas_reais_2025',
        examples: ['quando posso ir', 'tem disponibilidade']
      }
    ],
    learned: [],
    contextual: {
      urgency: {
        pattern: /\b(urgente|logo|r[aá]pido|quanto\s+antes)\b/i,
        weight: 1.0,
        flag: 'mentionsUrgency'
      },
      reschedule: {
        pattern: /\b(reagendar|remarcar|mudar\s+hor[aá]rio|trocar\s+hor[aá]rio|alterar\s+data)\b/i,
        weight: 1.0,
        flag: 'wantsReschedule'
      }
    }
  },

  // =========================================================================
  // INTENÇÃO: LOCALIZAÇÃO
  // =========================================================================
  location: {
    description: 'Lead pergunta sobre endereço, localização ou como chegar',
    base: [
      {
        pattern: /\b(onde\s+(fica|é|está|ficam|são))\s+(a\s+)?(cl[ií]nica|consult[oó]rio|voc[eê]s)/i,
        weight: 1.0,
        source: 'conversas_reais_2025',
        examples: ['onde fica a clínica', 'onde vocês são']
      },
      {
        pattern: /\b(qual\s+(o\s+)?endere[çc]o|endere[çc]o\s+(de\s+)?voc[eê]s)/i,
        weight: 1.0,
        source: 'conversas_reais_2025',
        examples: ['qual o endereço', 'endereço de vocês']
      },
      {
        pattern: /\b(como\s+(chego|chegar|chega)|localiza[çc][aã]o)/i,
        weight: 0.9,
        source: 'conversas_reais_2025',
        examples: ['como chego', 'localização']
      },
      {
        pattern: /\b(voc[eê]s\s+(s[aã]o|ficam)\s+(de\s+|em\s+|onde))/i,
        weight: 0.8,
        source: 'conversas_reais_2025',
        examples: ['vocês são de anápolis', 'vocês ficam onde']
      }
    ],
    learned: []
  },

  // =========================================================================
  // INTENÇÃO: PLANOS DE SAÚDE
  // 📊 Volume: 261 ocorrências (18.4%) - 3º lugar
  // 🏆 Unimed: 103 menções (39.5% dos casos de plano)
  // =========================================================================
  insurance: {
    description: 'Lead pergunta sobre convênios ou planos de saúde',
    frequency: 261,
    volumePercentage: 18.4,
    topPlan: { name: 'unimed', mentions: 103, percentage: 39.5 },
    base: [
      {
        pattern: /\bunimed\b/i,  // Extraído para destaque (103x nos dados)
        weight: 1.0,
        source: 'whatsapp_export_2026-02-13.txt',
        examples: ['aceitam unimed', 'tem unimed', 'pelo unimed'],
        frequency: 103
      },
      {
        pattern: /\b(ipasgo|amil|bradesco|sul\s*am[eé]rica|hapvida)\b/i,
        weight: 1.0,
        source: 'conversas_reais_2025',
        examples: ['tem ipasgo', 'aceita amil']
      },
      {
        pattern: /\b(plano|conv[eê]nio)\b/i,
        weight: 0.9,
        source: 'conversas_reais_2025',
        examples: ['tem convênio', 'aceita plano']
      },
      {
        pattern: /\b(reembolso|guia|declara[çc][aã]o.*plano)\b/i,
        weight: 0.8,
        source: 'conversas_reais_2025',
        examples: ['tem reembolso', 'emite guia']
      }
    ],
    learned: [],
    contextual: {
      objection: {
        pattern: /\b(queria\s+(pelo|usar\s+o)\s+plano|s[oó]\s+atendo\s+por\s+plano|n[aã]o\s+pago\s+particular)\b/i,
        weight: 1.0,
        flag: 'mentionsInsuranceObjection'
      }
    }
  },

  // =========================================================================
  // EMOÇÃO: URGÊNCIA
  // =========================================================================
  urgency: {
    description: 'Lead expressa necessidade urgente ou rápida',
    base: [
      {
        pattern: /\b(urgente|urg[êe]ncia|o\s+quanto\s+antes)\b/i,
        weight: 1.0,
        source: 'conversas_reais_2025',
        examples: ['é urgente', 'preciso urgente']
      },
      {
        pattern: /\b(logo|r[aá]pido|n[aã]o\s+pode\s+esperar)\b/i,
        weight: 0.9,
        source: 'conversas_reais_2025',
        examples: ['preciso logo', 'não pode esperar']
      },
      {
        pattern: /\b(preciso\s+(muito|urgente)|caso\s+urgente|emerg[êe]ncia)\b/i,
        weight: 1.0,
        source: 'conversas_reais_2025',
        examples: ['preciso muito', 'caso urgente']
      }
    ],
    learned: []
  },

  // =========================================================================
  // EMOÇÃO: CANCELAMENTO / DESISTÊNCIA
  // =========================================================================
  cancellation: {
    description: 'Lead quer cancelar ou expressa impossibilidade',
    base: [
      {
        pattern: /(quero|preciso|pode)\s+(cancelar|desmarcar)/i,
        weight: 1.0,
        source: 'conversas_reais_2025',
        examples: ['quero cancelar', 'preciso desmarcar']
      },
      {
        pattern: /n[aã]o\s+vou\s+(poder|mais|conseguir)\s*(ir)?/i,
        weight: 1.0,
        source: 'conversas_reais_2025',
        examples: ['não vou poder ir', 'não vou conseguir']
      },
      {
        pattern: /(surgiu|tive|aconteceu)\s+(um\s+)?(imprevisto|problema)/i,
        weight: 0.9,
        source: 'conversas_reais_2025',
        examples: ['surgiu um imprevisto', 'tive um problema']
      },
      {
        pattern: /(estou|t[oô]|fiquei)\s+(doente|mal|ruim)/i,
        weight: 0.8,
        source: 'conversas_reais_2025',
        examples: ['estou doente', 'tô mal']
      }
    ],
    learned: []
  },

  // =========================================================================
  // NEGAÇÃO / RECUSA
  // =========================================================================
  refusal: {
    description: 'Lead recusa oferta ou expressa desinteresse',
    base: [
      {
        pattern: /n[aã]o\s+(quero|preciso|vou|obrigad[oa]?)/i,
        weight: 1.0,
        source: 'conversas_reais_2025',
        examples: ['não quero', 'não preciso']
      },
      {
        pattern: /(obrigad[oa]|valeu),?\s+(mas\s+)?n[aã]o/i,
        weight: 1.0,
        source: 'conversas_reais_2025',
        examples: ['obrigada mas não', 'valeu não']
      },
      {
        pattern: /(vou|preciso|deixa\s+eu)\s+pensar/i,
        weight: 0.7,
        source: 'conversas_reais_2025',
        examples: ['vou pensar', 'deixa eu pensar']
      },
      {
        pattern: /(t[aá]|ficou|est[aá])\s+(caro|puxado|dif[ií]cil)/i,
        weight: 0.9,
        source: 'conversas_reais_2025',
        examples: ['tá caro', 'ficou puxado']
      }
    ],
    learned: []
  },

  // =========================================================================
  // CONFIRMAÇÃO
  // 📊 Volume: 373 ocorrências (26.3%) - 1º LUGAR (PRIORIDADE MÁXIMA)
  // 🎯 76% são apenas "sim/ok" (283 de 373)
  // 🔧 Agora usa ConfirmationDetector contextual para inferir significado
  // =========================================================================
  confirmation: {
    description: 'Lead confirma, concorda ou responde positivamente',
    frequency: 373,
    volumePercentage: 26.3,
    shortRepliesPercentage: 76,  // sim/ok representam 76% do total
    detector: 'ConfirmationDetector',  // Usa detector especializado
    base: [
      {
        pattern: /^\s*sim\s*$/i,
        weight: 1.0,
        source: 'whatsapp_export_2026-02-13.txt',
        examples: ['sim'],
        frequency: 186  // Dado real
      },
      {
        pattern: /^\s*ok\s*$/i,
        weight: 1.0,
        source: 'whatsapp_export_2026-02-13.txt',
        examples: ['ok'],
        frequency: 97  // Dado real
      },
      {
        pattern: /\b(isso|isso\s+mesmo|exato|correto|certo|confirmo)\b/i,
        weight: 1.0,
        source: 'conversas_reais_2025',
        examples: ['isso mesmo', 'exato', 'confirmo']
      },
      {
        pattern: /\b(pode\s+ser|ta\s+bom|beleza|blz)\b/i,
        weight: 0.9,
        source: 'conversas_reais_2025',
        examples: ['pode ser', 'tá bom', 'beleza']
      },
      {
        pattern: /\b(uhum|aham)\b/i,
        weight: 0.8,
        source: 'conversas_reais_2025',
        examples: ['uhum', 'aham']
      }
    ],
    learned: []
  },

  // =========================================================================
  // JÁ AGENDADO
  // =========================================================================
  already_scheduled: {
    description: 'Lead informa que já tem agendamento',
    base: [
      {
        pattern: /j[aá]\s+(est[aá]|t[aá]|foi)\s+(agendad[oa]|marcad[oa]|confirmad[oa])/i,
        weight: 1.0,
        source: 'conversas_reais_2025',
        examples: ['já está agendado', 'já tá marcado']
      },
      {
        pattern: /j[aá]\s+(agendei|marquei|confirmei)/i,
        weight: 1.0,
        source: 'conversas_reais_2025',
        examples: ['já agendei', 'já marquei']
      },
      {
        pattern: /j[aá]\s+tenho\s+(agendamento|consulta|hor[aá]rio)/i,
        weight: 1.0,
        source: 'conversas_reais_2025',
        examples: ['já tenho agendamento', 'já tenho horário']
      }
    ],
    learned: []
  },

  // =========================================================================
  // PERFIL DO LEAD: CONDIÇÕES MÉDICAS
  // =========================================================================
  medical_condition: {
    description: 'Lead menciona condição médica específica',
    subtypes: {
      tea_tdah: {
        pattern: /(tea|autismo|autista|tdah|d[eé]ficit\s+de\s+aten[çc][aã]o|hiperativ)/i,
        weight: 1.0,
        flag: 'mentionsTEA_TDAH'
      },
      tod: {
        pattern: /\b(tod|transtorno\s+oposito|desafiador|muita\s+birra|agressiv[ao])\b/i,
        weight: 1.0,
        flag: 'mentionsTOD'
      },
      tongue_tie: {
        pattern: /\b(linguinha|fr[eê]nulo\s+lingual|freio\s+da\s+l[ií]ngua)\b/i,
        weight: 1.0,
        flag: 'mentionsLinguinha'
      }
    }
  },

  // =========================================================================
  // SOLICITAÇÕES ESPECIAIS
  // =========================================================================
  special_requests: {
    description: 'Solicitações que fogem do fluxo padrão',
    subtypes: {
      human_agent: {
        pattern: /(falar\s+com\s+atendente|falar\s+com\s+uma\s+pessoa|quero\s+atendente)/i,
        weight: 1.0,
        flag: 'wantsHumanAgent'
      },
      invoice: {
        pattern: /(nota\s*fiscal|nf|nota\s*para\s*reembolso)/i,
        weight: 1.0,
        flag: 'wantsInvoice'
      },
      partnership: {
        pattern: /\b(curr[ií]cul|parceria|vaga|trabalhar\s+com\s+voc[eê]s)\b/i,
        weight: 1.0,
        flag: 'wantsPartnershipOrResume'
      }
    }
  }
};

/**
 * 🎯 PADRÕES DE PERFIL DO USUÁRIO
 * Classificação comportamental baseada em sintomas/queixas mencionadas
 */
export const USER_PROFILE_PATTERNS = {
  baby: {
    pattern: /(bebê|bebe|recém|nenem|nascido|amamenta|mamar|meses)/i,
    weight: 1.0,
    description: 'Bebê ou recém-nascido'
  },
  school: {
    pattern: /(escola|nota|professora|lição|dever)/i,
    weight: 0.9,
    description: 'Dificuldades escolares'
  },
  behavior: {
    pattern: /(birra|comportamento|mania|teima)/i,
    weight: 0.9,
    description: 'Questões comportamentais'
  },
  emotional: {
    pattern: /(ansiedade|medo|chora|emocional)/i,
    weight: 0.9,
    description: 'Aspectos emocionais'
  },
  sensory: {
    pattern: /(sensível|sensibilidade|textura|som)/i,
    weight: 0.9,
    description: 'Questões sensoriais'
  },
  motor: {
    pattern: /(coordenação|escrever|lápis|amarrar)/i,
    weight: 0.9,
    description: 'Desenvolvimento motor'
  },
  learning: {
    pattern: /(nota|aprender|estudar|dificuldade\s+escola)/i,
    weight: 0.9,
    description: 'Dificuldades de aprendizagem'
  },
  focus: {
    pattern: /(atenção|concentrar|distrair|hiperativo)/i,
    weight: 0.9,
    description: 'Problemas de atenção/foco'
  }
};

/**
 * 🎯 PADRÕES DE FAIXA ETÁRIA
 */
export const AGE_GROUP_PATTERNS = {
  child: {
    patterns: [
      /(\d{1,2})\s*anos?/i,  // "4 anos", "12 anos"
      /(\d{1,2})\s*mes(?:es)?/i,  // "18 meses"
      /\b(crian[çc]a|meu\s*filho|minha\s*filha|beb[eê])\b/i
    ],
    calculator: (text) => {
      const yearsMatch = text.match(/(\d{1,2})\s*anos?/i);
      if (yearsMatch) {
        const years = parseInt(yearsMatch[1], 10);
        if (years <= 12) return 'crianca';
        if (years <= 17) return 'adolescente';
        return 'adulto';
      }

      const monthsMatch = text.match(/(\d{1,2})\s*mes(?:es)?/i);
      if (monthsMatch) return 'crianca';

      return null;
    }
  },
  teen: {
    pattern: /\b(adolescente|adolesc[êe]ncia|pré[-\s]*adolescente)\b/i,
    value: 'adolescente'
  },
  adult: {
    pattern: /\b(adulto|maior\s*de\s*18|pra\s*mim|para\s*mim)\b/i,
    value: 'adulto'
  }
};

/**
 * 🛠️ CONFIGURAÇÃO DE DETECTORES
 */
export const DETECTOR_CONFIG = {
  // Threshold mínimo de confiança para considerar uma detecção válida
  confidenceThreshold: 0.7,

  // Peso de padrões aprendidos vs base
  learnedPatternWeight: 0.5,

  // Máximo de padrões aprendidos por categoria
  maxLearnedPatterns: 20,

  // Habilitar/desabilitar aprendizado automático
  enableAutoLearning: process.env.DISABLE_AUTO_LEARNING !== 'true'
};

export default {
  INTENT_PATTERNS,
  USER_PROFILE_PATTERNS,
  AGE_GROUP_PATTERNS,
  DETECTOR_CONFIG
};
