/**
 * 🎬 ZEUS — Gerador Estratégico de Conteúdo de Vídeo
 *
 * Cria roteiros estruturados para talking head (avatar falando) com foco
 * em viralização orgânica (Instagram) ou conversão (Meta Ads).
 *
 * Novos params: subTema, hookStyle, objetivo, platform, variacao, intensidade
 */

import OpenAI from 'openai';
import logger from '../utils/logger.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Mapeamento de especialidades para profissionais
const ESPECIALIDADE_PROFISSIONAL = {
  fonoaudiologia:          'fono_ana',
  psicologia:              'psico_bia',
  terapia_ocupacional:     'to_carla',
  terapiaocupacional:      'to_carla',
  neuropsicologia:         'neuro_dani',
  fisioterapia:            'fisio_edu',
  musicoterapia:           'musico_fer',
  atraso_fala:             'fono_ana',
  autismo:                 'psico_bia',
  comportamento:           'psico_bia',
  teste_linguinha:         'fono_ana',
  avaliacao_neuropsicologica: 'neuro_dani',
  coordenacao_motora:      'fisio_edu',
  fisioterapia_infantil:   'fisio_edu',
  psicomotricidade:        'to_carla',
  geral:                   'fono_ana'
};

const NOMES_PROFISSIONAL = {
  fono_ana:   'Ana (Fonoaudiologia)',
  psico_bia:  'Bia (Psicologia)',
  to_carla:   'Carla (Terapia Ocupacional)',
  neuro_dani: 'Dani (Neuropsicologia)',
  fisio_edu:  'Edu (Fisioterapia)',
  musico_fer: 'Fer (Musicoterapia)'
};

// Hooks específicos por subTema — mais precisos que os genéricos por hookStyle
// Usados quando subTema está definido, para máxima relevância emocional
const HOOKS_SUBTEMA = {
  atraso_fala: {
    curiosidade: [
      'Tem um detalhe no dia a dia que pode estar atrasando a fala do seu filho',
      'Por que algumas crianças demoram mais para falar — e o que ninguém te conta',
      'Existe algo que acontece em casa que a maioria dos pais não percebe'
    ],
    dor: [
      'Seu filho tem mais de dois anos e ainda fala pouco — você não está sozinha',
      'Você já se preocupou se seu filho vai falar igual às outras crianças?',
      'Essa angústia de esperar seu filho falar é mais comum do que parece'
    ],
    alerta: [
      'Se seu filho tem X anos e ainda não faz isso, vale investigar',
      'Esse sinal de linguagem aparece cedo — e precisa de atenção',
      'Atenção: esse comportamento na fala pode indicar atraso de linguagem'
    ],
    erro_comum: [
      'Muitos pais acham que esperar resolve — e isso atrasa ainda mais',
      'Esse hábito que parece inofensivo pode estar atrasando a fala',
      'A maioria das famílias faz isso achando que ajuda — mas não ajuda'
    ]
  },
  autismo: {
    curiosidade: [
      'Tem sinais de autismo que aparecem antes de 1 ano — e poucos reconhecem',
      'Por que identificar cedo faz uma diferença enorme no desenvolvimento',
      'Existe um sinal que aparece muito antes do diagnóstico — e é fácil de observar'
    ],
    dor: [
      'Você percebeu algo diferente no seu filho e não sabe se deve se preocupar',
      'Essa dúvida — "será que é autismo?" — pesa no coração de muitos pais',
      'Saber que algo pode estar diferente e não saber o que fazer é muito difícil'
    ],
    alerta: [
      'Esses sinais no primeiro ano de vida merecem atenção imediata',
      'Se seu filho tem menos de 2 anos e faz isso, não espere para avaliar',
      'Esse comportamento pode ser um sinal precoce — vale investigar'
    ],
    erro_comum: [
      'Muitos pais esperam a criança "crescer e melhorar" — e perdem o momento certo',
      'Esse mito sobre autismo ainda atrasa o diagnóstico de muitas crianças'
    ]
  },
  comportamento: {
    curiosidade: [
      'Por que seu filho faz birra — e o que está por trás disso',
      'Tem uma razão neurológica para as explosões emocionais do seu filho',
      'Esse comportamento que parece "manha" pode ser outra coisa'
    ],
    dor: [
      'Você já chegou ao limite com as birras do seu filho?',
      'Quando o comportamento do seu filho te esgota — e você não sabe o que fazer',
      'Essa sensação de que nada funciona com seu filho é exaustiva'
    ],
    erro_comum: [
      'A maioria dos pais reage às birras do jeito errado — sem saber',
      'Ceder ou punir: os dois podem piorar o comportamento do seu filho',
      'Esse hábito dos pais piora a regulação emocional da criança'
    ]
  },
  teste_linguinha: {
    curiosidade: [
      'Por que o freio da língua pode afetar muito mais que a amamentação',
      'Esse procedimento simples pode mudar o desenvolvimento da fala',
      'Poucos sabem que o freio lingual impacta isso no desenvolvimento'
    ],
    dor: [
      'Amamentação dolorosa, fala diferente — pode ser o freio da língua',
      'Você tentou amamentar e não conseguiu — pode ter uma razão simples'
    ],
    alerta: [
      'Esses sinais em bebê podem indicar freio lingual restrito',
      'Se seu bebê tem dificuldade para amamentar, não ignore esse sinal'
    ]
  },
  coordenacao_motora: {
    curiosidade: [
      'Por que algumas crianças caem mais que outras — e o que isso indica',
      'Esse detalhe no jeito do seu filho se mover pode dizer muito'
    ],
    dor: [
      'Você percebeu que seu filho cai mais que outras crianças da mesma idade?',
      'Ver seu filho com dificuldades motoras enquanto os outros correm é difícil'
    ],
    alerta: [
      'Se seu filho ainda não faz isso com X anos, vale uma avaliação',
      'Esse sinal motor aparece cedo e precisa de atenção'
    ]
  }
};

function escolherHookSubTema(subTema, hookStyle, seed = 0) {
  const hooks = HOOKS_SUBTEMA[subTema]?.[hookStyle];
  if (!hooks || hooks.length === 0) return null;
  return hooks[Math.floor(seed * hooks.length) % hooks.length];
}

// Contexto descritivo por subTema para enriquecer o prompt
const SUBTEMA_CONTEXTO = {
  atraso_fala:                'criança não fala, fala pouco, troca palavras, atraso de linguagem',
  autismo:                    'sinais iniciais de TEA, comportamento, socialização, contato visual',
  comportamento:              'birra, agressividade, dificuldade emocional, limites, autocontrole',
  teste_linguinha:            'frênulo lingual, amamentação, fala, freio da língua',
  avaliacao_neuropsicologica: 'atenção, aprendizado, memória, suspeitas de TDAH ou dificuldades escolares',
  coordenacao_motora:         'equilíbrio, quedas frequentes, dificuldade motora grossa',
  terapia_ocupacional:        'autonomia, coordenação fina, atividades do dia a dia',
  fisioterapia_infantil:      'desenvolvimento motor global, tônus muscular, postura',
  psicomotricidade:           'integração corpo e comportamento, coordenação, lateralidade'
};

// Biblioteca de ganchos por estilo — cada um tem DNA emocional diferente
const HOOKS = {
  dor: [
    'Seu filho pode estar com dificuldade e você ainda não percebeu',
    'Isso pode estar atrasando o desenvolvimento do seu filho',
    'Muitos pais só descobrem tarde demais',
    'Esse sinal pode estar passando despercebido todos os dias',
    'Você reconhece esse comportamento no seu filho?'
  ],
  alerta: [
    'Se seu filho faz isso, preste atenção agora',
    'Isso é um sinal que você não pode ignorar',
    'Atenção: esse comportamento pode indicar algo importante',
    'Se você perceber isso no seu filho, não espere',
    'Esse sinal aparece cedo — e poucos pais identificam'
  ],
  curiosidade: [
    'Você sabia que isso pode atrasar a fala do seu filho?',
    'Existe um detalhe que a maioria dos pais ignora — e muda tudo',
    'Poucos pais percebem esse sinal silencioso no desenvolvimento',
    'O que ninguém te contou sobre o desenvolvimento do seu filho',
    'Isso explica por que seu filho age assim — e você não vai acreditar',
    'Tem um sinal que aparece cedo demais para a maioria perceber'
  ],
  erro_comum: [
    'A maioria dos pais comete esse erro sem saber',
    'Você pode estar fazendo isso errado com seu filho',
    'Esse erro é mais comum do que parece — e prejudica o desenvolvimento',
    'Pare de fazer isso se quer ajudar seu filho',
    'Esse hábito parece inofensivo — mas não é'
  ],
  autoridade: [
    'Depois de atender centenas de crianças, aprendi isso',
    'Na clínica, vejo esse caso todos os dias — e poucos pais sabem',
    'Isso é o que os pais mais perguntam pra gente — e a resposta surpreende',
    'Como especialista, vou te contar o que realmente importa aqui',
    'Toda semana atendo famílias com essa mesma dúvida'
  ]
};

// Estruturas narrativas — cada hookStyle tem estruturas compatíveis
const ESTRUTURAS_POR_HOOK = {
  curiosidade: {
    B: 'Revelação gradual: Pergunta ou afirmação incompleta que abre curiosity gap → Informação surpreendente revelada aos poucos → Explicação do porquê isso acontece → CTA para compartilhar',
    C: 'Lista surpresa: Hook curiosidade → "Existem X sinais que poucos pais conhecem" → Revelar cada um como descoberta → CTA compartilhar'
  },
  dor: {
    A: 'Empatia + reconhecimento: Hook que nomeia a dor do pai → Valida a preocupação → 2-3 pontos práticos → CTA salvar',
    B: 'Mini história identificação: Situação do dia a dia que o pai reconhece → Explicação emocional → Solução acolhedora → CTA'
  },
  alerta: {
    A: 'Alerta direto: Hook urgente → Explicação rápida do risco → 2-3 sinais concretos → CTA agir agora',
    C: 'Lista de sinais: Hook alerta → Checklist numerada que o pai pode conferir → O que fazer se identificar → CTA'
  },
  erro_comum: {
    D: 'Erro + correção: Nomear o comportamento errado dos pais → Por que prejudica → Correção prática → CTA',
    B: 'Revelação do erro: Hook que implica que o pai pode estar errando → Revelar o erro → Explicar a versão correta → CTA'
  },
  autoridade: {
    B: 'Caso clínico: Abertura com experiência da clínica → Situação real (sem identificar paciente) → Aprendizado aplicável → CTA',
    C: 'Dicas de especialista: Hook autoridade → Lista de dicas práticas do dia a dia clínico → CTA agendar'
  }
};

// Instruções detalhadas por hookStyle — regras frase a frase
const HOOK_INSTRUCOES = {
  curiosidade: `
REGRAS OBRIGATÓRIAS para hookStyle=curiosidade (LEIA COM ATENÇÃO):
PROIBIDO:
- Começar com "Você sabia que..." (clichê, parece aula)
- Entregar a resposta na primeira frase
- Tom professoral ou educativo direto
- Frases genéricas como "isso pode mudar tudo", "isso é importante"

OBRIGATÓRIO — estrutura frase a frase:
- Frase 1: PROVOCATIVA ou ACUSATÓRIA — implica que o pai pode estar errando ou perdendo algo
  Ex fortes: "Você pode estar atrapalhando a fala do seu filho sem perceber",
             "Tem um hábito que a maioria dos pais tem — e atrasa o desenvolvimento",
             "Isso que parece ajudar seu filho pode estar fazendo o contrário"
- Frase 2: aprofunda a tensão — NÃO resolve ("e quase ninguém sabe disso")
- Frase 3-4: contextualiza sem revelar a resposta
- Frase 5-6: revela a virada surpreendente
- Última frase antes do CTA: insight que o pai vai querer compartilhar com outros pais

hook_texto_overlay para curiosidade: frase provocativa curta que cria tensão/dúvida imediata
Ex corretos: "Você pode estar errando com seu filho…", "Isso atrasa a fala — e ninguém fala",
             "O hábito que trava o desenvolvimento", "Tem algo que passa despercebido todo dia"`,

  dor: `
REGRAS OBRIGATÓRIAS para hookStyle=dor:
- Frase 1: nomeia a dor/preocupação real ("Você já ficou preocupada porque seu filho ainda não fala…")
- Tom: empático, de amiga especialista — NÃO alarmista, NÃO professoral
- Validar a preocupação do pai → oferecer acolhimento → caminho prático
- O pai precisa se sentir VISTO e COMPREENDIDO, não assustado`,

  alerta: `
REGRAS OBRIGATÓRIAS para hookStyle=alerta:
- Frase 1: sinal concreto e específico ("Se seu filho ainda não faz isso com X meses, preste atenção")
- Direto e objetivo — NÃO genérico ("isso pode indicar algo")
- Dar 2-3 sinais observáveis no dia a dia com nomes simples
- Terminar com ação clara e urgente`,

  erro_comum: `
REGRAS OBRIGATÓRIAS para hookStyle=erro_comum:
- Frase 1: nomeia o comportamento errado sem rodeios ("A maioria dos pais faz isso — e prejudica sem querer")
- Tom direto mas empático — o pai não é culpado, ele não sabia
- Estrutura: erro → por que prejudica → versão correta → CTA
- O pai deve sair com mudança prática imediata`,

  autoridade: `
REGRAS OBRIGATÓRIAS para hookStyle=autoridade:
- Frase 1: abre com experiência clínica real ("Toda semana atendo famílias com essa dúvida…")
- Dicas específicas e práticas que parecem "segredos de especialista"
- Tom de conversa — NÃO de palestra ou texto de site
- Terminar com CTA natural (não forçado)
hook_texto_overlay OBRIGATÓRIO: prova de experiência real ou dado que surpreende
PROIBIDO em hook_texto_overlay: "uma dica", "isso pode mudar tudo", "veja isso", qualquer frase genérica
Exemplos corretos: "Toda semana vejo esse erro na clínica…", "90% dos pais fazem isso sem saber", "O que vejo todo dia pode estar afetando seu filho"`
};

// Instruções de TOM — como a narração SOA (independente do hookStyle)
const TONE_INSTRUCOES = {
  educativo: `
TOM DO ROTEIRO: EDUCATIVO (Dicas/Fatos)
- Narração didática mas leve — como professora simpática, não como aula
- Incluir 1-2 informações concretas e verificáveis
- Frases tipo: "Na fonoaudiologia, a gente chama isso de...", "Um dado importante:"
- Funciona bem para salvar — o pai guarda o vídeo para usar depois
- Evitar emoção excessiva — o valor é a informação`,

  emotional: `
TOM DO ROTEIRO: EMOCIONAL (Dor/Urgência)
- Narração que ressoa com o estado emocional do pai preocupado
- Validar a angústia antes de qualquer informação: "Eu entendo o que você está sentindo..."
- Ritmo mais lento, frases curtas com pausas intencionais
- Terminar com acolhimento e esperança — nunca com medo
- Funciona bem para comentários e compartilhamentos`,

  inspiracional: `
TOM DO ROTEIRO: INSPIRACIONAL (Transformação)
- Narrativa de transformação positiva — "isso tem solução", "já vi muitas crianças evoluírem"
- Foco no DEPOIS: o que muda quando a família busca ajuda
- Tom esperançoso e encorajador, não sentimental demais
- Pode usar caso de sucesso genérico (sem identificar paciente)
- Funciona bem para compartilhar com outros pais`,

  bastidores: `
TOM DO ROTEIRO: BASTIDORES (Da clínica)
- Humanizar a clínica — mostrar o dia a dia real dos profissionais
- Tom de conversa casual, como se estivesse mostrando "por trás das cenas"
- Frases tipo: "Hoje na clínica aconteceu algo que quero compartilhar..."
- Gera aproximação e confiança — não é comercial
- Funciona bem para engajamento orgânico e comentários`
};

function escolherHook(hookStyle, seed = 0) {
  const lista = HOOKS[hookStyle] || HOOKS.dor;
  return lista[Math.floor(seed * lista.length) % lista.length];
}

function escolherEstrutura(hookStyle, variacao) {
  // Seleciona estrutura compatível com o hookStyle
  const mapa = ESTRUTURAS_POR_HOOK[hookStyle] || ESTRUTURAS_POR_HOOK.dor;
  const letras = Object.keys(mapa);
  const letra = letras[Math.floor(variacao * letras.length) % letras.length];
  return { letra, descricao: mapa[letra] };
}

/**
 * Gera conteúdo estratégico de vídeo (Instagram viral ou Meta Ads)
 *
 * @param {object} params
 * @param {string} params.tema           - Tema livre (pode ser vazio para geração automática)
 * @param {string} params.especialidade  - ID da especialidade/profissional
 * @param {string} params.funil          - TOPO | MEIO | FUNDO
 * @param {number} params.duracao        - Duração em segundos
 * @param {string} params.tone           - emotional | educativo | inspiracional | bastidores
 * @param {string} params.platform       - instagram | meta_ads (default: instagram)
 * @param {string} params.subTema        - subTema da clínica (ex: atraso_fala)
 * @param {string} params.hookStyle      - dor | alerta | curiosidade | erro_comum | autoridade
 * @param {string} params.objetivo       - salvar | compartilhar | comentar | agendar
 * @param {number} params.variacao       - 0..1 — controla estrutura e hook (anti-repetição)
 * @param {string} params.intensidade    - leve | moderado | forte | viral
 */
export async function gerarRoteiro({
  tema,
  especialidade,
  funil = 'TOPO',
  duracao = 60,
  tone = 'educativo',
  platform = 'instagram',
  subTema,
  hookStyle = 'dor',
  objetivo = 'salvar',
  variacao = Math.random(),
  intensidade = 'viral',
  bordao = ''
}) {
  const profissional = ESPECIALIDADE_PROFISSIONAL[subTema] ||
                       ESPECIALIDADE_PROFISSIONAL[especialidade?.toLowerCase()] ||
                       'fono_ana';
  const nomeProfissional = NOMES_PROFISSIONAL[profissional];

  const { letra: estruturaLetra, descricao: estruturaDescricao } = escolherEstrutura(hookStyle, variacao);
  // Hook por subTema é mais preciso — usa como primeiro candidato
  const hookSugerido = escolherHookSubTema(subTema, hookStyle, variacao)
                    || escolherHook(hookStyle, variacao);
  const subTemaContexto = SUBTEMA_CONTEXTO[subTema] || tema || especialidade;

  // Duração ajustada: Instagram = 20-35s, Ads = 30-60s
  const duracaoEfetiva = platform === 'instagram'
    ? Math.min(Math.max(duracao, 20), 35)
    : Math.min(Math.max(duracao, 30), 60);

  // CTAs variados por objetivo × hookStyle — mais naturais e com mais variedade
  const ctaVariantes = {
    salvar: [
      'Salva esse vídeo pra não esquecer',
      'Salva aqui pra consultar depois',
      'Guarda esse vídeo — você vai usar'
    ],
    compartilhar: [
      'Manda pra outro pai ou mãe que precisa ver isso',
      'Compartilha com quem tem filho na mesma idade',
      'Marca aqui um pai ou mãe que precisa saber disso'
    ],
    comentar: [
      'Comenta aqui a idade do seu filho que eu te ajudo',
      'Isso acontece aí? Comenta embaixo',
      'Conta pra mim nos comentários — já passaram por isso?'
    ],
    agendar: [
      'Fala com a gente no WhatsApp e agenda uma avaliação',
      'Manda mensagem no WhatsApp — vamos conversar',
      'Clica no link e agenda uma avaliação gratuita'
    ],
    dm: [
      'Me manda uma mensagem aqui se quiser saber mais',
      'Me chama no direct — te ajudo a entender melhor',
      'Manda DM com a palavra FILHO que eu te respondo'
    ]
  };
  // Seleciona variante baseada na variação (anti-repetição)
  const variantesObj = ctaVariantes[objetivo] || ctaVariantes.comentar;
  const ctaSugerido  = variantesObj[Math.floor(variacao * variantesObj.length) % variantesObj.length];

  logger.info(`[ZEUS] Gerando: subTema=${subTema || especialidade} | hook=${hookStyle} | tone=${tone} | estrutura=${estruturaLetra} | platform=${platform} | intensidade=${intensidade}`);

  const isInstagram = platform === 'instagram';

  const systemPrompt = `Você é ZEUS, especialista em marketing médico infantil e criação de conteúdo viral para Instagram.

Seu objetivo NÃO é apenas gerar um roteiro. É criar conteúdo que:
- Para o scroll nos primeiros 3 segundos
- Faz o pai pensar "isso é exatamente sobre meu filho"
- Gera salvamento, compartilhamento ou comentário real
- Posiciona a clínica como autoridade acolhedora

A clínica Fono Inova atende: Fonoaudiologia, Psicologia Infantil, Terapia Ocupacional, Fisioterapia Infantil, Psicomotricidade, Avaliação Neuropsicológica, Teste da Linguinha.

Público: pais de crianças de 0 a 10 anos com dúvidas sobre desenvolvimento.

REGRAS OBRIGATÓRIAS:
1. Linguagem simples — pai leigo precisa entender tudo
2. NUNCA usar jargão clínico pesado
3. Frases curtas, tom de conversa, como uma amiga especialista
4. Compliance saúde: nunca afirmar diagnóstico; usar "pode indicar", "vale investigar", "é importante observar"
5. Retorne APENAS o JSON solicitado, sem markdown, sem explicações

RELAÇÃO ENTRE hookStyle E tone (ESSENCIAL):
- hookStyle = define COMO o vídeo abre (os primeiros 3 segundos, a isca)
- tone = define COMO o vídeo faz a pessoa SENTIR ao longo de toda a narração
- Os dois devem trabalhar juntos, não se cancelar
- Exemplo: hookStyle=curiosidade + tone=emocional → abre com mistério, mas a narração toda ressoa emocionalmente

ANTI-ROBÔ (regras de naturalidade):
- NUNCA usar a mesma estrutura de frase duas vezes seguidas
- Variar ritmo: alterne frases longas com curtas (cria respiração no texto)
- PROIBIDO: frases genéricas tipo "é muito importante", "isso pode afetar muito", "devemos prestar atenção"
- Cada frase deve acrescentar algo novo — NUNCA repetir a mesma ideia com outras palavras
- Escrever como a profissional FALARIA, não como ela ESCREVERIA num relatório

REGRA GLOBAL DO hook_texto_overlay (A FRASE MAIS IMPORTANTE DO VÍDEO):
O hook_texto_overlay aparece em tela nos primeiros 3 segundos e decide se o usuário continua assistindo.
Ele precisa: parar o scroll, gerar emoção ou curiosidade imediata, ser específico ao tema.
NUNCA usar: "isso pode mudar tudo", "uma dica importante", "veja isso", "você precisa saber", frases vagas.
SEMPRE ser: específico, concreto, emocional ou surpreendente — máximo 8 palavras.
Auto-validação: antes de finalizar, pergunte — "essa frase faria alguém parar de rolar o feed?" Se não → reescreva.

${isInstagram
  ? `MODO INSTAGRAM (ORGÂNICO — VIRAL):
- Duração: 20-35 segundos (frases bem curtas, ritmo acelerado)
- Foco: retenção total + salvamento/compartilhamento
- Hook AGRESSIVO nos primeiros 3 segundos
- Intensidade: ${intensidade}`
  : `MODO META ADS (CONVERSÃO):
- Duração: 30-60 segundos
- Foco: clareza + promessa + CTA para WhatsApp
- Tom mais institucional mas ainda acolhedor`}`;

  const instrucaoHook  = HOOK_INSTRUCOES[hookStyle]  || HOOK_INSTRUCOES.dor;
  const instrucaoTone  = TONE_INSTRUCOES[tone]        || TONE_INSTRUCOES.educativo;

  const userPrompt = `SubTema: ${subTema || especialidade}
Contexto do tema: ${subTemaContexto}
Profissional: ${nomeProfissional}
Funil: ${funil}
Duração alvo: ${duracaoEfetiva} segundos (~${Math.floor(duracaoEfetiva * 2.2)} palavras na narração)
Objetivo do conteúdo: ${objetivo} — ${ctaSugerido}
Intensidade: ${intensidade}

ESTRUTURA NARRATIVA A USAR (${estruturaLetra}):
${estruturaDescricao}

${instrucaoHook}

${instrucaoTone}

HOOK DE REFERÊNCIA (use como inspiração, adapte ao tema): "${hookSugerido}"

COMBINAÇÃO ATIVA: hookStyle="${hookStyle}" + tone="${tone}"
${hookStyle === 'curiosidade' && tone === 'educativo'     ? '→ Abre com mistério, corpo do vídeo entrega a informação como descoberta' : ''}
${hookStyle === 'curiosidade' && tone === 'emotional'     ? '→ Abre com mistério emocional, narração toda ressoa com o coração do pai' : ''}
${hookStyle === 'dor'         && tone === 'emotional'     ? '→ Valida a dor primeiro, depois acolhe — gera muito comentário e DM' : ''}
${hookStyle === 'autoridade'  && tone === 'inspiracional' ? '→ Abre com credencial, corpo mostra transformação possível — gera compartilhamento' : ''}
${hookStyle === 'erro_comum'  && tone === 'educativo'     ? '→ Nomeia o erro, explica o porquê, dá a correção prática — gera salvamento' : ''}
${hookStyle === 'alerta'      && tone === 'bastidores'    ? '→ Alerta vindo de dentro da clínica — humanizado e urgente ao mesmo tempo' : ''}

${bordao ? `BORDÃO OBRIGATÓRIO DE ABERTURA:
O vídeo DEVE começar exatamente com: "${bordao}"
- A primeira palavra falada na narração é "${bordao}"
- O hook_texto_overlay também deve começar com "${bordao}"
- Mantenha o tom curioso/educativo após o bordão — NÃO acusatório
- Ex: "${bordao} que criticar seu filho pode travar a fala?" → correto
- Ex: "${bordao} que existe um sinal que a maioria dos pais ignora?" → correto
` : ''}
VERIFICAÇÃO OBRIGATÓRIA antes de finalizar (em ordem):
1. hook_texto_overlay: essa frase faria alguém parar de rolar o feed? É genérica? Se sim → REESCREVA antes de continuar.
${bordao ? `1b. hook_texto_overlay começa com "${bordao}"? Se não → REESCREVA.` : ''}
2. Primeira frase da narração abre no estilo "${hookStyle}" correto?
${bordao ? `2b. Primeira palavra da narração é "${bordao}"? Se não → REESCREVA.` : ''}
3. Toda a narração mantém o tom "${tone}" do início ao fim?
4. As frases variam em ritmo (curtas e longas alternadas)?
5. CTA final é exatamente: "${ctaSugerido}"?

Retorne JSON:
{
  "roteiro": {
    "titulo": "título curto snake_case max 40 chars",
    "profissional": "${profissional}",
    "duracao_estimada": ${duracaoEfetiva},
    "texto_completo": "narração exata que o avatar vai falar, tom de conversa",
    "hook_texto_overlay": "frase do hook em tela, max 8 palavras",
    "cta_texto_overlay": "${ctaSugerido}",
    "legenda_instagram": "legenda completa pro post com quebras de linha, emojis leves e CTA final",
    "hashtags": ["hashtag1", "hashtag2", "hashtag3", "hashtag4", "hashtag5"],
    "estrutura_usada": "${estruturaLetra}",
    "objetivo": "${objetivo}",
    "copy_anuncio": {
      "texto_primario": "copy 2-3 linhas pra Meta Ads",
      "headline": "headline 5-8 palavras",
      "descricao": "descrição secundária 1 frase"
    }
  }
}`;

  try {
    // curiosidade e erro_comum precisam de mais criatividade para não repetir padrões
    const temperature = ['curiosidade', 'erro_comum'].includes(hookStyle) ? 1.0 : 0.85;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature,
      max_tokens: 1800,
      response_format: { type: 'json_object' }
    });

    const resultado = JSON.parse(response.choices[0].message.content);

    if (!resultado.roteiro?.texto_completo) {
      throw new Error('ZEUS retornou roteiro sem texto_completo');
    }

    const palavras = resultado.roteiro.texto_completo.split(/\s+/).length;
    logger.info(`[ZEUS] ✅ Roteiro gerado: ${palavras} palavras | estrutura=${resultado.roteiro.estrutura_usada} | ${nomeProfissional}`);

    return resultado;

  } catch (error) {
    logger.error('[ZEUS] Erro ao gerar roteiro:', error.message);
    throw error;
  }
}

export default { gerarRoteiro };
