/**
 * ZEUS v3.1 — Pipelines Complementares (Consideração, Decisão, Retargeting)
 *
 * Configurações otimizadas para os 3 estágios restantes do funil:
 * - CONSIDERAÇÃO: Autoridade empática, prova social, diferenciação
 * - DECISÃO: Confronto direto, remoção de objeção, urgência
 * - RETARGETING: Cumplicidade, urgência incremental, reativação
 */

// ═══════════════════════════════════════════════════════════════
// PIPELINE 1: CONSIDERAÇÃO
// ═══════════════════════════════════════════════════════════════

export const CONFIG_CONSIDERACAO = {
  pipeline: 'consideracao',
  tom: 'autoridade empática, competência demonstrada, diferenciação sutil',
  tamanho_minimo: 80,
  tamanho_maximo: 95,
  
  objetivo: 'Transferir confiança do genérico para o específico. O pai deve sentir: "essa clínica entende o que meu filho tem de forma diferente"',
  
  validacoes: {
    prova_social_obrigatoria: true,
    diferenciacao_implicita: true,
    cta_qualificacao: true,      // WhatsApp permitido, mas baixa fricção
    evitar_credenciais_diretas: true,  // Não "sou especialista há 10 anos"
  },
  
  score_weights: {
    sem_prova_social: 25,
    tom_generico: 20,
    cta_whatsapp_direto: 15,     // Penaliza menos que descoberta
    sem_diferenciacao: 15,
  },
};

export const TEMPLATE_CONSIDERACAO = `
TEMPLATE OBRIGATÓRIO — 7 ELEMENTOS NESSA ORDEM:

1. CENA INICIAL (0–2s) — Caso específico da clínica
   - "Ontem atendi...", "Semana passada uma mãe chegou..."
   - Detalhe reconhecível: vídeo no celular, relatório escolar, conversa
   - ZERO apresentação de credenciais

2. HOOK DE AUTORIDADE (2–5s) — Demonstração, não afirmação
   - NUNCA: "Como fonoaudióloga com 10 anos..."
   - SEMPRE: "Quando vi o vídeo, entendi em 30 segundos"
   - Mostre competência através de caso, não de título

3. CONTEXTO DO PROBLEMA (5–12s) — O que outros não viram
   - Descreva como o problema foi mal compreendido anteriormente
   - "Foram em três lugares e disseram..."
   - Crie contraste entre abordagem comum vs. especializada

4. DIFERENCIAÇÃO IMPLÍCITA (12–18s) — O que faz essa clínica diferente
   - NUNCA: "Nós somos diferentes porque..."
   - SEMPRE: Demonstração através de abordagem específica
   - "A diferença não é o diagnóstico — é que aqui a gente não espera..."

5. PROVA SOCIAL CONCRETA (18–22s) — Resultado específico ⭐ OBRIGATÓRIO
   - SEMPRE inclua: número, tempo, transformação
   - Exemplos:
     * "Nessa semana saímos de 4 palavras para 18 em dois meses"
     * "A criança saiu com plano que não conseguiu em lugar nenhum"
     * "70% das famílias que começaram aqui relatam mudança em 3 meses"
   - NUNCA: "temos ótimos resultados", "já ajudei muitas famílias"

6. ANTI-TRAUMA (22–26s) — Validação de quem já foi frustrado
   - Reconheça que a família pode ter sido mal atendida antes
   - "Se você já foi em três lugares e não resolveu, faz sentido duvidar"
   - Ofereça segurança sem promessas exageradas

7. CTA DE QUALIFICAÇÃO (26–30s) — Baixa fricção, alta intenção
   - WhatsApp permitido, mas com qualificação
   - Exemplos:
     * "Manda mensagem — eu te digo se o que você descreve é algo que tratamos"
     * "Tem um vídeo assim? Manda que eu dou uma olhada"
     * "Se te disseram pra esperar, manda mensagem — eu te digo se ainda dá tempo"
   - Elimine fricção: não exija compromisso, ofereça avaliação
`;

export const FEW_SHOTS_CONSIDERACAO = [
  {
    tema: 'Atraso de Fala',
    estagio: 'consideracao',
    palavras: 88,
    elementos: {
      cena_inicial: 'Ontem uma mãe entrou com um relatório escolar de três páginas. O professor dizia que tudo estava normal.',
      hook_autoridade: 'Quando li a observação do comportamento, vi o que o professor não tinha visto.',
      contexto: 'Ela tinha ido em dois pediatras. Os dois disseram: "espera mais um pouco". Ela esperou seis meses.',
      diferenciacao: 'A diferença não é o diagnóstico. É que aqui a gente lê entre as linhas do que os outros chamam de "normalidade".',
      prova_social: 'Nessa semana saímos de quatro palavras para dezoito em dois meses. Não é caso extraordinário — é o que acontece quando a gente age no tempo certo.',
      anti_trauma: 'Se você já foi em algum lugar e disseram pra esperar, faz sentido duvidar. Eu também duvidaria.',
      cta: 'Manda mensagem — eu te digo se o que você descreve é algo que a gente trata aqui.',
    },
    texto_completo: 'Ontem uma mãe entrou com um relatório escolar de três páginas. O professor dizia que tudo estava normal. Quando li a observação do comportamento, vi o que o professor não tinha visto. Ela tinha ido em dois pediatras. Os dois disseram: "espera mais um pouco". Ela esperou seis meses. A diferença não é o diagnóstico. É que aqui a gente lê entre as linhas do que os outros chamam de "normalidade". Nessa semana saímos de quatro palavras para dezoito em dois meses. Não é caso extraordinário — é o que acontece quando a gente age no tempo certo. Se você já foi em algum lugar e disseram pra esperar, faz sentido duvidar. Eu também duvidaria. Manda mensagem — eu te digo se o que você descreve é algo que a gente trata aqui.',
  },
  {
    tema: 'Autismo',
    estagio: 'consideracao',
    palavras: 84,
    elementos: {
      cena_inicial: 'Semana passada uma mãe chegou com um vídeo de quarenta segundos no celular. "Você vai achar que estou exagerando."',
      hook_autoridade: 'Não achei. Em vinte segundos eu já sabia o que estava acontecendo.',
      contexto: 'Ela estava esperando há oito meses por uma resposta. Foram três consultas, dois encaminhamentos.',
      diferenciacao: 'O diagnóstico não criou o problema. Nomeou o que já existia e abriu o caminho pra trabalhar diferente.',
      prova_social: 'A criança saiu daqui com um plano de intervenção que os pais não tinham conseguido em lugar nenhum. Em três meses já tinha mudança visível.',
      anti_trauma: 'Se você já consultou e não teve resposta, não é exagero da sua parte. É falta de atenção do sistema.',
      cta: 'Tem um vídeo assim no celular? Manda que eu dou uma olhada e te digo o que estou vendo.',
    },
    texto_completo: 'Semana passada uma mãe chegou com um vídeo de quarenta segundos no celular. "Você vai achar que estou exagerando." Não achei. Em vinte segundos eu já sabia o que estava acontecendo. Ela estava esperando há oito meses por uma resposta. Foram três consultas, dois encaminhamentos. O diagnóstico não criou o problema. Nomeou o que já existia e abriu o caminho pra trabalhar diferente. A criança saiu daqui com um plano de intervenção que os pais não tinham conseguido em lugar nenhum. Em três meses já tinha mudança visível. Se você já consultou e não teve resposta, não é exagero da sua parte. É falta de atenção do sistema. Tem um vídeo assim no celular? Manda que eu dou uma olhada e te digo o que estou vendo.',
  },
];

// ═══════════════════════════════════════════════════════════════
// PIPELINE 2: DECISÃO
// ═══════════════════════════════════════════════════════════════

export const CONFIG_DECISAO = {
  pipeline: 'decisao',
  tom: 'direto, desbloqueador, confronto respeitoso da objeção',
  tamanho_minimo: 80,
  tamanho_maximo: 95,
  
  objetivo: 'Remover o último bloqueio entre intenção e ação. O pai deve sentir: "não existe mais razão válida para não fazer isso agora"',
  
  validacoes: {
    objecao_nomeada_diretamente: true,
    desmonte_com_especificidade: true,
    cta_acao_direta: true,       // WhatsApp com palavra-chave
    friction_eliminator: true,   // "sem compromisso", "respondo hoje"
  },
  
  score_weights: {
    objecao_nao_nomeada: 30,
    desmonte_generico: 20,
    sem_friction_eliminator: 15,
    cta_fraco: 15,
  },
};

export const TEMPLATE_DECISAO = `
TEMPLATE OBRIGATÓRIO — 7 ELEMENTOS NESSA ORDEM:

1. CENA INICIAL (0–2s) — Confronto direto com a objeção
   - Nomeie a objeção no primeiro segundo
   - Exemplos por objeção:
     * "É fase": "Três anos esperando virar. Agora são cinco."
     * "Muito caro": "A avaliação custa menos do que um mês de curso."
     * "Marido não acredita": "Toda semana atendo crianças cujo pai disse que era exagero."

2. HOOK CONFRONTADOR (2–5s) — A verdade que ninguém fala
   - Afirmação direta que quebra a justificativa da inação
   - "Vou ser direta: em anos de clínica..."
   - "Talvez você pense que é fase. Mas..."
   - Sem agressão, mas sem suavização

3. CUSTO REAL (5–12s) — O preço da espera
   - Não é sobre culpa — é sobre consequência real
   - Use dados de desenvolvimento: "janela neurológica", "plasticidade"
   - "O que poderia ser seis meses hoje são dois anos amanhã"

4. DESMONTE DA OBJEÇÃO (12–18s) — Com especificidade, não opinião
   - Se "é fase": "Em oito anos, casos que melhoraram sozinhos: conto nos dedos"
   - Se "muito caro": "O que investe em avaliação precoce economiza em anos de terapia"
   - Se "marido não acredita": "Quando mostro o que está acontecendo, ele é o primeiro a agradecer"

5. PROVA DE URGÊNCIA (18–22s) — Janela que fecha
   - Dado temporal específico
   - "Aos três anos essa janela fecha 40% mais rápido"
   - "Cada semana que passa, a intervenção fica mais difícil"

6. FRICÇÃO ELIMINADA (22–26s) — Próximo passo mínimo
   - Reduza ao absurdo a barreira para agir
   - "Avaliação dura uma hora. Você sai sabendo exatamente."
   - "Se for fase mesmo, sou a primeira a te dizer."
   - "Primeira conversa é sem compromisso."

7. CTA DE AÇÃO DIRETA (26–30s) — Palavra-chave + friction eliminator
   - WhatsApp direto com comando específico
   - Exemplos:
     * "Manda QUERO SABER aqui no WhatsApp. A gente agenda essa semana."
     * "Manda mensagem agora. Respondo hoje."
     * "Escreve QUERO AVALIAR. A primeira conversa é sem compromisso."
`;

export const FEW_SHOTS_DECISAO = [
  {
    tema: 'Atraso de Fala',
    objecao: 'e_fase',
    estagio: 'decisao',
    palavras: 87,
    elementos: {
      cena_inicial: 'Três anos esperando virar. Agora são cinco. E a frase ainda é: "deve ser fase".',
      hook_confrontador: 'Vou ser direta: em anos de clínica, os casos que melhoraram sozinhos eu conto nos dedos de uma mão.',
      custo_real: 'O resto chegou mais tarde, com atraso maior, e levou o dobro do tempo.',
      desmonte: '"Talvez seja fase" é a frase mais cara que uma família pode ouvir. Porque quando está errada, o custo é medido em meses de desenvolvimento que não voltam.',
      prova_urgencia: 'Aos três anos, a janela de plasticidade linguística cai pela metade. Isso não é metáfora — é biologia.',
      fricao_eliminada: 'A avaliação dura uma hora. No final você sabe exatamente o que está acontecendo. E se for fase mesmo, sou a primeira a te dizer.',
      cta: 'Manda QUERO SABER aqui no WhatsApp. A gente agenda essa semana.',
    },
    texto_completo: 'Três anos esperando virar. Agora são cinco. E a frase ainda é: "deve ser fase". Vou ser direta: em anos de clínica, os casos que melhoraram sozinhos eu conto nos dedos de uma mão. O resto chegou mais tarde, com atraso maior, e levou o dobro do tempo. "Talvez seja fase" é a frase mais cara que uma família pode ouvir. Porque quando está errada, o custo é medido em meses de desenvolvimento que não voltam. Aos três anos, a janela de plasticidade linguística cai pela metade. Isso não é metáfora — é biologia. A avaliação dura uma hora. No final você sabe exatamente o que está acontecendo. E se for fase mesmo, sou a primeira a te dizer. Manda QUERO SABER aqui no WhatsApp. A gente agenda essa semana.',
  },
  {
    tema: 'Autismo',
    objecao: 'marido_nao_acredita',
    estagio: 'decisao',
    palavras: 85,
    elementos: {
      cena_inicial: 'Toda semana atendo crianças cujo pai disse que era exagero da mãe. Toda semana.',
      hook_confrontador: 'E quando o pai entra na sala comigo e eu mostro o que está acontecendo, ele é o primeiro a agradecer por não ter esperado mais.',
      custo_real: 'A intuição da mãe sobre o próprio filho tem nome clínico: conhecimento contextual. É o dado mais valioso numa avaliação.',
      desmonte: 'Não é sobre discordar do marido. É sobre uma hora de avaliação confirmar ou descartar com certeza absoluta.',
      prova_urgencia: 'Diagnóstico antes dos dois anos muda completamente o prognóstico. Depois dos quatro, as mesmas intervenções demoram o dobro.',
      fricao_eliminada: 'Você não precisa convencer ninguém. Só precisa de uma hora de avaliação pra ter certeza.',
      cta: 'Manda mensagem aqui. A gente vê juntos.',
    },
    texto_completo: 'Toda semana atendo crianças cujo pai disse que era exagero da mãe. Toda semana. E quando o pai entra na sala comigo e eu mostro o que está acontecendo, ele é o primeiro a agradecer por não ter esperado mais. A intuição da mãe sobre o próprio filho tem nome clínico: conhecimento contextual. É o dado mais valioso numa avaliação. Não é sobre discordar do marido. É sobre uma hora de avaliação confirmar ou descartar com certeza absoluta. Diagnóstico antes dos dois anos muda completamente o prognóstico. Depois dos quatro, as mesmas intervenções demoram o dobro. Você não precisa convencer ninguém. Só precisa de uma hora de avaliação pra ter certeza. Manda mensagem aqui. A gente vê juntos.',
  },
];

// ═══════════════════════════════════════════════════════════════
// PIPELINE 3: RETARGETING
// ═══════════════════════════════════════════════════════════════

export const CONFIG_RETARGETING = {
  pipeline: 'retargeting',
  tom: 'cumplicidade tranquila, urgência incremental, sem julgamento',
  tamanho_minimo: 75,
  tamanho_maximo: 90,
  
  objetivo: 'Reativar intenção que existe mas esfriou. O pai deve sentir: "já sabia disso — o próximo passo é menor do que penso"',
  
  validacoes: {
    referencia_conteudo_passado: true,
    tempo_que_passou: true,
    remocao_culpa: true,
    cta_passo_minimo: true,      // "só um oi"
  },
  
  score_weights: {
    sem_referencia_passada: 20,
    tom_julgador: 25,
    cta_complexo: 15,
    sem_urgencia_incremental: 15,
  },
};

export const TEMPLATE_RETARGETING = `
TEMPLATE OBRIGATÓRIO — 7 ELEMENTOS NESSA ORDEM:

1. CENA INICIAL (0–2s) — Reconhecimento implícito
   - "Se você está vendo esse vídeo..."
   - "Você que acompanha aqui sabe que..."
   - Cria cumplicidade: implica que já há relação

2. HOOK DE REATIVAÇÃO (2–5s) — O que está dormindo
   - "Você já sentiu algo. O que está esperando?"
   - "Tem uma razão pra você não ter agido. E eu sei qual é."
   - Desperta intenção sem criar nova

3. TEMPO QUE PASSOU (5–12s) — Consequência real, sem culpa
   - "Desde o primeiro vídeo que você viu..."
   - "Cada semana que passa..."
   - NUNCA: "você está perdendo tempo", "por que demorou?"
   - SEMPRE: "o tempo passa independente da gente"

4. O QUE MUDOU (12–18s) — Na criança, não na oferta
   - "A janela de desenvolvimento fica um pouco mais curta..."
   - "O que era seis meses hoje pode ser doze amanhã"
   - Foque no custo para a criança, não na pressão para o pai

5. REMOÇÃO DE CULPA (18–22s) — Permissão para agir
   - "Entendo. Parece um passo grande."
   - "Parece que vai confirmar algo que você preferia não saber."
   - Valide o medo antes de pedir ação

6. ABERTURA DO CAMINHO (22–26s) — Próximo passo mínimo absoluto
   - Reduza a barreira ao absurdo
   - "Manda só um oi. Só isso."
   - "Sem reexplicar nada. Sem compromisso."
   - "Eu te respondo e a gente vê juntos."

7. CTA DE REATIVAÇÃO (26–30s) — Menor passo possível
   - Exemplos:
     * "Manda só um 'oi' aqui. Só isso."
     * "Escreve QUERO SABER. Sem compromisso."
     * "Responde esse stories com um emoji. Eu chamo você."
   - Menor atrito possível
   - Zero explicação adicional
`;

export const FEW_SHOTS_RETARGETING = [
  {
    tema: 'Geral',
    estagio: 'retargeting',
    palavras: 82,
    elementos: {
      cena_inicial: 'Se você está vendo esse vídeo, em algum momento você parou num conteúdo sobre desenvolvimento infantil.',
      hook_reativacao: 'Você sentiu algo. E não entrou em contato.',
      tempo_passou: 'Desde então, semanas se passaram. A rotina continuou. Mas o sinal que você viu não sumiu.',
      o_que_mudou: 'Cada semana que passa, a janela de intervenção fica um pouco mais curta. Não pra sempre — mas fica.',
      remocao_culpa: 'Entendo. Parece um passo grande. Parece que vai confirmar algo que você preferia não saber.',
      abertura: 'Mas olha: você não precisa decidir nada agora. Só precisa retomar a conversa.',
      cta: 'Manda só um "oi" aqui. Só isso. Eu te respondo e a gente vê juntos se faz sentido avançar.',
    },
    texto_completo: 'Se você está vendo esse vídeo, em algum momento você parou num conteúdo sobre desenvolvimento infantil. Você sentiu algo. E não entrou em contato. Desde então, semanas se passaram. A rotina continuou. Mas o sinal que você viu não sumiu. Cada semana que passa, a janela de intervenção fica um pouco mais curta. Não pra sempre — mas fica. Entendo. Parece um passo grande. Parece que vai confirmar algo que você preferia não saber. Mas olha: você não precisa decidir nada agora. Só precisa retomar a conversa. Manda só um "oi" aqui. Só isso. Eu te respondo e a gente vê juntos se faz sentido avançar.',
  },
  {
    tema: 'Atraso de Fala',
    estagio: 'retargeting',
    palavras: 79,
    elementos: {
      cena_inicial: 'Você que salvou aquele vídeo sobre atraso de fala...',
      hook_reativacao: 'Tem uma pergunta que você não fez na época. E ela ainda está aqui.',
      tempo_passou: 'Desde então seu filho ganhou algumas palavras? Ou ficou na mesma?',
      o_que_mudou: 'Entre dois e três anos a diferença não é só de tempo — é de possibilidade. O que resolve em seis meses com dois anos leva o dobro com três.',
      remocao_culpa: 'Não é sobre o que você deveria ter feito. É sobre o que ainda dá pra fazer.',
      abertura: 'Não precisa agendar nada. Não precisa se comprometer. Só precisa saber.',
      cta: 'Manda QUERO ENTENDER aqui. Eu te explico o que está acontecendo sem compromisso nenhum.',
    },
    texto_completo: 'Você que salvou aquele vídeo sobre atraso de fala... Tem uma pergunta que você não fez na época. E ela ainda está aqui. Desde então seu filho ganhou algumas palavras? Ou ficou na mesma? Entre dois e três anos a diferença não é só de tempo — é de possibilidade. O que resolve em seis meses com dois anos leva o dobro com três. Não é sobre o que você deveria ter feito. É sobre o que ainda dá pra fazer. Não precisa agendar nada. Não precisa se comprometer. Só precisa saber. Manda QUERO ENTENDER aqui. Eu te explico o que está acontecendo sem compromisso nenhum.',
  },
];

// ═══════════════════════════════════════════════════════════════
// FUNÇÕES DE SCORE ESPECÍFICAS
// ═══════════════════════════════════════════════════════════════

export function scorarConsideracao(roteiro, params = {}) {
  const t = roteiro.texto_completo || '';
  const tLow = t.toLowerCase();
  const hook = (roteiro.hook_texto_overlay || '').toLowerCase();
  
  let score = 100;
  const falhas = [];
  const acertos = [];
  
  const palavras = t.split(/\s+/).filter(Boolean).length;
  if (palavras < 80) {
    score -= 15;
    falhas.push(`Texto com ${palavras} palavras — mínimo recomendado é 80`);
  } else {
    acertos.push(`${palavras} palavras`);
  }
  
  // Verificar prova social concreta
  const temProva = /\d+\s*(palavras?|meses?|semanas?|anos?|crianças?|famílias?|%)/.test(tLow) ||
    /(de|para)\s+\d+/.test(tLow);
  if (!temProva) {
    score -= 25;
    falhas.push('Prova social concreta obrigatória: número, tempo ou caso específico');
  } else {
    acertos.push('Prova social presente');
  }
  
  // Verificar se não usa credenciais diretas
  if (/\d+\s*anos?\s+de\s+(experiência|formação)|sou\s+especialista|sou\s+fono|sou\s+psicóloga/.test(tLow)) {
    score -= 20;
    falhas.push('Evite credenciais diretas — demonstre autoridade através de casos');
  }
  
  // Verificar diferenciação
  if (!(/diferença|aqui a gente|o que fazemos|abordagem/.test(tLow))) {
    score -= 15;
    falhas.push('Diferenciação implícita não detectada');
  }
  
  return { score: Math.max(score, 0), palavras, falhas, acertos, aprovado: score >= 70 };
}

export function scorarDecisao(roteiro, params = {}) {
  const { objecao_principal } = params;
  const t = roteiro.texto_completo || '';
  const tLow = t.toLowerCase();
  const cta = (roteiro.cta_texto_overlay || '').toLowerCase();
  
  let score = 100;
  const falhas = [];
  const acertos = [];
  
  const palavras = t.split(/\s+/).filter(Boolean).length;
  if (palavras < 80) {
    score -= 10;
    falhas.push(`Texto com ${palavras} palavras`);
  }
  
  // Verificar se objeção foi nomeada
  const objecoesMapeadas = {
    e_fase: /fase|esperar|esperou/,
    muito_caro: /caro|custa|preço|investe|economiza/,
    marido_nao_acredita: /marido|pai|exagero/,
    ja_tentei: /já tentou|outro lugar|não resolveu/,
  };
  
  const regexObjecao = objecao_principal && objecoesMapeadas[objecao_principal];
  if (regexObjecao && !regexObjecao.test(tLow)) {
    score -= 30;
    falhas.push(`Objeção "${objecao_principal}" não nomeada diretamente no texto`);
  } else if (regexObjecao) {
    acertos.push('Objeção nomeada');
  }
  
  // Verificar friction eliminator
  const frictionEliminators = ['sem compromisso', 'respondo hoje', 'só uma hora', 'se for fase', 'primeira conversa'];
  if (!frictionEliminators.some(f => tLow.includes(f))) {
    score -= 15;
    falhas.push('Friction eliminator não detectado — reduza a barreira para ação');
  } else {
    acertos.push('Friction eliminator presente');
  }
  
  // Verificar CTA de ação direta
  if (!(/whatsapp|manda|escreve|chama/.test(cta))) {
    score -= 15;
    falhas.push('CTA de decisão deve ter WhatsApp direto');
  }
  
  return { score: Math.max(score, 0), palavras, falhas, acertos, aprovado: score >= 70 };
}

export function scorarRetargeting(roteiro, params = {}) {
  const t = roteiro.texto_completo || '';
  const tLow = t.toLowerCase();
  const cta = (roteiro.cta_texto_overlay || '').toLowerCase();
  
  let score = 100;
  const falhas = [];
  const acertos = [];
  
  const palavras = t.split(/\s+/).filter(Boolean).length;
  if (palavras < 75) {
    score -= 10;
    falhas.push(`Texto com ${palavras} palavras — mínimo é 75`);
  }
  
  // Verificar referência a conteúdo passado
  const referenciasPassadas = ['você viu', 'você salvou', 'você acompanha', 'se você está vendo', 'primeiro vídeo'];
  if (!referenciasPassadas.some(r => tLow.includes(r))) {
    score -= 20;
    falhas.push('Referência a conteúdo/interação passada não detectada');
  } else {
    acertos.push('Referência ao passado presente');
  }
  
  // Verificar remoção de culpa
  if (/você deveria|por que não|demorou|perdeu tempo/.test(tLow)) {
    score -= 25;
    falhas.push('Tom julgador detectado — remova culpa, ofereça permissão');
  } else {
    acertos.push('Sem julgamento');
  }
  
  // Verificar CTA de passo mínimo
  const ctasMinimos = ['só um oi', 'só isso', 'só um', 'sem compromisso', 'só pra saber'];
  if (!ctasMinimos.some(c => cta.includes(c))) {
    score -= 15;
    falhas.push('CTA deve ser o menor passo possível');
  } else {
    acertos.push('CTA de passo mínimo');
  }
  
  return { score: Math.max(score, 0), palavras, falhas, acertos, aprovado: score >= 70 };
}

// ═══════════════════════════════════════════════════════════════
// FUNÇÕES DE BUILD SYSTEM PROMPT
// ═══════════════════════════════════════════════════════════════

export function buildSystemPromptConsideracao(mapeamento) {
  const exemplos = FEW_SHOTS_CONSIDERACAO.map((ex, i) => `
EXEMPLO ${i + 1} — ${ex.tema} (${ex.palavras} palavras):
${ex.texto_completo}
`).join('\n---\n');

  return `Você é ZEUS, especialista em conteúdo de aquisição para clínicas de saúde infantil (Fono Inova — Anápolis/GO).

${TEMPLATE_CONSIDERACAO}

TOM OBRIGATÓRIO: AUTORIDADE EMPÁTICA
- Demonstre competência através de CASOS, não de credenciais
- NUNCA: "Sou especialista com 10 anos de experiência"
- SEMPRE: "Quando vi o vídeo, entendi em 30 segundos"
- Tom direto mas humanizado — conversa de especialista, não palestra
- Valide a frustração de quem já foi mal atendido

ESTADO DO VIEWER:
- Atual: ${mapeamento.estado_atual}
- Desejado: ${mapeamento.estado_desejado}

PROIBIDO:
- Credenciais diretas (anos de formado, títulos)
- "Nós somos diferentes porque..."
- Prova vaga: "já ajudei muitas famílias"
- CTA agressivo ou sem qualificação

METAS:
- Mínimo 80 palavras
- Prova social concreta com número/tempo obrigatória
- Diferenciação implícita (demonstrada, não declarada)

${exemplos}

Retorne APENAS JSON:
{
  "roteiro": {
    "titulo": "...",
    "texto_completo": "...",
    "hook_texto_overlay": "...",
    "cta_texto_overlay": "..."
  }
}`;
}

export function buildSystemPromptDecisao(mapeamento) {
  const exemplos = FEW_SHOTS_DECISAO.map((ex, i) => `
EXEMPLO ${i + 1} — ${ex.tema} | Objecao: ${ex.objecao} (${ex.palavras} palavras):
${ex.texto_completo}
`).join('\n---\n');

  return `Você é ZEUS, especialista em conteúdo de aquisição para clínicas de saúde infantil (Fono Inova — Anápolis/GO).

${TEMPLATE_DECISAO}

TOM OBRIGATÓRIO: DIRETO E DESBLOQUEADOR
- Confronte a objeção sem agredir
- Fale a verdade que ninguém fala, mas com respeito
- Tom firme como amigo especialista
- Remova a última desculpa para não agir

ESTADO DO VIEWER:
- Atual: ${mapeamento.estado_atual}
- Desejado: ${mapeamento.estado_desejado}

PROIBIDO:
- Suavizar a objeção — nomeie diretamente
- CTA fraco: "quando quiser", "se fizer sentido"
- Deixar fricção — elimine barreiras explicitamente

METAS:
- Mínimo 80 palavras
- Objeção nomeada nas primeiras 5 segundos
- Friction eliminator obrigatório
- CTA com palavra-chave específica

${exemplos}

Retorne APENAS JSON:
{
  "roteiro": {
    "titulo": "...",
    "texto_completo": "...",
    "hook_texto_overlay": "...",
    "cta_texto_overlay": "..."
  }
}`;
}

export function buildSystemPromptRetargeting(mapeamento) {
  const exemplos = FEW_SHOTS_RETARGETING.map((ex, i) => `
EXEMPLO ${i + 1} — ${ex.tema} (${ex.palavras} palavras):
${ex.texto_completo}
`).join('\n---\n');

  return `Você é ZEUS, especialista em conteúdo de aquisição para clínicas de saúde infantil (Fono Inova — Anápolis/GO).

${TEMPLATE_RETARGETING}

TOM OBRIGATÓRIO: CUMPLICIDADE TRANQUILA
- NUNCA julgamento pela demora
- SEMPRE: "Entendo", "faz sentido", "pode parecer"
- Remova culpa, abra o caminho
- Tom de continuidade — retomada de conversa

ESTADO DO VIEWER:
- Atual: ${mapeamento.estado_atual}
- Desejado: ${mapeamento.estado_desejado}

PROIBIDO:
- "Por que você demorou?"
- "Você está perdendo tempo"
- "Já deveria ter..."
- CTA que exige compromisso

METAS:
- Mínimo 75 palavras
- Referência a interação passada obrigatória
- Remoção de culpa explícita
- CTA de passo mínimo absoluto

${exemplos}

Retorne APENAS JSON:
{
  "roteiro": {
    "titulo": "...",
    "texto_completo": "...",
    "hook_texto_overlay": "...",
    "cta_texto_overlay": "..."
  }
}`;
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

export default {
  CONFIG_CONSIDERACAO,
  CONFIG_DECISAO,
  CONFIG_RETARGETING,
  FEW_SHOTS_CONSIDERACAO,
  FEW_SHOTS_DECISAO,
  FEW_SHOTS_RETARGETING,
  buildSystemPromptConsideracao,
  buildSystemPromptDecisao,
  buildSystemPromptRetargeting,
  scorarConsideracao,
  scorarDecisao,
  scorarRetargeting,
};
