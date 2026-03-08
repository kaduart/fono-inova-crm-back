/**
 * 🎬 Testes Unitários - Veo 3.1 Service
 * 
 * Cobre:
 * - Verificação de configuração (GOOGLE_AI_API_KEY)
 * - Construção de prompts cinematográficos
 * - Validação de parâmetros (duração, aspect ratio)
 * - Fallbacks e tratamento de erros
 * - Polling de geração
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// CONSTANTES E DADOS DE TESTE
// =============================================================================

const PROMPTS_ESPECIALIDADE = {
  fonoaudiologia: `Close-up cinematográfico de terapeuta auxiliando criança de 5 anos em exercício de sopro com bolhas,
    sessão de fonoaudiologia com espelho logopédico, ambiente clínico moderno com paredes verde claro e branco,
    iluminação natural difusa vindo de janela lateral, câmera estável em shoulder height,
    movimento suave de slow zoom-in nos rostos, profundidade de campo rasa,
    estilo documental médico high-end, atmosfera acolhedora, 24fps`,

  psicologia: `Terapeuta e adolescente em sessão terapêutica acolhedora, consultório moderno com plantas verdes,
    luz natural suave, câmera estável com rack focus no rosto da criança expressando alívio,
    cores calmas azul e bege, atmosfera segura e profissional, estilo documental emocional, 24fps`,

  terapia_ocupacional: `Criança realizando atividade de coordenação motora fina com materiais pedagógicos coloridos,
    terapeuta ocupacional guiando com mãos gentis, sala terapêutica clean com luz natural,
    câmera overhead com tilt suave para rosto da criança sorrindo, movimento expressivo das mãos,
    cores vibrantes e ambiente estimulante, estilo documental educacional, 24fps`,

  fisioterapia: `Fisioterapeuta pediátrico auxiliando criança em exercício de reabilitação com equipamentos coloridos,
    clínica moderna clara, iluminação profissional, câmera dolly suave acompanhando movimento,
    criança demonstrando superação e sorrindo, atmosfera motivadora, estilo documental clínico, 24fps`,

  psicomotricidade: `Criança pequena explorando movimento corporal em sala de psicomotricidade com tatames coloridos,
    psicomotricista observando e incentivando, ambiente lúdico e seguro, luz difusa suave,
    câmera wide seguindo movimento livre da criança, expressão de alegria e descoberta,
    estilo documental leve e alegre, 24fps`,

  freio_lingual: `Cirurgião-dentista pediátrico em clínica infantil com decoração acolhedora, equipamentos modernos,
    criança relaxada e confiante, luz clínica profissional com elementos suaves,
    câmera close-up em expressões tranquilas, ambiente clean e seguro,
    estilo documental médico profissional, 24fps`,

  neuropsicologia: `Neuropsicóloga aplicando avaliação lúdica com criança em consultório com iluminação quente,
    materiais de avaliação coloridos espalhados sobre mesa, câmera overhead capturando mãos em atividade,
    rack focus para rosto concentrado da criança, atmosfera estimulante e segura,
    estilo documental científico acessível, 24fps`,

  psicopedagogia: `Psicopedagoga e criança trabalhando com materiais de leitura e escrita criativos,
    sala de atendimento organizada e colorida, luz natural de janela, criança tendo insight expressando alegria,
    câmera close-up no momento de descoberta, atmosfera de aprendizado e conquista,
    estilo documental educacional inspirador, 24fps`,

  musicoterapia: `Musicoterapeuta e criança com autismo tocando instrumentos musicais simples juntos,
    sala de musicoterapia com instrumentos coloridos, luz quente e acolhedora, câmera capturando conexão entre os dois,
    criança totalmente engajada e sorrindo, movimento rítmico das mãos, atmosfera mágica e terapêutica,
    estilo documental emocional com foco em inclusão, 24fps`
};

// =============================================================================
// FUNÇÕES DE TESTE ISOLADAS
// =============================================================================

/**
 * ✅ Verifica se Veo está configurado
 */
function isVeoConfigured(apiKey) {
  return Boolean(apiKey);
}

/**
 * 📝 Constrói prompt customizado
 */
function buildCustomPrompt(tema, especialidadeId) {
  const base = PROMPTS_ESPECIALIDADE[especialidadeId] || PROMPTS_ESPECIALIDADE.fonoaudiologia;
  return `${tema}. ${base.split(',').slice(2).join(',')}`;
}

/**
 * ✅ Valida parâmetros de geração
 */
function validarParametrosVeo(options = {}) {
  const erros = [];
  const { durationSeconds = 8, aspectRatio = '9:16' } = options;
  
  // Duração máxima (grátis): 8 segundos
  if (durationSeconds > 8) {
    erros.push('Duração máxima para plano gratuito é 8 segundos');
  }
  
  // Duração mínima
  if (durationSeconds < 1) {
    erros.push('Duração mínima é 1 segundo');
  }
  
  // Aspect ratio válido
  const aspectRatiosValidos = ['9:16', '16:9', '1:1'];
  if (!aspectRatiosValidos.includes(aspectRatio)) {
    erros.push(`Aspect ratio inválido. Use: ${aspectRatiosValidos.join(', ')}`);
  }
  
  return {
    valido: erros.length === 0,
    erros,
    parametros: { durationSeconds, aspectRatio }
  };
}

/**
 * ⏱️ Calcula tempo estimado de geração
 */
function calcularTempoEstimado(durationSeconds) {
  // Veo geralmente leva 3-5 minutos, independente da duração (até 8s)
  const baseMinutos = 3;
  const variacao = Math.min(durationSeconds / 8, 1) * 2; // Até +2 minutos
  const minutos = Math.round(baseMinutos + variacao);
  
  return {
    minutos,
    descricao: `${minutos}-${minutos + 2} minutos`,
    segundos: minutos * 60
  };
}

/**
 * 🎬 Valida prompt cinematográfico
 */
function validarPromptCinematografico(prompt, especialidadeId) {
  const erros = [];
  const requisitos = [];
  
  if (!prompt || prompt.length < 100) {
    erros.push('Prompt cinematográfico muito curto');
    return { valido: false, erros, requisitos, temProfissional: false, temCrianca: false };
  }
  
  const promptLower = prompt.toLowerCase();
  
  // Elementos cinematográficos obrigatórios
  const elementosCinematicos = [
    { termo: 'close-up', descricao: 'Plano próximo' },
    { termo: 'cinematográfico', descricao: 'Estilo cinematográfico' },
    { termo: 'luz', descricao: 'Iluminação' },
    { termo: 'câmera', descricao: 'Movimento de câmera' },
    { termo: '24fps', descricao: 'Frame rate de cinema' }
  ];
  
  elementosCinematicos.forEach(el => {
    if (!promptLower.includes(el.termo.toLowerCase())) {
      requisitos.push(`Adicionar ${el.descricao} (${el.termo})`);
    }
  });
  
  // Deve ter descrição de profissional
  const profissionais = ['therapist', 'terapeuta', 'fonoaudiólogo', 'psicólogo', 'profissional'];
  const temProfissional = profissionais.some(p => promptLower.includes(p.toLowerCase()));
  if (!temProfissional) {
    erros.push('Prompt deve descrever o profissional terapeuta');
  }
  
  // Deve ter descrição de criança
  const criancas = ['child', 'criança', 'paciente', 'bebê', 'menino', 'menina'];
  const temCrianca = criancas.some(c => promptLower.includes(c.toLowerCase()));
  if (!temCrianca) {
    erros.push('Prompt deve descrever a criança/paciente');
  }
  
  // Deve mencionar a especialidade
  if (!promptLower.includes(especialidadeId.toLowerCase()) && 
      !PROMPTS_ESPECIALIDADE[especialidadeId]) {
    requisitos.push('Mencionar a especialidade explicitamente');
  }
  
  return {
    valido: erros.length === 0,
    erros,
    requisitos,
    comprimento: prompt.length,
    temProfissional,
    temCrianca
  };
}

/**
 * 🔗 Gera nome do arquivo
 */
function gerarNomeArquivo(especialidadeId, timestamp = Date.now()) {
  return `veo_${especialidadeId}_${timestamp}`;
}

/**
 * 📊 Simula polling de status
 */
async function simularPolling(operation, maxWaitMs = 8 * 60 * 1000, pollIntervalMs = 15000) {
  const startTime = Date.now();
  let attempts = 0;
  
  while (!operation.done) {
    if (Date.now() - startTime > maxWaitMs) {
      throw new Error('Timeout: vídeo não gerado em 8 minutos');
    }
    
    attempts++;
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    
    // Simula atualização do operation
    if (operation.simulateProgress) {
      operation.simulateProgress(attempts);
    }
  }
  
  if (operation.error) {
    throw new Error(`Erro da API Veo: ${operation.error.message}`);
  }
  
  return {
    completed: true,
    attempts,
    duration: Date.now() - startTime
  };
}

// =============================================================================
// TESTES
// =============================================================================

describe('🎬 Veo 3.1 Service', () => {

  // ===========================================================================
  // TESTES DE CONFIGURAÇÃO
  // ===========================================================================
  
  describe('⚙️ Configuração', () => {
    
    it('Deve retornar true quando GOOGLE_AI_API_KEY está configurada', () => {
      expect(isVeoConfigured('sk-test123')).toBe(true);
    });

    it('Deve retornar false quando GOOGLE_AI_API_KEY é vazia', () => {
      expect(isVeoConfigured('')).toBe(false);
    });

    it('Deve retornar false quando GOOGLE_AI_API_KEY é null', () => {
      expect(isVeoConfigured(null)).toBe(false);
    });

    it('Deve retornar false quando GOOGLE_AI_API_KEY é undefined', () => {
      expect(isVeoConfigured(undefined)).toBe(false);
    });

    it('Deve retornar true para string não vazia', () => {
      expect(isVeoConfigured('qualquer-chave')).toBe(true);
    });
  });

  // ===========================================================================
  // TESTES DE PROMPTS
  // ===========================================================================
  
  describe('📝 Prompts Cinematográficos', () => {
    
    it('Deve ter 9 especialidades configuradas', () => {
      expect(Object.keys(PROMPTS_ESPECIALIDADE)).toHaveLength(9);
    });

    it('Cada prompt deve ter pelo menos 200 caracteres', () => {
      Object.entries(PROMPTS_ESPECIALIDADE).forEach(([especialidade, prompt]) => {
        expect(prompt.length, `Prompt de ${especialidade} muito curto`).toBeGreaterThan(200);
      });
    });

    it('Cada prompt deve mencionar 24fps', () => {
      Object.entries(PROMPTS_ESPECIALIDADE).forEach(([especialidade, prompt]) => {
        expect(prompt, `Prompt de ${especialidade} sem 24fps`).toContain('24fps');
      });
    });

    it('Cada prompt deve ter estilo documental', () => {
      Object.entries(PROMPTS_ESPECIALIDADE).forEach(([especialidade, prompt]) => {
        expect(prompt.toLowerCase(), `Prompt de ${especialidade} sem estilo documental`)
          .toContain('documental');
      });
    });

    it('Deve construir prompt customizado corretamente', () => {
      const tema = 'Exercício de sopro com bolhas';
      const prompt = buildCustomPrompt(tema, 'fonoaudiologia');
      
      expect(prompt.startsWith(tema)).toBe(true);
      expect(prompt).toContain('24fps');
    });

    it('Deve usar fallback fonoaudiologia quando especialidade não existe', () => {
      const tema = 'Tema customizado';
      const prompt = buildCustomPrompt(tema, 'especialidade_inexistente');
      
      expect(prompt.startsWith(tema)).toBe(true);
      expect(prompt).toContain('24fps');
    });

    it('Prompt customizado deve ter comprimento adequado', () => {
      const tema = 'Criança lendo';
      const prompt = buildCustomPrompt(tema, 'psicopedagogia');
      
      expect(prompt.length).toBeGreaterThan(100);
      expect(prompt).toContain('24fps');
      expect(prompt).toContain(tema);
    });
  });

  // ===========================================================================
  // TESTES DE VALIDAÇÃO DE PARÂMETROS
  // ===========================================================================
  
  describe('✅ Validação de Parâmetros', () => {
    
    it('Deve validar parâmetros padrão (8s, 9:16)', () => {
      const validacao = validarParametrosVeo();
      
      expect(validacao.valido).toBe(true);
      expect(validacao.parametros.durationSeconds).toBe(8);
      expect(validacao.parametros.aspectRatio).toBe('9:16');
    });

    it('Deve validar parâmetros personalizados válidos', () => {
      const validacao = validarParametrosVeo({ 
        durationSeconds: 5, 
        aspectRatio: '16:9' 
      });
      
      expect(validacao.valido).toBe(true);
      expect(validacao.parametros.durationSeconds).toBe(5);
      expect(validacao.parametros.aspectRatio).toBe('16:9');
    });

    it('Deve rejeitar duração maior que 8 segundos (plano gratuito)', () => {
      const validacao = validarParametrosVeo({ durationSeconds: 10 });
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Duração máxima para plano gratuito é 8 segundos');
    });

    it('Deve rejeitar duração menor que 1 segundo', () => {
      const validacao = validarParametrosVeo({ durationSeconds: 0 });
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Duração mínima é 1 segundo');
    });

    it('Deve rejeitar aspect ratio inválido', () => {
      const validacao = validarParametrosVeo({ aspectRatio: '4:3' });
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros.some(e => e.includes('Aspect ratio'))).toBe(true);
    });

    it('Deve aceitar aspect ratio 1:1', () => {
      const validacao = validarParametrosVeo({ aspectRatio: '1:1' });
      
      expect(validacao.valido).toBe(true);
    });
  });

  // ===========================================================================
  // TESTES DE TEMPO ESTIMADO
  // ===========================================================================
  
  describe('⏱️ Tempo Estimado', () => {
    
    it('Deve estimar 3-5 minutos para vídeo curto', () => {
      const tempo = calcularTempoEstimado(5);
      
      expect(tempo.minutos).toBeGreaterThanOrEqual(3);
      expect(tempo.minutos).toBeLessThanOrEqual(5);
      expect(tempo.descricao).toMatch(/\d+-\d+ minutos/);
    });

    it('Deve estimar tempo maior para vídeo mais longo', () => {
      const tempoCurto = calcularTempoEstimado(1);
      const tempoLongo = calcularTempoEstimado(8);
      
      expect(tempoLongo.minutos).toBeGreaterThanOrEqual(tempoCurto.minutos);
    });

    it('Deve retornar tempo em segundos', () => {
      const tempo = calcularTempoEstimado(8);
      
      expect(tempo.segundos).toBe(tempo.minutos * 60);
    });
  });

  // ===========================================================================
  // TESTES DE VALIDAÇÃO DE PROMPT
  // ===========================================================================
  
  describe('🎨 Validação de Prompt Cinematográfico', () => {
    
    it('Deve validar prompt completo', () => {
      const prompt = PROMPTS_ESPECIALIDADE.fonoaudiologia;
      const validacao = validarPromptCinematografico(prompt, 'fonoaudiologia');
      
      expect(validacao.valido).toBe(true);
      expect(validacao.temProfissional).toBe(true);
      expect(validacao.temCrianca).toBe(true);
    });

    it('Deve rejeitar prompt muito curto', () => {
      const prompt = 'Video de terapia';
      const validacao = validarPromptCinematografico(prompt, 'fonoaudiologia');
      
      expect(validacao.valido).toBe(false);
      expect(validacao.erros).toContain('Prompt cinematográfico muito curto');
    });

    it('Deve detectar falta de descrição de profissional', () => {
      const prompt = 'Close-up cinematográfico em 24fps com luz natural suave de ambiente, apenas criança pequena brincando sozinha em sala ampla moderna';
      const validacao = validarPromptCinematografico(prompt, 'fonoaudiologia');
      
      expect(validacao.temProfissional).toBe(false);
      expect(validacao.erros).toContain('Prompt deve descrever o profissional terapeuta');
    });

    it('Deve detectar falta de descrição de criança', () => {
      const prompt = 'Close-up cinematográfico profissional em 24fps com luz natural suave, terapeuta adulto em sala moderna de atendimento';
      const validacao = validarPromptCinematografico(prompt, 'fonoaudiologia');
      
      expect(validacao.temCrianca).toBe(false);
      expect(validacao.erros).toContain('Prompt deve descrever a criança/paciente');
    });

    it('Deve listar elementos cinematográficos faltantes', () => {
      const prompt = 'Video de clinica';
      const validacao = validarPromptCinematografico(prompt, 'fonoaudiologia');
      
      expect(validacao.requisitos.length + validacao.erros.length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // TESTES DE GERAÇÃO DE NOME DE ARQUIVO
  // ===========================================================================
  
  describe('📁 Nome de Arquivo', () => {
    
    it('Deve gerar nome no formato correto', () => {
      const nome = gerarNomeArquivo('fonoaudiologia', 1234567890);
      
      expect(nome).toBe('veo_fonoaudiologia_1234567890');
      expect(nome.startsWith('veo_')).toBe(true);
    });

    it('Deve incluir timestamp quando não fornecido', () => {
      const antes = Date.now();
      const nome = gerarNomeArquivo('psicologia');
      const depois = Date.now();
      
      const timestamp = parseInt(nome.split('_')[2]);
      expect(timestamp).toBeGreaterThanOrEqual(antes);
      expect(timestamp).toBeLessThanOrEqual(depois);
    });

    it('Deve funcionar com diferentes especialidades', () => {
      const especialidades = ['fonoaudiologia', 'psicologia', 'terapia_ocupacional'];
      
      especialidades.forEach(esp => {
        const nome = gerarNomeArquivo(esp, 123);
        expect(nome).toContain(esp);
      });
    });
  });

  // ===========================================================================
  // TESTES DE POLLING
  // ===========================================================================
  
  describe('⏳ Polling de Geração', () => {
    
    it('Deve completar quando operation.done é true', async () => {
      const operation = { done: true };
      
      const resultado = await simularPolling(operation, 1000, 100);
      
      expect(resultado.completed).toBe(true);
      expect(resultado.attempts).toBe(0);
    });

    it('Deve lançar erro em timeout', async () => {
      const operation = { 
        done: false,
        simulateProgress: () => {} // Nunca completa
      };
      
      await expect(simularPolling(operation, 100, 50))
        .rejects.toThrow('Timeout');
    });

    it('Deve lançar erro quando operation tem error', async () => {
      const operation = {
        done: true,
        error: { message: 'Erro na API' }
      };
      
      await expect(simularPolling(operation))
        .rejects.toThrow('Erro na API');
    });

    it('Deve contar tentativas corretamente', async () => {
      let attempts = 0;
      const operation = {
        done: false,
        simulateProgress: (a) => {
          attempts = a;
          if (a >= 3) operation.done = true;
        }
      };
      
      const resultado = await simularPolling(operation, 5000, 10);
      
      expect(resultado.attempts).toBe(3);
    });
  });

  // ===========================================================================
  // TESTES INTEGRADOS
  // ===========================================================================
  
  describe('🔄 Fluxos Integrados', () => {
    
    it('Fluxo completo: Config → Prompt → Validação → Tempo', () => {
      // 1. Verifica configuração
      const apiKey = 'sk-test';
      expect(isVeoConfigured(apiKey)).toBe(true);
      
      // 2. Gera prompt
      const prompt = buildCustomPrompt('Exercício de fala', 'fonoaudiologia');
      expect(prompt).toContain('24fps');
      
      // 3. Valida parâmetros
      const validacaoParams = validarParametrosVeo({ durationSeconds: 8, aspectRatio: '9:16' });
      expect(validacaoParams.valido).toBe(true);
      
      // 4. Calcula tempo
      const tempo = calcularTempoEstimado(8);
      expect(tempo.minutos).toBeGreaterThanOrEqual(3);
    });

    it('Deve detectar configuração ausente antes de gerar', () => {
      const apiKey = '';
      
      if (!isVeoConfigured(apiKey)) {
        // Não deve tentar gerar
        expect(true).toBe(true);
      } else {
        throw new Error('Não deveria chegar aqui');
      }
    });

    it('Todos os prompts devem conter elementos cinematográficos', () => {
      Object.entries(PROMPTS_ESPECIALIDADE).forEach(([especialidade, prompt]) => {
        // Verifica elementos essenciais
        expect(prompt, `Prompt de ${especialidade} sem 24fps`).toContain('24fps');
        expect(prompt, `Prompt de ${especialidade} sem estilo documental`)
          .toMatch(/documental/i);
        expect(prompt.length, `Prompt de ${especialidade} muito curto`).toBeGreaterThan(200);
      });
    });
  });
});

// Exportar funções para reuso
export {
  isVeoConfigured,
  buildCustomPrompt,
  validarParametrosVeo,
  calcularTempoEstimado,
  validarPromptCinematografico,
  gerarNomeArquivo,
  simularPolling,
  PROMPTS_ESPECIALIDADE
};
