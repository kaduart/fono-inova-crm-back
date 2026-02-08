import Logger from '../services/utils/Logger.js';
import { extractEntities, getMissingEntities } from './entityExtractor.js';
import { detectAllFlags } from '../utils/flagsDetector.js';
import { CLINIC_KNOWLEDGE } from '../knowledge/clinicKnowledge.js';
import callAI from '../services/IA/Aiproviderservice.js';
import { SYSTEM_PROMPT_AMANDA } from '../utils/amandaPrompt.js';
import ChatContext from '../models/ChatContext.js';

// =============================================================================
// 🧠 WHATSAPP ORCHESTRATOR V7 - Response-First Architecture
// =============================================================================
//
// FILOSOFIA CENTRAL:
// 1. RESPONDER o que o lead perguntou (sempre primeiro!)
// 2. ACOLHER o que o lead contou
// 3. PERGUNTAR apenas 1 coisa (se necessário)
//
// Esta ordem inverte o "slot-first thinking" e humaniza a conversa.
// =============================================================================

export class WhatsAppOrchestratorV7 {
  constructor() {
    this.logger = new Logger('OrchestratorV7');
  }

  /**
   * 🎯 Processa mensagem com arquitetura Response-First
   */
  async process({ lead, message, context = {} }) {
    const userText = message?.content || message?.text || '';
    const leadId = lead?._id?.toString() || 'unknown';

    this.logger.info('V7_START', {
      leadId,
      textPreview: userText.substring(0, 60),
      architecture: 'response-first'
    });

    try {
      // ═══════════════════════════════════════════════════
      // FASE 1: DETECÇÃO PARALELA (rápido)
      // ═══════════════════════════════════════════════════
      const [questions, entities, flags] = await Promise.all([
        this.extractQuestions(userText),
        extractEntities(userText, context),
        Promise.resolve(detectAllFlags(userText, lead, context))
      ]);

      this.logger.debug('V7_DETECTION', {
        leadId,
        questionsCount: questions.length,
        entitiesFound: Object.keys(entities).filter(k => entities[k]),
        flagsActive: Object.keys(flags).filter(k => flags[k] === true).slice(0, 5)
      });

      // ═══════════════════════════════════════════════════
      // FASE 2: CONSTRUIR RESPOSTA (ordem importa!)
      // ═══════════════════════════════════════════════════
      let response = "";

      // 2.1 🎯 RESPONDE PERGUNTAS (prioridade máxima)
      if (questions.length > 0) {
        this.logger.info('V7_ANSWERING_QUESTIONS', {
          leadId,
          questions: questions.map(q => q.text)
        });

        const answers = await this.answerQuestions(questions, {
          flags,
          entities,
          context,
          lead
        });

        response += answers + "\n\n";
      }

      // 2.2 💚 ACOLHE DADOS NOVOS
      const newData = this.getNewData(entities, context);
      if (newData.length > 0) {
        this.logger.debug('V7_ACKNOWLEDGING', {
          leadId,
          newData
        });

        const acknowledgment = this.acknowledgeData(newData, entities);
        if (acknowledgment) {
          response += acknowledgment + "\n\n";
        }
      }

      // 2.3 ❓ PERGUNTA 1 COISA (só se não fez 2+ perguntas)
      if (questions.length < 2) {
        const nextQuestion = this.decideNextQuestion(context, entities, flags, lead);
        if (nextQuestion) {
          this.logger.debug('V7_ASKING', {
            leadId,
            question: nextQuestion.substring(0, 50)
          });
          response += nextQuestion;
        }
      } else {
        this.logger.debug('V7_SKIP_QUESTION', {
          leadId,
          reason: 'lead_asked_multiple_questions'
        });
      }

      // ═══════════════════════════════════════════════════
      // FASE 3: PERSISTIR CONTEXTO ATUALIZADO
      // ═══════════════════════════════════════════════════
      const updatedContext = {
        ...context,
        ...entities,
        lastProcessedAt: new Date(),
        lastArchitecture: 'v7-response-first'
      };

      await this.saveMemory(lead._id, updatedContext);

      this.logger.info('V7_COMPLETE', {
        leadId,
        responseLength: response.length,
        answered: questions.length > 0,
        acknowledged: newData.length > 0,
        askedNext: questions.length < 2
      });

      return {
        command: 'SEND_MESSAGE',
        payload: { text: response.trim() }
      };

    } catch (error) {
      this.logger.error('V7_ERROR', {
        leadId,
        error: error.message,
        stack: error.stack
      });

      // Fallback humanizado
      return {
        command: 'SEND_MESSAGE',
        payload: {
          text: 'Oi! Sou a Amanda da Fono Inova 💚\n\nQue bom que entrou em contato! Me conta: como posso te ajudar hoje?'
        }
      };
    }
  }

  /**
   * 🔍 Extrai perguntas da mensagem do lead
   * Não tenta mapear todas as perguntas possíveis - usa categorias amplas
   */
  extractQuestions(text) {
    const questions = [];
    const lower = text.toLowerCase();

    // Padrões de perguntas (categorias amplas, não específicas)
    const patterns = [
      {
        regex: /quanto\s+(custa|é|fica|cobra|custa\s+a|sai)/i,
        type: 'pricing',
        text: text.match(/[^.!?]*quanto\s+(?:custa|é|fica|cobra|sai)[^.!?]*/i)?.[0]
      },
      {
        regex: /aceita\s+(plano|conv[eê]nio)|plano\s+de\s+sa[uú]de/i,
        type: 'insurance',
        text: text.match(/[^.!?]*(?:aceita|plano)[^.!?]*/i)?.[0]
      },
      {
        regex: /voc[eê]s?\s+(fazem|trabalham|atendem|t[eê]m|oferecem)/i,
        type: 'services',
        text: text.match(/[^.!?]*voc[eê]s?\s+(?:fazem|trabalham|atendem|têm|oferecem)[^.!?]*/i)?.[0]
      },
      {
        regex: /precisa\s+(de\s+)?(laudo|encaminhamento|pedido|m[eé]dico)/i,
        type: 'documentation',
        text: text.match(/[^.!?]*precisa[^.!?]*/i)?.[0]
      },
      {
        regex: /qual\s+(hor[aá]rio|dia|per[ií]odo|turno)/i,
        type: 'schedule',
        text: text.match(/[^.!?]*qual\s+(?:horário|dia|período|turno)[^.!?]*/i)?.[0]
      },
      {
        regex: /como\s+(funciona|[eé]|faz)/i,
        type: 'process',
        text: text.match(/[^.!?]*como\s+(?:funciona|é|faz)[^.!?]*/i)?.[0]
      },
      {
        regex: /\?$/m,
        type: 'general',
        text: text.split(/[.!]/).find(s => s.trim().endsWith('?'))
      }
    ];

    for (const pattern of patterns) {
      if (pattern.regex.test(lower) && pattern.text) {
        questions.push({
          text: pattern.text.trim(),
          type: pattern.type
        });
      }
    }

    // Remove duplicatas
    const unique = questions.filter((q, i, arr) =>
      arr.findIndex(x => x.type === q.type) === i
    );

    return unique;
  }

  /**
   * 💬 Responde perguntas usando LLM + Knowledge Base
   * NUNCA inventa - só responde com base no conhecimento oficial
   */
  async answerQuestions(questions, { flags, entities, context, lead }) {
    // Busca conhecimento relevante baseado nas perguntas
    const knowledge = this.getRelevantKnowledge(questions, flags);

    // Se não tem conhecimento, retorna resposta genérica
    if (Object.keys(knowledge).length === 0) {
      return "Que bom que você perguntou isso! 💚 Deixa eu verificar os detalhes certinhos com a equipe e já te respondo. Enquanto isso, me conta: o que mais te preocupa?";
    }

    // Constrói prompt para o LLM
    const questionsText = questions.map(q => `- ${q.text}`).join('\n');
    const knowledgeText = JSON.stringify(knowledge, null, 2);

    const prompt = `O lead fez estas perguntas:
${questionsText}

Informações OFICIAIS da clínica (use SOMENTE estas):
${knowledgeText}

🎯 SEU PAPEL: Consultora acolhedora + vendedora consultiva (não agressiva)

REGRAS OBRIGATÓRIAS:

1. **TOM ACOLHEDOR**
   - Comece validando a dúvida: "Que bom que perguntou!", "Entendo sua preocupação"
   - Use empatia: "É normal se sentir assim", "Muitas famílias passam por isso"
   - Seja calorosa mas profissional

2. **VENDA CONSULTIVA**
   - Foque em BENEFÍCIOS (não só características)
   - Exemplo RUIM: "Avaliação custa R$ 200"
   - Exemplo BOM: "Na avaliação, a gente entende exatamente o que está acontecendo e já traça um plano personalizado. O investimento é R$ 200 💚"
   - Use prova social: "Muitas famílias vêm com essa mesma dúvida e ficam tranquilas depois da avaliação"

3. **GATILHOS PSICOLÓGICOS SUTIS**
   - Escassez suave: "Temos vagas essa semana ainda"
   - Urgência: "Quanto antes começar, melhores os resultados"
   - Autoridade: "Nossa equipe é especializada nisso"
   - Segurança: "Você não precisa de laudo prévio, fazemos tudo aqui"

4. **ESTRUTURA DA RESPOSTA**
   - 1ª frase: Acolhe a dúvida
   - 2ª-3ª frases: Responde com BENEFÍCIO + informação
   - 4ª frase: Convida para próximo passo (sutil)
   - Máximo 5 frases
   - 1-2 emojis 💚

EXEMPLO DE RESPOSTA BOA:
"Que bom que perguntou sobre os valores! 💚 Na avaliação, nossa equipe faz uma análise completa e você já sai sabendo exatamente o que fazer. O investimento é R$ 200 (50min). E trabalhamos com reembolso de todos os planos! Quer que eu verifique os horários disponíveis?"

Responda AGORA:`;

    try {
      const answer = await callAI({
        systemPrompt: SYSTEM_PROMPT_AMANDA,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 500,
        temperature: 0.7
      });

      return answer || this.fallbackAnswer(questions[0].type, knowledge);
    } catch (error) {
      this.logger.warn('V7_LLM_FAILED', { error: error.message });
      return this.fallbackAnswer(questions[0].type, knowledge);
    }
  }

  /**
   * 📚 Busca conhecimento relevante da base (com gatilhos de venda)
   */
  getRelevantKnowledge(questions, flags) {
    const kb = {};

    // Preço (SEMPRE inclui salesTriggers quando perguntar preço)
    if (questions.some(q => q.type === 'pricing')) {
      kb.pricing = CLINIC_KNOWLEDGE.pricing;
      kb.salesTriggers = CLINIC_KNOWLEDGE.salesTriggers; // 🎯 Gatilhos de venda
    }

    // Planos
    if (questions.some(q => q.type === 'insurance')) {
      kb.insurance = CLINIC_KNOWLEDGE.insurance;
    }

    // Documentação
    if (questions.some(q => q.type === 'documentation')) {
      kb.documentation = CLINIC_KNOWLEDGE.documentation;
    }

    // Horários (inclui escassez sutil)
    if (questions.some(q => q.type === 'schedule')) {
      kb.schedule = CLINIC_KNOWLEDGE.schedule;
      kb.escassez = CLINIC_KNOWLEDGE.salesTriggers.escassez;
    }

    // Métodos específicos (baseado em flags)
    if (flags.mentionsABA) {
      kb.methods = { ...kb.methods, aba: CLINIC_KNOWLEDGE.methods.aba };
    }
    if (flags.mentionsDenver) {
      kb.methods = { ...kb.methods, denver: CLINIC_KNOWLEDGE.methods.denver };
    }
    if (flags.mentionsBobath) {
      kb.methods = { ...kb.methods, bobath: CLINIC_KNOWLEDGE.methods.bobath };
    }

    // Estrutura (se perguntou sobre formato)
    if (questions.some(q => /individual|grupo|sess[aã]o|dura/.test(q.text))) {
      kb.structure = CLINIC_KNOWLEDGE.structure;
    }

    // SEMPRE inclui diferenciais (prova social)
    kb.differentials = CLINIC_KNOWLEDGE.differentials.slice(0, 2); // Top 2

    return kb;
  }

  /**
   * 🆘 Resposta fallback quando LLM falha (acolhedora + persuasiva)
   */
  fallbackAnswer(questionType, knowledge) {
    const fallbacks = {
      pricing: `Que bom que perguntou! 💚 Na avaliação (${knowledge.pricing?.avaliacao || 'R$ 200'}), a gente faz uma análise completa e você já sai com um plano personalizado. Muitas famílias ficam surpresas com o quanto evoluem já nas primeiras sessões! Quer que eu veja os horários?`,

      insurance: `Sim! Trabalhamos com reembolso de TODOS os planos de saúde 💚 A maioria dos nossos pacientes consegue reembolso de 80-100%. Você paga e depois solicita ao plano. É super tranquilo! Quer agendar?`,

      documentation: `Não precisa de nada prévio! 💚 Nossa equipe faz a avaliação completa aqui mesmo. Aliás, muitas pessoas vêm preocupadas com isso e ficam aliviadas quando vêem que é simples. Você já está dando o primeiro passo, que é o mais importante!`,

      schedule: `Atendemos segunda a sexta, das 8h às 18h! 💚 Temos vagas tanto de manhã quanto à tarde. Quanto antes começar, melhor! Qual período funciona pra você?`,

      services: `Sim! Nossa equipe é SUPER experiente nisso 💚 Já ajudamos muitas pessoas com essa mesma situação. Você veio ao lugar certo! Me conta mais: é para você ou para alguém da família?`,

      general: `Que bom que perguntou! 💚 Muitas pessoas têm essa mesma dúvida. Me conta um pouquinho mais sobre a situação que eu te ajudo certinho!`
    };

    return fallbacks[questionType] || fallbacks.general;
  }

  /**
   * 🆕 Identifica dados novos que o lead forneceu
   */
  getNewData(entities, context) {
    const newData = [];

    for (const key of Object.keys(entities)) {
      if (entities[key] && !context[key]) {
        newData.push(key);
      }
    }

    return newData;
  }

  /**
   * 💚 Acolhe dados que o lead forneceu (humaniza + venda sutil)
   */
  acknowledgeData(newData, entities) {
    const acks = [];

    // Nome
    if (newData.includes('patientName')) {
      const name = entities.patientName;
      acks.push(`Que nome lindo, ${name}! 🥰 Já anotei aqui!`);
    }

    // Idade com empatia + urgência sutil
    if (newData.includes('age')) {
      const age = entities.age;
      if (age <= 3) {
        acks.push(`${age} aninhos é uma fase TÃO importante! Quanto antes começar, melhores os resultados 💚 Nossa equipe é super experiente com bebês!`);
      } else if (age <= 6) {
        acks.push(`${age} anos! Idade perfeita para trabalharmos! Nessa fase o desenvolvimento é super rápido quando tem o acompanhamento certo 🌟`);
      } else if (age <= 12) {
        acks.push(`${age} anos! Muitas crianças dessa idade vêm aqui e os pais ficam impressionados com a evolução! Vamos cuidar muito bem! 💚`);
      } else if (age <= 17) {
        acks.push(`Adolescência é uma fase delicada, né? Nossa equipe sabe exatamente como lidar! Já ajudamos muitos adolescentes a superarem isso 💚`);
      } else {
        acks.push(`Que bom que está buscando ajuda! Muitos adultos deixam para depois e isso só complica. Você está no caminho certo! 💚`);
      }
    }

    // Queixa com validação emocional
    if (newData.includes('complaint') && entities.complaint) {
      acks.push(`Entendo sua preocupação, é muito comum! A boa notícia é que tem solução e a gente trata exatamente isso 💚`);
    }

    return acks.join(' ');
  }

  /**
   * ❓ Decide próxima pergunta (só 1, contextual)
   */
  decideNextQuestion(context, entities, flags, lead) {
    // Merge contexto atualizado
    const merged = { ...context, ...entities };

    // Se tem tudo para agendamento, oferece
    if (merged.therapy && merged.patientName && merged.age && merged.period) {
      return "Vou verificar os horários disponíveis! Pode ser? 💚";
    }

    // ═══════════════════════════════════════════════════
    // PRIORIDADE DE PERGUNTAS (ordem inteligente)
    // ═══════════════════════════════════════════════════

    // 1. Se não sabe o problema, pergunta primeiro (com empatia)
    if (!merged.therapy && !merged.complaint) {
      return "Fico feliz que entrou em contato! 💚 Me conta: o que está acontecendo que te trouxe até aqui? Estou aqui para te ouvir!";
    }

    // 2. Se tem queixa mas não especialidade → TRIAGEM (com autoridade)
    if (merged.complaint && !merged.therapy) {
      const triage = this.performSimpleTriage(merged.complaint, flags);

      if (triage.specialty && triage.confidence > 0.7) {
        const specialtyName = this.getSpecialtyDisplayName(triage.specialty);
        return `Pelo que você descreveu, nossa equipe de ${specialtyName} é PERFEITA para isso! Temos profissionais super experientes e já ajudamos muitas famílias na mesma situação 💚 Quer que eu verifique os horários disponíveis?`;
      } else {
        return "Para eu te ajudar certinho, me conta: é mais questão de fala/linguagem, comportamento/emocional, desenvolvimento motor, ou outra coisa? Trabalhamos com tudo isso! 💚";
      }
    }

    // 3. Idade (importante para matching de profissional) + urgência sutil
    if (!merged.age) {
      return "Perfeito! Só pra eu verificar os melhores profissionais: qual a idade? Nossa equipe tem especialistas para cada faixa etária 💚";
    }

    // 4. Nome (menos invasivo depois de entender o caso) + rapport
    if (!merged.patientName) {
      const isPediatric = merged.age && merged.age < 18;
      return isPediatric
        ? "E o pequeno, como se chama? Adoro personalizar o atendimento! 💚"
        : "E você, como posso te chamar? Quero te atender pelo nome! 💚";
    }

    // 5. Período (por último) + escassez sutil
    if (!merged.period) {
      return "Maravilha! Temos vagas essa semana ainda 🌟 Qual período funciona melhor: manhã ou tarde? (Horário: 8h às 18h)";
    }

    // Não precisa perguntar nada
    return null;
  }

  /**
   * 🏥 Triagem simples multidisciplinar
   */
  performSimpleTriage(complaint, flags) {
    const text = complaint.toLowerCase();

    // Mapa sintoma → especialidade (15 principais)
    const symptomMap = {
      'fonoaudiologia': [
        /não fala|nao fala|atraso\s+(na\s+)?fala|fala\s+pouco|poucas\s+palavras/i,
        /troca\s+letras|troca\s+sons|fala\s+errado/i,
        /gagueira|gaguejar|travando\s+na\s+fala/i,
        /dificuldade\s+(de|pra)\s+falar|pronuncia/i,
        /linguagem|comunica[cç][aã]o/i
      ],
      'psicologia': [
        /ansiedade|ansiosa?|medo|p[aâ]nico/i,
        /hiperativ|tdah|d[eé]ficit\s+de\s+aten[cç][aã]o/i,
        /birra|agressiv|comportamento|desobediente/i,
        /triste|depress|chora\s+muito/i,
        /dificuldade\s+(na\s+)?escola.*comportamento/i
      ],
      'fisioterapia': [
        /dor\s+(na|nas|no)\s+(coluna|costa|ombro|joelho|pesco[cç]o)/i,
        /não\s+anda|nao\s+anda|atraso\s+motor|quedas\s+frequentes/i,
        /postura|reabilita[cç][aã]o|acidente/i,
        /lesão|les[aã]o|machucou/i
      ],
      'terapia_ocupacional': [
        /não\s+come|nao\s+come|seletiv.*alimenta[cç][aã]o/i,
        /coordena[cç][aã]o\s+motora|escrever.*dificuldade/i,
        /amarrar|abotoar|segurar\s+l[aá]pis/i,
        /sensorial|textura|barulho/i,
        /integra[cç][aã]o\s+sensorial/i
      ],
      'neuropsicologia': [
        /avalia[cç][aã]o.*neuro|laudo.*neuro/i,
        /mem[oó]ria|esquecimento|concentra[cç][aã]o/i,
        /racioc[ií]nio|fun[cç][õo]es.*cognitiv/i
      ]
    };

    // Pontua cada especialidade
    for (const [specialty, patterns] of Object.entries(symptomMap)) {
      for (const pattern of patterns) {
        if (pattern.test(text)) {
          return { specialty, confidence: 0.85 };
        }
      }
    }

    // Se mencionou condição específica
    if (flags.mentionsTEA_TDAH) {
      return { specialty: 'psicologia', confidence: 0.75 };
    }

    return { specialty: null, confidence: 0 };
  }

  /**
   * 📝 Nome legível da especialidade
   */
  getSpecialtyDisplayName(specialty) {
    const names = {
      'fonoaudiologia': 'fonoaudiologia',
      'psicologia': 'psicologia',
      'fisioterapia': 'fisioterapia',
      'terapia_ocupacional': 'terapia ocupacional',
      'neuropsicologia': 'neuropsicologia',
      'psicopedagogia': 'psicopedagogia'
    };
    return names[specialty] || specialty;
  }

  /**
   * 💾 Salva contexto atualizado
   */
  async saveMemory(leadId, context) {
    try {
      await ChatContext.findOneAndUpdate(
        { lead: leadId },
        {
          $set: {
            conversationState: context,
            lastContactAt: new Date(),
            architecture: 'v7-response-first'
          }
        },
        { upsert: true }
      );
    } catch (error) {
      this.logger.error('V7_SAVE_ERROR', {
        leadId: leadId?.toString(),
        error: error.message
      });
    }
  }
}

export default WhatsAppOrchestratorV7;
