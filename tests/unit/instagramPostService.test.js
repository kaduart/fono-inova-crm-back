/**
 * 📸 Testes Unitários - Instagram Post Service
 * 
 * Cobre:
 * - Geração de headlines (máx 6 palavras, 30 caracteres)
 * - Geração de legendas estruturadas
 * - Validação de prompts para imagem
 * - Fallbacks quando APIs falham
 */

import { describe, it, expect, vi } from 'vitest';

// =============================================================================
// MOCKS
// =============================================================================

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: vi.fn()
      }
    }
  }))
}));

// =============================================================================
// CONSTANTES E DADOS DE TESTE
// =============================================================================

const MOCK_ESPECIALIDADE = {
  id: 'fonoaudiologia',
  nome: 'Fonoaudiologia',
  foco: 'Fala, linguagem, pronúncia, gagueira',
  publico: 'crianças com dificuldades de comunicação',
  gancho: 'Sua criança não fala ainda?'
};

const HEADLINES_FUNIL = {
  top: [
    'Seu filho ainda não fala?',
    'Sua criança evita socializar?',
    'Atraso na fala?'
  ],
  middle: [
    'Como funciona a avaliação?',
    'Benefícios da terapia',
    'O que esperar?'
  ],
  bottom: [
    'Agende sua avaliação',
    'Vagas para essa semana',
    'Comece o tratamento'
  ]
};

// =============================================================================
// FUNÇÕES DE TESTE ISOLADAS
// =============================================================================

/**
 * ✅ Valida headline (regras de negócio)
 */
function validarHeadline(headline) {
  const erros = [];
  const palavras = headline.trim().split(/\s+/);
  
  // Máximo 6 palavras
  if (palavras.length > 6) {
    erros.push(`Headline tem ${palavras.length} palavras (máx 6)`);
  }
  
  // Máximo 30 caracteres
  if (headline.length > 30) {
    erros.push(`Headline tem ${headline.length} caracteres (máx 30)`);
  }
  
  // Deve ter conteúdo
  if (headline.trim().length === 0) {
    erros.push('Headline vazia');
  }
  
  // Não deve ter emojis
  const regexEmoji = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/u;
  if (regexEmoji.test(headline)) {
    erros.push('Headline não deve conter emojis');
  }
  
  return {
    valido: erros.length === 0,
    erros,
    palavras: palavras.length,
    caracteres: headline.length
  };
}

/**
 * 📋 Fallback de headline por template
 */
function getHeadlineFallback(especialidade, funnelStage) {
  const templates = HEADLINES_FUNIL[funnelStage] || HEADLINES_FUNIL.top;
  const index = especialidade.nome.length % templates.length;
  return templates[index];
}

/**
 * ✅ Valida legenda Instagram
 */
function validarLegenda(legenda, especialidade) {
  const erros = [];
  const avisos = [];
  
  if (!legenda || legenda.trim().length === 0) {
    erros.push('Legenda vazia');
    return { valido: false, erros, avisos };
  }
  
  // Deve conter nome da clínica
  if (!legenda.includes('Fono Inova')) {
    avisos.push('Legenda não menciona Fono Inova');
  }
  
  // Deve conter localização
  if (!legenda.includes('Anápolis')) {
    avisos.push('Legenda não menciona Anápolis');
  }
  
  // Deve ter CTA
  const temCTA = /link|bio|whatsapp|agende|chame/i.test(legenda);
  if (!temCTA) {
    erros.push('Legenda deve conter call-to-action');
  }
  
  // Deve ter hashtags
  if (!legenda.includes('#')) {
    avisos.push('Legenda não contém hashtags');
  }
  
  // Não deve usar frases proibidas
  const frasesProibidas = ['Conheça nosso trabalho', 'venha nos conhecer'];
  frasesProibidas.forEach(frase => {
    if (legenda.toLowerCase().includes(frase.toLowerCase())) {
      erros.push(`Legenda usa frase proibida: "${frase}"`);
    }
  });
  
  // Deve ter pelo menos 100 caracteres (legenda curta demais pode ser spam)
  if (legenda.length < 100) {
    avisos.push('Legenda muito curta (menos de 100 caracteres)');
  }
  
  // Máximo 2200 caracteres (limite do Instagram)
  if (legenda.length > 2200) {
    erros.push('Legenda excede limite do Instagram (2200 caracteres)');
  }
  
  return {
    valido: erros.length === 0,
    erros,
    avisos,
    caracteres: legenda.length,
    paragrafos: legenda.split('\n\n').filter(p => p.trim()).length
  };
}

/**
 * 📝 Gera legenda fallback
 */
function gerarLegendaFallback(especialidade, headline) {
  return `${headline}\n\n${especialidade.foco}.\n\nNa Fono Inova, em Anápolis, ajudamos seu filho a desenvolver todo seu potencial.\n\nAgende pelo link da bio.\n\n💚 Fono Inova | Anápolis/GO\n#${especialidade.id} #anapolis`;
}

/**
 * 🎨 Valida prompt de imagem
 */
function validarPromptImagem(prompt, especialidade) {
  const erros = [];
  const requisitos = [];
  const avisos = [];
  
  if (!prompt || prompt.length < 50) {
    erros.push('Prompt muito curto');
    return { valido: false, erros, requisitos, avisos, temEstiloFoto: false, temPessoas: false, temAmbiente: false, temLuz: false };
  }
  
  const promptLower = prompt.toLowerCase();
  
  // Deve mencionar a especialidade
  if (!promptLower.includes(especialidade.id.toLowerCase()) && 
      !promptLower.includes(especialidade.nome.toLowerCase())) {
    avisos.push('Prompt não menciona explicitamente a especialidade');
  }
  
  // Deve ter estilo fotográfico
  const estilosFoto = ['photo', 'photography', 'cinematic', 'photorealistic', 'shot on'];
  const temEstiloFoto = estilosFoto.some(estilo => promptLower.includes(estilo));
  if (!temEstiloFoto) {
    requisitos.push('Adicionar estilo fotográfico (photo, cinematic)');
  }
  
  // Deve ter descrição de pessoas
  const elementosPessoas = ['therapist', 'child', 'criança', 'terapeuta', 'paciente'];
  const temPessoas = elementosPessoas.some(el => promptLower.includes(el));
  if (!temPessoas) {
    requisitos.push('Adicionar descrição de terapeuta e criança');
  }
  
  // Deve ter ambiente
  const elementosAmbiente = ['clinic', 'room', 'sala', 'ambiente', 'consultório'];
  const temAmbiente = elementosAmbiente.some(el => promptLower.includes(el));
  if (!temAmbiente) {
    requisitos.push('Adicionar descrição do ambiente');
  }
  
  // Deve ter iluminação
  const elementosLuz = ['light', 'luz', 'lighting', 'natural'];
  const temLuz = elementosLuz.some(el => promptLower.includes(el));
  if (!temLuz) {
    requisitos.push('Adicionar descrição de iluminação');
  }
  
  // Negative prompts importantes
  const negativePromptsNecessarios = ['cartoon', 'illustration', 'anime', 'drawing'];
  
  return {
    valido: erros.length === 0,
    erros,
    requisitos,
    comprimento: prompt.length,
    temEstiloFoto,
    temPessoas,
    temAmbiente,
    temLuz
  };
}

/**
 * 🔍 Extrai tema específico do post
 */
function extrairTemaParaPrompt(postContent, especialidadeId) {
  if (!postContent) return null;
  
  const conteudo = postContent.toLowerCase();
  
  const temas = {
    'fonoaudiologia': [
      { keywords: ['troca', 'errinho'], tema: 'troca_letra' },
      { keywords: ['gagueira', 'fluência', 'travar'], tema: 'gagueira' },
      { keywords: ['mamar', 'amamentação'], tema: 'amamentacao' }
    ],
    'psicologia': [
      { keywords: ['ansiedade', 'medo', 'preocupação'], tema: 'ansiedade' },
      { keywords: ['comportamento', 'agressivo', 'birra'], tema: 'comportamento' }
    ]
  };
  
  const temasEspecialidade = temas[especialidadeId] || [];
  
  for (const item of temasEspecialidade) {
    if (item.keywords.some(kw => conteudo.includes(kw))) {
      return item.tema;
    }
  }
  
  return null;
}

// =============================================================================
// TESTES
// =============================================================================

describe('📸 Instagram Post Service', () => {

  // ===========================================================================
  // TESTES DE HEADLINE
  // ===========================================================================
  
  describe('🎯 Headlines', () => {
    
    it('Deve validar headline com 6 palavras ou menos', () => {
      const headline = 'Seu filho ainda não fala?';
      const validacao = validarHeadline(headline);
      
      expect(validacao.valido).toBe(true);
      expect(validacao.palavras).toBeLessThanOrEqual(6);
    });

    it('Deve rejeitar headline com mais de 6 palavras', () => {
      const headline = 'Seu filho ainda não fala corretamente hoje';
      const validacao = validarHeadline(headline);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.palavras).toBeGreaterThan(6);
      expect(validacao.erros.length).toBeGreaterThan(0);
    });

    it('Deve validar headline com até 30 caracteres', () => {
      const headline = 'Atraso na fala?';
      const validacao = validarHeadline(headline);
      
      expect(validacao.valido).toBe(true);
      expect(validacao.caracteres).toBeLessThanOrEqual(30);
    });

    it('Deve rejeitar headline com mais de 30 caracteres', () => {
      const headline = 'Sua criança tem dificuldade para falar?';
      const validacao = validarHeadline(headline);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.caracteres).toBeGreaterThan(30);
      expect(validacao.erros.length).toBeGreaterThan(0);
    });

    it('Deve rejeitar headline com emojis', () => {
      const headline = 'Seu filho não fala 😢';
      const validacao = validarHeadline(headline);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Headline não deve conter emojis');
    });

    it('Deve aceitar headline sem emojis', () => {
      const headline = 'Seu filho ainda não fala?';
      const validacao = validarHeadline(headline);
      
      expect(validacao.erros).not.toContain('Headline não deve conter emojis');
    });

    it('Deve rejeitar headline vazia', () => {
      const headline = '';
      const validacao = validarHeadline(headline);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Headline vazia');
    });

    it('Deve retornar fallback correto por funil', () => {
      const fallbackTop = getHeadlineFallback(MOCK_ESPECIALIDADE, 'top');
      expect(HEADLINES_FUNIL.top).toContain(fallbackTop);
      
      const fallbackMiddle = getHeadlineFallback(MOCK_ESPECIALIDADE, 'middle');
      expect(HEADLINES_FUNIL.middle).toContain(fallbackMiddle);
      
      const fallbackBottom = getHeadlineFallback(MOCK_ESPECIALIDADE, 'bottom');
      expect(HEADLINES_FUNIL.bottom).toContain(fallbackBottom);
    });

    it('Deve retornar fallback do funil TOP quando funil é inválido', () => {
      const fallback = getHeadlineFallback(MOCK_ESPECIALIDADE, 'invalido');
      expect(HEADLINES_FUNIL.top).toContain(fallback);
    });
  });

  // ===========================================================================
  // TESTES DE LEGENDA
  // ===========================================================================
  
  describe('📝 Legendas', () => {
    
    it('Deve validar legenda completa e correta', () => {
      const legenda = `Seu filho ainda não fala?

Isso pode ser sinal de atraso na fala. Na Fono Inova, em Anápolis, nossos especialistas em fonoaudiologia infantil ajudam crianças a desenvolverem sua comunicação.

Agende pelo link da bio 👆

💚 Fono Inova | Anápolis/GO
#fonoaudiologia #anapolis`;
      
      const validacao = validarLegenda(legenda, MOCK_ESPECIALIDADE);
      
      expect(validacao.valido).toBe(true);
      expect(validacao.erros).toHaveLength(0);
    });

    it('Deve rejeitar legenda sem CTA', () => {
      const legenda = `Seu filho ainda não fala?

Isso pode ser sinal de atraso na fala. Na Fono Inova, em Anápolis, ajudamos crianças.

💚 Fono Inova | Anápolis/GO`;
      
      const validacao = validarLegenda(legenda, MOCK_ESPECIALIDADE);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Legenda deve conter call-to-action');
    });

    it('Deve alertar quando não menciona Fono Inova', () => {
      const legenda = `Seu filho ainda não fala?

Isso pode ser sinal de atraso.

Agende pelo link da bio.

#fonoaudiologia`;
      
      const validacao = validarLegenda(legenda, MOCK_ESPECIALIDADE);
      
      expect(validacao.avisos).toContain('Legenda não menciona Fono Inova');
    });

    it('Deve alertar quando não menciona Anápolis', () => {
      const legenda = `Seu filho ainda não fala?

Isso pode ser sinal de atraso na fala. Na Fono Inova, ajudamos crianças.

Agende pelo link da bio.

💚 Fono Inova`;
      
      const validacao = validarLegenda(legenda, MOCK_ESPECIALIDADE);
      
      expect(validacao.avisos).toContain('Legenda não menciona Anápolis');
    });

    it('Deve alertar quando não tem hashtags', () => {
      const legenda = `Seu filho ainda não fala?

Isso pode ser sinal de atraso na fala. Na Fono Inova, em Anápolis, ajudamos crianças.

Agende pelo link da bio.

💚 Fono Inova | Anápolis/GO`;
      
      const validacao = validarLegenda(legenda, MOCK_ESPECIALIDADE);
      
      expect(validacao.avisos).toContain('Legenda não contém hashtags');
    });

    it('Deve rejeitar legenda com frases proibidas', () => {
      const legenda = `Conheça nosso trabalho

Na Fono Inova, em Anápolis, ajudamos crianças.

Agende pelo link da bio.

💚 Fono Inova | Anápolis/GO`;
      
      const validacao = validarLegenda(legenda, MOCK_ESPECIALIDADE);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros.some(e => e.includes('Conheça nosso trabalho'))).toBe(true);
    });

    it('Deve gerar legenda fallback completa', () => {
      const headline = 'Seu filho ainda não fala?';
      const legenda = gerarLegendaFallback(MOCK_ESPECIALIDADE, headline);
      
      expect(legenda).toContain(headline);
      expect(legenda).toContain('Fono Inova');
      expect(legenda).toContain('Anápolis');
      expect(legenda).toContain('#fonoaudiologia');
      expect(legenda).toContain('link da bio');
    });

    it('Deve contar parágrafos corretamente', () => {
      const legenda = `Parágrafo 1

Parágrafo 2

Parágrafo 3`;
      
      const validacao = validarLegenda(legenda, MOCK_ESPECIALIDADE);
      
      expect(validacao.paragrafos).toBe(3);
    });

    it('Deve rejeitar legenda vazia', () => {
      const legenda = '';
      const validacao = validarLegenda(legenda, MOCK_ESPECIALIDADE);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Legenda vazia');
    });
  });

  // ===========================================================================
  // TESTES DE PROMPT DE IMAGEM
  // ===========================================================================
  
  describe('🎨 Prompts de Imagem', () => {
    
    it('Deve validar prompt fotográfico completo', () => {
      const prompt = `Cinematic photo, professional pediatric therapy session, therapist and child facing each other, bright Fono Inova clinic with natural window light`;
      
      const validacao = validarPromptImagem(prompt, MOCK_ESPECIALIDADE);
      
      expect(validacao.valido).toBe(true);
      expect(validacao.temEstiloFoto).toBe(true);
    });

    it('Deve detectar falta de estilo fotográfico', () => {
      const prompt = `Professional scene showing therapist and child together in bright clinic with natural window light`;
      
      const validacao = validarPromptImagem(prompt, MOCK_ESPECIALIDADE);
      
      expect(validacao.temEstiloFoto).toBe(false);
      expect(validacao.requisitos).toContain('Adicionar estilo fotográfico (photo, cinematic)');
    });

    it('Deve detectar falta de descrição de pessoas', () => {
      const prompt = `Cinematic professional photograph with soft natural lighting, modern medical facility interior design`;
      
      const validacao = validarPromptImagem(prompt, MOCK_ESPECIALIDADE);
      
      expect(validacao.temPessoas).toBe(false);
      expect(validacao.requisitos).toContain('Adicionar descrição de terapeuta e criança');
    });

    it('Deve detectar falta de ambiente', () => {
      const prompt = `Cinematic professional photograph of female therapist with young patient, soft natural lighting`;
      
      const validacao = validarPromptImagem(prompt, MOCK_ESPECIALIDADE);
      
      expect(validacao.temAmbiente).toBe(false);
      expect(validacao.requisitos).toContain('Adicionar descrição do ambiente');
    });

    it('Deve detectar falta de iluminação', () => {
      const prompt = `Cinematic photo of therapist and child in clinic room`;
      
      const validacao = validarPromptImagem(prompt, MOCK_ESPECIALIDADE);
      
      expect(validacao.temLuz).toBe(false);
      expect(validacao.requisitos).toContain('Adicionar descrição de iluminação');
    });

    it('Deve rejeitar prompt muito curto', () => {
      const prompt = 'Photo of clinic';
      const validacao = validarPromptImagem(prompt, MOCK_ESPECIALIDADE);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Prompt muito curto');
    });
  });

  // ===========================================================================
  // TESTES DE EXTRAÇÃO DE TEMA
  // ===========================================================================
  
  describe('🔍 Extração de Tema', () => {
    
    it('Deve extrair tema de troca de letras', () => {
      const conteudo = 'Seu filho troca a letra R pelo L?';
      const tema = extrairTemaParaPrompt(conteudo, 'fonoaudiologia');
      
      expect(tema).toBe('troca_letra');
    });

    it('Deve extrair tema de gagueira', () => {
      const conteudo = 'Seu filho tem dificuldade de fluência e gagueja?';
      const tema = extrairTemaParaPrompt(conteudo, 'fonoaudiologia');
      
      expect(tema).toBe('gagueira');
    });

    it('Deve extrair tema de ansiedade', () => {
      const conteudo = 'Seu filho tem ansiedade e medo excessivo?';
      const tema = extrairTemaParaPrompt(conteudo, 'psicologia');
      
      expect(tema).toBe('ansiedade');
    });

    it('Deve retornar null quando não encontra tema', () => {
      const conteudo = 'Texto genérico sem tema específico';
      const tema = extrairTemaParaPrompt(conteudo, 'fonoaudiologia');
      
      expect(tema).toBeNull();
    });

    it('Deve retornar null quando especialidade não tem mapeamento', () => {
      const conteudo = 'Texto qualquer';
      const tema = extrairTemaParaPrompt(conteudo, 'especialidade_desconhecida');
      
      expect(tema).toBeNull();
    });

    it('Deve retornar null quando conteúdo é vazio', () => {
      const tema = extrairTemaParaPrompt(null, 'fonoaudiologia');
      expect(tema).toBeNull();
    });
  });

  // ===========================================================================
  // TESTES INTEGRADOS
  // ===========================================================================
  
  describe('🔄 Fluxos Integrados', () => {
    
    it('Fluxo completo: Headline → Legenda → Validação', () => {
      // Gera headline
      const headline = 'Seu filho ainda não fala?';
      const validacaoHeadline = validarHeadline(headline);
      expect(validacaoHeadline.valido).toBe(true);
      
      // Gera legenda
      const legenda = gerarLegendaFallback(MOCK_ESPECIALIDADE, headline);
      
      // Valida legenda
      const validacaoLegenda = validarLegenda(legenda, MOCK_ESPECIALIDADE);
      expect(validacaoLegenda.valido).toBe(true);
      
      // Verifica integração
      expect(legenda).toContain(headline);
      expect(legenda).toContain(MOCK_ESPECIALIDADE.foco);
    });

    it('Deve lidar com falha de API usando fallbacks', () => {
      // Simula falha na API (retorna null/undefined)
      const headlineFallback = getHeadlineFallback(MOCK_ESPECIALIDADE, 'top');
      
      // Fallback deve ser válido
      const validacao = validarHeadline(headlineFallback);
      expect(validacao.valido).toBe(true);
    });
  });
});

// Exportar funções para reuso
export {
  validarHeadline,
  getHeadlineFallback,
  validarLegenda,
  gerarLegendaFallback,
  validarPromptImagem,
  extrairTemaParaPrompt,
  HEADLINES_FUNIL
};
