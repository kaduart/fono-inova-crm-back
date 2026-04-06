/**
 * 🎯 PriorityResolver V2 - Enxuto
 * Resolve a melhor área terapêutica com base em múltiplas fontes de contexto
 * 
 * Regra de precedência:
 * 1. Menção explícita no texto
 * 2. Nome da clínica no texto
 * 3. Histórico do lead
 * 4. Fallback → null
 */

const AREA_KEYWORDS = {
  // ⚠️ 'fono' removido - evitar falso positivo com "Fono Inova" (nome da clínica)
  fonoaudiologia: ['fonoaudiologia', 'falar', 'fala', 'língua', 'línguinha', 'anquiloglossia', 'freio'],
  // ⚠️ ATENÇÃO: 'psico' removido para não conflitar com 'neuropsicologia'
  psicologia: ['psicologia', 'comportamento', 'ansiedade', 'depressão', 'tcc'],
  'terapia ocupacional': ['to', 'terapia ocupacional', 'motricidade', 'sensorial', 'tod'],
  fisioterapia: ['fisio', 'fisioterapia', 'postura', 'movimento', 'marcha', 'bobath'],
  neuropsicologia: ['neuropsicologia', 'neuro', 'cognição', 'memória', 'aprendizagem', 'dislexia', 'tdah', 'tea'],
  psicopedagogia: ['psicopedagogia', 'escola', 'alfabetização', 'dificuldade escolar']
};

/**
 * Resolve a área terapêutica com base no contexto
 * 
 * ⚠️ IMPORTANTE: Nome da clínica (Fono Inova) NÃO indica especialidade!
 * O lead pode querer qualquer área (psicologia, fisioterapia, etc.)
 */
export function resolveBestArea({ message = '', lead, pageSource }) {
  const text = message.toLowerCase();

  // 🔥 1. Menção explícita de especialidade no texto
  // Ordena por palavras maiores primeiro (mais específicas)
  const sortedAreas = Object.entries(AREA_KEYWORDS).sort((a, b) => {
    // Calcula tamanho médio das palavras-chave (maiores = mais específicas)
    const avgLengthA = a[1].reduce((sum, k) => sum + k.length, 0) / a[1].length;
    const avgLengthB = b[1].reduce((sum, k) => sum + k.length, 0) / b[1].length;
    return avgLengthB - avgLengthA; // Decrescente
  });
  
  for (const [area, keywords] of sortedAreas) {
    // Ordena palavras-chave do maior para o menor
    const sortedKeywords = [...keywords].sort((a, b) => b.length - a.length);
    
    for (const keyword of sortedKeywords) {
      if (text.includes(keyword.toLowerCase())) {
        return {
          area,
          confidence: 0.9,
          source: 'explicit_text',
          matchedWord: keyword
        };
      }
    }
  }

  // 🔥 3. Página de origem (SEO)
  if (pageSource) {
    const seoArea = mapPageSourceToArea(pageSource);
    if (seoArea) {
      return {
        area: seoArea,
        confidence: 0.85,
        source: 'page_source'
      };
    }
  }

  // 🔥 4. Histórico do lead
  if (lead?.qualification?.therapyArea) {
    return {
      area: lead.qualification.therapyArea,
      confidence: 0.9,
      source: 'lead_history'
    };
  }

  // ❌ Não sabemos
  return {
    area: null,
    confidence: 0,
    source: 'unknown'
  };
}

/**
 * Verifica se devemos pular a pergunta de área
 */
export function shouldSkipAreaQuestion(resolution) {
  return resolution.confidence >= 0.8;
}

/**
 * Mapeia página de origem para área
 */
function mapPageSourceToArea(pageSource) {
  const mappings = {
    'dislexia': 'neuropsicologia',
    'tea': 'neuropsicologia',
    'tdah': 'neuropsicologia',
    'fala-tardia': 'fonoaudiologia',
    'freio-lingual': 'fonoaudiologia',
    'teste-linguinha': 'fonoaudiologia',
    'fonoaudiologia': 'fonoaudiologia',
    'psicologia': 'psicologia',
    'terapia-ocupacional': 'terapia ocupacional',
    'fisioterapia': 'fisioterapia',
    'neuropsicologia': 'neuropsicologia',
    'psicopedagogia': 'psicopedagogia'
  };

  for (const [key, area] of Object.entries(mappings)) {
    if (pageSource.includes(key)) return area;
  }
  return null;
}
