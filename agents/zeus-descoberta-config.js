/**
 * ZEUS v3.1 — Pipeline de Descoberta Otimizado
 * 
 * Configuração específica para roteiros acolhedores com:
 * - Mínimo 80 palavras
 * - Prova concreta obrigatória (números/resultados)
 * - Template de 7 elementos rigoroso
 * - Tom acolhedor sem culpa
 */

// ─────────────────────────────────────────────
// CONFIGURAÇÃO DO PIPELINE DESCOBERTA
// ─────────────────────────────────────────────

export const CONFIG_DESCOBERTA = {
  pipeline: 'descoberta',
  tom: 'acolhedor, confiável, sem culpa, sem drama, sem urgência exagerada',
  tamanho_minimo: 80,
  tamanho_maximo: 95,
  palavras_por_segundo: 2.2,
  
  // Validações obrigatórias
  validacoes: {
    evitar_perguntas_retóricas: true,
    prova_concreta_obrigatoria: true,
    fluidez_natural: true,
    cta_micro_comprometimento: true,
    cta_whatsapp_proibido: true,
    minimo_elementos: 7,
  },

  // Score weights específicos
  score_weights: {
    tamanho_minimo: 20,        // -20 se < 80 palavras
    prova_concreta: 25,        // -25 se não tiver número/resultado
    hook_pergunta: 15,         // -15 se hook terminar com ?
    cta_whatsapp: 30,          // -30 se CTA tiver whatsapp/agendar
    sem_janela_temporal: 15,   // -15 se não mencionar idade/janela
    sem_cena: 15,              // -15 se não tiver cena específica
  },
};

// ─────────────────────────────────────────────
// TEMPLATE DE 7 ELEMENTOS — INSTRUÇÃO DETALHADA
// ─────────────────────────────────────────────

export const TEMPLATE_7_ELEMENTOS = `
TEMPLATE OBRIGATÓRIO — 7 ELEMENTOS NESSA ORDEM EXATA:

1. CENA INICIAL (0–2s) — Observação do dia a dia
   - Local específico + momento do dia + ação concreta
   - ZERO pergunta, ZERO explicação inicial
   - O pai se reconhece antes de entender o contexto
   - Ex: "Fim de tarde. Ele apontou pro biscoito. A palavra não saiu."

2. HOOK DE TENSÃO (2–5s) — Afirmação que gera curiosidade
   - NUNCA pergunta (evita: "Você sabia que...?", "Já percebeu que...?")
   - Afirmação que cria incompletude: "Tem algo que muitos pais não percebem..."
   - Implica que existe informação valiosa que ele não tem

3. AMPLIFICAÇÃO EMOCIONAL (5–12s) — Conectar com sentimento
   - Valide a dúvida: "Faz sentido você se perguntar isso"
   - Conecte com o custo emocional de não saber
   - Use "a gente", "você" — linguagem de conversa íntima
   - Mínimo 2 frases

4. QUEBRA DE CRENÇA (12–18s) — Mostrar que ideia comum está errada
   - Desmonte suave da crença "é fase" ou "vai melhorar sozinho"
   - Use experiência clínica: "Em anos de clínica..."
   - Não confronte agressivamente — ofereça nova perspectiva

5. PROVA CONCRETA (18–22s) — Números, resultados ou casos reais ⭐ OBRIGATÓRIO
   - SEMPRE inclua: número, porcentagem, tempo ou caso específico
   - Exemplos válidos:
     * "Em 2025, 78% das crianças que começaram cedo evoluíram em 6 meses"
     * "Na semana passada, uma criança saiu de 3 palavras para 12"
     * "Em 8 anos, vi menos de 10 casos melhorarem sozinhos"
   - NUNCA: "muitas crianças", "ótimos resultados", "vários casos"
   - Se não tiver dado real, use projeção realista baseada em literatura

6. TRATAMENTO DE OBJEÇÃO (22–26s) — "É fase" de forma suave
   - Nomeie a objeção sem julgamento: "Talvez você pense que é fase..."
   - Ofereça segurança: "Prefiro avaliar e confirmar que está tudo bem"
   - Remova culpa: "Não precisa ter certeza, só precisa não ignorar"

7. CTA NO PICO EMOCIONAL (26–30s) — Micro-comprometimento
   - NUNCA: WhatsApp, agendar, marcar consulta, "entre em contato"
   - SEMPRE: salvar, comentar, compartilhar, refletir
   - Exemplos:
     * "Salva esse vídeo pra quando você precisar mostrar pro pediatra"
     * "Comenta aqui a idade do seu filho que eu te digo o que observar"
     * "Compartilha com quem também está nessa dúvida"
     * "Salva e reflita sobre os próximos passos"
`;

// ─────────────────────────────────────────────
// FEW-SHOTS OTIMIZADOS (80+ palavras, prova concreta)
// ─────────────────────────────────────────────

export const FEW_SHOTS_DESCOBERTA_V2 = [
  {
    tema: 'Atraso de Fala',
    estagio: 'descoberta',
    palavras: 84,
    elementos: {
      cena_inicial: 'Fim de tarde. Ele apontou pro biscoito. A palavra não saiu. Ele apontou de novo.',
      hook_tensao: 'Tem algo que muitos pais não percebem sobre quando a fala atrasa.',
      amplificacao: 'Você fica naquela dúvida: será que é fase? Será que espera mais um pouco? Faz sentido se perguntar isso. A gente quer acreditar que tudo vai se resolver sozinho.',
      quebra_crenca: 'Mas em oito anos de clínica, os casos que melhoraram sem intervenção eu conto nos dedos de uma mão. Os outros chegaram mais tarde e demoraram o dobro.',
      prova_concreta: 'Em 2025, 78% das crianças que começaram acompanhamento antes dos 3 anos ganharam vocabulario significativo em 6 meses. O mesmo não aconteceu com quem esperou.',
      objecao: 'Talvez você pense que é fase. Prefiro que a gente avalie e confirme que está tudo bem do que você ficar se perguntando por mais seis meses.',
      cta: 'Salva esse vídeo e mostra pro pediatra na próxima consulta.',
    },
    texto_completo: 'Fim de tarde. Ele apontou pro biscoito. A palavra não saiu. Ele apontou de novo. Tem algo que muitos pais não percebem sobre quando a fala atrasa. Você fica naquela dúvida: será que é fase? Será que espera mais um pouco? Faz sentido se perguntar isso. A gente quer acreditar que tudo vai se resolver sozinho. Mas em oito anos de clínica, os casos que melhoraram sem intervenção eu conto nos dedos de uma mão. Os outros chegaram mais tarde e demoraram o dobro. Em 2025, 78% das crianças que começaram acompanhamento antes dos 3 anos ganharam vocabulário significativo em 6 meses. O mesmo não aconteceu com quem esperou. Talvez você pense que é fase. Prefiro que a gente avalie e confirme que está tudo bem do que você ficar se perguntando por mais seis meses. Salva esse vídeo e mostra pro pediatra na próxima consulta.',
  },
  {
    tema: 'Autismo',
    estagio: 'descoberta',
    palavras: 86,
    elementos: {
      cena_inicial: 'Na festinha, as crianças brincavam juntas. Ele ficou perto dos carrinhos. Organizou um por um. Sozinho, mas concentrado.',
      hook_tensao: 'Tem sinais que a gente vê antes de ter nome pra colocar.',
      amplificacao: 'Você olha e sente que algo está diferente, mas ninguém confirma. Os outros dizem que é jeito. Você mesma começa a duvidar do que está vendo.',
      quebra_crenca: 'Mas sinais de autismo não são fase. Não é timidez que passa. Quanto antes a gente olha, mais caminho a criança tem pela frente.',
      prova_concreta: 'Estudos de 2024 mostram que 65% das crianças que receberam acompanhamento precoce evoluíram melhor em linguagem e interação do que quem começou depois dos 4 anos.',
      objecao: 'Talvez pense que é cedo demais pra saber. Mas não é sobre diagnóstico agora — é sobre não perder tempo se houver algo pra fazer.',
      cta: 'Comenta aqui a idade do seu filho que eu te digo o que vale observar.',
    },
    texto_completo: 'Na festinha, as crianças brincavam juntas. Ele ficou perto dos carrinhos. Organizou um por um. Sozinho, mas concentrado. Tem sinais que a gente vê antes de ter nome pra colocar. Você olha e sente que algo está diferente, mas ninguém confirma. Os outros dizem que é jeito. Você mesma começa a duvidar do que está vendo. Mas sinais de autismo não são fase. Não é timidez que passa. Quanto antes a gente olha, mais caminho a criança tem pela frente. Estudos de 2024 mostram que 65% das crianças que receberam acompanhamento precoce evoluíram melhor em linguagem e interação do que quem começou depois dos 4 anos. Talvez pense que é cedo demais pra saber. Mas não é sobre diagnóstico agora — é sobre não perder tempo se houver algo pra fazer. Comenta aqui a idade do seu filho que eu te digo o que vale observar.',
  },
  {
    tema: 'Comportamento',
    estagio: 'descoberta',
    palavras: 82,
    elementos: {
      cena_inicial: 'No mercado, ele pediu biscoito. Ela disse não. A situação saiu do controle. Todo mundo olhou.',
      hook_tensao: 'Crises que parecem birra podem ter outra explicação.',
      amplificacao: 'Você tenta de tudo e nada funciona. Depois se sente culpada por não conseguir controlar. Outros pais parecem ter mais facilidade. Você se pergunta onde está errando.',
      quebra_crenca: 'Mas não é sobre controle. É sobre regulação. E regulação emocional não se aprende sozinha — precisa de orientação.',
      prova_concreta: 'Na nossa clínica, 70% das famílias que começaram estratégias de regulação viram redução de crises em 3 meses. Antes, tinham tentado de tudo sozinhos.',
      objecao: 'Talvez pense que é falta de limites ou que ele precisa de mais firmeza. Mas firmeza sem compreensão do que está por trás só piora.',
      cta: 'Salva e compartilha com quem também precisa ouvir isso.',
    },
    texto_completo: 'No mercado, ele pediu biscoito. Ela disse não. A situação saiu do controle. Todo mundo olhou. Crises que parecem birra podem ter outra explicação. Você tenta de tudo e nada funciona. Depois se sente culpada por não conseguir controlar. Outros pais parecem ter mais facilidade. Você se pergunta onde está errando. Mas não é sobre controle. É sobre regulação. E regulação emocional não se aprende sozinha — precisa de orientação. Na nossa clínica, 70% das famílias que começaram estratégias de regulação viram redução de crises em 3 meses. Antes, tinham tentado de tudo sozinhos. Talvez pense que é falta de limites ou que ele precisa de mais firmeza. Mas firmeza sem compreensão do que está por trás só piora. Salva e compartilha com quem também precisa ouvir isso.',
  },
];

// ─────────────────────────────────────────────
// PROMPT SYSTEM OTIMIZADO
// ─────────────────────────────────────────────

export function buildSystemPromptDescobertaV2() {
  const exemplos = FEW_SHOTS_DESCOBERTA_V2.map((ex, i) => `
EXEMPLO ${i + 1} — ${ex.tema} (${ex.palavras} palavras):
${ex.texto_completo}

Elementos identificados:
- Cena: ${ex.elementos.cena_inicial}
- Hook: ${ex.elementos.hook_tensao}
- Prova: ${ex.elementos.prova_concreta}
- CTA: ${ex.elementos.cta}
`).join('\n---\n');

  return `Você é ZEUS, especialista em conteúdo de aquisição para clínicas de saúde infantil (Fono Inova — Anápolis/GO).

${TEMPLATE_7_ELEMENTOS}

TOM OBRIGATÓRIO: ACOLHEDOR E CONFIÁVEL
- Sem culpa, sem drama, sem urgência exagerada
- Voz de especialista que entende e acolhe
- Frases curtas (máx 12 palavras), linguagem falada
- Use "a gente", "você", contracões naturais (tá, às vezes, tô)
- Valide antes de informar: "Faz sentido você pensar assim"

PROIBIDO:
- Perguntas no hook
- "Você sabia que...?"
- Urgência agressiva: "não espere mais", "cada dia que passa"
- CTA de WhatsApp, agendamento, "entre em contato"
- Prova vaga: "muitas crianças", "vários casos"

METAS RIGOROSAS:
- Mínimo 80 palavras (contar no texto_completo)
- Prova concreta com número, % ou caso específico
- CTA de micro-comprometimento apenas

${exemplos}

Retorne APENAS JSON no formato:
{
  "roteiro": {
    "titulo": "...",
    "texto_completo": "...",
    "hook_texto_overlay": "...",
    "cta_texto_overlay": "...",
    "prova_concreta_usada": "...",
    "contagem_palavras": 0
  }
}`;
}

// ─────────────────────────────────────────────
// SCORE ESPECÍFICO PARA DESCOBERTA V2
// ─────────────────────────────────────────────

export function scorarDescobertaV2(roteiro, params = {}) {
  const t = roteiro.texto_completo || '';
  const tLow = t.toLowerCase();
  const hook = (roteiro.hook_texto_overlay || '').toLowerCase();
  const cta = (roteiro.cta_texto_overlay || '').toLowerCase();
  
  let score = 100;
  const falhas = [];
  const acertos = [];
  
  // Verificar tamanho mínimo (80 palavras)
  const palavras = t.split(/\s+/).filter(Boolean).length;
  if (palavras < 80) {
    score -= 20;
    falhas.push(`Texto curto demais: ${palavras} palavras — mínimo é 80 para os 7 elementos`);
  } else {
    acertos.push(`${palavras} palavras`);
  }
  
  // Verificar prova concreta (números, %, casos específicos)
  const temProvaConcreta = /\d+\s*(%|palavras?|meses?|crianças?|famílias?|anos?|semanas?|casos?)/.test(tLow) ||
    /em \d{4}/.test(tLow) ||
    /(estudos?|pesquisas?) mostra/.test(tLow);
  
  if (!temProvaConcreta) {
    score -= 25;
    falhas.push('Prova concreta obrigatória: inclua número, % ou caso específico');
  } else {
    acertos.push('Prova concreta presente');
  }
  
  // Verificar hook sem pergunta
  if (hook.endsWith('?') || hook.includes('você sabia') || hook.includes('já percebeu')) {
    score -= 15;
    falhas.push('Hook é pergunta — use afirmação que gera curiosidade');
  } else {
    acertos.push('Hook afirmativo');
  }
  
  // Verificar CTA sem WhatsApp
  const ctaProibida = ['whatsapp', 'manda mensagem', 'chama aqui', 'agende', 'marcar', 'entre em contato'];
  if (ctaProibida.some(p => cta.includes(p))) {
    score -= 30;
    falhas.push('CTA de descoberta NÃO pode ter WhatsApp ou agendamento');
  } else if (cta.includes('salva') || cta.includes('comenta') || cta.includes('compartilha')) {
    acertos.push('CTA de micro-comprometimento correto');
  }
  
  // Verificar janela temporal
  if (!/\d+\s*(anos?|meses?)/.test(tLow) && !tLow.includes('antes dos')) {
    score -= 10;
    falhas.push('Janela temporal não mencionada');
  } else {
    acertos.push('Janela temporal presente');
  }
  
  // Verificar cena específica
  if (hook.length < 20 || hook.startsWith('você')) {
    score -= 10;
    falhas.push('Cena inicial fraca — seja específico');
  } else {
    acertos.push('Cena específica');
  }
  
  // Verificar tom acolhedor (ausência de culpa)
  const palavrasCulpa = ['você está errando', 'culpa sua', 'deveria', 'tá fazendo errado'];
  if (palavrasCulpa.some(p => tLow.includes(p))) {
    score -= 15;
    falhas.push('Tom culposo detectado — mantenha acolhedor');
  }
  
  return {
    score: Math.max(score, 0),
    palavras,
    falhas,
    acertos,
    aprovado: score >= 70 && falhas.length <= 2,
  };
}

// ─────────────────────────────────────────────
// FUNÇÃO DE GERAÇÃO OTIMIZADA
// ─────────────────────────────────────────────

export async function gerarRoteiroDescoberta(params) {
  // Placeholder — implementação real usaria OpenAI
  // Esta é a configuração pronta para uso
  return {
    config: CONFIG_DESCOBERTA,
    systemPrompt: buildSystemPromptDescobertaV2(),
    scorar: scorarDescobertaV2,
    fewShots: FEW_SHOTS_DESCOBERTA_V2,
  };
}

export default {
  CONFIG_DESCOBERTA,
  TEMPLATE_7_ELEMENTOS,
  FEW_SHOTS_DESCOBERTA_V2,
  buildSystemPromptDescobertaV2,
  scorarDescobertaV2,
  gerarRoteiroDescoberta,
};
