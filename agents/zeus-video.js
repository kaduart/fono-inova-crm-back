/**
 * 🎬 ZEUS — Gerador Estratégico de Conteúdo de Vídeo (v2.0 com Intenção do Lead)
 *
 * Cria roteiros estruturados para talking head (avatar falando) com foco
 * em viralização orgânica (Instagram) ou conversão (Meta Ads).
 *
 * 🧠 NOVO: Detecção automática de intenção do lead
 * - Passar contextoLead (texto da mensagem) para detectar intenção automaticamente
 * - O ZEUS escolhe hookStyle, tone e CTA baseado no momento do lead
 *
 * Exemplo de uso com intenção:
 *   gerarRoteiro({
 *     subTema: 'atraso_fala',
 *     contextoLead: 'meu filho tem 3 anos e ainda não fala, estou desesperada',
 *     // ZEUS detecta: preocupacao → hook=dor, tone=emotional, cta=agendar
 *   })
 *
 * Params:
 *   subTema, hookStyle, objetivo, platform, variacao, intensidade,
 *   contextoLead (novo), forcarIntencao (novo)
 */

import OpenAI from 'openai';
import logger from '../utils/logger.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Mapeamento de especialidades para profissionais
const ESPECIALIDADE_PROFISSIONAL = {
  fonoaudiologia:          'fono_ana',
  psicologia:              'psico_bia',
  terapia_ocupacional:     'to_carla',
  terapiaocupacional:      'to_carla',
  neuropsicologia:         'neuro_dani',
  fisioterapia:            'fisio_edu',
  musicoterapia:           'musico_fer',
  atraso_fala:             'fono_ana',
  autismo:                 'psico_bia',
  comportamento:           'psico_bia',
  teste_linguinha:         'fono_ana',
  avaliacao_neuropsicologica: 'neuro_dani',
  coordenacao_motora:      'fisio_edu',
  fisioterapia_infantil:   'fisio_edu',
  psicomotricidade:        'to_carla',
  geral:                   'fono_ana'
};

const NOMES_PROFISSIONAL = {
  fono_ana:   'Ana (Fonoaudiologia)',
  psico_bia:  'Bia (Psicologia)',
  to_carla:   'Carla (Terapia Ocupacional)',
  neuro_dani: 'Dani (Neuropsicologia)',
  fisio_edu:  'Edu (Fisioterapia)',
  musico_fer: 'Fer (Musicoterapia)'
};

// Hooks específicos por subTema — FORTES mas RESPEITOSOS
// Nível de intensidade: MODERADO (identificação sem drama excessivo)
const HOOKS_SUBTEMA = {
  atraso_fala: {
    curiosidade: [
      'Tem um hábito em casa que pode estar travando a fala do seu filho',
      'Por que seu filho de 3 anos fala "tá" em vez de "está"?',
      'Tem um sinal na fala que muitos pais não percebem'
    ],
    dor: [
      'Você chama seu filho… e ele não responde?',
      'Seu filho já tentou falar… mas não conseguiu se expressar?',
      'Enquanto outras crianças brincam, seu filho fica no canto sozinho?'
    ],
    alerta: [
      'Seu filho já tem 3 anos e ainda não fala?',
      'Esse sinal na fala aparece aos 18 meses — e poucos pais notam',
      'Não responder quando chama pode ser mais que teimosia'
    ],
    erro_comum: [
      'Esperar "a hora certa" pode estar custando meses de desenvolvimento',
      'O que você faz achando que ajuda — e na verdade atrasa a fala',
      'A maioria dos pais corrige o filho do jeito errado todo dia'
    ]
  },
  autismo: {
    curiosidade: [
      'Tem sinais que aparecem aos 6 meses — e a maioria dos pais ignora',
      'Por que seu filho olha pro lado quando você chama o nome?',
      'O que significa quando a criança roda objetos por horas'
    ],
    dor: [
      'Você chama seu filho… e ele não olha pra você?',
      'Seu filho brinca sozinho enquanto outras crianças interagem?',
      'Tem algo diferente no seu filho que você não consegue explicar?'
    ],
    alerta: [
      'Se seu filho faz isso antes dos 2 anos, não é "fase"',
      'Não olhar nos olhos quando chama — isso não é normal aos 18 meses',
      'Esse comportamento pode ser um sinal — e aparece cedo'
    ],
    erro_comum: [
      '"Ele vai melhorar quando entrar na escola" — o erro que atrasa tudo',
      'Esperar a criança "crescer e parar" pode perder o melhor momento',
      'O que a vovó diz que é normal — e não é'
    ]
  },
  comportamento: {
    curiosidade: [
      'Por que seu filho joga no chão quando contrariado — não é birra',
      'Tem uma explicação neurológica para as explosões do seu filho',
      'O que está por trás das birras longas'
    ],
    dor: [
      'Você já tentou sair do mercado com seu filho aos gritos?',
      'Sua rotina vira uma batalha quando é hora de…?',
      'Você já se sentiu perdido com as reações do seu filho?'
    ],
    erro_comum: [
      'Ceder ou gritar: os dois caminhos pioram o comportamento',
      'O que você faz no impulso — e reforça a birra',
      'A frase que os pais usam e que aumenta as crises'
    ]
  },
  teste_linguinha: {
    curiosidade: [
      'Por que seu bebê engasga toda hora na mamadeira',
      'O que o formato da língua do bebê diz sobre amamentação',
      'Por que alguns bebês não conseguem segurar o peito direito'
    ],
    dor: [
      'Seus seios doem e o bebê não consegue mamar direito?',
      'O bebê não consegue segurar o peito — pode ser físico',
      'Amamentação difícil desde o primeiro dia?'
    ],
    alerta: [
      'Se seu bebê faz "clique" ao mamar, presta atenção',
      'Esse formato da língua dificulta a amamentação desde o nascimento',
      'Dor nos seios e bebê frustrado — pode ser o freio'
    ]
  },
  coordenacao_motora: {
    curiosidade: [
      'Por que seu filho cai tanto quando corre — não é desajeitado',
      'O que o jeito de subir escada diz sobre coordenação',
      'Por que algumas crianças não conseguem andar de bicicleta'
    ],
    dor: [
      'Seu filho cai mais que os amigos da mesma idade?',
      'Seu filho tem medo de brincar porque cai muito?',
      'Ver seu filho atrás dos outros nas brincadeiras'
    ],
    alerta: [
      'Se seu filho de 5 anos ainda não consegue pular de um pé só',
      'Quedas frequentes não são normalidade — é um sinal',
      'Dificuldade para subir escada pode indicar problema motor'
    ]
  }
};

function escolherHookSubTema(subTema, hookStyle, seed = 0) {
  const hooks = HOOKS_SUBTEMA[subTema]?.[hookStyle];
  if (!hooks || hooks.length === 0) return null;
  return hooks[Math.floor(seed * hooks.length) % hooks.length];
}

// Hashtags base garantidas por especialidade/subTema — sempre incluídas, independente do que o GPT gerar
const HASHTAGS_BASE = {
  fonoaudiologia:          ['#Fonoaudiologia', '#FonoaudiologiaInfantil', '#DesenvolvimentoDaFala', '#FonoInova'],
  atraso_fala:             ['#AtrasoFala', '#FilhoNaoFala', '#DesenvolvimentoDaFala', '#Fonoaudiologia', '#FonoInova'],
  teste_linguinha:         ['#TesteDaLinguinha', '#FreioLingual', '#Fonoaudiologia', '#FonoInova'],
  psicologia:              ['#PsicologiaInfantil', '#SaúdeMentalInfantil', '#DesenvolvimentoInfantil', '#FonoInova'],
  autismo:                 ['#Autismo', '#TEA', '#AutismoInfantil', '#IdentificacaoPrecoce', '#FonoInova'],
  comportamento:           ['#ComportamentoInfantil', '#Birra', '#RegulaçãoEmocional', '#PsicologiaInfantil', '#FonoInova'],
  terapia_ocupacional:     ['#TerapiaOcupacional', '#TOInfantil', '#DesenvolvimentoMotor', '#FonoInova'],
  terapiaocupacional:      ['#TerapiaOcupacional', '#TOInfantil', '#DesenvolvimentoMotor', '#FonoInova'],
  neuropsicologia:         ['#Neuropsicologia', '#AvaliacaoNeuropsicologica', '#TDAH', '#FonoInova'],
  avaliacao_neuropsicologica: ['#AvaliacaoNeuropsicologica', '#Neuropsicologia', '#TDAH', '#FonoInova'],
  fisioterapia:            ['#FisioterapiaInfantil', '#DesenvolvimentoMotor', '#FisioInfantil', '#FonoInova'],
  fisioterapia_infantil:   ['#FisioterapiaInfantil', '#DesenvolvimentoMotor', '#FisioInfantil', '#FonoInova'],
  coordenacao_motora:      ['#CoordenacaoMotora', '#DesenvolvimentoMotor', '#FisioterapiaInfantil', '#FonoInova'],
  psicomotricidade:        ['#Psicomotricidade', '#DesenvolvimentoMotor', '#TerapiaOcupacional', '#FonoInova'],
  musicoterapia:           ['#Musicoterapia', '#MusicoterapiaInfantil', '#FonoInova'],
  geral:                   ['#DesenvolvimentoInfantil', '#SaúdeInfantil', '#FonoInova']
};

// Hashtags de público (pais) — sempre incluídas para alcance orgânico
const HASHTAGS_PUBLICO = [
  '#Maternidade', '#Parentalidade', '#DesenvolvimentoInfantil', '#CriançaSaudável', '#MaeDePrimeirViagem'
];

// Hashtags de localidade — alcance geográfico Anápolis/GO
const HASHTAGS_LOCAL = ['#Anápolis', '#AnápolisGO', '#Goiás'];

/**
 * Mescla hashtags do ZEUS com as bases garantidas — remove duplicatas, normaliza formato
 */
function montarHashtags(hashtagsGeradas = [], subTema, especialidade) {
  const chave = subTema || especialidade?.toLowerCase() || 'geral';
  const base = HASHTAGS_BASE[chave] || HASHTAGS_BASE.geral;

  // Normaliza todas para ter # na frente e lowercase para comparar
  const normalizar = (h) => h.startsWith('#') ? h : `#${h}`;
  const todas = [...hashtagsGeradas.map(normalizar), ...base, ...HASHTAGS_PUBLICO, ...HASHTAGS_LOCAL];

  // Remove duplicatas ignorando case
  const vistas = new Set();
  return todas.filter(h => {
    const key = h.toLowerCase();
    if (vistas.has(key)) return false;
    vistas.add(key);
    return true;
  }).slice(0, 25); // Instagram: máx 30, usamos 25 para margem
}

// Contexto descritivo por subTema para enriquecer o prompt
const SUBTEMA_CONTEXTO = {
  atraso_fala:                'criança não fala, fala pouco, troca palavras, atraso de linguagem',
  autismo:                    'sinais iniciais de TEA, comportamento, socialização, contato visual',
  comportamento:              'birra, agressividade, dificuldade emocional, limites, autocontrole',
  teste_linguinha:            'frênulo lingual, amamentação, fala, freio da língua',
  avaliacao_neuropsicologica: 'atenção, aprendizado, memória, suspeitas de TDAH ou dificuldades escolares',
  coordenacao_motora:         'equilíbrio, quedas frequentes, dificuldade motora grossa',
  terapia_ocupacional:        'autonomia, coordenação fina, atividades do dia a dia',
  fisioterapia_infantil:      'desenvolvimento motor global, tônus muscular, postura',
  psicomotricidade:           'integração corpo e comportamento, coordenação, lateralidade'
};

// 🧠 PERCEPÇÃO CLÍNICA: Mapeamento de dor real por subTema
const DOR_REAL = {
  atraso_fala: {
    dor_principal: 'angústia de ver outras crianças falando e seu filho calado, comparação com outros, culpa',
    situacao_real: 'o pai tenta fazer o filho repetir palavras e ele não responde, ou fala "tá" em vez de "está"',
    idade_critica: '2 a 4 anos',
    estagio_pai: 'descoberta — acabou de perceber que algo está errado'
  },
  autismo: {
    dor_principal: 'medo do diagnóstico, dúvida se está imaginando, comparação com outros, isolamento social da criança',
    situacao_real: 'a criança não olha nos olhos quando chama, fica rodando objetos, não brinca com outras',
    idade_critica: '1 a 3 anos',
    estagio_pai: 'dúvida — sabe que algo está diferente mas não sabe se é autismo ou fase'
  },
  comportamento: {
    dor_principal: 'exaustão emocional, vergonha em público, culpa por não saber lidar, medo de estar fazendo errado',
    situacao_real: 'birra no mercado, choro que não para, criança bate em outros, não obedece',
    idade_critica: '2 a 6 anos',
    estagio_pai: 'ação — já tentou de tudo e precisa de ajuda urgente'
  },
  teste_linguinha: {
    dor_principal: 'amamentação dolorosa, culpa por não conseguir amamentar, medo de afetar fala',
    situacao_real: 'o bebê não pega direito no peito, mamãe tem feridas, ou o bebê engasga muito',
    idade_critica: '0 a 12 meses',
    estagio_pai: 'descoberta — acabou de ouvir falar do freio lingual'
  },
  avaliacao_neuropsicologica: {
    dor_principal: 'frustração escolar, comparação com colegas, culpa por achar que é preguiça',
    situacao_real: 'criança não consegue se concentrar nas tarefas, esquece o que aprendeu, desorganização',
    idade_critica: '5 a 10 anos',
    estagio_pai: 'dúvida — acha que pode ser TDAH mas não tem certeza'
  },
  coordenacao_motora: {
    dor_principal: 'vergonha de ver o filho caindo, medo de acidente, frustração por não acompanhar amigos',
    situacao_real: 'cai toda hora, não consegue subir escada, tem dificuldade para brincar na rua',
    idade_critica: '3 a 7 anos',
    estagio_pai: 'descoberta — percebeu que outras crianças fazem coisas que seu filho não consegue'
  },
  terapia_ocupacional: {
    dor_principal: 'dependência excessiva, frustração do filho por não conseguir se vestir/sozinho',
    situacao_real: 'não consegue abotoar camisa, segurar lápis direito, fazer sozinho as tarefas do dia a dia',
    idade_critica: '3 a 8 anos',
    estagio_pai: 'ação — precisa que o filho tenha mais autonomia'
  },
  fisioterapia_infantil: {
    dor_principal: 'preocupação com postura, medo de dores futuras, comparação com desenvolvimento de outros',
    situacao_real: 'anda torto, senta errado, reclama de dor nas costas, não consegue correr direito',
    idade_critica: '4 a 10 anos',
    estagio_pai: 'dúvida — não sabe se é postura ou problema sério'
  },
  psicomotricidade: {
    dor_principal: 'dificuldade de coordenação, confusão entre direita/esquerda, desajeitão',
    situacao_real: 'bate em tudo, não consegue andar de bicicleta, confunde lados do corpo',
    idade_critica: '4 a 8 anos',
    estagio_pai: 'descoberta — percebeu que o filho é desajeitado demais'
  }
};

// 🎯 MÓDULO: INTENÇÃO DO LEAD → CONTEÚDO
// Detecta automaticamente o momento do lead e adapta estratégia

const INTENCAO_KEYWORDS = {
  duvida: [
    'não sei se', 'será que', 'acho que', 'dúvida', 'pergunta', 'como funciona',
    'o que é', 'por que', 'como sabe', 'difícil saber', 'não entendo',
    'me explica', 'como assim', 'o que significa'
  ],
  preocupacao: [
    'preocupada', 'preocupado', 'medo', 'angustiada', 'angustiado', 'desesperada',
    'desesperado', 'choro', 'não dormo', 'não sei o que fazer', 'tô perdida',
    'tô perdido', 'tô desesperada', 'tô desesperado', 'não aguento mais',
    'será que é grave', 'pode ser autismo', 'pode ser atraso', 'tem algo errado'
  ],
  comparacao: [
    'outras crianças', 'outros filhos', 'comparando', 'igual a', 'diferente de',
    'as outras já', 'os outros já', 'meu filho não faz', 'meu filho ainda não',
    'deveria estar', 'era pra estar', 'já deveria', 'ainda não consegue'
  ],
  acao: [
    'quero agendar', 'como faço', 'quanto custa', 'valor', 'preço', 'horário',
    'disponibilidade', 'quando tem', 'quero começar', 'quero marcar',
    'quero saber mais', 'pode me ajudar', 'como funciona atendimento',
    'quero conversar', 'posso ir aí', 'endereço', 'telefone', 'whatsapp'
  ],
  leve_curiosidade: [
    'vi no', 'achei interessante', 'curiosa', 'curioso', 'só queria saber',
    'vi sobre', 'ouvi falar', 'vi no instagram', 'vi no site', 'passando aqui',
    'só uma dúvida', 'só perguntando', 'por curiosidade'
  ]
};

/**
 * Detecta intenção do lead baseada no texto da conversa/mensagem
 * @param {string} textoLead - Texto da mensagem ou contexto do lead
 * @returns {Object} { intencao, confianca, hookRecomendado, toneRecomendado, ctaRecomendado }
 */
export function detectarIntencaoLead(textoLead = '') {
  if (!textoLead || textoLead.length < 5) {
    return { 
      intencao: 'desconhecida', 
      confianca: 0,
      hookRecomendado: 'dor',
      toneRecomendado: 'emotional',
      ctaRecomendado: 'agendar'
    };
  }

  const texto = textoLead.toLowerCase();
  const scores = {};
  
  // Calcular score para cada intenção
  Object.entries(INTENCAO_KEYWORDS).forEach(([intencao, keywords]) => {
    scores[intencao] = keywords.filter(kw => texto.includes(kw)).length;
  });

  // Encontrar intenção com maior score
  const entries = Object.entries(scores);
  const maxScore = Math.max(...entries.map(([, score]) => score));
  
  // Se nenhuma intenção foi detectada com confiança
  if (maxScore === 0) {
    // Fallback: análise de sentimento simples
    if (texto.includes('?') && texto.length < 50) {
      return { 
        intencao: 'duvida', 
        confianca: 0.6,
        hookRecomendado: 'curiosidade',
        toneRecomendado: 'educativo',
        ctaRecomendado: 'comentar'
      };
    }
    return { 
      intencao: 'preocupacao', 
      confianca: 0.5,
      hookRecomendado: 'dor',
      toneRecomendado: 'emotional',
      ctaRecomendado: 'agendar'
    };
  }

  const intencaoDetectada = entries.find(([, score]) => score === maxScore)[0];
  const confianca = Math.min(maxScore * 0.3 + 0.4, 0.95); // Score baseado na quantidade de matches

  // Mapear para estratégia de conteúdo
  const estrategias = {
    duvida: {
      hookRecomendado: 'curiosidade',
      toneRecomendado: 'educativo',
      ctaRecomendado: 'comentar',
      ctaTexto: 'posso te explicar melhor nos comentários'
    },
    preocupacao: {
      hookRecomendado: 'dor',
      toneRecomendado: 'emotional',
      ctaRecomendado: 'agendar',
      ctaTexto: 'se quiser entender melhor o que está acontecendo'
    },
    comparacao: {
      hookRecomendado: 'alerta',
      toneRecomendado: 'emotional',
      ctaRecomendado: 'salvar',
      ctaTexto: 'salva aqui pra comparar depois com seu filho'
    },
    acao: {
      hookRecomendado: 'autoridade',
      toneRecomendado: 'inspiracional',
      ctaRecomendado: 'agendar',
      ctaTexto: 'posso te mostrar os horários disponíveis'
    },
    leve_curiosidade: {
      hookRecomendado: 'curiosidade',
      toneRecomendado: 'educativo',
      ctaRecomendado: 'compartilhar',
      ctaTexto: 'se conhece alguém que precisa ver isso'
    }
  };

  const estrategia = estrategias[intencaoDetectada];

  return {
    intencao: intencaoDetectada,
    confianca,
    ...estrategia
  };
}

// 🚫 PALAVRAS PROIBIDAS (geram texto genérico/fraco)
// Aplicadas tanto no hook_texto_overlay quanto no texto_completo inteiro
const PALAVRAS_PROIBIDAS = [
  // Frases de IA genérica
  'eu entendo o que você está sentindo',
  'eu entendo o que voce esta sentindo',
  'você não está sozinha',
  'voce nao esta sozinha',
  'você não está sozinho',
  'voce nao esta sozinho',
  'não hesite',
  'nao hesite',
  'estamos aqui para ajudar',
  'conte com a gente',
  // CTAs fracos
  'agende agora',
  'não perca tempo',
  'corra',
  // Linguagem clínica genérica
  'é muito importante',
  'isso pode afetar',
  'devemos observar',
  'é fundamental',
  'é essencial',
  'precisamos prestar atenção',
  'isso pode prejudicar',
  'é necessário',
  'devemos considerar',
  'interação social',
  'desenvolvimento infantil'
];

/**
 * Verifica se o texto contém alguma frase proibida
 * @param {string} texto
 * @returns {string[]} lista de frases proibidas encontradas
 */
function verificarFrasesProibidas(texto) {
  const t = texto.toLowerCase();
  return PALAVRAS_PROIBIDAS.filter(p => t.includes(p.toLowerCase()));
}

// ✅ FRASES DE HUMANIZAÇÃO (substituir formais)
const SUBSTITUICOES_HUMANIZADAS = {
  'crianças': 'os pequenos',
  'paciente': 'o atendimento de hoje',
  'tratamento': 'acompanhamento',
  'intervenção': 'ajuda',
  'diagnóstico': 'entender o que está acontecendo',
  'terapia': 'os encontros',
  'evolução': 'melhora',
  'desenvolvimento': 'crescimento'
};

// Biblioteca de ganchos por estilo — cada um tem DNA emocional diferente
const HOOKS = {
  dor: [
    'Seu filho pode estar com dificuldade e você ainda não percebeu',
    'Isso pode estar atrasando o desenvolvimento do seu filho',
    'Muitos pais só descobrem tarde demais',
    'Esse sinal pode estar passando despercebido todos os dias',
    'Você reconhece esse comportamento no seu filho?'
  ],
  alerta: [
    'Se seu filho faz isso, preste atenção agora',
    'Isso é um sinal que você não pode ignorar',
    'Atenção: esse comportamento pode indicar algo importante',
    'Se você perceber isso no seu filho, não espere',
    'Esse sinal aparece cedo — e poucos pais identificam'
  ],
  curiosidade: [
    'Você sabia que isso pode atrasar a fala do seu filho?',
    'Existe um detalhe que a maioria dos pais ignora — e muda tudo',
    'Poucos pais percebem esse sinal silencioso no desenvolvimento',
    'O que ninguém te contou sobre o desenvolvimento do seu filho',
    'Isso explica por que seu filho age assim — e você não vai acreditar',
    'Tem um sinal que aparece cedo demais para a maioria perceber'
  ],
  erro_comum: [
    'A maioria dos pais comete esse erro sem saber',
    'Você pode estar fazendo isso errado com seu filho',
    'Esse erro é mais comum do que parece — e prejudica o desenvolvimento',
    'Pare de fazer isso se quer ajudar seu filho',
    'Esse hábito parece inofensivo — mas não é'
  ],
  autoridade: [
    'Depois de atender centenas de crianças, aprendi isso',
    'Na clínica, vejo esse caso todos os dias — e poucos pais sabem',
    'Isso é o que os pais mais perguntam pra gente — e a resposta surpreende',
    'Como especialista, vou te contar o que realmente importa aqui',
    'Toda semana atendo famílias com essa mesma dúvida'
  ]
};

// Estruturas narrativas — cada hookStyle tem estruturas compatíveis
const ESTRUTURAS_POR_HOOK = {
  curiosidade: {
    B: 'Revelação gradual: Pergunta ou afirmação incompleta que abre curiosity gap → Informação surpreendente revelada aos poucos → Explicação do porquê isso acontece → CTA para compartilhar',
    C: 'Lista surpresa: Hook curiosidade → "Existem X sinais que poucos pais conhecem" → Revelar cada um como descoberta → CTA compartilhar'
  },
  dor: {
    A: 'Empatia + reconhecimento: Hook que nomeia a dor do pai → Valida a preocupação → 2-3 pontos práticos → CTA salvar',
    B: 'Mini história identificação: Situação do dia a dia que o pai reconhece → Explicação emocional → Solução acolhedora → CTA'
  },
  alerta: {
    A: 'Alerta direto: Hook urgente → Explicação rápida do risco → 2-3 sinais concretos → CTA agir agora',
    C: 'Lista de sinais: Hook alerta → Checklist numerada que o pai pode conferir → O que fazer se identificar → CTA'
  },
  erro_comum: {
    D: 'Erro + correção: Nomear o comportamento errado dos pais → Por que prejudica → Correção prática → CTA',
    B: 'Revelação do erro: Hook que implica que o pai pode estar errando → Revelar o erro → Explicar a versão correta → CTA'
  },
  autoridade: {
    B: 'Caso clínico: Abertura com experiência da clínica → Situação real (sem identificar paciente) → Aprendizado aplicável → CTA',
    C: 'Dicas de especialista: Hook autoridade → Lista de dicas práticas do dia a dia clínico → CTA agendar'
  }
};

// Instruções detalhadas por hookStyle — regras frase a frase
const HOOK_INSTRUCOES = {
  curiosidade: `
REGRAS OBRIGATÓRIAS para hookStyle=curiosidade (LEIA COM ATENÇÃO):
PROIBIDO:
- Começar com "Você sabia que..." (clichê, parece aula)
- Entregar a resposta na primeira frase
- Tom professoral ou educativo direto
- Frases genéricas como "isso pode mudar tudo", "isso é importante"

OBRIGATÓRIO — estrutura frase a frase:
- Frase 1: PROVOCATIVA ou ACUSATÓRIA — implica que o pai pode estar errando ou perdendo algo
  Ex fortes: "Você pode estar atrapalhando a fala do seu filho sem perceber",
             "Tem um hábito que a maioria dos pais tem — e atrasa o desenvolvimento",
             "Isso que parece ajudar seu filho pode estar fazendo o contrário"
- Frase 2: aprofunda a tensão — NÃO resolve ("e quase ninguém sabe disso")
- Frase 3-4: contextualiza sem revelar a resposta
- Frase 5-6: revela a virada surpreendente
- Última frase antes do CTA: insight que o pai vai querer compartilhar com outros pais

hook_texto_overlay para curiosidade: frase provocativa curta que cria tensão/dúvida imediata
Ex corretos: "Você pode estar errando com seu filho…", "Isso atrasa a fala — e ninguém fala",
             "O hábito que trava o desenvolvimento", "Tem algo que passa despercebido todo dia"`,

  dor: `
REGRAS OBRIGATÓRIAS para hookStyle=dor:
- Frase 1: nomeia a dor/preocupação real ("Você já ficou preocupada porque seu filho ainda não fala…")
- Tom: empático, de amiga especialista — NÃO alarmista, NÃO professoral
- Validar a preocupação do pai → oferecer acolhimento → caminho prático
- O pai precisa se sentir VISTO e COMPREENDIDO, não assustado`,

  alerta: `
REGRAS OBRIGATÓRIAS para hookStyle=alerta:
- Frase 1: sinal concreto e específico ("Se seu filho ainda não faz isso com X meses, preste atenção")
- Direto e objetivo — NÃO genérico ("isso pode indicar algo")
- Dar 2-3 sinais observáveis no dia a dia com nomes simples
- Terminar com ação clara e urgente`,

  erro_comum: `
REGRAS OBRIGATÓRIAS para hookStyle=erro_comum:
- Frase 1: nomeia o comportamento errado sem rodeios ("A maioria dos pais faz isso — e prejudica sem querer")
- Tom direto mas empático — o pai não é culpado, ele não sabia
- Estrutura: erro → por que prejudica → versão correta → CTA
- O pai deve sair com mudança prática imediata`,

  autoridade: `
REGRAS OBRIGATÓRIAS para hookStyle=autoridade:
- Frase 1: abre com experiência clínica real ("Toda semana atendo famílias com essa dúvida…")
- Dicas específicas e práticas que parecem "segredos de especialista"
- Tom de conversa — NÃO de palestra ou texto de site
- Terminar com CTA natural (não forçado)
hook_texto_overlay OBRIGATÓRIO: prova de experiência real ou dado que surpreende
PROIBIDO em hook_texto_overlay: "uma dica", "isso pode mudar tudo", "veja isso", qualquer frase genérica
Exemplos corretos: "Toda semana vejo esse erro na clínica…", "90% dos pais fazem isso sem saber", "O que vejo todo dia pode estar afetando seu filho"`
};

// Instruções de TOM — como a narração SOA (independente do hookStyle)
const TONE_INSTRUCOES = {
  educativo: `
TOM DO ROTEIRO: EDUCATIVO (Dicas/Fatos)
- Narração didática mas leve — como professora simpática, não como aula
- Incluir 1-2 informações concretas e verificáveis
- Frases tipo: "Na fonoaudiologia, a gente chama isso de...", "Um dado importante:"
- Funciona bem para salvar — o pai guarda o vídeo para usar depois
- Evitar emoção excessiva — o valor é a informação`,

  emotional: `
TOM DO ROTEIRO: EMOCIONAL (Dor/Urgência)
- Narração que ressoa com o estado emocional do pai preocupado
- Validar a angústia antes de qualquer informação: "Eu entendo o que você está sentindo..."
- Ritmo mais lento, frases curtas com pausas intencionais
- Terminar com acolhimento e esperança — nunca com medo
- Funciona bem para comentários e compartilhamentos`,

  inspiracional: `
TOM DO ROTEIRO: INSPIRACIONAL (Transformação)
- Narrativa de transformação positiva — "isso tem solução", "já vi muitas crianças evoluírem"
- Foco no DEPOIS: o que muda quando a família busca ajuda
- Tom esperançoso e encorajador, não sentimental demais
- Pode usar caso de sucesso genérico (sem identificar paciente)
- Funciona bem para compartilhar com outros pais`,

  bastidores: `
TOM DO ROTEIRO: BASTIDORES (Da clínica)
- Humanizar a clínica — mostrar o dia a dia real dos profissionais
- Tom de conversa casual, como se estivesse mostrando "por trás das cenas"
- Frases tipo: "Hoje na clínica aconteceu algo que quero compartilhar..."
- Gera aproximação e confiança — não é comercial
- Funciona bem para engajamento orgânico e comentários`
};

function escolherHook(hookStyle, seed = 0) {
  const lista = HOOKS[hookStyle] || HOOKS.dor;
  return lista[Math.floor(seed * lista.length) % lista.length];
}

function escolherEstrutura(hookStyle, variacao) {
  // Seleciona estrutura compatível com o hookStyle
  const mapa = ESTRUTURAS_POR_HOOK[hookStyle] || ESTRUTURAS_POR_HOOK.dor;
  const letras = Object.keys(mapa);
  const letra = letras[Math.floor(variacao * letras.length) % letras.length];
  return { letra, descricao: mapa[letra] };
}

/**
 * Gera conteúdo estratégico de vídeo (Instagram viral ou Meta Ads)
 *
 * @param {object} params
 * @param {string} params.tema           - Tema livre (pode ser vazio para geração automática)
 * @param {string} params.especialidade  - ID da especialidade/profissional
 * @param {string} params.funil          - TOPO | MEIO | FUNDO
 * @param {number} params.duracao        - Duração em segundos
 * @param {string} params.tone           - emotional | educativo | inspiracional | bastidores
 * @param {string} params.platform       - instagram | meta_ads (default: instagram)
 * @param {string} params.subTema        - subTema da clínica (ex: atraso_fala)
 * @param {string} params.hookStyle      - dor | alerta | curiosidade | erro_comum | autoridade
 * @param {string} params.objetivo       - salvar | compartilhar | comentar | agendar
 * @param {number} params.variacao       - 0..1 — controla estrutura e hook (anti-repetição)
 * @param {string} params.intensidade    - leve | moderado | forte | viral
 */
export async function gerarRoteiro({
  tema,
  especialidade,
  funil = 'TOPO',
  duracao = 60,
  tone = 'educativo',
  platform = 'instagram',
  subTema,
  hookStyle = 'dor',
  objetivo = 'salvar',
  variacao = Math.random(),
  intensidade = 'viral',
  bordao = '',
  contextoLead = null,  // 🧠 Texto da mensagem/conversa do lead para detectar intenção
  forcarIntencao = null // 🧠 Opcional: forçar uma intenção específica ('duvida', 'preocupacao', etc)
}) {
  // 🧠 DETECÇÃO DE INTENÇÃO DO LEAD
  let intencaoDetectada = null;
  let ctaPersonalizado = null;
  
  if (forcarIntencao) {
    // Usar intenção forçada manualmente
    intencaoDetectada = detectarIntencaoLead('');
    intencaoDetectada.intencao = forcarIntencao;
    logger.info(`[ZEUS] 🎯 Intenção forçada: ${forcarIntencao}`);
  } else if (contextoLead) {
    // Detectar automaticamente baseado no contexto
    intencaoDetectada = detectarIntencaoLead(contextoLead);
    logger.info(`[ZEUS] 🎯 Intenção detectada: ${intencaoDetectada.intencao} (confiança: ${(intencaoDetectada.confianca * 100).toFixed(0)}%)`);
  }
  
  // 🚫 BLOQUEAR COMBINAÇÕES RUINS
  const COMBINACOES_BLOQUEADAS = [
    { hook: 'alerta', tone: 'emotional', motivo: 'alerta precisa ser direto, não emotivo' },
    { hook: 'autoridade', tone: 'emotional', motivo: 'autoridade + emocional mistura sinais' },
    { hook: 'curiosidade', tone: 'inspiracional', motivo: 'curiosidade precisa tensão, não esperança' }
  ];
  
  const combinacaoRuim = COMBINACOES_BLOQUEADAS.find(c => c.hook === hookStyle && c.tone === tone);
  if (combinacaoRuim) {
    logger.warn(`[ZEUS] 🚫 Combinação bloqueada: ${hookStyle}+${tone} (${combinacaoRuim.motivo})`);
    // Fallback: mudar tone para algo compatível
    if (hookStyle === 'alerta') tone = 'educativo';
    else if (hookStyle === 'autoridade') tone = 'inspiracional';
    else if (hookStyle === 'curiosidade') tone = 'educativo';
    logger.info(`[ZEUS] 🔄 Tone ajustado para: ${tone}`);
  }

  // Aplicar estratégia baseada na intenção detectada
  if (intencaoDetectada && intencaoDetectada.confianca > 0.5) {
    hookStyle = intencaoDetectada.hookRecomendado;
    tone = intencaoDetectada.toneRecomendado;
    objetivo = intencaoDetectada.ctaRecomendado;
    ctaPersonalizado = intencaoDetectada.ctaTexto;
    logger.info(`[ZEUS] 🎯 Estratégia aplicada: hook=${hookStyle} | tone=${tone} | objetivo=${objetivo}`);
  }

  const profissional = ESPECIALIDADE_PROFISSIONAL[subTema] ||
                       ESPECIALIDADE_PROFISSIONAL[especialidade?.toLowerCase()] ||
                       'fono_ana';
  const nomeProfissional = NOMES_PROFISSIONAL[profissional];

  const { letra: estruturaLetra, descricao: estruturaDescricao } = escolherEstrutura(hookStyle, variacao);
  // Hook por subTema é mais preciso — usa como primeiro candidato
  const hookSugerido = escolherHookSubTema(subTema, hookStyle, variacao)
                    || escolherHook(hookStyle, variacao);
  const subTemaContexto = SUBTEMA_CONTEXTO[subTema] || tema || especialidade;

  // Duração ajustada: Instagram = 20-35s, Ads = 30-60s
  const duracaoEfetiva = platform === 'instagram'
    ? Math.min(Math.max(duracao, 20), 35)
    : Math.min(Math.max(duracao, 30), 60);

  // CTAs variados por objetivo — naturais, como continuação da conversa
  const ctaVariantes = {
    salvar: [
      'Salva aqui que você vai precisar depois',
      'Guarda esse vídeo pra quando precisar consultar',
      'Salva que essa informação vale ouro'
    ],
    compartilhar: [
      'Se conhece alguém nessa situação, manda pra ela ver',
      'Compartilha com quem você sabe que tá passando por isso',
      'Marca aqui quem precisa ouvir isso hoje'
    ],
    comentar: [
      'Comenta aqui como tá sendo aí na sua casa',
      'Me conta nos comentários se isso faz sentido pra você',
      'Deixa aqui a idade do seu filho que eu te digo mais'
    ],
    agendar: [
      'Se quiser conversar sobre isso, me chama no WhatsApp',
      'Se fizer sentido pra você, a gente pode marcar um horário',
      'Quando quiser entender melhor, é só mandar mensagem'
    ],
    dm: [
      'Me chama no direct se quiser conversar sobre o seu caso',
      'Manda mensagem aqui que eu te ajudo a entender melhor',
      'Se preferir falar no privado, me chama aqui'
    ]
  };
  // Seleciona variante baseada na variação (anti-repetição)
  const variantesObj = ctaVariantes[objetivo] || ctaVariantes.comentar;
  let ctaSugerido  = variantesObj[Math.floor(variacao * variantesObj.length) % variantesObj.length];
  
  // 🧠 Se tem intenção detectada com CTA personalizado, usar ele
  if (ctaPersonalizado) {
    ctaSugerido = ctaPersonalizado;
    logger.info(`[ZEUS] 🎯 CTA personalizado por intenção: "${ctaSugerido}"`);
  }

  logger.info(`[ZEUS] Gerando: subTema=${subTema || especialidade} | hook=${hookStyle} | tone=${tone} | estrutura=${estruturaLetra} | platform=${platform} | intensidade=${intensidade}`);

  const isInstagram = platform === 'instagram';

  const systemPrompt = `Você é ZEUS, especialista em marketing médico infantil e criação de conteúdo viral para Instagram.

Seu objetivo NÃO é apenas gerar um roteiro. É criar conteúdo que:
- Para o scroll nos primeiros 3 segundos
- Faz o pai pensar "isso é exatamente sobre meu filho"
- Gera salvamento, compartilhamento ou comentário real
- Posiciona a clínica como autoridade acolhedora

A clínica Fono Inova atende: Fonoaudiologia, Psicologia Infantil, Terapia Ocupacional, Fisioterapia Infantil, Psicomotricidade, Avaliação Neuropsicológica, Teste da Linguinha.

Público: pais de crianças de 0 a 10 anos com dúvidas sobre desenvolvimento.

REGRAS OBRIGATÓRIAS:
1. Linguagem simples — pai leigo precisa entender tudo
2. NUNCA usar jargão clínico pesado
3. Frases curtas, tom de conversa, como uma amiga especialista
4. Compliance saúde: nunca afirmar diagnóstico; usar "pode indicar", "vale investigar", "é importante observar"
5. Retorne APENAS o JSON solicitado, sem markdown, sem explicações

RELAÇÃO ENTRE hookStyle E tone (ESSENCIAL):
- hookStyle = define COMO o vídeo abre (os primeiros 3 segundos, a isca)
- tone = define COMO o vídeo faz a pessoa SENTIR ao longo de toda a narração
- Os dois devem trabalhar juntos, não se cancelar
- Exemplo: hookStyle=curiosidade + tone=emocional → abre com mistério, mas a narração toda ressoa emocionalmente

ANTI-ROBÔ (regras de naturalidade):
- NUNCA usar a mesma estrutura de frase duas vezes seguidas
- Variar ritmo: alterne frases longas com curtas (cria respiração no texto)
- PROIBIDO: frases genéricas tipo "é muito importante", "isso pode afetar muito", "devemos prestar atenção"
- Cada frase deve acrescentar algo novo — NUNCA repetir a mesma ideia com outras palavras
- Escrever como a profissional FALARIA, não como ela ESCREVERIA num relatório

REGRAS DE CONVERSÃO FORTE (obrigatório):
- PROIBIDO linguagem genérica: "interação social", "comportamento", "desenvolvimento" — SEJA ESPECÍFICO (ex: "não olha nos olhos", "não responde quando chama", "fica isolada no recreio")
- PROIBIDO CTA fraco: "não hesite", "pense nisso", "quando quiser", "agende agora" — VÁ DIRETO AO PONTO
- SEMPRE use gatilho de urgência leve: "quanto antes", "logo nos primeiros meses", "enquanto é cedo"
- Mencione IDADE específica ou FAIXA ETÁRIA (ex: "crianças de 2 a 4 anos", "antes dos 5 anos")
- Dê 1 EXEMPLO CONCRETO na narração (ex: "ontem atendi uma menina de 3 anos que...")
- CTA final MÁXIMO 8 palavras, direto, sem enrolação

🎚️ NÍVEL DE INTENSIDADE EMOCIONAL: MODERADO
- NÃO usar sofrimento extremo (choro, desespero, culpa intensa)
- NÃO dramatizar ou explorar dor excessivamente
- Focar em situações REAIS do dia a dia (não tragédias)
- Gerar IDENTIFICAÇÃO, não choque ou rejeição
- Equilibrar: forte o suficiente para parar o scroll, respeitoso o suficiente para não gerar repulsa

🚫 HOOKS PROIBIDOS (nunca use):
- "Eu entendo o que você está sentindo" → genérico, fraco
- "Preste muita atenção" → professoral
- "Você já chorou vendo seu filho..." → pesado demais, explora dor
- "Isso pode mudar tudo" → vazio
- Qualquer frase que explore culpa ou sofrimento extremo

✅ HOOKS PERMITIDOS (moderados e efetivos):
- "Você chama seu filho… e ele não responde?"
- "Seu filho já tem 3 anos e ainda não fala?"
- "Tem um sinal que muitos pais não percebem…"
- "Enquanto outras crianças brincam, seu filho fica sozinho?"

👉 REGRA DE OURO: Se a primeira frase não fizer a mãe pensar "isso acontece aqui em casa", REESCREVA.

🧠 PERCEPÇÃO CLÍNICA (injetar no roteiro):
Antes de escrever, interprete a dor real do pai:
- Dor principal: angústia específica (não "preocupação" genérica)
- Situação real: o que acontece no dia a dia (ex: "tenta fazer repetir e não responde")
- Idade crítica: mencione no roteiro
- Estágio do pai: descoberta (acabou de perceber) | dúvida (sabe que algo está errado) | ação (já tentou de tudo)

🚫 BLOQUEADOR DE TEXTO GENÉRICO:
Se o rascunho contiver: "é muito importante", "isso pode afetar", "devemos observar", "é fundamental" → REESCREVER imediatamente com linguagem específica ou emocional.

💬 HUMANIZAÇÃO TOTAL:
- Converter 100% para linguagem falada (WhatsApp/consulta)
- Frases MÁXIMO 12 palavras
- Usar contrações: "tá", "às vezes", "muito comum ver", "a gente vê"
- Substituir termos formais:
  * "crianças" → "os pequenos", "os filhos"
  * "tratamento" → "acompanhamento", "os encontros"
  * "evolução" → "melhora", "mudança"
  * "diagnóstico" → "entender o que está acontecendo"

🎯 CTA NATURAL (continuação da conversa):
Proibido: "agende agora", "não perca tempo", "corra"
Usar: "se fizer sentido pra você...", "se quiser entender melhor...", "quando quiser conversar..."
O CTA deve parecer que a profissional continuou falando, não um comercial.

REGRA GLOBAL DO hook_texto_overlay (A FRASE MAIS IMPORTANTE DO VÍDEO):
O hook_texto_overlay aparece em tela nos primeiros 3 segundos e decide se o usuário continua assistindo.
Ele precisa: parar o scroll, gerar emoção ou curiosidade imediata, ser específico ao tema.

🚫 HOOK_TEXTO_OVERLAY PROIBIDOS (nunca use):
- "Eu entendo o que você está sentindo"
- "Preste muita atenção"
- "Isso pode mudar tudo"
- "Uma dica importante"
- "Você precisa saber"
- "É importante observar"

✅ EXEMPLOS DE HOOKS FORTES:
- "Você já pediu pro seu filho repetir..."
- "Enquanto outras crianças brincam, seu filho..."
- "Você já chorou vendo seu filho tentar falar?"
- "Toda vez que você tenta brincar, ele vira o rosto"

👉 Auto-validação: antes de finalizar, pergunte — "essa frase faria alguém parar de rolar o feed?" Se não → reescreva imediatamente.

${isInstagram
  ? `MODO INSTAGRAM (ORGÂNICO — VIRAL):
- Duração: 20-35 segundos (frases bem curtas, ritmo acelerado)
- Foco: retenção total + salvamento/compartilhamento
- Hook AGRESSIVO nos primeiros 3 segundos
- Intensidade: ${intensidade}`
  : `MODO META ADS (CONVERSÃO):
- Duração: 30-60 segundos
- Foco: clareza + promessa + CTA para WhatsApp
- Tom mais institucional mas ainda acolhedor`}`;

  const instrucaoHook  = HOOK_INSTRUCOES[hookStyle]  || HOOK_INSTRUCOES.dor;
  const instrucaoTone  = TONE_INSTRUCOES[tone]        || TONE_INSTRUCOES.educativo;

  const userPrompt = `SubTema: ${subTema || especialidade}
Contexto do tema: ${subTemaContexto}
Profissional: ${nomeProfissional}
Funil: ${funil}
Duração alvo: ${duracaoEfetiva} segundos (~${Math.floor(duracaoEfetiva * 2.2)} palavras na narração)
Objetivo do conteúdo: ${objetivo} — ${ctaSugerido}
Intensidade: ${intensidade}

ESTRUTURA NARRATIVA A USAR (${estruturaLetra}):
${estruturaDescricao}

${instrucaoHook}

${instrucaoTone}

HOOK DE REFERÊNCIA (USE ESTE EXATO HOOK): "${hookSugerido}"

⚠️ OBRIGATÓRIO: Use o hook acima EXATAMENTE como hook_texto_overlay. NÃO crie hooks genéricos como "eu entendo" ou "preste atenção".

COMBINAÇÃO ATIVA: hookStyle="${hookStyle}" + tone="${tone}"
${hookStyle === 'curiosidade' && tone === 'educativo'     ? '→ Abre com mistério, corpo do vídeo entrega a informação como descoberta' : ''}
${hookStyle === 'curiosidade' && tone === 'emotional'     ? '→ Abre com mistério emocional, narração toda ressoa com o coração do pai' : ''}
${hookStyle === 'dor'         && tone === 'emotional'     ? '→ Valida a dor primeiro, depois acolhe — gera muito comentário e DM' : ''}
${hookStyle === 'autoridade'  && tone === 'inspiracional' ? '→ Abre com credencial, corpo mostra transformação possível — gera compartilhamento' : ''}
${hookStyle === 'erro_comum'  && tone === 'educativo'     ? '→ Nomeia o erro, explica o porquê, dá a correção prática — gera salvamento' : ''}
${hookStyle === 'alerta'      && tone === 'bastidores'    ? '→ Alerta vindo de dentro da clínica — humanizado e urgente ao mesmo tempo' : ''}

${bordao ? `BORDÃO OBRIGATÓRIO DE ABERTURA:
O vídeo DEVE começar exatamente com: "${bordao}"
- A primeira palavra falada na narração é "${bordao}"
- O hook_texto_overlay também deve começar com "${bordao}"
- Mantenha o tom curioso/educativo após o bordão — NÃO acusatório
- Ex: "${bordao} que criticar seu filho pode travar a fala?" → correto
- Ex: "${bordao} que existe um sinal que a maioria dos pais ignora?" → correto
` : ''}
PERCEPÇÃO CLÍNICA A INJETAR (dor real do tema):
${JSON.stringify(DOR_REAL[subTema] || DOR_REAL.atraso_fala, null, 2)}

REGRA DE ESCRITA: Use a dor principal e situação real acima como base emocional. Não explique a dor — mostre que você ENTENDE vivenciando com o pai.

VERIFICAÇÃO OBRIGATÓRIA antes de finalizar (em ordem):
1. HOOK INTENSO: Essa frase faria alguém PARAR O SCROLL imediatamente? Gera identificação ou curiosidade forte? Se não → REESCREVA.
${bordao ? `1b. hook_texto_overlay começa com "${bordao}"? Se não → REESCREVA.` : ''}
2. HUMANIZAÇÃO: Todas as frases têm máximo 12 palavras? Usa contrações (tá, às vezes, a gente)? Se não → REESCREVA.
3. SEM TEXTOS GENÉRICOS: Contém "é muito importante", "isso pode afetar", "devemos observar"? Se sim → REESCREVA com situação específica.
4. Tom: "${tone}" está consistente do início ao fim?
5. Ritmo: Frases curtas e longas alternadas?
6. CTA NATURAL: É continuação da conversa ("se quiser entender...") e NÃO comercial ("agende agora")?
7. IDADE: Menciona idade específica ou faixa etária?
8. EXEMPLO: Tem situação concreta do dia a dia (ex: "ontem atendi...")?
9. GATILHO: Tem urgência leve ("quanto antes", "enquanto é cedo")?

CONTROLE DE QUALIDADE FINAL (auto-avaliação):
❓ Parece uma profissional FALANDO ou um texto ESCRITO de site? Se escrito → ajustar para linguagem falada.
❓ Tem EMOÇÃO (pai se sente visto) OU DESCOBERTA REAL (insight novo)? Se não → adicionar.
❓ Tem APLICAÇÃO PRÁTICA (o pai sai sabendo o que fazer)? Se não → adicionar dica acionável.
❓ O hook é ESPECÍFICO (não genérico)? Se genérico → reescrever com detalhe concreto.

⚠️ VALIDAÇÃO CRÍTICA DO HOOK_TEXTO_OVERLAY:
Se hook_texto_overlay conter: "eu entendo", "preste atenção", "isso pode mudar", "dica importante" → REESCREVER imediatamente com cena específica (ex: "você já pediu pro seu filho repetir...").

Retorne JSON:
{
  "roteiro": {
    "titulo": "título legível em português, máx 50 chars, sem snake_case — ex: 'Seu filho ainda não fala?' ou 'Sinais de atraso de linguagem'",
    "profissional": "${profissional}",
    "duracao_estimada": ${duracaoEfetiva},
    "texto_completo": "narração exata que o avatar vai falar, tom de conversa",
    "hook_texto_overlay": "USE EXATAMENTE: ${hookSugerido}",
    "cta_texto_overlay": "${ctaSugerido}",
    "legenda_instagram": "REGRA: primeiros 125 chars DEVEM conter a palavra-chave principal do tema (ex: 'atraso de fala', 'autismo', 'birra'). Depois quebras de linha, emojis leves (máx 3) e CTA. Mínimo 150 chars no total.",
    "hashtags": ["gere 8 a 10 hashtags específicas do tema — SEM as de localidade e SEM #FonoInova que são adicionadas automaticamente. Misture: 2 de alto volume (ex: #Maternidade), 4 de médio (ex: #AtrasoFala), 2-4 de nicho (ex: #FilhoNaoFala). NUNCA inclua hashtag genérica demais como #Criança sozinha."],
    "estrutura_usada": "${estruturaLetra}",
    "objetivo": "${objetivo}",
    "copy_anuncio": {
      "texto_primario": "copy 2-3 linhas pra Meta Ads",
      "headline": "headline 5-8 palavras",
      "descricao": "descrição secundária 1 frase"
    }
  }
}`;

  const MAX_TENTATIVAS = 3;
  let ultimoErro;

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    if (tentativa > 1) {
      logger.info(`[ZEUS] 🔄 Tentativa ${tentativa}/${MAX_TENTATIVAS} — roteiro anterior reprovado: ${ultimoErro}`);
    }

  try {
    // curiosidade e erro_comum precisam de mais criatividade para não repetir padrões
    // A cada tentativa aumenta levemente a temperatura para variar o output
    const baseTemp = ['curiosidade', 'erro_comum'].includes(hookStyle) ? 1.0 : 0.85;
    const temperature = Math.min(baseTemp + (tentativa - 1) * 0.05, 1.2);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature,
      max_tokens: 1800,
      response_format: { type: 'json_object' }
    });

    let resultado = JSON.parse(response.choices[0].message.content);

    if (!resultado.roteiro?.texto_completo) {
      throw new Error('ZEUS retornou roteiro sem texto_completo');
    }

    // 🚫 VALIDAÇÃO: Bloquear texto genérico automaticamente (texto_completo inteiro)
    const texto = resultado.roteiro.texto_completo.toLowerCase();
    const palavrasProibidasEncontradas = verificarFrasesProibidas(resultado.roteiro.texto_completo);
    
    if (palavrasProibidasEncontradas.length > 0) {
      logger.warn(`[ZEUS] ⚠️ Texto genérico detectado: ${palavrasProibidasEncontradas.join(', ')}. Solicitando reescrita...`);
      
      // Reescrever automaticamente
      const rewritePrompt = `O roteiro abaixo contém linguagem genérica proibida: ${palavrasProibidasEncontradas.join(', ')}.

REGRAS OBRIGATÓRIAS para a reescrita:
1. MANTENHA: faixa etária específica (ex: "2 a 4 anos", "18 meses") — NÃO remova
2. MANTENHA: comportamentos concretos (ex: "não responde", "não fala", "não olha") — NÃO remova
3. SUBSTITUA o CTA fraco por algo natural: "me chama no WhatsApp", "manda mensagem aqui", "quando quiser conversar"
4. Frases curtas, linguagem de conversa (tá, às vezes, a gente)
5. NUNCA use: "não hesite", "estamos aqui para ajudar", "eu entendo", "é normal"

Roteiro original:
${resultado.roteiro.texto_completo}

Retorne APENAS o novo texto no campo "texto_completo" do JSON.`;

      const rewriteResponse = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: rewritePrompt }
        ],
        temperature: 0.9,
        max_tokens: 1000,
        response_format: { type: 'json_object' }
      });

      const rewriteResult = JSON.parse(rewriteResponse.choices[0].message.content);
      if (rewriteResult.texto_completo) {
        resultado.roteiro.texto_completo = rewriteResult.texto_completo;
        logger.info('[ZEUS] ✅ Roteiro reescrito para remover textos genéricos');
      }
    }

    // 💬 HUMANIZAÇÃO ADICIONAL: Substituir termos formais
    let textoHumanizado = resultado.roteiro.texto_completo;
    Object.entries(SUBSTITUICOES_HUMANIZADAS).forEach(([formal, informal]) => {
      const regex = new RegExp(`\\b${formal}\\b`, 'gi');
      textoHumanizado = textoHumanizado.replace(regex, informal);
    });
    resultado.roteiro.texto_completo = textoHumanizado;

    // 🚫 VALIDAÇÃO DO HOOK: Bloquear hooks genéricos
    const hook = resultado.roteiro.hook_texto_overlay?.toLowerCase() || '';
    const hooksProibidos = [
      'eu entendo', 'preste atenção', 'isso pode mudar',
      'dica importante', 'você precisa saber', 'é importante'
    ];
    const hookFraco = hooksProibidos.some(h => hook.includes(h));

    if (hookFraco) {
      logger.warn(`[ZEUS] ⚠️ Hook genérico detectado: "${resultado.roteiro.hook_texto_overlay}". Substituindo...`);
      const hookForte = escolherHookSubTema(subTema, hookStyle, variacao) || hookSugerido;
      resultado.roteiro.hook_texto_overlay = hookForte;
      logger.info(`[ZEUS] ✅ Hook substituído por: "${hookForte}"`);
    }

    // 🔴 DETECTOR DE CONTRADIÇÃO: abre com preocupação e depois normaliza
    const textoFinal = resultado.roteiro.texto_completo.toLowerCase();
    const temPreocupacao = textoFinal.includes('preocup') || textoFinal.includes('angust') || textoFinal.includes('medo');
    const temNormalizacao = textoFinal.includes('é normal') || textoFinal.includes('e normal') || textoFinal.includes('isso é comum') || textoFinal.includes('nao se preocupe') || textoFinal.includes('não se preocupe');
    if (temPreocupacao && temNormalizacao) {
      logger.warn('[ZEUS] 🔴 CONTRADIÇÃO DETECTADA: roteiro abre com dor/medo e depois normaliza — mata conversão. Rejeitando...');
      throw new Error('CONTRADIÇÃO DE MENSAGEM — roteiro abre com preocupação e depois diz "é normal". REGERAR.');
    }

    // 📊 SCORE DE QUALIDADE 0-100 — só libera acima de 70
    const scoreRoteiro = (() => {
      let s = 100;
      const t = resultado.roteiro.texto_completo;
      const tLow = t.toLowerCase();
      const palavras = t.split(/\s+/).filter(Boolean).length;

      // -35: frases proibidas no texto completo
      const proibidas = verificarFrasesProibidas(t);
      if (proibidas.length > 0) s -= 35;

      // -20: muito curto (menos de 80 palavras)
      if (palavras < 80) s -= 20;

      // -15: sem faixa etária específica
      if (!/\d+\s*(anos?|meses?|m[eê]s)/.test(tLow)) s -= 15;

      // -15: sem comportamento concreto observável
      const comportamentosConcretos = ['não fala', 'nao fala', 'não responde', 'nao responde', 'não olha', 'nao olha', 'não anda', 'nao anda', 'não come', 'nao come', 'não dorme', 'nao dorme', 'não brinca', 'nao brinca', 'cai muito', 'chora muito'];
      if (!comportamentosConcretos.some(c => tLow.includes(c))) s -= 15;

      // -10: CTA fraco (genérico)
      const ctaFraco = ['não perca', 'nao perca', 'agende agora', 'não hesite', 'nao hesite', 'estamos aqui'];
      if (ctaFraco.some(c => tLow.includes(c))) s -= 10;

      // -10: hook_texto_overlay muito longo (>70 chars) ou ausente
      const hookLen = (resultado.roteiro.hook_texto_overlay || '').length;
      if (hookLen === 0 || hookLen > 70) s -= 10;

      return Math.max(s, 0);
    })();

    logger.info(`[ZEUS] 📊 Score de qualidade: ${scoreRoteiro}/100`);

    if (scoreRoteiro < 60) {
      logger.warn(`[ZEUS] 🔴 ROTEIRO REPROVADO (score ${scoreRoteiro}/100) — abaixo do mínimo de 60. Rejeitando para regerar.`);
      throw new Error(`ROTEIRO REPROVADO — score ${scoreRoteiro}/100. Requer mínimo 60.`);
    }

    // ✅ CONTROLE DE QUALIDADE FINAL (warnings não-bloqueantes)
    const validacoes = [
      { teste: texto.length < 500, mensagem: 'Texto muito curto' },
      { teste: !resultado.roteiro.hook_texto_overlay || resultado.roteiro.hook_texto_overlay.length > 60, mensagem: 'Hook muito longo ou ausente' },
      { teste: resultado.roteiro.texto_completo.split('.').some(f => f.trim().split(/\s+/).length > 15), mensagem: 'Frases muito longas detectadas' }
    ];

    const falhas = validacoes.filter(v => v.teste);
    if (falhas.length > 0) {
      logger.warn(`[ZEUS] ⚠️ Avisos de qualidade: ${falhas.map(f => f.mensagem).join(', ')}`);
    }

    // Mescla hashtags do GPT com as bases garantidas (localidade + especialidade)
    resultado.roteiro.hashtags = montarHashtags(
      resultado.roteiro.hashtags || [],
      subTema,
      especialidade
    );

    const palavras = resultado.roteiro.texto_completo.split(/\s+/).length;
    logger.info(`[ZEUS] ✅ Roteiro gerado: ${palavras} palavras | estrutura=${resultado.roteiro.estrutura_usada} | ${nomeProfissional} | hashtags=${resultado.roteiro.hashtags.length}`);

    // 🧠 Adicionar metadados de intenção ao resultado
    if (intencaoDetectada) {
      resultado.roteiro._intencao = {
        detectada: intencaoDetectada.intencao,
        confianca: intencaoDetectada.confianca,
        hookAplicado: hookStyle,
        toneAplicado: tone,
        objetivoAplicado: objetivo
      };
    }

    return resultado;

  } catch (error) {
    const erroQualidade = error.message.startsWith('ROTEIRO REPROVADO') ||
                          error.message.startsWith('CONTRADIÇÃO DE MENSAGEM');

    if (erroQualidade && tentativa < MAX_TENTATIVAS) {
      ultimoErro = error.message;
      continue; // tenta novamente
    }

    logger.error('[ZEUS] Erro ao gerar roteiro:', error.message);
    throw error;
  }
  } // fim for tentativas

  // Se chegou aqui, todas as tentativas falharam por qualidade
  throw new Error(`[ZEUS] Roteiro reprovado após ${MAX_TENTATIVAS} tentativas: ${ultimoErro}`);
}

export default { gerarRoteiro, detectarIntencaoLead };
