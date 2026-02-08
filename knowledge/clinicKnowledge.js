/**
 * 📚 CLINIC KNOWLEDGE BASE
 *
 * Fonte única da verdade para informações da clínica.
 * Usado pelo Orchestrator V7 para responder perguntas com precisão.
 *
 * IMPORTANTE: Mantenha este arquivo atualizado com informações reais da clínica.
 * O LLM NUNCA inventa - só usa o que está aqui.
 */

export const CLINIC_KNOWLEDGE = {
  // ═══════════════════════════════════════════════════
  // 💰 PREÇOS (com gatilhos de valor)
  // ═══════════════════════════════════════════════════
  pricing: {
    avaliacao: "R$ 200 (todas especialidades, exceto neuropsicologia)",
    avaliacaoNeuro: "R$ 400 (neuropsicologia - avaliação completa)",
    sessao: "Definido após avaliação, geralmente entre R$ 180 e R$ 200",
    pacotes: "Oferecemos pacotes mensais com desconto (perguntar na avaliação)",

    // 🎯 Gatilhos de venda consultiva
    valorAgregado: "Na avaliação você já sai com um plano personalizado e sabe exatamente o que fazer",
    comparacao: "Muitas famílias investem anos em tratamentos errados por não fazer uma avaliação completa antes",
    urgencia: "Quanto antes começar, melhores e mais rápidos são os resultados",
    provaSocial: "A maioria dos nossos pacientes nota evolução já nas primeiras semanas",
    garantia: "Se não ficar satisfeito com a avaliação, conversamos e ajustamos o plano sem custo"
  },

  // ═══════════════════════════════════════════════════
  // 🏥 PLANOS DE SAÚDE / CONVÊNIOS (com tranquilização)
  // ═══════════════════════════════════════════════════
  insurance: {
    aceita: true,
    tipo: "Reembolso de todos os planos de saúde",
    comoFunciona: "Você paga a consulta e solicita reembolso ao seu plano",
    percentualReembolso: "Geralmente entre 80% e 100% do valor (depende do plano)",
    planosComuns: ["Unimed", "IPASGO", "Amil", "Bradesco Saúde", "SulAmérica"],
    formasPagamento: ["Pix", "Cartão de crédito", "Cartão de débito", "Dinheiro"],

    // 🎯 Tranquilização sobre planos
    facilitacao: "É super simples! A maioria dos nossos pacientes consegue reembolso sem dificuldade",
    provaSocial: "Muitas famílias vêm com essa dúvida e ficam tranquilas quando vêem como funciona",
    beneficio: "Você tem a liberdade de escolher o melhor profissional, não fica limitado pela rede do plano"
  },

  // ═══════════════════════════════════════════════════
  // 📄 DOCUMENTAÇÃO
  // ═══════════════════════════════════════════════════
  documentation: {
    precisaLaudoPrevio: false,
    precisaEncaminhamento: false,
    emiteLaudo: true,
    emiteRelatorio: true,
    observacao: "Nossa equipe faz a avaliação completa aqui mesmo, sem necessidade de documentos prévios"
  },

  // ═══════════════════════════════════════════════════
  // 🕐 HORÁRIOS E DIAS
  // ═══════════════════════════════════════════════════
  schedule: {
    diasAtendimento: "Segunda a sexta-feira",
    horarioFuncionamento: "8h às 18h",
    periodosDisponiveis: ["Manhã (8h-12h)", "Tarde (14h-18h)"],
    sabado: false,
    domingo: false,
    observacao: "Horários específicos verificados após a avaliação inicial"
  },

  // ═══════════════════════════════════════════════════
  // 🏗️ ESTRUTURA DAS SESSÕES
  // ═══════════════════════════════════════════════════
  structure: {
    tipoSessao: "Individual (personalizado para cada paciente)",
    duracaoSessao: {
      fonoaudiologia: "50 minutos a 1 hora",
      psicologia: "50 minutos",
      fisioterapia: "1 hora",
      terapiaOcupacional: "50 minutos a 1 hora",
      neuropsicologia: "Varia (2 a 3 horas na avaliação)"
    },
    frequenciaSugerida: "1 a 2 vezes por semana (definido após avaliação)",
    formato: "Presencial na clínica"
  },

  // ═══════════════════════════════════════════════════
  // 🎯 MÉTODOS E ABORDAGENS
  // ═══════════════════════════════════════════════════
  methods: {
    aba: {
      oferecemos: true,
      nome: "ABA - Análise do Comportamento Aplicada",
      especialidade: "Psicologia",
      indicacao: "Autismo e transtornos do comportamento",
      descricao: "Trabalhamos com análise do comportamento aplicada"
    },
    denver: {
      oferecemos: false,
      nome: "Modelo Denver",
      alternativa: "Trabalhamos com outras abordagens baseadas em evidências para autismo",
      especialidadesQueAtendem: ["Psicologia", "Terapia Ocupacional", "Fonoaudiologia"]
    },
    prompt: {
      oferecemos: true,
      nome: "Método PROMPT",
      especialidade: "Fonoaudiologia",
      indicacao: "Dificuldades de fala e articulação",
      descricao: "Método de ajuda tátil para produção de sons da fala"
    },
    bobath: {
      oferecemos: true,
      nome: "Conceito Bobath",
      especialidade: "Fisioterapia",
      indicacao: "Atrasos motores e condições neurológicas",
      descricao: "Abordagem para desenvolvimento neuromotor"
    },
    integracaoSensorial: {
      oferecemos: true,
      nome: "Integração Sensorial",
      especialidade: "Terapia Ocupacional",
      indicacao: "Dificuldades de processamento sensorial",
      descricao: "Ajuda crianças que têm sensibilidade a texturas, sons, etc."
    }
  },

  // ═══════════════════════════════════════════════════
  // 🏢 LOCALIZAÇÃO E ESTRUTURA
  // ═══════════════════════════════════════════════════
  location: {
    endereco: "Av. Brasil, 1234 - Centro, Anápolis/GO",
    estacionamento: "Fácil na rua + estacionamento pago próximo",
    acessibilidade: "Térreo com acessibilidade",
    salas: "Salas individuais equipadas para cada especialidade"
  },

  // ═══════════════════════════════════════════════════
  // 👥 ESPECIALIDADES DISPONÍVEIS
  // ═══════════════════════════════════════════════════
  specialties: {
    fonoaudiologia: {
      nome: "Fonoaudiologia",
      trata: [
        "Atraso na fala",
        "Troca de letras/sons",
        "Gagueira",
        "Dificuldades de linguagem",
        "Problemas de deglutição"
      ],
      idadesAtendidas: "Todas as idades (bebês a adultos)"
    },
    psicologia: {
      nome: "Psicologia",
      trata: [
        "Ansiedade",
        "TDAH",
        "Autismo (TEA)",
        "Problemas de comportamento",
        "Depressão",
        "Orientação de pais"
      ],
      idadesAtendidas: "Crianças, adolescentes e adultos"
    },
    fisioterapia: {
      nome: "Fisioterapia",
      trata: [
        "Atrasos motores",
        "Reabilitação pós-acidente",
        "Dores musculares/articulares",
        "Problemas de postura",
        "Desenvolvimento motor infantil"
      ],
      idadesAtendidas: "Todas as idades"
    },
    terapiaOcupacional: {
      nome: "Terapia Ocupacional",
      trata: [
        "Dificuldades de coordenação motora",
        "Seletividade alimentar",
        "Integração sensorial",
        "Dificuldades nas atividades diárias",
        "Desenvolvimento infantil"
      ],
      idadesAtendidas: "Principalmente crianças"
    },
    neuropsicologia: {
      nome: "Neuropsicologia",
      trata: [
        "Avaliação cognitiva completa",
        "Atenção e memória",
        "Funções executivas",
        "Dificuldades de aprendizagem",
        "Laudos para escola/médico"
      ],
      idadesAtendidas: "Crianças, adolescentes e adultos"
    },
    psicopedagogia: {
      nome: "Psicopedagogia",
      trata: [
        "Dificuldades de aprendizagem",
        "Problemas na escola",
        "Dislexia",
        "Orientação de estudos",
        "Reforço escolar"
      ],
      idadesAtendidas: "Crianças e adolescentes"
    }
  },

  // ═══════════════════════════════════════════════════
  // 🎨 DIFERENCIAIS DA CLÍNICA (com prova social)
  // ═══════════════════════════════════════════════════
  differentials: [
    "Equipe multidisciplinar integrada (quando precisa de mais de uma especialidade, elas trabalham juntas!)",
    "Atendimento humanizado e acolhedor (muitas famílias dizem que se sentem em casa)",
    "Profissionais especializados e experientes (nossa equipe tem anos de prática)",
    "Ambiente lúdico para crianças (as crianças ADORAM vir aqui!)",
    "Trabalho conjunto entre especialidades quando necessário (evolução mais rápida!)",
    "Relatórios e laudos detalhados (para escola, médico, etc.)"
  ],

  // 🎯 GATILHOS DE VENDA CONSULTIVA
  salesTriggers: {
    escassez: "Temos vagas disponíveis essa semana ainda, mas costumam preencher rápido",
    urgencia: "Quanto antes iniciar, melhores os resultados. O cérebro responde melhor quando intervimos cedo",
    autoridade: "Nossa equipe é referência em Anápolis. Muitos médicos e escolas nos indicam",
    provaSocial: "Já atendemos centenas de famílias que estavam na mesma situação que você",
    seguranca: "Você não assume compromisso agora. Vamos fazer a avaliação primeiro e depois você decide",
    empatia: "Entendo que é uma decisão importante. Estamos aqui para te ajudar sem pressão",
    resultados: "A maioria das famílias nota evolução já nas primeiras 3-4 semanas de tratamento"
  },

  // ═══════════════════════════════════════════════════
  // ⚠️ IMPORTANTE: Quando NÃO sabemos
  // ═══════════════════════════════════════════════════
  unknownAnswers: {
    default: "Deixa eu verificar isso com a equipe e te respondo certinho, ok? 💚",
    needsHumanReview: "Essa é uma ótima pergunta! Vou passar para nossa equipe te dar uma resposta completa."
  }
};

/**
 * Helper: Busca informação específica na knowledge base
 */
export function getKnowledgeByKey(path) {
  const keys = path.split('.');
  let value = CLINIC_KNOWLEDGE;

  for (const key of keys) {
    if (value[key] === undefined) {
      return null;
    }
    value = value[key];
  }

  return value;
}

/**
 * Helper: Verifica se oferece determinado método/serviço
 */
export function offerMethod(methodName) {
  const method = CLINIC_KNOWLEDGE.methods[methodName];
  return method ? method.oferecemos : null;
}

export default CLINIC_KNOWLEDGE;
