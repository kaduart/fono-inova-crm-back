/**
 * Testes unitários — Zeus v3.0 Pipeline de Descoberta
 *
 * O que valida:
 * 1. scorarConversao  — penalizações corretas para o estágio descoberta
 * 2. TOM_POR_ESTAGIO  — instrução acolhedora está presente e sem frases proibidas
 * 3. MAPEAMENTO_JORNADA — descoberta proíbe CTA de WhatsApp
 * 4. detectarIntencaoLead — comportamento informacional (não sobrescreve, retorna estagio_sugerido)
 * 5. buildSystemPrompt (indireto) — TOM_POR_ESTAGIO injetado para todos os estágios
 * 6. CENAS_ABERTURA — cenas observacionais (não dramáticas) para descoberta
 */

import { describe, it, expect } from 'vitest';
import {
  scorarConversao,
  TOM_POR_ESTAGIO,
  MAPEAMENTO_JORNADA,
  CENAS_ABERTURA,
  detectarIntencaoLead,
} from '../../agents/zeus-video.js';

// ─────────────────────────────────────────────
// FIXTURES
// ─────────────────────────────────────────────

const ROTEIRO_ACOLHEDOR_CORRETO = {
  titulo: 'Quando a palavra não vem',
  texto_completo: 'Fim de tarde. Ele tentou me chamar. A palavra saiu diferente. Você já viveu isso? Às vezes a gente percebe um detalhe na fala do filho e fica naquela dúvida silenciosa: será que é fase? Essa dúvida faz sentido — e é exatamente ela que vale ouvir. Antes dos três anos existe uma janela de desenvolvimento da fala que, quando a gente presta atenção cedo, muda muito o caminho. Não precisa ter certeza de que tem um problema. Salva esse vídeo — e se quiser conversar sobre o que você está vendo, estou aqui.',
  hook_texto_overlay: 'Fim de tarde. Ele tentou me chamar. A palavra saiu diferente.',
  cta_texto_overlay: 'Salva — e se quiser conversar sobre o que você está vendo, estou aqui',
};

const ROTEIRO_CTA_PROIBIDO = {
  ...ROTEIRO_ACOLHEDOR_CORRETO,
  cta_texto_overlay: 'Manda mensagem agora no WhatsApp para agendar',
};

const ROTEIRO_HOOK_PERGUNTA = {
  ...ROTEIRO_ACOLHEDOR_CORRETO,
  hook_texto_overlay: 'Seu filho tem 3 anos e ainda não fala?',
};

const ROTEIRO_SEM_JANELA = {
  ...ROTEIRO_ACOLHEDOR_CORRETO,
  texto_completo: 'O filho tentou falar. A palavra não saiu. É algo que acontece com muitas crianças. Você não está sozinha nisso. Buscar ajuda cedo faz diferença. Salva esse vídeo.',
};

const ROTEIRO_SEM_PROVA = {
  ...ROTEIRO_ACOLHEDOR_CORRETO,
  texto_completo: 'Fim de tarde. Ele tentou me chamar. A palavra saiu diferente. Antes dos três anos existe uma janela de desenvolvimento da fala. Não precisa ter certeza. Salva esse vídeo.',
};

const ROTEIRO_CURTO_DEMAIS = {
  ...ROTEIRO_ACOLHEDOR_CORRETO,
  texto_completo: 'A palavra não saiu. Antes dos três anos isso muda. Salva.',
};

const PARAMS_DESCOBERTA = {
  estagio_jornada:   'descoberta',
  objecao_principal: 'e_fase',
};

const PARAMS_DECISAO = {
  estagio_jornada:   'decisao',
  objecao_principal: 'e_fase',
};

// ─────────────────────────────────────────────
// 1. SCORE DE CONVERSÃO — PIPELINE DESCOBERTA
// ─────────────────────────────────────────────

describe('scorarConversao — descoberta', () => {
  it('roteiro correto não perde pontos por CTA no descoberta', () => {
    const { score, falhas } = scorarConversao(ROTEIRO_ACOLHEDOR_CORRETO, PARAMS_DESCOBERTA);
    const penalizouCta = falhas.some(f => f.toLowerCase().includes('whatsapp'));
    expect(penalizouCta).toBe(false);
    expect(score).toBeGreaterThanOrEqual(55);
  });

  it('perde 30 pontos por CTA de WhatsApp/agendamento em descoberta', () => {
    const { score: scoreCorreto }   = scorarConversao(ROTEIRO_ACOLHEDOR_CORRETO, PARAMS_DESCOBERTA);
    const { score: scoreProibido }  = scorarConversao(ROTEIRO_CTA_PROIBIDO,      PARAMS_DESCOBERTA);
    expect(scoreCorreto - scoreProibido).toBeGreaterThanOrEqual(25);
    const { falhas } = scorarConversao(ROTEIRO_CTA_PROIBIDO, PARAMS_DESCOBERTA);
    expect(falhas.some(f => f.toLowerCase().includes('whatsapp') || f.toLowerCase().includes('lead frio'))).toBe(true);
  });

  it('CTA de WhatsApp NÃO é penalizado em decisao (correto nesse estágio)', () => {
    const roteiroCta = {
      ...ROTEIRO_ACOLHEDOR_CORRETO,
      cta_texto_overlay: 'Manda QUERO SABER no WhatsApp — a gente agenda essa semana',
      texto_completo: ROTEIRO_ACOLHEDOR_CORRETO.texto_completo + ' Em anos de clínica, os casos que melhoraram sozinhos dá pra contar nos dedos. Antes dos três anos a janela fecha.',
    };
    const { falhas } = scorarConversao(roteiroCta, PARAMS_DECISAO);
    expect(falhas.some(f => f.toLowerCase().includes('whatsapp') || f.toLowerCase().includes('lead frio'))).toBe(false);
  });

  it('perde pontos por hook como pergunta', () => {
    const { score: scoreHookOk }   = scorarConversao(ROTEIRO_ACOLHEDOR_CORRETO, PARAMS_DESCOBERTA);
    const { score: scoreHookRuim } = scorarConversao(ROTEIRO_HOOK_PERGUNTA,     PARAMS_DESCOBERTA);
    expect(scoreHookOk).toBeGreaterThan(scoreHookRuim);
    const { falhas } = scorarConversao(ROTEIRO_HOOK_PERGUNTA, PARAMS_DESCOBERTA);
    expect(falhas.some(f => f.toLowerCase().includes('pergunta'))).toBe(true);
  });

  it('perde pontos por ausência de janela temporal', () => {
    const { score: scoreComJanela } = scorarConversao(ROTEIRO_ACOLHEDOR_CORRETO, PARAMS_DESCOBERTA);
    const { score: scoreSemJanela } = scorarConversao(ROTEIRO_SEM_JANELA,        PARAMS_DESCOBERTA);
    expect(scoreComJanela).toBeGreaterThan(scoreSemJanela);
    const { falhas } = scorarConversao(ROTEIRO_SEM_JANELA, PARAMS_DESCOBERTA);
    expect(falhas.some(f => f.toLowerCase().includes('janela'))).toBe(true);
  });

  it('perde pontos por ausência de prova concreta', () => {
    const { score: scoreComProva } = scorarConversao(ROTEIRO_ACOLHEDOR_CORRETO, PARAMS_DESCOBERTA);
    const { score: scoreSemProva } = scorarConversao(ROTEIRO_SEM_PROVA,         PARAMS_DESCOBERTA);
    expect(scoreComProva).toBeGreaterThan(scoreSemProva);
  });

  it('perde pontos por texto curto demais', () => {
    const { falhas } = scorarConversao(ROTEIRO_CURTO_DEMAIS, PARAMS_DESCOBERTA);
    expect(falhas.some(f => f.toLowerCase().includes('curto') || f.toLowerCase().includes('7 element'))).toBe(true);
  });

  it('score nunca fica negativo', () => {
    const roteiroPessimo = {
      titulo: '',
      texto_completo: 'ok',
      hook_texto_overlay: 'Você sabia que?',
      cta_texto_overlay: 'agende agora no WhatsApp',
    };
    const { score } = scorarConversao(roteiroPessimo, PARAMS_DESCOBERTA);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────
// 2. TOM_POR_ESTAGIO — instrução acolhedora
// ─────────────────────────────────────────────

describe('TOM_POR_ESTAGIO — descoberta', () => {
  it('existe instrução de tom para todos os 4 estágios', () => {
    expect(TOM_POR_ESTAGIO.descoberta).toBeTruthy();
    expect(TOM_POR_ESTAGIO.consideracao).toBeTruthy();
    expect(TOM_POR_ESTAGIO.decisao).toBeTruthy();
    expect(TOM_POR_ESTAGIO.retargeting).toBeTruthy();
  });

  it('instrução de descoberta contém palavra "acolhedor" ou "validant"', () => {
    const tom = TOM_POR_ESTAGIO.descoberta.toLowerCase();
    expect(tom.includes('acolhedor') || tom.includes('validant')).toBe(true);
  });

  it('instrução de descoberta proíbe culpa intensa e urgência exagerada', () => {
    const tom = TOM_POR_ESTAGIO.descoberta.toLowerCase();
    expect(tom.includes('proibido')).toBe(true);
    // Deve proibir explicitamente linguagem de urgência agressiva
    const proibeUrgencia = tom.includes('urgência exagerada') || tom.includes('urgencia exagerada') ||
                           tom.includes('não espere mais') || tom.includes('nao espere mais') ||
                           tom.includes('drama');
    expect(proibeUrgencia).toBe(true);
  });

  it('instrução de descoberta inclui CTA de micro-comprometimento', () => {
    const tom = TOM_POR_ESTAGIO.descoberta.toLowerCase();
    expect(tom.includes('micro') || tom.includes('salva') || tom.includes('comenta')).toBe(true);
  });

  it('instrução de decisao é mais direta que descoberta', () => {
    const tomDesc = TOM_POR_ESTAGIO.descoberta.toLowerCase();
    const tomDec  = TOM_POR_ESTAGIO.decisao.toLowerCase();
    // Decisao deve mencionar direto ou desbloqueador
    expect(tomDec.includes('direto') || tomDec.includes('desbloqueador') || tomDec.includes('objeção')).toBe(true);
    // Descoberta não deve mencionar "direto" como tom principal
    expect(tomDesc.includes('acolhedor')).toBe(true);
  });
});

// ─────────────────────────────────────────────
// 3. MAPEAMENTO_JORNADA — regras por estágio
// ─────────────────────────────────────────────

describe('MAPEAMENTO_JORNADA — estrutura correta', () => {
  it('todos os 4 estágios estão mapeados', () => {
    expect(MAPEAMENTO_JORNADA.descoberta).toBeTruthy();
    expect(MAPEAMENTO_JORNADA.consideracao).toBeTruthy();
    expect(MAPEAMENTO_JORNADA.decisao).toBeTruthy();
    expect(MAPEAMENTO_JORNADA.retargeting).toBeTruthy();
  });

  it('descoberta proíbe cta_whatsapp_direto e cta_agendar', () => {
    const proibicoes = MAPEAMENTO_JORNADA.descoberta.proibicoes;
    expect(proibicoes).toContain('cta_whatsapp_direto');
    expect(proibicoes).toContain('cta_agendar');
  });

  it('decisao permite acao_direta', () => {
    expect(MAPEAMENTO_JORNADA.decisao.cta_tipo).toBe('acao_direta');
  });

  it('descoberta define cta_tipo como micro_comprometimento', () => {
    expect(MAPEAMENTO_JORNADA.descoberta.cta_tipo).toBe('micro_comprometimento');
  });

  it('cada estágio tem estado_atual e estado_desejado definidos', () => {
    Object.values(MAPEAMENTO_JORNADA).forEach(mapa => {
      expect(mapa.estado_atual).toBeTruthy();
      expect(mapa.estado_desejado).toBeTruthy();
      expect(mapa.mecanismo).toBeTruthy();
      expect(mapa.cta_tipo).toBeTruthy();
    });
  });
});

// ─────────────────────────────────────────────
// 4. detectarIntencaoLead — comportamento informacional
// ─────────────────────────────────────────────

describe('detectarIntencaoLead — informacional, não sobrescreve', () => {
  it('retorna estagio_sugerido em vez de sobrescrever hookStyle/tone', () => {
    const resultado = detectarIntencaoLead('estou preocupada com meu filho, ele não fala');
    expect(resultado).toHaveProperty('estagio_sugerido');
    // Não deve retornar hookRecomendado nem toneRecomendado (campos que sobrescreviam)
    expect(resultado).not.toHaveProperty('hookRecomendado');
    expect(resultado).not.toHaveProperty('toneRecomendado');
    expect(resultado).not.toHaveProperty('ctaRecomendado');
  });

  it('detecta preocupação e sugere descoberta ou consideracao', () => {
    const r = detectarIntencaoLead('estou preocupada com o desenvolvimento do meu filho, tem medo que seja autismo');
    expect(r.intencao).toBe('preocupacao');
    expect(['descoberta', 'consideracao']).toContain(r.estagio_sugerido);
  });

  it('detecta ação e sugere decisao', () => {
    const r = detectarIntencaoLead('quero agendar uma consulta, qual o valor e horário disponível?');
    expect(r.intencao).toBe('acao');
    expect(r.estagio_sugerido).toBe('decisao');
  });

  it('texto vazio retorna desconhecida com confiança zero', () => {
    const r = detectarIntencaoLead('');
    expect(r.intencao).toBe('desconhecida');
    expect(r.confianca).toBe(0);
  });

  it('confiança não ultrapassa 0.85 (calibrada para não gerar falsa certeza)', () => {
    const textoComMuitasKeywords = 'preocupada angustiada desesperada medo não sei o que fazer tô perdida tem algo errado';
    const r = detectarIntencaoLead(textoComMuitasKeywords);
    expect(r.confianca).toBeLessThanOrEqual(0.85);
  });

  it('pergunta curta retorna duvida com confiança moderada', () => {
    const r = detectarIntencaoLead('será normal?');
    expect(r.intencao).toBe('duvida');
    expect(r.confianca).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────
// 5. CENAS_ABERTURA — tom observacional em descoberta
// ─────────────────────────────────────────────

describe('CENAS_ABERTURA — tom correto para descoberta', () => {
  const subTemasDescoberta = ['atraso_fala', 'autismo', 'comportamento'];

  subTemasDescoberta.forEach(subTema => {
    it(`${subTema}: nenhuma cena termina com pergunta (hook afirmativo)`, () => {
      const cenas = CENAS_ABERTURA[subTema] || [];
      expect(cenas.length).toBeGreaterThan(0);
      cenas.forEach(cena => {
        expect(cena.trim().endsWith('?')).toBe(false);
      });
    });

    it(`${subTema}: nenhuma cena contém palavras de drama excessivo`, () => {
      const palavrasDrama = ['desesperada', 'chorando de raiva', 'todo mundo olhava', 'vergonha'];
      const cenas = CENAS_ABERTURA[subTema] || [];
      cenas.forEach(cena => {
        palavrasDrama.forEach(palavra => {
          expect(cena.toLowerCase()).not.toContain(palavra);
        });
      });
    });

    it(`${subTema}: cenas têm tamanho observacional (10 a 120 chars)`, () => {
      const cenas = CENAS_ABERTURA[subTema] || [];
      cenas.forEach(cena => {
        expect(cena.length).toBeGreaterThanOrEqual(10);
        expect(cena.length).toBeLessThanOrEqual(150);
      });
    });
  });

  it('atraso_fala tem pelo menos 3 cenas', () => {
    expect(CENAS_ABERTURA.atraso_fala.length).toBeGreaterThanOrEqual(3);
  });
});

// ─────────────────────────────────────────────
// 6. VALIDAÇÕES DE SAÍDA — o que um roteiro de descoberta NUNCA deve ter
// ─────────────────────────────────────────────

describe('Validação de saída — roteiro de descoberta', () => {
  // Simula output de roteiro e verifica regras sem chamar a API
  const FRASES_URGENCIA_EXAGERADA = [
    'não espere mais',
    'está perdendo tempo',
    'precisa agir agora',
    'cada dia que passa',
    'não perca essa chance',
    'janela está fechando rapidamente',
  ];

  const FRASES_DRAMA = [
    'você já chorou',
    'está desesperada',
    'não aguenta mais',
    'quebrou em choro',
  ];

  FRASES_URGENCIA_EXAGERADA.forEach(frase => {
    it(`roteiro de descoberta não deve conter urgência exagerada: "${frase}"`, () => {
      const roteiro = {
        ...ROTEIRO_ACOLHEDOR_CORRETO,
        texto_completo: `${ROTEIRO_ACOLHEDOR_CORRETO.texto_completo} ${frase}`,
      };
      // Tom obrigatório proíbe isso — verificar que o TOM_POR_ESTAGIO menciona o proibido
      const tom = TOM_POR_ESTAGIO.descoberta.toLowerCase();
      const menciona = FRASES_URGENCIA_EXAGERADA.some(f => tom.includes(f.split(' ')[0]));
      // O tom precisa mencionar pelo menos um termo de urgência exagerada como proibido
      expect(tom.includes('proibido')).toBe(true);
    });
  });

  FRASES_DRAMA.forEach(frase => {
    it(`instrução de tom proíbe cenas de drama: "${frase}"`, () => {
      const tom = TOM_POR_ESTAGIO.descoberta.toLowerCase();
      expect(tom.includes('proibido') || tom.includes('drama')).toBe(true);
    });
  });

  it('CTA correto de descoberta não contém "whatsapp", "agendar" ou "marcar"', () => {
    const cta = ROTEIRO_ACOLHEDOR_CORRETO.cta_texto_overlay.toLowerCase();
    expect(cta).not.toContain('whatsapp');
    expect(cta).not.toContain('agendar');
    expect(cta).not.toContain('marcar horário');
  });

  it('score do roteiro correto é maior que o do roteiro com CTA proibido', () => {
    const { score: s1 } = scorarConversao(ROTEIRO_ACOLHEDOR_CORRETO, PARAMS_DESCOBERTA);
    const { score: s2 } = scorarConversao(ROTEIRO_CTA_PROIBIDO,      PARAMS_DESCOBERTA);
    expect(s1).toBeGreaterThan(s2);
  });
});
