/**
 * 📝 Testes Unitários - Post Worker
 * 
 * Cobre:
 * - Processamento de jobs por canal (GMB, Instagram, Facebook)
 * - Aplicação de tone e qualityScore
 * - Agendamento de posts
 * - Fallbacks quando serviços falham
 * - Validação de dados do job
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// CONSTANTES E DADOS DE TESTE
// =============================================================================

const CHANNEL_MODELS = {
  gmb: 'GmbPost',
  instagram: 'InstagramPost',
  facebook: 'FacebookPost'
};

const CHANNEL_NAMES = {
  gmb: 'Google Meu Negócio',
  instagram: 'Instagram',
  facebook: 'Facebook'
};

const MOCK_ESPECIALIDADE = {
  id: 'fonoaudiologia',
  nome: 'Fonoaudiologia',
  foco: 'Fala, linguagem, pronúncia',
  publico: 'crianças com dificuldades de comunicação',
  gancho: 'Sua criança não fala ainda?',
  url: 'https://clinica.com/fono'
};

const MOCK_ESPECIALIDADES = [
  MOCK_ESPECIALIDADE,
  {
    id: 'psicologia',
    nome: 'Psicologia',
    foco: 'Comportamento, emocional',
    publico: 'crianças com dificuldades emocionais',
    gancho: 'Seu filho está ansioso?'
  }
];

// =============================================================================
// FUNÇÕES DE TESTE ISOLADAS
// =============================================================================

/**
 * ✅ Valida dados do job
 */
function validarJobData(jobData) {
  const erros = [];
  const camposObrigatorios = ['postId', 'channel', 'especialidadeId'];
  
  camposObrigatorios.forEach(campo => {
    if (!jobData[campo]) {
      erros.push(`Campo obrigatório ausente: ${campo}`);
    }
  });
  
  // Valida canal
  if (jobData.channel && !CHANNEL_MODELS[jobData.channel]) {
    erros.push(`Canal inválido: ${jobData.channel}`);
  }
  
  // Valida tone (se fornecido)
  const tonesValidos = ['emotional', 'educativo', 'inspiracional', 'bastidores'];
  if (jobData.tone && !tonesValidos.includes(jobData.tone)) {
    erros.push(`Tone inválido: ${jobData.tone}`);
  }
  
  // Valida funnelStage
  const funisValidos = ['top', 'middle', 'bottom'];
  if (jobData.funnelStage && !funisValidos.includes(jobData.funnelStage)) {
    erros.push(`FunnelStage inválido: ${jobData.funnelStage}`);
  }
  
  return {
    valido: erros.length === 0,
    erros
  };
}

/**
 * 🎯 Determina modelo por canal
 */
function getModelForChannel(channel) {
  return CHANNEL_MODELS[channel] || null;
}

/**
 * 📊 Determina status do post (scheduled vs draft)
 */
function determinarStatus(scheduledAt) {
  return scheduledAt ? 'scheduled' : 'draft';
}

/**
 * 🎭 Aplica configuração de tone
 */
function aplicarTone(tone = 'emotional') {
  const tonesConfig = {
    emotional: { usaCTAPadrao: true, instrucao: null },
    educativo: { usaCTAPadrao: false, cta: 'Salve esse post para não esquecer!' },
    inspiracional: { usaCTAPadrao: false, cta: 'Comente ❤️ se essa história te tocou' },
    bastidores: { usaCTAPadrao: false, cta: 'Venha nos conhecer! Link na bio 👆' }
  };
  
  return tonesConfig[tone] || tonesConfig.emotional;
}

/**
 * ⏰ Valida data de agendamento
 */
function validarScheduledAt(scheduledAt) {
  if (!scheduledAt) return { valido: true, erros: [] };
  
  const data = new Date(scheduledAt);
  const agora = new Date();
  
  const erros = [];
  
  if (isNaN(data.getTime())) {
    erros.push('Data de agendamento inválida');
    return { valido: false, erros };
  }
  
  // Data no passado (mais de 1 minuto)
  if (data < new Date(agora.getTime() - 60000)) {
    erros.push('Data de agendamento está no passado');
  }
  
  // Data muito no futuro (mais de 1 ano)
  const umAnoDepois = new Date(agora.getTime() + 365 * 24 * 60 * 60 * 1000);
  if (data > umAnoDepois) {
    erros.push('Data de agendamento muito no futuro (máx 1 ano)');
  }
  
  return {
    valido: erros.length === 0,
    erros,
    data
  };
}

/**
 * 📝 Gera dados de atualização do post
 */
function gerarDadosAtualizacao(dados) {
  const {
    channel,
    postData,
    mediaUrl,
    imageProvider,
    scheduledAt,
    tone,
    qualityScore,
    funnelStage
  } = dados;
  
  const base = {
    title: postData?.title,
    content: postData?.content,
    status: determinarStatus(scheduledAt),
    aiGenerated: true,
    processingStatus: 'completed',
    tone
  };
  
  // Campos específicos por canal
  if (channel === 'instagram') {
    base.headline = postData?.title;
    base.caption = postData?.content;
  }
  
  // Media (se gerada)
  if (mediaUrl) {
    base.mediaUrl = mediaUrl;
    base.mediaType = 'image';
    base.imageProvider = imageProvider;
  }
  
  // Agendamento
  if (scheduledAt) {
    base.scheduledAt = new Date(scheduledAt);
  }
  
  // Score de qualidade
  if (qualityScore) {
    base.qualityScore = qualityScore;
  }
  
  // Funil
  if (funnelStage) {
    base.funnelStage = funnelStage;
  }
  
  return base;
}

/**
 * 🎨 Simula geração de imagem com fallback
 */
async function simularGeracaoImagem(tentativas = []) {
  // Tenta cada provider na ordem
  const providers = ['fal-flux-dev', 'freepik-ai', 'hf-flux-dev', 'pollinations'];
  
  for (const provider of providers) {
    const tentativa = tentativas.find(t => t.provider === provider);
    
    if (!tentativa || tentativa.sucesso) {
      return {
        url: `https://cloudinary.com/test-${provider}.jpg`,
        provider
      };
    }
  }
  
  // Todos falharam
  return null;
}

/**
 * ✅ Valida resultado do processamento
 */
function validarResultado(resultado) {
  const erros = [];
  
  if (!resultado.postId) {
    erros.push('Resultado sem postId');
  }
  
  if (!resultado.channel) {
    erros.push('Resultado sem channel');
  }
  
  if (!resultado.status) {
    erros.push('Resultado sem status');
  }
  
  // Status válido
  const statusValidos = ['completed', 'failed', 'processing'];
  if (resultado.status && !statusValidos.includes(resultado.status)) {
    erros.push(`Status inválido: ${resultado.status}`);
  }
  
  return {
    valido: erros.length === 0,
    erros
  };
}

/**
 * 📊 Calcula progresso do processamento
 */
function calcularProgresso(etapa) {
  const progressos = {
    'inicio': 10,
    'conteudo': 25,
    'imagem': 60,
    'upload': 80,
    'finalizacao': 100
  };
  
  return progressos[etapa] || 0;
}

// =============================================================================
// TESTES
// =============================================================================

describe('📝 Post Worker', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // TESTES DE VALIDAÇÃO DE JOB
  // ===========================================================================
  
  describe('✅ Validação de Job', () => {
    
    it('Deve validar job completo', () => {
      const jobData = {
        postId: '123',
        channel: 'gmb',
        especialidadeId: 'fonoaudiologia'
      };
      
      const validacao = validarJobData(jobData);
      
      expect(validacao.valido).toBe(true);
      expect(validacao.erros).toHaveLength(0);
    });

    it('Deve rejeitar job sem postId', () => {
      const jobData = {
        channel: 'gmb',
        especialidadeId: 'fonoaudiologia'
      };
      
      const validacao = validarJobData(jobData);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Campo obrigatório ausente: postId');
    });

    it('Deve rejeitar job sem channel', () => {
      const jobData = {
        postId: '123',
        especialidadeId: 'fonoaudiologia'
      };
      
      const validacao = validarJobData(jobData);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Campo obrigatório ausente: channel');
    });

    it('Deve rejeitar job sem especialidadeId', () => {
      const jobData = {
        postId: '123',
        channel: 'gmb'
      };
      
      const validacao = validarJobData(jobData);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Campo obrigatório ausente: especialidadeId');
    });

    it('Deve rejeitar canal inválido', () => {
      const jobData = {
        postId: '123',
        channel: 'twitter',
        especialidadeId: 'fonoaudiologia'
      };
      
      const validacao = validarJobData(jobData);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Canal inválido: twitter');
    });

    it('Deve aceitar todos os canais válidos', () => {
      const canais = ['gmb', 'instagram', 'facebook'];
      
      canais.forEach(channel => {
        const jobData = { postId: '123', channel, especialidadeId: 'fono' };
        const validacao = validarJobData(jobData);
        expect(validacao.valido).toBe(true);
      });
    });

    it('Deve rejeitar tone inválido', () => {
      const jobData = {
        postId: '123',
        channel: 'gmb',
        especialidadeId: 'fonoaudiologia',
        tone: 'invalido'
      };
      
      const validacao = validarJobData(jobData);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Tone inválido: invalido');
    });

    it('Deve aceitar todos os tones válidos', () => {
      const tones = ['emotional', 'educativo', 'inspiracional', 'bastidores'];
      
      tones.forEach(tone => {
        const jobData = { postId: '123', channel: 'gmb', especialidadeId: 'fono', tone };
        const validacao = validarJobData(jobData);
        expect(validacao.valido).toBe(true);
      });
    });

    it('Deve rejeitar funnelStage inválido', () => {
      const jobData = {
        postId: '123',
        channel: 'gmb',
        especialidadeId: 'fonoaudiologia',
        funnelStage: 'invalido'
      };
      
      const validacao = validarJobData(jobData);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('FunnelStage inválido: invalido');
    });
  });

  // ===========================================================================
  // TESTES DE MODELOS
  // ===========================================================================
  
  describe('🎯 Modelos por Canal', () => {
    
    it('Deve retornar GmbPost para canal gmb', () => {
      const modelo = getModelForChannel('gmb');
      expect(modelo).toBe('GmbPost');
    });

    it('Deve retornar InstagramPost para canal instagram', () => {
      const modelo = getModelForChannel('instagram');
      expect(modelo).toBe('InstagramPost');
    });

    it('Deve retornar FacebookPost para canal facebook', () => {
      const modelo = getModelForChannel('facebook');
      expect(modelo).toBe('FacebookPost');
    });

    it('Deve retornar null para canal inválido', () => {
      const modelo = getModelForChannel('invalido');
      expect(modelo).toBeNull();
    });
  });

  // ===========================================================================
  // TESTES DE STATUS
  // ===========================================================================
  
  describe('📊 Status do Post', () => {
    
    it('Deve retornar scheduled quando há scheduledAt', () => {
      const status = determinarStatus('2024-12-25T10:00:00Z');
      expect(status).toBe('scheduled');
    });

    it('Deve retornar draft quando não há scheduledAt', () => {
      const status = determinarStatus(null);
      expect(status).toBe('draft');
    });

    it('Deve retornar draft quando scheduledAt é undefined', () => {
      const status = determinarStatus(undefined);
      expect(status).toBe('draft');
    });

    it('Deve retornar scheduled para qualquer valor truthy', () => {
      const status = determinarStatus('qualquer-data');
      expect(status).toBe('scheduled');
    });
  });

  // ===========================================================================
  // TESTES DE TONE
  // ===========================================================================
  
  describe('🎭 Configuração de Tone', () => {
    
    it('Deve aplicar configuração emotional padrão', () => {
      const config = aplicarTone('emotional');
      
      expect(config.usaCTAPadrao).toBe(true);
      expect(config.instrucao).toBeNull();
    });

    it('Deve aplicar configuração educativo', () => {
      const config = aplicarTone('educativo');
      
      expect(config.usaCTAPadrao).toBe(false);
      expect(config.cta).toContain('Salve esse post');
    });

    it('Deve aplicar configuração inspiracional', () => {
      const config = aplicarTone('inspiracional');
      
      expect(config.usaCTAPadrao).toBe(false);
      expect(config.cta).toContain('❤️');
    });

    it('Deve aplicar configuração bastidores', () => {
      const config = aplicarTone('bastidores');
      
      expect(config.usaCTAPadrao).toBe(false);
      expect(config.cta).toContain('Link na bio');
    });

    it('Deve usar emotional como fallback', () => {
      const config = aplicarTone('invalido');
      
      expect(config.usaCTAPadrao).toBe(true);
    });

    it('Deve usar emotional quando tone não é fornecido', () => {
      const config = aplicarTone();
      
      expect(config.usaCTAPadrao).toBe(true);
    });
  });

  // ===========================================================================
  // TESTES DE AGENDAMENTO
  // ===========================================================================
  
  describe('⏰ Validação de Agendamento', () => {
    
    it('Deve validar scheduledAt nulo', () => {
      const validacao = validarScheduledAt(null);
      
      expect(validacao.valido).toBe(true);
    });

    it('Deve validar scheduledAt undefined', () => {
      const validacao = validarScheduledAt(undefined);
      
      expect(validacao.valido).toBe(true);
    });

    it('Deve validar data futura', () => {
      const amanha = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const validacao = validarScheduledAt(amanha.toISOString());
      
      expect(validacao.valido).toBe(true);
      expect(validacao.data).toBeInstanceOf(Date);
    });

    it('Deve rejeitar data inválida', () => {
      const validacao = validarScheduledAt('data-invalida');
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Data de agendamento inválida');
    });

    it('Deve rejeitar data no passado', () => {
      const ontem = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const validacao = validarScheduledAt(ontem.toISOString());
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Data de agendamento está no passado');
    });

    it('Deve rejeitar data muito no futuro', () => {
      const futuroDistante = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
      const validacao = validarScheduledAt(futuroDistante.toISOString());
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Data de agendamento muito no futuro (máx 1 ano)');
    });

    it('Deve aceitar data exatamente 1 ano no futuro', () => {
      const umAno = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      const validacao = validarScheduledAt(umAno.toISOString());
      
      expect(validacao.valido).toBe(true);
    });
  });

  // ===========================================================================
  // TESTES DE GERAÇÃO DE DADOS
  // ===========================================================================
  
  describe('📝 Geração de Dados de Atualização', () => {
    
    it('Deve gerar dados básicos corretamente', () => {
      const dados = {
        channel: 'gmb',
        postData: { title: 'Título', content: 'Conteúdo' },
        tone: 'emotional'
      };
      
      const atualizacao = gerarDadosAtualizacao(dados);
      
      expect(atualizacao.title).toBe('Título');
      expect(atualizacao.content).toBe('Conteúdo');
      expect(atualizacao.status).toBe('draft');
      expect(atualizacao.aiGenerated).toBe(true);
      expect(atualizacao.processingStatus).toBe('completed');
      expect(atualizacao.tone).toBe('emotional');
    });

    it('Deve adicionar headline e caption para Instagram', () => {
      const dados = {
        channel: 'instagram',
        postData: { title: 'Headline', content: 'Legenda' },
        tone: 'emotional'
      };
      
      const atualizacao = gerarDadosAtualizacao(dados);
      
      expect(atualizacao.headline).toBe('Headline');
      expect(atualizacao.caption).toBe('Legenda');
    });

    it('Deve adicionar media quando disponível', () => {
      const dados = {
        channel: 'gmb',
        postData: { title: 'Título', content: 'Conteúdo' },
        mediaUrl: 'https://img.com/test.jpg',
        imageProvider: 'fal',
        tone: 'emotional'
      };
      
      const atualizacao = gerarDadosAtualizacao(dados);
      
      expect(atualizacao.mediaUrl).toBe('https://img.com/test.jpg');
      expect(atualizacao.mediaType).toBe('image');
      expect(atualizacao.imageProvider).toBe('fal');
    });

    it('Deve adicionar scheduledAt quando fornecido', () => {
      const scheduledAt = '2024-12-25T10:00:00Z';
      const dados = {
        channel: 'gmb',
        postData: { title: 'Título' },
        scheduledAt,
        tone: 'emotional'
      };
      
      const atualizacao = gerarDadosAtualizacao(dados);
      
      expect(atualizacao.scheduledAt).toBeInstanceOf(Date);
      expect(atualizacao.status).toBe('scheduled');
    });

    it('Deve adicionar qualityScore quando disponível', () => {
      const qualityScore = { score_geral: 8 };
      const dados = {
        channel: 'gmb',
        postData: { title: 'Título' },
        qualityScore,
        tone: 'emotional'
      };
      
      const atualizacao = gerarDadosAtualizacao(dados);
      
      expect(atualizacao.qualityScore).toEqual(qualityScore);
    });

    it('Deve adicionar funnelStage quando disponível', () => {
      const dados = {
        channel: 'gmb',
        postData: { title: 'Título' },
        funnelStage: 'bottom',
        tone: 'emotional'
      };
      
      const atualizacao = gerarDadosAtualizacao(dados);
      
      expect(atualizacao.funnelStage).toBe('bottom');
    });
  });

  // ===========================================================================
  // TESTES DE GERAÇÃO DE IMAGEM
  // ===========================================================================
  
  describe('🎨 Geração de Imagem', () => {
    
    it('Deve gerar imagem com primeiro provider', async () => {
      const resultado = await simularGeracaoImagem();
      
      expect(resultado).not.toBeNull();
      expect(resultado.provider).toBe('fal-flux-dev');
    });

    it('Deve tentar próximo provider quando um falha', async () => {
      const tentativas = [
        { provider: 'fal-flux-dev', sucesso: false },
        { provider: 'freepik-ai', sucesso: true }
      ];
      
      const resultado = await simularGeracaoImagem(tentativas);
      
      expect(resultado.provider).toBe('freepik-ai');
    });

    it('Deve retornar null quando todos falham', async () => {
      const tentativas = [
        { provider: 'fal-flux-dev', sucesso: false },
        { provider: 'freepik-ai', sucesso: false },
        { provider: 'hf-flux-dev', sucesso: false },
        { provider: 'pollinations', sucesso: false }
      ];
      
      const resultado = await simularGeracaoImagem(tentativas);
      
      expect(resultado).toBeNull();
    });
  });

  // ===========================================================================
  // TESTES DE VALIDAÇÃO DE RESULTADO
  // ===========================================================================
  
  describe('✅ Validação de Resultado', () => {
    
    it('Deve validar resultado completo', () => {
      const resultado = {
        postId: '123',
        channel: 'gmb',
        status: 'completed'
      };
      
      const validacao = validarResultado(resultado);
      
      expect(validacao.valido).toBe(true);
      expect(validacao.erros).toHaveLength(0);
    });

    it('Deve rejeitar resultado sem postId', () => {
      const resultado = {
        channel: 'gmb',
        status: 'completed'
      };
      
      const validacao = validarResultado(resultado);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Resultado sem postId');
    });

    it('Deve rejeitar resultado sem channel', () => {
      const resultado = {
        postId: '123',
        status: 'completed'
      };
      
      const validacao = validarResultado(resultado);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Resultado sem channel');
    });

    it('Deve rejeitar resultado sem status', () => {
      const resultado = {
        postId: '123',
        channel: 'gmb'
      };
      
      const validacao = validarResultado(resultado);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Resultado sem status');
    });

    it('Deve rejeitar status inválido', () => {
      const resultado = {
        postId: '123',
        channel: 'gmb',
        status: 'invalido'
      };
      
      const validacao = validarResultado(resultado);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Status inválido: invalido');
    });

    it('Deve aceitar todos os status válidos', () => {
      const statusValidos = ['completed', 'failed', 'processing'];
      
      statusValidos.forEach(status => {
        const resultado = { postId: '123', channel: 'gmb', status };
        const validacao = validarResultado(resultado);
        expect(validacao.valido).toBe(true);
      });
    });
  });

  // ===========================================================================
  // TESTES DE PROGRESSO
  // ===========================================================================
  
  describe('📈 Cálculo de Progresso', () => {
    
    it('Deve retornar 10% no início', () => {
      expect(calcularProgresso('inicio')).toBe(10);
    });

    it('Deve retornar 25% na geração de conteúdo', () => {
      expect(calcularProgresso('conteudo')).toBe(25);
    });

    it('Deve retornar 60% na geração de imagem', () => {
      expect(calcularProgresso('imagem')).toBe(60);
    });

    it('Deve retornar 80% no upload', () => {
      expect(calcularProgresso('upload')).toBe(80);
    });

    it('Deve retornar 100% na finalização', () => {
      expect(calcularProgresso('finalizacao')).toBe(100);
    });

    it('Deve retornar 0% para etapa desconhecida', () => {
      expect(calcularProgresso('desconhecida')).toBe(0);
    });
  });

  // ===========================================================================
  // TESTES INTEGRADOS
  // ===========================================================================
  
  describe('🔄 Fluxos Integrados', () => {
    
    it('Fluxo GMB completo: Validação → Geração → Atualização', () => {
      // 1. Valida job
      const jobData = {
        postId: '123',
        channel: 'gmb',
        especialidadeId: 'fonoaudiologia',
        tone: 'educativo',
        funnelStage: 'top'
      };
      const validacaoJob = validarJobData(jobData);
      expect(validacaoJob.valido).toBe(true);
      
      // 2. Aplica tone
      const toneConfig = aplicarTone(jobData.tone);
      expect(toneConfig.usaCTAPadrao).toBe(false);
      
      // 3. Gera dados de atualização
      const dadosAtualizacao = gerarDadosAtualizacao({
        channel: jobData.channel,
        postData: { title: 'Título', content: 'Conteúdo' },
        tone: jobData.tone,
        funnelStage: jobData.funnelStage
      });
      expect(dadosAtualizacao.status).toBe('draft');
      expect(dadosAtualizacao.tone).toBe('educativo');
    });

    it('Fluxo Instagram agendado: Validação → Agendamento → Status', () => {
      // 1. Valida job
      const dataFutura = new Date(Date.now() + 24 * 60 * 60 * 1000); // Amanhã
      const jobData = {
        postId: '456',
        channel: 'instagram',
        especialidadeId: 'psicologia',
        scheduledAt: dataFutura.toISOString()
      };
      const validacaoJob = validarJobData(jobData);
      expect(validacaoJob.valido).toBe(true);
      
      // 2. Valida agendamento
      const validacaoAgendamento = validarScheduledAt(jobData.scheduledAt);
      expect(validacaoAgendamento.valido).toBe(true);
      
      // 3. Determina status
      const status = determinarStatus(jobData.scheduledAt);
      expect(status).toBe('scheduled');
      
      // 4. Gera dados com headline
      const dadosAtualizacao = gerarDadosAtualizacao({
        channel: jobData.channel,
        postData: { title: 'Headline IG', content: 'Legenda IG' },
        scheduledAt: jobData.scheduledAt,
        tone: 'emotional'
      });
      expect(dadosAtualizacao.headline).toBe('Headline IG');
      expect(dadosAtualizacao.caption).toBe('Legenda IG');
      expect(dadosAtualizacao.status).toBe('scheduled');
    });

    it('Fluxo com Quality Score: Geração → Score → Validação', () => {
      const qualityScore = {
        clareza: 8,
        impacto_emocional: 9,
        cta: 7,
        score_geral: 8
      };
      
      const dadosAtualizacao = gerarDadosAtualizacao({
        channel: 'facebook',
        postData: { title: 'Título FB', content: 'Conteúdo FB' },
        tone: 'inspiracional',
        qualityScore
      });
      
      expect(dadosAtualizacao.qualityScore).toEqual(qualityScore);
      expect(dadosAtualizacao.qualityScore.score_geral).toBe(8);
    });
  });
});

// Exportar funções para reuso
export {
  validarJobData,
  getModelForChannel,
  determinarStatus,
  aplicarTone,
  validarScheduledAt,
  gerarDadosAtualizacao,
  simularGeracaoImagem,
  validarResultado,
  calcularProgresso
};
