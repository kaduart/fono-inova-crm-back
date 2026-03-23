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

// Biblioteca de ganchos por estilo
const HOOKS = {
  dor: [
    'Seu filho pode estar com dificuldade e você ainda não percebeu',
    'Isso pode estar atrasando o desenvolvimento do seu filho',
    'Muitos pais só descobrem tarde demais',
    'Esse sinal pode estar passando despercebido'
  ],
  alerta: [
    'Se seu filho faz isso, preste atenção',
    'Isso é um sinal que você não pode ignorar',
    'Atenção: isso pode indicar algo importante',
    'Se você perceber isso, não espere'
  ],
  curiosidade: [
    'Poucos pais sabem disso sobre o desenvolvimento infantil',
    'Isso pode mudar tudo no desenvolvimento do seu filho',
    'Existe um sinal silencioso que quase ninguém percebe',
    'Isso explica por que seu filho age assim'
  ],
  erro_comum: [
    'A maioria dos pais comete esse erro sem saber',
    'Você pode estar fazendo isso errado',
    'Esse erro é mais comum do que você imagina',
    'Pare de fazer isso se quer ajudar seu filho'
  ],
  autoridade: [
    'Como especialista, vejo isso todos os dias na clínica',
    'Depois de atender centenas de crianças, aprendi isso',
    'Na clínica, esse é um dos casos mais comuns',
    'Isso é o que os pais mais perguntam pra gente'
  ]
};

// 4 estruturas narrativas variáveis
const ESTRUTURAS = {
  A: 'Alerta direto: Hook → Explicação rápida → 2-3 sinais práticos → CTA',
  B: 'Mini história: Pergunta de identificação → Situação do dia a dia → Explicação leve → CTA',
  C: 'Lista prática: Hook → Lista numerada de sinais/dicas → Conclusão → CTA',
  D: 'Erro comum: Comportamento errado dos pais → Correção → Por que isso importa → CTA'
};

function escolherHook(hookStyle, seed = 0) {
  const lista = HOOKS[hookStyle] || HOOKS.dor;
  return lista[Math.floor(seed * lista.length) % lista.length];
}

function escolherEstrutura(variacao) {
  const letras = Object.keys(ESTRUTURAS);
  return letras[Math.floor(variacao * letras.length) % letras.length];
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
  intensidade = 'viral'
}) {
  const profissional = ESPECIALIDADE_PROFISSIONAL[subTema] ||
                       ESPECIALIDADE_PROFISSIONAL[especialidade?.toLowerCase()] ||
                       'fono_ana';
  const nomeProfissional = NOMES_PROFISSIONAL[profissional];

  const estruturaLetra = escolherEstrutura(variacao);
  const estruturaDescricao = ESTRUTURAS[estruturaLetra];
  const hookSugerido = escolherHook(hookStyle, variacao);
  const subTemaContexto = SUBTEMA_CONTEXTO[subTema] || tema || especialidade;

  // Duração ajustada: Instagram = 20-35s, Ads = 30-60s
  const duracaoEfetiva = platform === 'instagram'
    ? Math.min(Math.max(duracao, 20), 35)
    : Math.min(Math.max(duracao, 30), 60);

  // CTA varia pelo objetivo
  const ctaMap = {
    salvar:       'Salve esse vídeo para não esquecer',
    compartilhar: 'Manda esse vídeo para outro pai ou mãe',
    comentar:     'Comenta aqui a idade do seu filho que eu te ajudo',
    agendar:      'Fale com a gente no WhatsApp e agende uma avaliação'
  };
  const ctaSugerido = ctaMap[objetivo] || ctaMap.comentar;

  logger.info(`[ZEUS] Gerando: subTema=${subTema || especialidade} | hook=${hookStyle} | estrutura=${estruturaLetra} | platform=${platform} | intensidade=${intensidade}`);

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
4. NUNCA soar robótico ou genérico
5. Compliance saúde: nunca afirmar diagnóstico; usar "pode indicar", "vale investigar", "é importante observar"
6. Retorne APENAS o JSON solicitado, sem markdown, sem explicações

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

  const userPrompt = `SubTema: ${subTema || especialidade}
Contexto do tema: ${subTemaContexto}
Profissional: ${nomeProfissional}
Funil: ${funil}
Duração alvo: ${duracaoEfetiva} segundos (~${Math.floor(duracaoEfetiva * 2.2)} palavras na narração)
Objetivo do conteúdo: ${objetivo} — ${ctaSugerido}
Intensidade: ${intensidade}

ESTRUTURA A USAR (${estruturaLetra}): ${estruturaDescricao}

HOOK SUGERIDO (adapte se necessário): "${hookSugerido}"

ESTILO DO HOOK: ${hookStyle}
${hookStyle === 'dor'        ? '→ Mostrar preocupação real, angústia de pai que não sabe o que fazer' : ''}
${hookStyle === 'alerta'     ? '→ Risco ou atenção urgente, sem causar pânico' : ''}
${hookStyle === 'curiosidade'? '→ Algo pouco conhecido que vai surpreender o pai' : ''}
${hookStyle === 'erro_comum' ? '→ Comportamento que muitos pais fazem e que prejudica o filho' : ''}
${hookStyle === 'autoridade' ? '→ Experiência clínica real, caso do dia a dia' : ''}

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
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.8,
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
