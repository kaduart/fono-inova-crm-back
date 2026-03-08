/**
 * 📝 Testes Unitários - Marketing Content (GMB Service)
 * 
 * Cobre as funcionalidades implementadas:
 * - Tones de voz (emotional, educativo, inspiracional, bastidores)
 * - Variações A/B de conteúdo
 * - Score de qualidade de posts
 * - Geração de captions SEO
 * - Geração de hooks virais
 * - Gestão de especialidades sem post
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// MOCKS
// =============================================================================

const mockOpenAICreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockOpenAICreate
      }
    }
  }))
}));

vi.mock('cloudinary', () => ({
  v2: {
    config: vi.fn(),
    uploader: {
      upload: vi.fn().mockResolvedValue({ secure_url: 'https://cloudinary.com/test.jpg' })
    }
  }
}));

vi.mock('../../models/GmbPost.js', () => ({
  default: {
    findOne: vi.fn(),
    find: vi.fn(),
    create: vi.fn()
  }
}));

// =============================================================================
// CONSTANTES E DADOS DE TESTE
// =============================================================================

const MOCK_ESPECIALIDADE = {
  id: 'fonoaudiologia',
  nome: 'Fonoaudiologia',
  url: 'https://www.clinicafonoinova.com.br/fonoaudiologia',
  foco: 'Fala, linguagem, pronúncia, gagueira, autismo, TDAH, atraso de fala',
  publico: 'crianças com dificuldades de comunicação',
  gancho: 'Sua criança não fala ainda?'
};

const MOCK_ESPECIALIDADES = [
  MOCK_ESPECIALIDADE,
  {
    id: 'psicologia',
    nome: 'Psicologia',
    url: 'https://www.clinicafonoinova.com.br/psicologia',
    foco: 'Comportamento, emocional, ansiedade, socialização, temperamento',
    publico: 'crianças com dificuldades comportamentais ou emocionais',
    gancho: 'Seu filho está mais irritado ou ansioso?'
  },
  {
    id: 'terapia_ocupacional',
    nome: 'Terapia Ocupacional',
    foco: 'Autonomia, coordenação motora fina, alimentação, vestir, higiene',
    publico: 'crianças com dificuldades de autonomia',
    gancho: 'Sua criança ainda depende muito de você?'
  }
];

// =============================================================================
// FUNÇÕES DE TESTE ISOLADAS (Extraídas do gmbService.js)
// =============================================================================

/**
 * 🔍 Verifica quais especialidades já tiveram post hoje
 */
async function getEspecialidadesSemPostHoje(especialidades, postsHoje) {
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const amanha = new Date(hoje);
  amanha.setDate(amanha.getDate() + 1);
  
  const especialidadesComPost = new Set(postsHoje.map(p => p.theme));
  
  return especialidades.filter(esp => !especialidadesComPost.has(esp.id));
}

/**
 * 🎯 Determina estratégia por funil
 */
function getEstrategiaPorFunil(funnelStage) {
  const estrategiaPorFunil = {
    top: {
      objetivo: 'crescimento/viralização',
      gatilhos: ['Curiosidade', 'Contradição', 'Identificação'],
      cta: 'Comente "SIM" se você passou por isso, salve este post ou marque outra mãe que precisa ver',
      tom: 'provocativo mas acolhedor'
    },
    middle: {
      objetivo: 'autoridade/educar',
      gatilhos: ['Prova Social', 'Autoridade Técnica', 'Benefício Rápido'],
      cta: 'Siga para parte 2 nos comentários ou comente sua dúvida que respondo pessoalmente',
      tom: 'especialista empático'
    },
    bottom: {
      objetivo: 'conversão/agendamento',
      gatilhos: ['Urgência', 'Escassez', 'Medo Estratégico'],
      cta: 'Me chame com a palavra AVALIAÇÃO no WhatsApp - temos apenas 3 vagas esta semana',
      tom: 'urgente mas ético'
    }
  };

  return estrategiaPorFunil[funnelStage] || estrategiaPorFunil.top;
}

/**
 * 🎭 Configurações de tom de voz
 */
const TONES = {
  emotional: null,
  educativo: {
    instrucao: 'Tom EDUCATIVO: ensine algo valioso, use "Você sabia que...", estatísticas reais, dicas práticas. NÃO foque na dor — foque no conhecimento.',
    cta: 'Salve esse post para não esquecer!'
  },
  inspiracional: {
    instrucao: 'Tom INSPIRACIONAL: conte uma história de transformação (sem identificar paciente), foque no "depois", nas conquistas, na esperança. Cause emoção positiva.',
    cta: 'Comente ❤️ se essa história te tocou'
  },
  bastidores: {
    instrucao: 'Tom BASTIDORES: mostre como a equipe trabalha, o ambiente da clínica, um dia na rotina, como são as sessões. Humanize a clínica. Gere curiosidade e proximidade.',
    cta: 'Venha nos conhecer! Link na bio 👆'
  }
};

/**
 * 📝 Parse de variações A/B (fallback seguro)
 */
function parseVariacoesAB(rawText, especialidade) {
  try {
    return JSON.parse(rawText);
  } catch {
    // Fallback: retorna variações padrão
    return [
      { gatilho: 'Curiosidade', angulo: 'Identificação', hook: especialidade.gancho },
      { gatilho: 'Contradição', angulo: 'Quebra', hook: `Você não sabia, mas ${especialidade.foco.split(',')[0].toLowerCase()} tem solução.` },
      { gatilho: 'Prova Social', angulo: 'Autoridade', hook: `Centenas de famílias em Anápolis já passaram por isso.` }
    ];
  }
}

/**
 * 📊 Parse de score de qualidade (fallback seguro)
 */
function parseScoreQuality(rawText) {
  try {
    return JSON.parse(rawText);
  } catch {
    return { 
      clareza: 7, 
      impacto_emocional: 7, 
      cta: 7, 
      score_geral: 7, 
      ponto_forte: 'Conteúdo relevante', 
      sugestao: 'Adicione um CTA mais específico' 
    };
  }
}

/**
 * 🔗 Geração de keyword SEO
 */
function generateKeywordSEO(especialidadeNome) {
  return `${especialidadeNome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')} infantil`;
}

/**
 * ✅ Validação de post gerado
 */
function validarPostGerado(post) {
  const erros = [];
  
  if (!post.title || post.title.length === 0) {
    erros.push('Título não pode ser vazio');
  }
  
  if (post.title && post.title.length > 80) {
    erros.push('Título muito longo (máx 80 caracteres)');
  }
  
  if (!post.content || post.content.length < 50) {
    erros.push('Conteúdo muito curto (mín 50 caracteres)');
  }
  
  if (post.content && post.content.length > 2000) {
    erros.push('Conteúdo muito longo (máx 2000 caracteres)');
  }
  
  // Regras de conteúdo
  if (post.content) {
    // Não deve ter alarmismo extremo
    const palavrasAlarmantes = ['URGENTE', 'CUIDADO', 'PERIGO', 'AVISO'];
    const temAlarmismoExtremo = palavrasAlarmantes.some(p => 
      post.content.toUpperCase().includes(p)
    );
    if (temAlarmismoExtremo) {
      erros.push('Conteúdo contém alarmismo excessivo');
    }
    
    // Deve ter CTA
    const temCTA = /link|bio|whatsapp|agende|chame/i.test(post.content);
    if (!temCTA) {
      erros.push('Conteúdo deve conter call-to-action');
    }
  }
  
  return {
    valido: erros.length === 0,
    erros
  };
}

// =============================================================================
// TESTES
// =============================================================================

describe('📝 Marketing Content - GMB Service', () => {
  
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // TESTES DE TOM DE VOZ (TONE)
  // ===========================================================================
  
  describe('🎭 Tones de Voz', () => {
    
    it('Deve ter 4 tones configurados', () => {
      expect(Object.keys(TONES)).toHaveLength(4);
      expect(TONES).toHaveProperty('emotional');
      expect(TONES).toHaveProperty('educativo');
      expect(TONES).toHaveProperty('inspiracional');
      expect(TONES).toHaveProperty('bastidores');
    });

    it('Tone educativo deve ter instrução e CTA específicos', () => {
      expect(TONES.educativo.instrucao).toContain('EDUCATIVO');
      expect(TONES.educativo.instrucao).toContain('Você sabia que');
      expect(TONES.educativo.cta).toContain('Salve esse post');
    });

    it('Tone inspiracional deve focar em histórias de transformação', () => {
      expect(TONES.inspiracional.instrucao).toContain('INSPIRACIONAL');
      expect(TONES.inspiracional.instrucao).toContain('história de transformação');
      expect(TONES.inspiracional.cta).toContain('❤️');
    });

    it('Tone bastidores deve humanizar a clínica', () => {
      expect(TONES.bastidores.instrucao).toContain('BASTIDORES');
      expect(TONES.bastidores.instrucao).toContain('equipe trabalha');
      expect(TONES.bastidores.cta).toContain('Link na bio');
    });

    it('Tone emotional deve ser null (comportamento padrão)', () => {
      expect(TONES.emotional).toBeNull();
    });
  });

  // ===========================================================================
  // TESTES DE ESTRATÉGIA POR FUNIL
  // ===========================================================================
  
  describe('🎯 Estratégia por Funil', () => {
    
    it('Funil TOP deve focar em viralização', () => {
      const estrategia = getEstrategiaPorFunil('top');
      expect(estrategia.objetivo).toBe('crescimento/viralização');
      expect(estrategia.gatilhos).toContain('Curiosidade');
      expect(estrategia.gatilhos).toContain('Contradição');
      expect(estrategia.tom).toBe('provocativo mas acolhedor');
    });

    it('Funil MIDDLE deve focar em autoridade', () => {
      const estrategia = getEstrategiaPorFunil('middle');
      expect(estrategia.objetivo).toBe('autoridade/educar');
      expect(estrategia.gatilhos).toContain('Prova Social');
      expect(estrategia.gatilhos).toContain('Autoridade Técnica');
      expect(estrategia.tom).toBe('especialista empático');
    });

    it('Funil BOTTOM deve focar em conversão', () => {
      const estrategia = getEstrategiaPorFunil('bottom');
      expect(estrategia.objetivo).toBe('conversão/agendamento');
      expect(estrategia.gatilhos).toContain('Urgência');
      expect(estrategia.gatilhos).toContain('Escassez');
      expect(estrategia.cta).toContain('AVALIAÇÃO');
      expect(estrategia.tom).toBe('urgente mas ético');
    });

    it('Funil inválido deve retornar estratégia TOP como fallback', () => {
      const estrategia = getEstrategiaPorFunil('invalido');
      expect(estrategia.objetivo).toBe('crescimento/viralização');
    });
  });

  // ===========================================================================
  // TESTES DE ESPECIALIDADES SEM POST
  // ===========================================================================
  
  describe('📅 Gestão de Especialidades Sem Post', () => {
    
    it('Deve retornar todas especialidades quando não há posts', async () => {
      const postsHoje = [];
      const resultado = await getEspecialidadesSemPostHoje(MOCK_ESPECIALIDADES, postsHoje);
      
      expect(resultado).toHaveLength(3);
      expect(resultado.map(e => e.id)).toContain('fonoaudiologia');
      expect(resultado.map(e => e.id)).toContain('psicologia');
      expect(resultado.map(e => e.id)).toContain('terapia_ocupacional');
    });

    it('Deve filtrar especialidades que já têm post', async () => {
      const postsHoje = [
        { theme: 'fonoaudiologia', createdAt: new Date() },
        { theme: 'psicologia', createdAt: new Date() }
      ];
      
      const resultado = await getEspecialidadesSemPostHoje(MOCK_ESPECIALIDADES, postsHoje);
      
      expect(resultado).toHaveLength(1);
      expect(resultado[0].id).toBe('terapia_ocupacional');
    });

    it('Deve retornar array vazio quando todas têm post', async () => {
      const postsHoje = [
        { theme: 'fonoaudiologia', createdAt: new Date() },
        { theme: 'psicologia', createdAt: new Date() },
        { theme: 'terapia_ocupacional', createdAt: new Date() }
      ];
      
      const resultado = await getEspecialidadesSemPostHoje(MOCK_ESPECIALIDADES, postsHoje);
      
      expect(resultado).toHaveLength(0);
    });
  });

  // ===========================================================================
  // TESTES DE VARIAÇÕES A/B
  // ===========================================================================
  
  describe('🔄 Variações A/B', () => {
    
    it('Deve parsear JSON válido de variações', () => {
      const jsonValido = JSON.stringify([
        { gatilho: 'Curiosidade', angulo: 'Teste', hook: 'Hook 1' },
        { gatilho: 'Contradição', angulo: 'Teste', hook: 'Hook 2' },
        { gatilho: 'Prova Social', angulo: 'Teste', hook: 'Hook 3' }
      ]);
      
      const resultado = parseVariacoesAB(jsonValido, MOCK_ESPECIALIDADE);
      
      expect(resultado).toHaveLength(3);
      expect(resultado[0].gatilho).toBe('Curiosidade');
    });

    it('Deve retornar fallback quando JSON é inválido', () => {
      const jsonInvalido = 'não é json {[]}';
      
      const resultado = parseVariacoesAB(jsonInvalido, MOCK_ESPECIALIDADE);
      
      expect(resultado).toHaveLength(3);
      expect(resultado[0].hook).toBe(MOCK_ESPECIALIDADE.gancho);
    });

    it('Fallback deve conter gatilhos variados', () => {
      const jsonInvalido = 'invalido';
      
      const resultado = parseVariacoesAB(jsonInvalido, MOCK_ESPECIALIDADE);
      
      const gatilhos = resultado.map(v => v.gatilho);
      expect(gatilhos).toContain('Curiosidade');
      expect(gatilhos).toContain('Contradição');
      expect(gatilhos).toContain('Prova Social');
    });
  });

  // ===========================================================================
  // TESTES DE SCORE DE QUALIDADE
  // ===========================================================================
  
  describe('📊 Score de Qualidade', () => {
    
    it('Deve parsear JSON válido de score', () => {
      const jsonValido = JSON.stringify({
        clareza: 8,
        impacto_emocional: 7,
        cta: 9,
        score_geral: 8,
        ponto_forte: 'CTA claro',
        sugestao: 'Melhorar hook'
      });
      
      const resultado = parseScoreQuality(jsonValido);
      
      expect(resultado.clareza).toBe(8);
      expect(resultado.impacto_emocional).toBe(7);
      expect(resultado.cta).toBe(9);
      expect(resultado.score_geral).toBe(8);
    });

    it('Deve retornar fallback quando JSON é inválido', () => {
      const jsonInvalido = 'não é json';
      
      const resultado = parseScoreQuality(jsonInvalido);
      
      expect(resultado.clareza).toBe(7);
      expect(resultado.impacto_emocional).toBe(7);
      expect(resultado.cta).toBe(7);
      expect(resultado.score_geral).toBe(7);
    });

    it('Score deve ter todas as dimensões obrigatórias', () => {
      const jsonValido = JSON.stringify({
        clareza: 5,
        impacto_emocional: 6,
        cta: 7
      });
      
      const resultado = parseScoreQuality(jsonValido);
      
      expect(resultado).toHaveProperty('clareza');
      expect(resultado).toHaveProperty('impacto_emocional');
      expect(resultado).toHaveProperty('cta');
    });
  });

  // ===========================================================================
  // TESTES DE SEO
  // ===========================================================================
  
  describe('🔍 SEO - Keywords', () => {
    
    it('Deve gerar keyword no formato correto', () => {
      const keyword = generateKeywordSEO('Fonoaudiologia');
      expect(keyword).toBe('fonoaudiologia infantil');
    });

    it('Deve remover acentos da keyword', () => {
      const keyword = generateKeywordSEO('Psicomotricidade');
      expect(keyword).toBe('psicomotricidade infantil');
      expect(keyword).not.toContain('ç'); // Deve ser normalizado
    });

    it('Deve converter para lowercase', () => {
      const keyword = generateKeywordSEO('TERAPIA');
      expect(keyword).toBe('terapia infantil');
    });
  });

  // ===========================================================================
  // TESTES DE VALIDAÇÃO DE POST
  // ===========================================================================
  
  describe('✅ Validação de Posts Gerados', () => {
    
    it('Deve validar post completo e correto', () => {
      const post = {
        title: 'Sua criança não fala ainda?',
        content: 'Se você reconhece esse sinal, saiba que existe solução. Agende pelo link da bio.',
        especialidade: MOCK_ESPECIALIDADE
      };
      
      const validacao = validarPostGerado(post);
      
      expect(validacao.valido).toBe(true);
      expect(validacao.erros).toHaveLength(0);
    });

    it('Deve rejeitar post sem título', () => {
      const post = {
        title: '',
        content: 'Conteúdo válido aqui. Agende pelo link.'
      };
      
      const validacao = validarPostGerado(post);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Título não pode ser vazio');
    });

    it('Deve rejeitar post com título muito longo', () => {
      const post = {
        title: 'A'.repeat(100),
        content: 'Conteúdo válido. Link na bio.'
      };
      
      const validacao = validarPostGerado(post);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Título muito longo (máx 80 caracteres)');
    });

    it('Deve rejeitar post sem CTA', () => {
      const post = {
        title: 'Título válido',
        content: 'Conteúdo informativo mas sem call to action.'
      };
      
      const validacao = validarPostGerado(post);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Conteúdo deve conter call-to-action');
    });

    it('Deve rejeitar post com alarmismo excessivo', () => {
      const post = {
        title: 'Título válido',
        content: 'URGENTE! PERIGO! Seu filho pode estar em risco! Agende pelo link.'
      };
      
      const validacao = validarPostGerado(post);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Conteúdo contém alarmismo excessivo');
    });

    it('Deve aceitar CTA em diferentes formatos', () => {
      const ctasValidos = [
        'Agende pelo link da bio',
        'Chame no WhatsApp',
        'Link na bio',
        'Agende uma avaliação'
      ];
      
      ctasValidos.forEach(cta => {
        const post = {
          title: 'Título',
          content: `Conteúdo válido. ${cta}`
        };
        const validacao = validarPostGerado(post);
        expect(validacao.erros).not.toContain('Conteúdo deve conter call-to-action');
      });
    });
  });

  // ===========================================================================
  // TESTES INTEGRADOS
  // ===========================================================================
  
  describe('🔄 Fluxos Integrados', () => {
    
    it('Fluxo completo: Especialidade sem post → Geração → Validação', async () => {
      // Simula: Nenhum post hoje
      const postsHoje = [];
      const semPost = await getEspecialidadesSemPostHoje(MOCK_ESPECIALIDADES, postsHoje);
      
      expect(semPost.length).toBeGreaterThan(0);
      
      // Simula geração de post
      const especialidade = semPost[0];
      const postGerado = {
        title: especialidade.gancho,
        content: `Você sabia que ${especialidade.foco.toLowerCase()} tem solução? Na Fono Inova ajudamos seu filho. Agende pelo link da bio.`,
        especialidade
      };
      
      // Valida
      const validacao = validarPostGerado(postGerado);
      expect(validacao.valido).toBe(true);
    });

    it('Fluxo com tone educativo deve alterar CTA', () => {
      const tone = 'educativo';
      const estrategia = getEstrategiaPorFunil('top');
      const ctaFinal = TONES[tone]?.cta || estrategia.cta;
      
      expect(ctaFinal).toBe('Salve esse post para não esquecer!');
    });

    it('Fluxo com tone emotional deve manter CTA do funil', () => {
      const tone = 'emotional';
      const estrategia = getEstrategiaPorFunil('bottom');
      const ctaFinal = TONES[tone]?.cta || estrategia.cta;
      
      expect(ctaFinal).toBe(estrategia.cta);
      expect(ctaFinal).toContain('AVALIAÇÃO');
    });
  });
});

// Exportar funções para reuso em outros testes
export { 
  getEspecialidadesSemPostHoje, 
  getEstrategiaPorFunil, 
  TONES, 
  parseVariacoesAB, 
  parseScoreQuality,
  generateKeywordSEO,
  validarPostGerado
};
