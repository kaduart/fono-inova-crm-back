/**
 * 🎬 Testes Unitários - Video Worker
 * 
 * Cobre:
 * - Processamento de jobs de vídeo em 3 modos (veo, avatar, ilustrativo)
 * - Progresso e atualização de status
 * - Fallback entre modos
 * - Validação de parâmetros de vídeo
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// CONSTANTES E DADOS DE TESTE
// =============================================================================

const MODOS_VIDEO = {
  avatar: {
    nome: 'Avatar',
    usaHeyGen: true,
    usaPosProducao: true,
    estimativaMinutos: 8
  },
  ilustrativo: {
    nome: 'Ilustrativo',
    usaSlideshow: true,
    usaPosProducao: false,
    estimativaMinutos: 5
  },
  veo: {
    nome: 'Veo 3.1',
    usaVeo: true,
    usaPosProducao: false,
    estimativaMinutos: 4
  }
};

const FUNIS = {
  TOPO: { nome: 'Topo de Funil', objetivo: 'awareness' },
  MEIO: { nome: 'Meio de Funil', objetivo: 'consideration' },
  FUNDO: { nome: 'Fundo de Funil', objetivo: 'conversion' }
};

const MOCK_JOB = {
  jobId: 'video-123',
  videoDocId: 'doc-456',
  tema: 'Atraso na fala',
  especialidadeId: 'fonoaudiologia',
  funil: 'TOPO',
  duracao: 60,
  publicar: false,
  userId: 'user-789'
};

// =============================================================================
// FUNÇÕES DE TESTE ISOLADAS
// =============================================================================

/**
 * ✅ Valida modo de vídeo
 */
function validarModo(modo) {
  const modosValidos = Object.keys(MODOS_VIDEO);
  
  if (!modo || !modosValidos.includes(modo)) {
    return {
      valido: false,
      erro: `Modo inválido. Use: ${modosValidos.join(', ')}`,
      modoFallback: 'veo'
    };
  }
  
  return {
    valido: true,
    config: MODOS_VIDEO[modo],
    modo
  };
}

/**
 * ⏱️ Calcula progresso por etapa e modo
 */
function calcularProgressoVideo(etapa, modo = 'veo') {
  const progressos = {
    avatar: {
      'ROTEIRO': 10,
      'HEYGEN': 30,
      'POS_PRODUCAO': 65,
      'UPLOAD': 92,
      'CONCLUIDO': 100
    },
    ilustrativo: {
      'ROTEIRO': 10,
      'HEYGEN': 30,
      'POS_PRODUCAO': 90, // Pula upload
      'CONCLUIDO': 100
    },
    veo: {
      'ROTEIRO': 10,
      'HEYGEN': 30,
      'POS_PRODUCAO': 90,
      'CONCLUIDO': 100
    }
  };
  
  return progressos[modo]?.[etapa] || 0;
}

/**
 * ⏰ Calcula tempo estimado por modo
 */
function calcularTempoEstimadoVideo(modo, duracao = 60) {
  const config = MODOS_VIDEO[modo];
  
  if (!config) {
    return { minutos: 0, descricao: 'Desconhecido' };
  }
  
  // Ajusta por duração (vídeos mais longos demoram mais)
  const fatorDuracao = Math.min(duracao / 60, 2); // Max 2x
  const minutos = Math.round(config.estimativaMinutos * fatorDuracao);
  
  return {
    minutos,
    descricao: `${minutos}-${minutos + 2} minutos`,
    modo: config.nome
  };
}

/**
 * ✅ Valida parâmetros de job de vídeo
 */
function validarJobVideo(jobData) {
  const erros = [];
  
  // Campos obrigatórios
  if (!jobData.jobId) erros.push('jobId é obrigatório');
  if (!jobData.videoDocId) erros.push('videoDocId é obrigatório');
  if (!jobData.tema) erros.push('tema é obrigatório');
  if (!jobData.especialidadeId) erros.push('especialidadeId é obrigatório');
  
  // Valida duração
  if (typeof jobData.duracao === 'number') {
    if (jobData.duracao < 1) erros.push('duração mínima é 1 segundo');
    if (jobData.duracao > 300) erros.push('duração máxima é 300 segundos (5 minutos)');
    
    // Veo tem limite de 8s no plano gratuito
    if (jobData.modo === 'veo' && jobData.duracao > 8) {
      erros.push('modo veo: duração máxima é 8 segundos no plano gratuito');
    }
  }
  
  // Valida funil
  if (jobData.funil && !FUNIS[jobData.funil]) {
    erros.push(`funil inválido: ${jobData.funil}`);
  }
  
  return {
    valido: erros.length === 0,
    erros
  };
}

/**
 * 🎬 Determina etapas do pipeline por modo
 */
function determinarEtapasPipeline(modo) {
  const etapasBase = ['ROTEIRO', 'HEYGEN'];
  
  switch (modo) {
    case 'veo':
      return [...etapasBase, 'POS_PRODUCAO', 'CONCLUIDO'];
    case 'ilustrativo':
      return [...etapasBase, 'POS_PRODUCAO', 'CONCLUIDO'];
    case 'avatar':
      return [...etapasBase, 'POS_PRODUCAO', 'UPLOAD', 'CONCLUIDO'];
    default:
      return etapasBase;
  }
}

/**
 * 🔍 Valida roteiro gerado
 */
function validarRoteiro(roteiro) {
  const erros = [];
  const avisos = [];
  
  if (!roteiro) {
    return { valido: false, erros: ['Roteiro vazio'], avisos: [] };
  }
  
  // Campos obrigatórios
  if (!roteiro.titulo) erros.push('Roteiro sem título');
  if (!roteiro.texto_completo) erros.push('Roteiro sem texto completo');
  if (!roteiro.profissional) erros.push('Roteiro sem profissional');
  
  // Validações de conteúdo
  if (roteiro.texto_completo) {
    // Deve ter CTA
    if (!/link|bio|whatsapp|agende|chame|avaliação/i.test(roteiro.texto_completo)) {
      avisos.push('Roteiro sem CTA claro');
    }
    
    // Deve mencionar Fono Inova
    if (!roteiro.texto_completo.includes('Fono Inova')) {
      avisos.push('Roteiro não menciona Fono Inova');
    }
  }
  
  // Hook overlay
  if (!roteiro.hook_texto_overlay) {
    avisos.push('Roteiro sem hook para overlay');
  }
  
  // CTA overlay
  if (!roteiro.cta_texto_overlay) {
    avisos.push('Roteiro sem CTA para overlay');
  }
  
  return {
    valido: erros.length === 0,
    erros,
    avisos
  };
}

/**
 * 📊 Gera status de atualização do vídeo
 */
function gerarStatusVideo(dados) {
  const {
    etapa,
    percentual,
    videoUrl = null,
    roteiro = null,
    provider = null,
    meta = null
  } = dados;
  
  const status = {
    pipelineStatus: etapa,
    'progresso.etapa': etapa,
    'progresso.percentual': percentual,
    'progresso.atualizadoEm': new Date()
  };
  
  if (videoUrl) {
    status.videoUrl = videoUrl;
    status.videoFinalUrl = videoUrl;
  }
  
  if (roteiro) {
    status.roteiro = roteiro.titulo;
    status.roteiroEstruturado = roteiro;
  }
  
  if (provider) {
    status.provider = provider;
  }
  
  if (meta) {
    status.metaCampaignId = meta.campaign_id;
  }
  
  if (etapa === 'CONCLUIDO') {
    status.status = 'ready';
  } else if (etapa === 'ERRO') {
    status.status = 'failed';
  } else {
    status.status = 'processing';
  }
  
  return status;
}

/**
 * 🎭 Seleciona música por funil
 */
function selecionarMusica(funil) {
  const musicas = {
    TOPO: 'calma',
    MEIO: 'esperancosa',
    FUNDO: 'motivadora'
  };
  
  return musicas[funil] || 'calma';
}

/**
 * ✅ Valida resultado final
 */
function validarResultadoVideo(resultado, modo) {
  const erros = [];
  
  if (!resultado.jobId) erros.push('Resultado sem jobId');
  if (!resultado.status) erros.push('Resultado sem status');
  if (!resultado.roteiro) erros.push('Resultado sem roteiro');
  
  // Vídeo é obrigatório para todos os modos
  if (!resultado.videoFinal) {
    erros.push('Resultado sem videoFinal');
  }
  
  // Provider específico
  if (modo === 'veo' && resultado.provider !== 'veo-3.1') {
    erros.push('Modo veo deve ter provider veo-3.1');
  }
  
  return {
    valido: erros.length === 0,
    erros
  };
}

// =============================================================================
// TESTES
// =============================================================================

describe('🎬 Video Worker', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // TESTES DE VALIDAÇÃO DE MODO
  // ===========================================================================
  
  describe('✅ Validação de Modo', () => {
    
    it('Deve validar modo veo', () => {
      const validacao = validarModo('veo');
      
      expect(validacao.valido).toBe(true);
      expect(validacao.config.nome).toBe('Veo 3.1');
      expect(validacao.config.usaVeo).toBe(true);
    });

    it('Deve validar modo avatar', () => {
      const validacao = validarModo('avatar');
      
      expect(validacao.valido).toBe(true);
      expect(validacao.config.nome).toBe('Avatar');
      expect(validacao.config.usaHeyGen).toBe(true);
    });

    it('Deve validar modo ilustrativo', () => {
      const validacao = validarModo('ilustrativo');
      
      expect(validacao.valido).toBe(true);
      expect(validacao.config.nome).toBe('Ilustrativo');
      expect(validacao.config.usaSlideshow).toBe(true);
    });

    it('Deve rejeitar modo inválido', () => {
      const validacao = validarModo('invalido');
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erro).toContain('Modo inválido');
      expect(validacao.modoFallback).toBe('veo');
    });

    it('Deve rejeitar modo nulo', () => {
      const validacao = validarModo(null);
      
      expect(validacao.valido).toBe(false);
    });

    it('Deve rejeitar modo undefined', () => {
      const validacao = validarModo(undefined);
      
      expect(validacao.valido).toBe(false);
    });
  });

  // ===========================================================================
  // TESTES DE PROGRESSO
  // ===========================================================================
  
  describe('📈 Cálculo de Progresso', () => {
    
    it('Deve retornar 10% na etapa ROTEIRO', () => {
      expect(calcularProgressoVideo('ROTEIRO', 'veo')).toBe(10);
      expect(calcularProgressoVideo('ROTEIRO', 'avatar')).toBe(10);
    });

    it('Deve retornar 30% na etapa HEYGEN', () => {
      expect(calcularProgressoVideo('HEYGEN', 'veo')).toBe(30);
    });

    it('Deve retornar 65% na etapa POS_PRODUCAO para avatar', () => {
      expect(calcularProgressoVideo('POS_PRODUCAO', 'avatar')).toBe(65);
    });

    it('Deve retornar 90% na etapa POS_PRODUCAO para veo', () => {
      expect(calcularProgressoVideo('POS_PRODUCAO', 'veo')).toBe(90);
    });

    it('Deve retornar 92% na etapa UPLOAD para avatar', () => {
      expect(calcularProgressoVideo('UPLOAD', 'avatar')).toBe(92);
    });

    it('Deve retornar 100% na etapa CONCLUIDO', () => {
      expect(calcularProgressoVideo('CONCLUIDO', 'veo')).toBe(100);
      expect(calcularProgressoVideo('CONCLUIDO', 'avatar')).toBe(100);
    });

    it('Deve retornar 0% para etapa desconhecida', () => {
      expect(calcularProgressoVideo('DESCONHECIDA', 'veo')).toBe(0);
    });
  });

  // ===========================================================================
  // TESTES DE TEMPO ESTIMADO
  // ===========================================================================
  
  describe('⏱️ Tempo Estimado', () => {
    
    it('Deve estimar 4 minutos para veo (60s)', () => {
      const tempo = calcularTempoEstimadoVideo('veo', 60);
      
      expect(tempo.minutos).toBe(4);
      expect(tempo.descricao).toContain('minutos');
    });

    it('Deve estimar 8 minutos para avatar (60s)', () => {
      const tempo = calcularTempoEstimadoVideo('avatar', 60);
      
      expect(tempo.minutos).toBe(8);
    });

    it('Deve estimar 5 minutos para ilustrativo (60s)', () => {
      const tempo = calcularTempoEstimadoVideo('ilustrativo', 60);
      
      expect(tempo.minutos).toBe(5);
    });

    it('Deve ajustar tempo para vídeos mais longos', () => {
      const tempoCurto = calcularTempoEstimadoVideo('veo', 30);
      const tempoLongo = calcularTempoEstimadoVideo('veo', 120);
      
      expect(tempoLongo.minutos).toBeGreaterThan(tempoCurto.minutos);
    });

    it('Deve retornar desconhecido para modo inválido', () => {
      const tempo = calcularTempoEstimadoVideo('invalido', 60);
      
      expect(tempo.descricao).toBe('Desconhecido');
    });
  });

  // ===========================================================================
  // TESTES DE VALIDAÇÃO DE JOB
  // ===========================================================================
  
  describe('✅ Validação de Job', () => {
    
    it('Deve validar job completo', () => {
      const validacao = validarJobVideo(MOCK_JOB);
      
      expect(validacao.valido).toBe(true);
      expect(validacao.erros).toHaveLength(0);
    });

    it('Deve rejeitar job sem jobId', () => {
      const job = { ...MOCK_JOB, jobId: null };
      const validacao = validarJobVideo(job);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('jobId é obrigatório');
    });

    it('Deve rejeitar job sem videoDocId', () => {
      const job = { ...MOCK_JOB, videoDocId: null };
      const validacao = validarJobVideo(job);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('videoDocId é obrigatório');
    });

    it('Deve rejeitar job sem tema', () => {
      const job = { ...MOCK_JOB, tema: null };
      const validacao = validarJobVideo(job);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('tema é obrigatório');
    });

    it('Deve rejeitar job sem especialidadeId', () => {
      const job = { ...MOCK_JOB, especialidadeId: null };
      const validacao = validarJobVideo(job);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('especialidadeId é obrigatório');
    });

    it('Deve rejeitar duração menor que 1 segundo', () => {
      const job = {
        jobId: 'video-123',
        videoDocId: 'doc-456',
        tema: 'Teste',
        especialidadeId: 'fonoaudiologia',
        duracao: 0
      };
      
      const validacao = validarJobVideo(job);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('duração mínima é 1 segundo');
    });

    it('Deve rejeitar duração maior que 300 segundos', () => {
      const job = { ...MOCK_JOB };
      job.duracao = 301;
      
      const validacao = validarJobVideo(job);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('duração máxima é 300 segundos (5 minutos)');
    });

    it('Deve rejeitar duração > 8s no modo veo', () => {
      const job = { ...MOCK_JOB };
      job.modo = 'veo';
      job.duracao = 10;
      
      const validacao = validarJobVideo(job);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('modo veo: duração máxima é 8 segundos no plano gratuito');
    });

    it('Deve aceitar duração 8s no modo veo', () => {
      const job = { ...MOCK_JOB };
      job.modo = 'veo';
      job.duracao = 8;
      
      const validacao = validarJobVideo(job);
      
      expect(validacao.erros).not.toContain('modo veo: duração máxima é 8 segundos no plano gratuito');
    });

    it('Deve rejeitar funil inválido', () => {
      const job = { ...MOCK_JOB, funil: 'INVALIDO' };
      const validacao = validarJobVideo(job);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('funil inválido: INVALIDO');
    });

    it('Deve aceitar todos os funis válidos', () => {
      const funisValidos = ['TOPO', 'MEIO', 'FUNDO'];
      
      funisValidos.forEach(funil => {
        const job = { ...MOCK_JOB, funil };
        const validacao = validarJobVideo(job);
        expect(validacao.erros).not.toContain(`funil inválido: ${funil}`);
      });
    });
  });

  // ===========================================================================
  // TESTES DE ETAPAS DO PIPELINE
  // ===========================================================================
  
  describe('🔄 Etapas do Pipeline', () => {
    
    it('Deve retornar etapas para modo veo', () => {
      const etapas = determinarEtapasPipeline('veo');
      
      expect(etapas).toContain('ROTEIRO');
      expect(etapas).toContain('HEYGEN');
      expect(etapas).toContain('CONCLUIDO');
      expect(etapas).not.toContain('UPLOAD');
    });

    it('Deve retornar etapas para modo avatar', () => {
      const etapas = determinarEtapasPipeline('avatar');
      
      expect(etapas).toContain('ROTEIRO');
      expect(etapas).toContain('HEYGEN');
      expect(etapas).toContain('POS_PRODUCAO');
      expect(etapas).toContain('UPLOAD');
      expect(etapas).toContain('CONCLUIDO');
    });

    it('Deve retornar etapas para modo ilustrativo', () => {
      const etapas = determinarEtapasPipeline('ilustrativo');
      
      expect(etapas).toContain('ROTEIRO');
      expect(etapas).toContain('CONCLUIDO');
    });

    it('Deve retornar etapas base para modo desconhecido', () => {
      const etapas = determinarEtapasPipeline('desconhecido');
      
      expect(etapas).toEqual(['ROTEIRO', 'HEYGEN']);
    });
  });

  // ===========================================================================
  // TESTES DE VALIDAÇÃO DE ROTEIRO
  // ===========================================================================
  
  describe('📝 Validação de Roteiro', () => {
    
    it('Deve validar roteiro completo', () => {
      const roteiro = {
        titulo: '5 Sinais de Atraso na Fala',
        texto_completo: 'Seu filho ainda não fala? Na Fono Inova em Anápolis ajudamos. Agende pelo link.',
        profissional: 'fonoaudiologia',
        hook_texto_overlay: '5 sinais que seu filho precisa de fonoaudiologia',
        cta_texto_overlay: 'Agende sua avaliação'
      };
      
      const validacao = validarRoteiro(roteiro);
      
      expect(validacao.valido).toBe(true);
      expect(validacao.erros).toHaveLength(0);
    });

    it('Deve rejeitar roteiro vazio', () => {
      const validacao = validarRoteiro(null);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Roteiro vazio');
    });

    it('Deve rejeitar roteiro sem título', () => {
      const roteiro = {
        texto_completo: 'Texto',
        profissional: 'fono'
      };
      
      const validacao = validarRoteiro(roteiro);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Roteiro sem título');
    });

    it('Deve rejeitar roteiro sem texto completo', () => {
      const roteiro = {
        titulo: 'Título',
        profissional: 'fono'
      };
      
      const validacao = validarRoteiro(roteiro);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Roteiro sem texto completo');
    });

    it('Deve rejeitar roteiro sem profissional', () => {
      const roteiro = {
        titulo: 'Título',
        texto_completo: 'Texto'
      };
      
      const validacao = validarRoteiro(roteiro);
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Roteiro sem profissional');
    });

    it('Deve alertar quando não tem CTA', () => {
      const roteiro = {
        titulo: 'Título',
        texto_completo: 'Texto sem call to action',
        profissional: 'fono'
      };
      
      const validacao = validarRoteiro(roteiro);
      
      expect(validacao.avisos).toContain('Roteiro sem CTA claro');
    });

    it('Deve alertar quando não menciona Fono Inova', () => {
      const roteiro = {
        titulo: 'Título',
        texto_completo: 'Texto de exemplo. Agende agora.',
        profissional: 'fono'
      };
      
      const validacao = validarRoteiro(roteiro);
      
      expect(validacao.avisos).toContain('Roteiro não menciona Fono Inova');
    });

    it('Deve alertar quando não tem hook para overlay', () => {
      const roteiro = {
        titulo: 'Título',
        texto_completo: 'Texto com Fono Inova. Agende pelo link.',
        profissional: 'fono'
      };
      
      const validacao = validarRoteiro(roteiro);
      
      expect(validacao.avisos).toContain('Roteiro sem hook para overlay');
    });
  });

  // ===========================================================================
  // TESTES DE STATUS
  // ===========================================================================
  
  describe('📊 Geração de Status', () => {
    
    it('Deve gerar status para etapa inicial', () => {
      const status = gerarStatusVideo({
        etapa: 'ROTEIRO',
        percentual: 10
      });
      
      expect(status.pipelineStatus).toBe('ROTEIRO');
      expect(status['progresso.percentual']).toBe(10);
      expect(status.status).toBe('processing');
    });

    it('Deve gerar status com vídeo', () => {
      const status = gerarStatusVideo({
        etapa: 'HEYGEN',
        percentual: 30,
        videoUrl: 'https://video.com/test.mp4'
      });
      
      expect(status.videoUrl).toBe('https://video.com/test.mp4');
      expect(status.videoFinalUrl).toBe('https://video.com/test.mp4');
    });

    it('Deve gerar status com roteiro', () => {
      const roteiro = { titulo: 'Título do Vídeo' };
      const status = gerarStatusVideo({
        etapa: 'ROTEIRO',
        percentual: 10,
        roteiro
      });
      
      expect(status.roteiro).toBe('Título do Vídeo');
      expect(status.roteiroEstruturado).toEqual(roteiro);
    });

    it('Deve gerar status para concluído', () => {
      const status = gerarStatusVideo({
        etapa: 'CONCLUIDO',
        percentual: 100
      });
      
      expect(status.status).toBe('ready');
    });

    it('Deve gerar status para erro', () => {
      const status = gerarStatusVideo({
        etapa: 'ERRO',
        percentual: 0
      });
      
      expect(status.status).toBe('failed');
    });

    it('Deve incluir provider quando fornecido', () => {
      const status = gerarStatusVideo({
        etapa: 'HEYGEN',
        percentual: 30,
        provider: 'veo-3.1'
      });
      
      expect(status.provider).toBe('veo-3.1');
    });

    it('Deve incluir meta quando fornecido', () => {
      const meta = { campaign_id: 'camp-123' };
      const status = gerarStatusVideo({
        etapa: 'UPLOAD',
        percentual: 92,
        meta
      });
      
      expect(status.metaCampaignId).toBe('camp-123');
    });
  });

  // ===========================================================================
  // TESTES DE SELEÇÃO DE MÚSICA
  // ===========================================================================
  
  describe('🎵 Seleção de Música', () => {
    
    it('Deve selecionar música calma para TOPO', () => {
      expect(selecionarMusica('TOPO')).toBe('calma');
    });

    it('Deve selecionar música esperançosa para MEIO', () => {
      expect(selecionarMusica('MEIO')).toBe('esperancosa');
    });

    it('Deve selecionar música motivivadora para FUNDO', () => {
      expect(selecionarMusica('FUNDO')).toBe('motivadora');
    });

    it('Deve usar calma como fallback', () => {
      expect(selecionarMusica('INVALIDO')).toBe('calma');
    });
  });

  // ===========================================================================
  // TESTES DE VALIDAÇÃO DE RESULTADO
  // ===========================================================================
  
  describe('✅ Validação de Resultado', () => {
    
    it('Deve validar resultado completo', () => {
      const resultado = {
        jobId: 'video-123',
        status: 'CONCLUIDO',
        roteiro: { titulo: 'Título' },
        videoFinal: 'https://video.com/final.mp4',
        provider: 'veo-3.1'
      };
      
      const validacao = validarResultadoVideo(resultado, 'veo');
      
      expect(validacao.valido).toBe(true);
      expect(validacao.erros).toHaveLength(0);
    });

    it('Deve rejeitar resultado sem jobId', () => {
      const resultado = {
        status: 'CONCLUIDO',
        roteiro: { titulo: 'Título' },
        videoFinal: 'https://video.com/final.mp4'
      };
      
      const validacao = validarResultadoVideo(resultado, 'veo');
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Resultado sem jobId');
    });

    it('Deve rejeitar resultado sem status', () => {
      const resultado = {
        jobId: 'video-123',
        roteiro: { titulo: 'Título' },
        videoFinal: 'https://video.com/final.mp4'
      };
      
      const validacao = validarResultadoVideo(resultado, 'veo');
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Resultado sem status');
    });

    it('Deve rejeitar resultado sem roteiro', () => {
      const resultado = {
        jobId: 'video-123',
        status: 'CONCLUIDO',
        videoFinal: 'https://video.com/final.mp4'
      };
      
      const validacao = validarResultadoVideo(resultado, 'veo');
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Resultado sem roteiro');
    });

    it('Deve rejeitar resultado sem videoFinal', () => {
      const resultado = {
        jobId: 'video-123',
        status: 'CONCLUIDO',
        roteiro: { titulo: 'Título' }
      };
      
      const validacao = validarResultadoVideo(resultado, 'veo');
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Resultado sem videoFinal');
    });

    it('Deve validar provider veo-3.1 para modo veo', () => {
      const resultado = {
        jobId: 'video-123',
        status: 'CONCLUIDO',
        roteiro: { titulo: 'Título' },
        videoFinal: 'https://video.com/final.mp4',
        provider: 'veo-3.1'
      };
      
      const validacao = validarResultadoVideo(resultado, 'veo');
      
      expect(validacao.valido).toBe(true);
    });

    it('Deve rejeitar provider diferente para modo veo', () => {
      const resultado = {
        jobId: 'video-123',
        status: 'CONCLUIDO',
        roteiro: { titulo: 'Título' },
        videoFinal: 'https://video.com/final.mp4',
        provider: 'heygen'
      };
      
      const validacao = validarResultadoVideo(resultado, 'veo');
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Modo veo deve ter provider veo-3.1');
    });
  });

  // ===========================================================================
  // TESTES INTEGRADOS
  // ===========================================================================
  
  describe('🔄 Fluxos Integrados', () => {
    
    it('Fluxo VEO completo: Validação → Etapas → Progresso → Resultado', () => {
      // 1. Valida job
      const job = { ...MOCK_JOB, modo: 'veo', duracao: 8 };
      const validacaoJob = validarJobVideo(job);
      expect(validacaoJob.valido).toBe(true);
      
      // 2. Valida modo
      const validacaoModo = validarModo('veo');
      expect(validacaoModo.valido).toBe(true);
      expect(validacaoModo.config.usaVeo).toBe(true);
      
      // 3. Determina etapas
      const etapas = determinarEtapasPipeline('veo');
      expect(etapas).toContain('ROTEIRO');
      expect(etapas).toContain('CONCLUIDO');
      
      // 4. Calcula progresso
      expect(calcularProgressoVideo('ROTEIRO', 'veo')).toBe(10);
      expect(calcularProgressoVideo('CONCLUIDO', 'veo')).toBe(100);
      
      // 5. Gera status
      const status = gerarStatusVideo({
        etapa: 'CONCLUIDO',
        percentual: 100,
        provider: 'veo-3.1',
        videoUrl: 'https://video.com/final.mp4'
      });
      expect(status.status).toBe('ready');
      expect(status.provider).toBe('veo-3.1');
    });

    it('Fluxo Avatar com publicação Meta', () => {
      // 1. Valida job
      const job = { ...MOCK_JOB, modo: 'avatar', publicar: true };
      const validacaoJob = validarJobVideo(job);
      expect(validacaoJob.valido).toBe(true);
      
      // 2. Verifica que precisa de upload
      const etapas = determinarEtapasPipeline('avatar');
      expect(etapas).toContain('UPLOAD');
      
      // 3. Seleciona música
      const musica = selecionarMusica(job.funil);
      expect(musica).toBe('calma');
      
      // 4. Gera status com meta
      const status = gerarStatusVideo({
        etapa: 'UPLOAD',
        percentual: 92,
        meta: { campaign_id: 'camp-123' }
      });
      expect(status.metaCampaignId).toBe('camp-123');
    });

    it('Comparação de tempos entre modos', () => {
      const tempoVeo = calcularTempoEstimadoVideo('veo', 60);
      const tempoAvatar = calcularTempoEstimadoVideo('avatar', 60);
      const tempoIlustrativo = calcularTempoEstimadoVideo('ilustrativo', 60);
      
      // Veo deve ser mais rápido
      expect(tempoVeo.minutos).toBeLessThan(tempoAvatar.minutos);
      
      // Ilustrativo deve ser intermediário
      expect(tempoIlustrativo.minutos).toBeGreaterThanOrEqual(tempoVeo.minutos);
      expect(tempoIlustrativo.minutos).toBeLessThanOrEqual(tempoAvatar.minutos);
    });
  });
});

// Exportar funções para reuso
export {
  validarModo,
  calcularProgressoVideo,
  calcularTempoEstimadoVideo,
  validarJobVideo,
  determinarEtapasPipeline,
  validarRoteiro,
  gerarStatusVideo,
  selecionarMusica,
  validarResultadoVideo,
  MODOS_VIDEO,
  FUNIS
};
