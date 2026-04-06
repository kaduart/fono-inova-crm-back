/**
 * 🧠 ClinicalMapper V3 - Árvore de Decisão Clínica
 * 
 * Mapeamento profissional de sintomas para áreas terapêuticas
 * Estrutura: Multi-sintomas com pesos + validação cruzada
 * 
 * Versão: 3.0
 * Data: 2026-04-05
 */

// ============================================================================
// 🎯 CONFIGURAÇÃO DE THRESHOLDS
// ============================================================================

const THRESHOLDS = {
  CERTAIN: 0.9,    // Resposta direta imediata
  HIGH: 0.75,      // Resposta guiada
  MEDIUM: 0.6,     // Sugestão com confirmação
  LOW: 0.4         // Pergunta de esclarecimento
};

// ============================================================================
// 📚 MAPEAMENTO CLÍNICO AVANÇADO
// ============================================================================

export const CLINICAL_MAP = {
  // ═════════════════════════════════════════════════════════════════════════
  // FONOAUDIOLOGIA (área mais crítica - cobertura completa)
  // ═════════════════════════════════════════════════════════════════════════
  
  'fala_tardia': {
    symptoms: [
      'não fala', 'atraso na fala', 'fala pouco', 'não diz palavras', 
      'só aponta', 'não verbaliza', 'não fala direito', 'fala atrasada',
      'ainda não fala', 'não fala nada', 'não emite sons'
    ],
    secondary_symptoms: ['2 anos e não fala', '3 anos e não fala'],
    area: 'fonoaudiologia',
    confidence: 0.9,
    weight: 1.0,
    response_key: 'fala_tardia'
  },
  
  'problemas_articulacao': {
    symptoms: [
      'troca letras', 'fala enrolado', 'não pronuncia direito', 
      'fala estranho', 'troca r por l', 'troca f por p', 'fala engasgada',
      'pronúncia errada', 'troca fonemas', 'dificuldade para pronunciar',
      'fala trocando sons', 'não consegue falar o r', 'não fala o l direito'
    ],
    area: 'fonoaudiologia',
    confidence: 0.85,
    weight: 0.95,
    response_key: 'articulacao'
  },
  
  'gagueira': {
    symptoms: [
      'gagueira', 'gagueja', 'trava na fala', 'fala travada', 
      'repete sílabas', 'repete sons', 'fala arrastada', 'tartamudez',
      'demora para falar', 'fala com dificuldade'
    ],
    area: 'fonoaudiologia',
    confidence: 0.95,
    weight: 1.0,
    response_key: 'fluencia'
  },
  
  'freio_lingual': {
    symptoms: [
      'freio lingual', 'linguinha presa', 'anquiloglossia', 
      'teste da linguinha', 'amamentação difícil', 'lingua presa',
      'freio curto', 'lingua não sobe', 'dificuldade para mamar'
    ],
    area: 'fonoaudiologia',
    confidence: 0.95,
    weight: 1.0,
    response_key: 'freio_lingual'
  },
  
  'problemas_voz': {
    symptoms: [
      'voz rouca', 'voz rouca constante', 'fala rouca', 'voz alterada',
      'dores para falar', 'cansaço ao falar', 'voz fraca'
    ],
    area: 'fonoaudiologia',
    confidence: 0.85,
    weight: 0.9,
    response_key: 'voz'
  },
  
  'degluticao': {
    symptoms: [
      'engasga muito', 'engasga ao comer', 'mastigação ruim', 
      'recusa alimentar', 'seletividade alimentar', 'não mastiga',
      'passa comida direto', 'engasga com líquido', 'tosse ao alimentar'
    ],
    area: 'fonoaudiologia',
    confidence: 0.85,
    weight: 0.9,
    response_key: 'degluticao'
  },
  
  // ═════════════════════════════════════════════════════════════════════════
  // NEUROPSICOLOGIA (já bem coberta - manter)
  // ═════════════════════════════════════════════════════════════════════════
  
  'dislexia': {
    symptoms: [
      'troca letras ao ler', 'confunde letras', 'dificuldade para ler', 
      'inverte sílabas', 'dislexia', 'lê trocando letras', 
      'dificuldade com leitura', 'lê errado', 'escrita trocada'
    ],
    area: 'neuropsicologia',
    confidence: 0.9,
    weight: 1.0,
    response_key: 'dislexia'
  },
  
  'tea': {
    symptoms: [
      'autismo', 'tea', 'espectro autista', 'não olha nos olhos', 
      'comportamentos repetitivos', 'estereotipias', 'não responde ao nome',
      'isolamento', 'não interage', 'manias estranhas'
    ],
    area: 'neuropsicologia',
    confidence: 0.9,
    weight: 1.0,
    response_key: 'tea'
  },
  
  'tdah': {
    symptoms: [
      'tdah', 'hiperativo', 'inquieto', 'não para quieto', 
      'dificuldade de atenção', 'distraído', 'falta de foco',
      'agitado demais', 'não concentra', 'falta atenção'
    ],
    area: 'neuropsicologia',
    confidence: 0.9,
    weight: 1.0,
    response_key: 'tdah'
  },
  
  'dificuldade_escolar': {
    symptoms: [
      'dificuldade na escola', 'notas baixas', 'não aprende', 
      'problemas de aprendizagem', 'dificuldade com lição',
      'não acompanha a turma', 'reprovação', 'desinteresse escolar'
    ],
    area: 'neuropsicologia',
    confidence: 0.85,
    weight: 0.9,
    response_key: 'aprendizagem'
  },
  
  'memoria_atencao': {
    symptoms: [
      'esquece tudo', 'memória ruim', 'dificuldade de memória',
      'não lembra do que estudou', 'memória fraca', 'desatento'
    ],
    area: 'neuropsicologia',
    confidence: 0.85,
    weight: 0.9,
    response_key: 'memoria'
  },
  
  // ═════════════════════════════════════════════════════════════════════════
  // PSICOLOGIA (expandido)
  // ═════════════════════════════════════════════════════════════════════════
  
  'comportamental': {
    symptoms: [
      'birra', 'birras frequentes', 'agressivo', 'bate em outros', 
      'não obedece', 'tantrum', 'crise de choro', 'birra para tudo',
      'muito irritadiço', 'explode fácil', 'desobedece sempre'
    ],
    area: 'psicologia',
    confidence: 0.8,
    weight: 0.85,
    response_key: 'comportamento'
  },
  
  'emocional': {
    symptoms: [
      'ansioso', 'medo excessivo', 'inseguro', 'tímido demais', 
      'não socializa', 'isolado', 'ansiedade', 'medo de separação',
      'choroso', 'humor instável', 'seletividade social'
    ],
    area: 'psicologia',
    confidence: 0.8,
    weight: 0.85,
    response_key: 'emocional'
  },
  
  'sono': {
    symptoms: [
      'dorme mal', 'insônia', 'pesadelos frequentes', 'medo de dormir',
      'acorda chorando', 'sono agitado', 'sonambulismo', 'dificuldade para dormir'
    ],
    area: 'psicologia',
    confidence: 0.8,
    weight: 0.8,
    response_key: 'sono'
  },
  
  'enurese_encoprese': {
    symptoms: [
      'faz xixi na cama', 'enurese', 'micção noturna', 'molha a cama',
      'faz cocô na roupa', 'encoprese', 'incontinência', 'acidentes frequentes'
    ],
    area: 'psicologia',
    confidence: 0.85,
    weight: 0.85,
    response_key: 'continencia'
  },
  
  // ═════════════════════════════════════════════════════════════════════════
  // TERAPIA OCUPACIONAL (expandido)
  // ═════════════════════════════════════════════════════════════════════════
  
  'motricidade_fina': {
    symptoms: [
      'coordenação motora ruim', 'motor ruim', 'torpe', 'desajeitado', 
      'cai muito', 'tropessa', 'derruba tudo', 'agarrada fraca',
      'não consegue segurar lápis', 'dificuldade com tesoura'
    ],
    area: 'terapia_ocupacional',
    confidence: 0.85,
    weight: 0.9,
    response_key: 'motricidade'
  },
  
  'integracao_sensorial': {
    symptoms: [
      'sensorial', 'não gosta de textura', 'sensível a barulho', 
      'seletividade alimentar extrema', 'tosse com comida', 'agitação com barulho',
      'não gosta de toque', 'sensibilidade sensorial', 'evita contato'
    ],
    area: 'terapia_ocupacional',
    confidence: 0.9,
    weight: 0.95,
    response_key: 'sensorial'
  },
  
  'autonomia_avd': {
    symptoms: [
      'não se veste sozinho', 'dependente demais', 'não come sozinho',
      'dificuldade com higiene', 'atraso nas avds', 'não faz nada sozinho',
      'dependência excessiva'
    ],
    area: 'terapia_ocupacional',
    confidence: 0.8,
    weight: 0.85,
    response_key: 'autonomia'
  },
  
  'lateralidade': {
    symptoms: [
      'não definiu lateralidade', 'troca de mão', 'canhoto forçado',
      'escrita lenta', 'cansanço ao escrever', 'letra ilegível'
    ],
    area: 'terapia_ocupacional',
    confidence: 0.8,
    weight: 0.8,
    response_key: 'escrita'
  },
  
  // ═════════════════════════════════════════════════════════════════════════
  // FISIOTERAPIA
  // ═════════════════════════════════════════════════════════════════════════
  
  'postura': {
    symptoms: [
      'postura ruim', 'costas tortas', 'escoliose', 'cabeça para frente',
      'corcunda', 'postura curvada'
    ],
    area: 'fisioterapia',
    confidence: 0.9,
    weight: 0.95,
    response_key: 'postura'
  },
  
  'atraso_motor': {
    symptoms: [
      'não engatinhou', 'atraso motor', 'marcha estranha', 'anda na ponta do pé',
      'não andou ainda', 'atraso para andar', 'quedas frequentes'
    ],
    area: 'fisioterapia',
    confidence: 0.9,
    weight: 0.95,
    response_key: 'motor'
  },
  
  'prematuridade_fisio': {
    symptoms: [
      'prematuro', 'prematuridade', 'utero', 'uti neonatal', 
      'nasceu antes', 'baixo peso ao nascer'
    ],
    area: 'fisioterapia',
    confidence: 0.85,
    weight: 0.9,
    response_key: 'prematuro'
  },
  
  // ═════════════════════════════════════════════════════════════════════════
  // MULTIDISCIPLINAR
  // ═════════════════════════════════════════════════════════════════════════
  
  'sindrome_down': {
    symptoms: [
      'síndrome de down', 'down', 'trissomia 21', 'sd'
    ],
    areas: ['fonoaudiologia', 'fisioterapia', 'terapia_ocupacional', 'neuropsicologia'],
    confidence: 0.95,
    weight: 1.0,
    isMultidisciplinary: true,
    response_key: 'multiprofissional'
  },
  
  'paralisia_cerebral': {
    symptoms: [
      'paralisia cerebral', 'pc', 'encefalopatia', 'hipotonia', 
      'hipertonia', 'espasticidade'
    ],
    areas: ['fisioterapia', 'terapia_ocupacional', 'fonoaudiologia'],
    confidence: 0.95,
    weight: 1.0,
    isMultidisciplinary: true,
    response_key: 'multiprofissional'
  },
  
  'microcefalia': {
    symptoms: [
      'microcefalia', 'cabeça pequena', 'perímetro cefálico baixo'
    ],
    areas: ['neuropsicologia', 'fisioterapia', 'terapia_ocupacional'],
    confidence: 0.9,
    weight: 1.0,
    isMultidisciplinary: true,
    response_key: 'multiprofissional'
  }
};

// ============================================================================
// 🧮 SISTEMA DE SCORING INTELIGENTE
// ============================================================================

function calculateMatchScore(text, condition, data) {
  const lowerText = text.toLowerCase();
  let primaryMatches = 0;
  let secondaryMatches = 0;
  let matchedSymptoms = [];
  
  // Primary symptoms (peso 1.0)
  for (const symptom of data.symptoms) {
    const symptomLower = symptom.toLowerCase();
    // Match parcial (ex: "não fala" match em "meu filho não fala direito")
    if (lowerText.includes(symptomLower)) {
      primaryMatches++;
      matchedSymptoms.push(symptom);
    }
  }
  
  // Secondary symptoms (peso 0.5)
  if (data.secondary_symptoms) {
    for (const symptom of data.secondary_symptoms) {
      if (lowerText.includes(symptom.toLowerCase())) {
        secondaryMatches += 0.5;
        matchedSymptoms.push(symptom + '*');
      }
    }
  }
  
  // Se não deu match em nenhum sintoma, retorna 0
  if (primaryMatches === 0 && secondaryMatches === 0) {
    return { score: 0, matches: 0, secondaryMatches: 0, matchedSymptoms: [] };
  }
  
  // NOVO: Cálculo de score baseado em matches, não proporção
  // 1 match = 0.6, 2 matches = 0.85, 3+ matches = 1.0
  let baseScore;
  if (primaryMatches === 1) {
    baseScore = 0.6;
  } else if (primaryMatches === 2) {
    baseScore = 0.85;
  } else {
    baseScore = 1.0;
  }
  
  // Adiciona contribuição de secondary matches
  baseScore += secondaryMatches * 0.2;
  
  // Aplicação do peso da condição
  const weightedScore = Math.min(1.0, baseScore * (data.weight || 1.0));
  
  return {
    score: weightedScore,
    matches: primaryMatches,
    secondaryMatches,
    matchedSymptoms
  };
}

// ============================================================================
// 🔍 FUNÇÕES PÚBLICAS
// ============================================================================

/**
 * Detecta sintomas clínicos no texto com scoring avançado
 */
export function detectClinicalSymptoms(message) {
  const text = message.toLowerCase();
  const detected = [];
  
  for (const [condition, data] of Object.entries(CLINICAL_MAP)) {
    const matchResult = calculateMatchScore(text, condition, data);
    
    // Só inclui se score mínimo
    if (matchResult.score >= 0.3) {
      detected.push({
        condition,
        ...matchResult,
        area: data.area || data.areas,
        confidence: data.confidence,
        isMultidisciplinary: data.isMultidisciplinary || false,
        response_key: data.response_key
      });
    }
  }
  
  // Ordena por score
  detected.sort((a, b) => b.score - a.score);
  
  return detected;
}

/**
 * Resolve a área clínica mais provável
 */
export function resolveClinicalArea(message, context = {}) {
  const detected = detectClinicalSymptoms(message);
  
  if (detected.length === 0) {
    return {
      area: null,
      confidence: 0,
      source: 'no_clinical_indicators',
      isMultidisciplinary: false
    };
  }
  
  const bestMatch = detected[0];
  
  // Se é multidisciplinar
  if (bestMatch.isMultidisciplinary && Array.isArray(bestMatch.area)) {
    return {
      area: bestMatch.area[0], // Sugere a primeira como principal
      allAreas: bestMatch.area,
      confidence: bestMatch.confidence * bestMatch.score,
      source: 'clinical_inference_multidisciplinary',
      condition: bestMatch.condition,
      isMultidisciplinary: true,
      matchedSymptoms: bestMatch.matchedSymptoms,
      score: bestMatch.score
    };
  }
  
  return {
    area: bestMatch.area,
    confidence: bestMatch.confidence * bestMatch.score,
    source: 'clinical_inference',
    condition: bestMatch.condition,
    matchedSymptoms: bestMatch.matchedSymptoms,
    isMultidisciplinary: false,
    score: bestMatch.score
  };
}

/**
 * Verifica se devemos sugerir área baseado em sintomas
 */
export function shouldSuggestArea(clinicalResolution, context = {}) {
  const effectiveConfidence = clinicalResolution.confidence * (clinicalResolution.score || 1);
  
  // Sempre sugerir se tem confiança alta
  if (effectiveConfidence >= THRESHOLDS.HIGH) return true;
  
  // Se tem sintoma claro e não temos área ainda
  if (effectiveConfidence >= THRESHOLDS.MEDIUM && !context.currentArea) return true;
  
  return false;
}

/**
 * Retorna explicação do raciocínio clínico (para debug)
 */
export function explainClinicalReasoning(message) {
  const detected = detectClinicalSymptoms(message);
  const resolved = resolveClinicalArea(message);
  
  return {
    message: message.substring(0, 50),
    topConditions: detected.slice(0, 3).map(d => ({
      condition: d.condition,
      score: d.score.toFixed(2),
      confidence: d.confidence,
      matchedSymptoms: d.matchedSymptoms.slice(0, 3)
    })),
    resolvedArea: resolved.area,
    effectiveConfidence: (resolved.confidence || 0).toFixed(2),
    isMultidisciplinary: resolved.isMultidisciplinary
  };
}

/**
 * Retorna estatísticas do mapper
 */
export function getClinicalMapperStats() {
  const stats = {
    totalConditions: Object.keys(CLINICAL_MAP).length,
    byArea: {},
    totalSymptoms: 0
  };
  
  for (const [condition, data] of Object.entries(CLINICAL_MAP)) {
    const area = data.isMultidisciplinary ? 'multidisciplinary' : data.area;
    stats.byArea[area] = (stats.byArea[area] || 0) + 1;
    stats.totalSymptoms += data.symptoms.length;
  }
  
  return stats;
}

// Exporta thresholds para uso externo
export { THRESHOLDS };
