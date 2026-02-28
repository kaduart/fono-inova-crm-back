/**
 * 📍 Serviço de integração com Google Meu Negócio (GMB)
 * Modo: Geração de conteúdo + Make (Integromat) para publicação automática
 */

import OpenAI from 'openai';
import { v2 as cloudinary } from 'cloudinary';
import GmbPost from '../models/GmbPost.js';
import { gerarImagemBranded } from './brandImageService.js';

// OpenAI - GPT-3.5
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * 🏥 ESPECIALIDADES DA FONO INOVA
 */
export const ESPECIALIDADES = [
  {
    id: 'fonoaudiologia',
    nome: 'Fonoaudiologia',
    url: 'https://www.clinicafonoinova.com.br/fonoaudiologia',
    foco: 'Fala, linguagem, pronúncia, gagueira, autismo, TDAH, atraso de fala',
    publico: 'crianças com dificuldades de comunicação',
    gancho: 'Sua criança não fala ainda?'
  },
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
    url: 'https://www.clinicafonoinova.com.br/terapia-ocupacional',
    foco: 'Autonomia, coordenação motora fina, alimentação, vestir, higiene',
    publico: 'crianças com dificuldades de autonomia',
    gancho: 'Sua criança ainda depende muito de você?'
  },
  {
    id: 'fisioterapia',
    nome: 'Fisioterapia',
    url: 'https://www.clinicafonoinova.com.br/fisioterapia',
    foco: 'Postura, fortalecimento muscular, equilíbrio, tônus, motricidade global',
    publico: 'crianças com dificuldades posturais ou motoras',
    gancho: 'Sua criança tropeça muito ou tem postura curvada?'
  },
  {
    id: 'psicomotricidade',
    nome: 'Psicomotricidade',
    url: 'https://www.clinicafonoinova.com.br/psicomotricidade',
    foco: 'Corpo, movimento, esquema corporal, lateralidade, aprendizagem escolar',
    publico: 'crianças em fase de alfabetização',
    gancho: 'Seu filho confunde letras ou é desatento na escola?'
  },
  {
    id: 'freio_lingual',
    nome: 'Freio Lingual',
    url: 'https://www.clinicafonoinova.com.br/freio-lingual',
    foco: 'Língua presa, sucção, mastigação, amamentação, fala',
    publico: 'bebês e crianças com freio curto',
    gancho: 'Seu bebê tem dificuldade para mamar ou engolir?'
  },
  {
    id: 'neuropsicologia',
    nome: 'Avaliação Neuropsicológica',
    url: 'https://www.clinicafonoinova.com.br/avaliacao-neuropsicologica',
    foco: 'Memória, atenção, concentração, funções executivas, cognição',
    publico: 'crianças com dificuldades de aprendizagem ou TDAH',
    gancho: 'Seu filho esquece o que acabou de aprender?'
  },
  {
    id: 'psicopedagogia_clinica',
    nome: 'Psicopedagogia Clínica',
    url: 'https://www.clinicafonoinova.com.br/psicopedagogia-clinica',
    foco: 'Alfabetização, leitura, escrita, matemática, dislexia, disortografia',
    publico: 'crianças com dificuldades escolares',
    gancho: 'Sua criança tem dificuldade para ler ou escrever?'
  },
  {
    id: 'psicopedagogia',
    nome: 'Psicopedagogia',
    url: 'https://www.clinicafonoinova.com.br/psicopedagogia',
    foco: 'Desenvolvimento cognitivo, aprendizagem escolar, raciocínio lógico',
    publico: 'crianças em desenvolvimento escolar',
    gancho: 'O desenvolvimento da sua criança está na idade certa?'
  },
  {
    id: 'musicoterapia',
    nome: 'Musicoterapia',
    url: 'https://www.clinicafonoinova.com.br/musicoterapia',
    foco: 'Expressão emocional, comunicação não verbal, ritmo, som, autismo',
    publico: 'crianças com dificuldades de expressão ou autismo',
    gancho: 'Sua criança se fecha ou não se expressa?'
  }
];

/**
 * 🎯 HORÁRIOS ESTRATÉGICOS
 */
export const HORARIOS_PUBLICACAO = [
  '08:00', '12:30', '15:00', '19:00', '21:00'
];

/**
 * 📅 OBTÉM PRÓXIMA ESPECIALIDADE
 */
async function getNextEspecialidade() {
  try {
    const lastPost = await GmbPost.findOne({
      theme: { $in: ESPECIALIDADES.map(e => e.id) }
    })
      .sort({ createdAt: -1 })
      .select('theme')
      .lean();

    if (!lastPost) return ESPECIALIDADES[0];

    const currentIndex = ESPECIALIDADES.findIndex(e => e.id === lastPost.theme);
    const nextIndex = (currentIndex + 1) % ESPECIALIDADES.length;

    return ESPECIALIDADES[nextIndex];
  } catch {
    return ESPECIALIDADES[0];
  }
}

/**
 * 🎯 PROMPTS ESPECÍFICOS POR ESPECIALIDADE — foco em geração de leads
 */
const PROMPTS_ESPECIALIDADE = {
  fonoaudiologia: {
    dor: 'a criança não fala, tem fala enrolada, gagueja, não pronuncia letras, tem diagnóstico de autismo ou TDAH, ou o pediatra disse "vamos esperar mais um pouco"',
    urgencia: 'cada mês sem intervenção é um mês de atraso no desenvolvimento da fala — quanto antes, melhores os resultados',
    diferencial: 'a Fono Inova tem fonoaudiólogos especializados em linguagem infantil que identificam a causa real do atraso e montam um plano individualizado',
    gatilho: 'pais que estão em dúvida se devem buscar ajuda agora ou esperar mais',
  },
  psicologia: {
    dor: 'a criança tem crises de choro sem motivo, agressividade, ansiedade, dificuldade de socializar, medo excessivo, comportamentos repetitivos ou tristeza',
    urgencia: 'comportamentos emocionais não resolvidos na infância se tornam padrões difíceis de mudar na adolescência',
    diferencial: 'a Fono Inova tem psicólogos infantis que trabalham com brinquedos e técnicas lúdicas — a criança nem percebe que está em terapia',
    gatilho: 'pais que se sentem esgotados e sem saber como ajudar o filho emocionalmente',
  },
  terapia_ocupacional: {
    dor: 'a criança tem dificuldade para se vestir sozinha, se recusa a comer certos alimentos, não consegue segurar lápis, tem sensibilidade ao toque ou barulho, ou perde equilíbrio fácil',
    urgencia: 'dificuldades de autonomia afetam diretamente a autoestima e o desempenho escolar — intervenção precoce evita isso',
    diferencial: 'a Fono Inova usa a abordagem de integração sensorial — transforma atividades do dia a dia em terapia sem a criança perceber',
    gatilho: 'pais que acham que o filho é "difícil" ou "mimado" sem saber que pode ser uma questão sensorial',
  },
  fisioterapia: {
    dor: 'a criança tropeça muito, tem postura curvada, cansa fácil, tem hipotonia (músculo molinho), dificuldade de correr ou pular, ou ficou com sequela após uma cirurgia',
    urgencia: 'o corpo em desenvolvimento corrige padrões motores com muito mais facilidade na infância — na adolescência é muito mais difícil',
    diferencial: 'a Fono Inova combina fisioterapia com atividades lúdicas — a criança se exercita brincando sem resistência',
    gatilho: 'pais que achavam que o filho só era "desajeitado" e descobriram que há algo a tratar',
  },
  psicomotricidade: {
    dor: 'a criança confunde letras (b/d, p/q), tem caligrafia ilegível, não sabe direita de esquerda, é desatenta na escola ou tem dificuldade de coordenação para esportes',
    urgencia: 'o período dos 4 aos 8 anos é a janela ideal para desenvolver o esquema corporal que sustenta a alfabetização — depois fica muito mais difícil',
    diferencial: 'a Fono Inova usa psicomotricidade relacional — jogos de movimento que preparam o cérebro para ler, escrever e calcular',
    gatilho: 'pais que receberam reclamação da escola sobre coordenação ou atenção do filho',
  },
  freio_lingual: {
    dor: 'o bebê tem dificuldade para mamar, fica irrequieto no peito, a mãe sente dor ao amamentar, ou a criança maior tem dificuldade para pronunciar o "R" ou "L"',
    urgencia: 'o freio lingual não tratado afeta amamentação, mastigação, deglutição e fala — quanto antes avaliado, mais simples a solução',
    diferencial: 'a Fono Inova faz avaliação completa do freio lingual com protocolo MBGR e orienta sobre o procedimento mais adequado para cada caso',
    gatilho: 'mães que estão sofrendo para amamentar e ninguém identificou ainda a causa',
  },
  neuropsicologia: {
    dor: 'a criança esquece o que acabou de aprender, é muito dispersa, tem dificuldade de concentração, demora muito para fazer tarefas simples ou tem suspeita de TDAH, dislexia ou TEA',
    urgencia: 'uma avaliação neuropsicológica identifica exatamente onde está a dificuldade — sem isso qualquer intervenção é um chute no escuro',
    diferencial: 'a Fono Inova emite laudo neuropsicológico detalhado com orientações para escola, família e outros profissionais — um mapa completo do desenvolvimento',
    gatilho: 'pais que estão há anos ouvindo "é só falta de atenção" sem um diagnóstico claro',
  },
  psicopedagogia_clinica: {
    dor: 'a criança lê muito devagar, troca letras ao escrever, não consegue aprender a ler mesmo com esforço, tem dificuldade com matemática ou recebe diagnóstico de dislexia ou disortografia',
    urgencia: 'dificuldades de leitura e escrita não tratadas geram baixa autoestima e bloqueio escolar que pode durar a vida toda — a intervenção antes dos 9 anos tem 90% de sucesso',
    diferencial: 'a Fono Inova usa método fônico estruturado e terapia cognitiva — a criança aprende de um jeito que faz sentido para o cérebro dela',
    gatilho: 'pais desesperados porque o filho repete de ano ou está muito abaixo dos colegas em leitura',
  },
  psicopedagogia: {
    dor: 'a criança não tem interesse em aprender, não consegue se organizar para estudar, tem notas baixas mesmo estudando, ou perdeu a motivação na escola',
    urgencia: 'dificuldades de aprendizagem sem suporte viram crenças limitantes — a criança passa a acreditar que "não é boa nos estudos"',
    diferencial: 'a Fono Inova investiga o estilo de aprendizagem único de cada criança e cria estratégias personalizadas para ela aprender de verdade',
    gatilho: 'pais que estão brigando diariamente com o filho para fazer lição e não sabem mais o que fazer',
  },
  musicoterapia: {
    dor: 'a criança tem autismo, não se comunica verbalmente, tem dificuldade de expressar emoções, está isolada socialmente ou não responde a terapias tradicionais',
    urgencia: 'a música acessa áreas do cérebro que outras terapias não alcançam — especialmente em crianças com TEA e dificuldades de comunicação não verbal',
    diferencial: 'a Fono Inova usa musicoterapia receptiva e ativa — a criança se conecta através do ritmo e do som quando as palavras ainda não chegaram',
    gatilho: 'pais de crianças com autismo que já tentaram várias terapias e estão buscando algo diferente',
  },
};

/**
 * 🤖 GERA POST COM GPT - VERSÃO ESTRATÉGICA
 * Prompt turbinado com gatilhos psicológicos por funil
 */
export async function generatePostForEspecialidade(especialidade, customTheme = null, funnelStage = 'top') {
  try {
    const nicho = PROMPTS_ESPECIALIDADE[especialidade.id] || null;

    // 🧠 LÓGICA ESTRATÉGICA: Define gatilho e CTA baseado no funil
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

    const estrategia = estrategiaPorFunil[funnelStage] || estrategiaPorFunil.top;
    const gatilhoPrincipal = estrategia.gatilhos[Math.floor(Math.random() * estrategia.gatilhos.length)];

    const temaTexto = customTheme
      ? `TEMA ESPECÍFICO: "${customTheme}" dentro da área de ${especialidade.nome}`
      : `GANCHO: ${especialidade.gancho}`;

    const nichoInstrucoes = nicho ? `
DOR DO PAI/MÃE: ${nicho.dor}
URGÊNCIA: ${nicho.urgencia}
DIFERENCIAL DA CLÍNICA: ${nicho.diferencial}
GATILHO EMOCIONAL: ${nicho.gatilho}` : '';

    // 🎯 KEYWORD SEO DINÂMICA
    const keywordSEO = `${especialidade.nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')} infantil`;

    const messages = [
      {
        role: 'system',
        content: `Você é estrategista de conteúdo da Clínica Fono Inova, especialista em copywriting para saúde infantil.

REGRAS INEGOCIÁVEIS:
- Máximo 200 palavras
- Máximo 2 emojis
- SEM alarmismo (saúde infantil é sensível)
- SEM promessas de cura
- Tom: técnico mas conversacional (como mãe experiente falando com outra)
- Proibido usar pontos no meio das frases do hook (frase corrida para vídeos)
- CTA deve ser CHOCANTE, VIRAL e QUEBRAR PADRÕES (não use "Agende pelo link")`
      },
      {
        role: 'user',
        content: `Crie post estratégico para ${especialidade.nome}.

${temaTexto}
FOCO: ${especialidade.foco}
PÚBLICO: Pais de ${especialidade.publico}
${nichoInstrucoes}

📊 ESTRATÉGIA DO FUNIL (${funnelStage.toUpperCase()}):
- Objetivo: ${estrategia.objetivo}
- Gatilho dominante: ${gatilhoPrincipal}
- Tom obrigatório: ${estrategia.tom}
- CTA obrigatória: "${estrategia.cta}"

🎯 SEO OBRIGATÓRIO:
- Inclua a palavra-chave "${keywordSEO}" naturalmente no meio do texto (densidade 1-2%)
- NÃO comece com a keyword
- Primeiras 125 caracteres devem conter o hook principal

📋 ESTRUTURA OBRIGATÓRIA:

1️⃣ HOOK (2 frases curtas, máx 25 palavras):
- Use o gatilho ${gatilhoPrincipal}
- Frase corrida (evite pontos no meio)
- Interrompa o scroll imediatamente
- Exemplo se Curiosidade: "Tem uma coisa sobre ${especialidade.nome.toLowerCase()} que ninguém te contou e que pode estar prejudicando seu filho sem você perceber"
- Exemplo se Contradição: "Pare de fazer isso com seu filho - você está atrasando o desenvolvimento sem saber"

2️⃣ VALOR + CONEXÃO:
- Valide a dor: "Você não está sozinha, isso é mais comum do que parece"
- Explique o problema de forma simples
- Como a Fono Inova resolve (específico, não genérico)

3️⃣ SEO NATURAL:
- Insira "${keywordSEO}" no meio do texto
- Use termos relacionados: desenvolvimento infantil, Anápolis, terapia infantil

4️⃣ CTA ESTRATÉGICA:
- Use EXATAMENTE: "${estrategia.cta}"
- NÃO invente outra CTA
- Seja específico e gerador de ação

💡 DICA: Pense como um Social Media profissional, não como assistente genérico. Cada palavra deve ter propósito estratégico.

${customTheme ? `\n🎯 FOCO ESPECIAL NO TEMA: ${customTheme}` : ''}`
      }
    ];

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: messages,
      max_tokens: 450,
      temperature: 0.8
    });

    const content = response.choices[0].message.content.trim();
    
    // Extrai título do hook (primeiras 80 chars da primeira linha não vazia)
    const linhas = content.split('\n').filter(l => l.trim());
    const primeiraLinha = linhas[0]?.replace(/^[^a-zA-Z0-9]+/, '').substring(0, 80) || especialidade.gancho;

    return {
      title: primeiraLinha,
      content,
      especialidade,
      estrategia: {
        funnelStage,
        gatilho: gatilhoPrincipal,
        objetivo: estrategia.objetivo,
        cta: estrategia.cta
      }
    };

  } catch (error) {
    console.error('❌ Erro OpenAI:', error.message);
    return generateFallbackPost(especialidade);
  }
}

/**
 * 📝 POST TEMPLATE (FALLBACK)
 */
function generateFallbackPost(especialidade) {
  const nicho = PROMPTS_ESPECIALIDADE[especialidade.id];
  const dor = nicho?.dor?.split(',')[0] || especialidade.foco.split(',')[0];

  const templates = [
    `${especialidade.gancho}\n\nSe você reconhece esse sinal no seu filho, saiba que não está sozinho — e que existe solução.\n\nNa Fono Inova, nossos especialistas em ${especialidade.nome} identificam a causa real e criam um plano personalizado para cada criança.\n\nQuanto antes a avaliação, melhores os resultados. Agende uma avaliação pelo link abaixo 👇`,

    `Você sabia que ${dor} é mais comum do que parece?\n\nMuitos pais passam meses esperando "melhorar sozinho" — e perdem o momento ideal de intervenção.\n\nNa Fono Inova em Anápolis, atendemos ${especialidade.publico} com uma equipe especializada e ambiente pensado para crianças.\n\nAgende uma avaliação pelo link abaixo 👇`,

    `${especialidade.gancho}\n\nIsso pode ser sinal de que seu filho precisa de apoio especializado em ${especialidade.nome}.\n\nNa Fono Inova, cada criança recebe um atendimento único — porque cada desenvolvimento é único.\n\nNão espere o problema aumentar. Agende uma avaliação pelo link abaixo 👇`
  ];

  const dia = new Date().getDate();
  const template = templates[dia % templates.length];

  return {
    title: especialidade.gancho,
    content: template,
    especialidade,
    isFallback: true
  };
}

// ─────────────────────────────────────────────
// SUBSTITUI TODA A FUNÇÃO generateImagePromptFromContent no gmbService.js
// ─────────────────────────────────────────────

function generateImagePromptFromContent(content, especialidade) {
  const c = content.toLowerCase();

  const pessoas = [
    'real Brazilian female therapist, white skin, long straight brown hair, ' +
    'light Mediterranean complexion, colorful cheerful patterned scrubs top, professional clinical attire, NOT white coat, NOT white shirt',

    'real Brazilian female therapist, white skin, straight black hair shoulder length, ' +
    'Southern Brazilian European features, colorful cheerful patterned scrubs top, professional clinical attire, NOT white coat, NOT white shirt',

    'real Brazilian female therapist, light skin, straight dark brown hair, ' +
    'Southeast Brazilian features, morena clara, colorful cheerful patterned scrubs top, professional clinical attire, NOT white coat, NOT white shirt',

    'real Brazilian female therapist, fair skin, wavy brown hair, ' +
    'Brazilian mixed European heritage features, colorful cheerful patterned scrubs top, professional clinical attire, NOT white coat, NOT white shirt',

    'real Brazilian female therapist, light olive skin, straight dark hair in bun, ' +
    'typical Southeast Brazilian appearance, colorful cheerful patterned scrubs top, professional clinical attire, NOT white coat, NOT white shirt',
  ];

  const criancas = [
    'real Brazilian child age 5-7, light skin, straight dark hair, natural happy expression',
    'real Brazilian child age 5-7, tan skin, wavy dark hair, happy curious expression',
    'real Brazilian child age 5-7, warm brown skin, curly dark hair, smiling engaged expression',
    'real Brazilian child age 5-7, olive skin, straight brown hair, bright curious eyes',
    'real Brazilian child age 5-7, light brown skin, loose curly hair, warm attentive expression',
  ];

  const person = pessoas[Math.floor(Math.random() * pessoas.length)];
  const child = criancas[Math.floor(Math.random() * criancas.length)];
  const personMale = 'real Brazilian male therapist late 20s, light olive skin, short dark hair, colorful clinical scrubs, warm smile';
  const parent = 'real Brazilian mother early 30s, light caramel skin, dark wavy hair, casual everyday clothes, warm gentle smile';

  // ESTILO FOTOGRÁFICO — cinematográfico, natural, não forçado
  const photoStyle =
    'Cinematic photo, professional pediatric therapy session, ' +
    'genuine natural expressions (NOT posed smile, NOT exaggerated), ' +
    'soft window light, shallow depth of field, ' +
    'professional healthcare photography style, ' +
    'realistic skin texture, natural skin tones, ' +
    'authentic candid moment, documentary style, ' +
    'child and therapist naturally engaged in activity, ' +
    'NO forced smiles, NO teeth showing, ' +
    'NO text, NO watermarks, 4K quality, ' +
    'premium Brazilian pediatric clinic environment';

  // AMBIENTES — clínicos, alegres, acolhedores
  const rooms = {
    fono:
      'bright cheerful pediatric speech therapy room, ' +
      'white walls with colorful children alphabet posters and animal illustrations pinned up, ' +
      'large window with soft natural light, light hardwood floor, ' +
      'modern white low table, colorful picture cards spread on table, ' +
      'wooden shelves with therapy toys and picture books, ' +
      'large mirror on one wall, warm cheerful professional pediatric clinic',

    psico:
      'warm cheerful pediatric psychology room, ' +
      'soft sage green accent wall with colorful children art prints, ' +
      'large window with sheer white curtains, light hardwood floor, ' +
      'small round white table, two low child-height chairs, ' +
      'wooden shelf with dolls stuffed animals and drawing materials, ' +
      'cozy welcoming professional pediatric clinic',

    to:
      'bright cheerful occupational therapy room, ' +
      'white walls with colorful educational posters and children illustrations, ' +
      'large window with natural light, light hardwood floor, ' +
      'modern white activity table at child height, ' +
      'wooden Montessori shelves with beads pegboards puzzles and fine motor toys, ' +
      'small colorful foam mat area, warm professional pediatric clinic',

    fisio:
      'spacious bright pediatric physiotherapy gym, ' +
      'white walls with colorful exercise and body illustration posters, ' +
      'floor-to-ceiling windows with trees outside, light hardwood floor, ' +
      'colorful foam therapy steps blocks and balance beam, ' +
      'cheerful energetic professional pediatric rehabilitation clinic',

    psicomotri:
      'large bright psychomotor therapy room, ' +
      'white walls with colorful movement and body awareness posters, ' +
      'floor-to-ceiling windows with abundant natural light, ' +
      'premium colorful foam mats covering floor, ' +
      'foam tunnels steps and soft obstacles, ' +
      'joyful energetic professional pediatric clinic',

    neuro:
      'clean bright neuropsychology assessment room, ' +
      'white walls with colorful framed alphabet and number prints, ' +
      'large window with natural light, light hardwood floor, ' +
      'modern white desk at child height, two ergonomic chairs, ' +
      'organized colorful cognitive assessment blocks and cards on table, ' +
      'warm focused professional pediatric clinic',

    music:
      'warm bright music therapy room, ' +
      'white walls with colorful music note and instrument illustrations, ' +
      'large window with natural light, light hardwood floor with fabric rug, ' +
      'wooden shelves with drum tambourine xylophone acoustic guitar, ' +
      'small colorful cushions on floor, joyful creative professional pediatric clinic',

    psicoped:
      'bright cheerful learning support room, ' +
      'white walls covered with colorful alphabet number and children book illustration posters, ' +
      'large window with abundant natural light, light hardwood floor, ' +
      'modern white desk at child height, ergonomic low chairs, ' +
      'wooden Montessori shelves with educational books wooden puzzles and learning materials, ' +
      'warm encouraging professional pediatric clinic',

    freio:
      'clean warm pediatric consultation room, ' +
      'white walls with one colorful children educational illustration print, ' +
      'large window with soft natural light, light hardwood floor, ' +
      'modern comfortable examination chair, sleek white cabinet, ' +
      'small plant in corner, warm professional private pediatric clinic',
  };

  // INTERAÇÃO obrigatória — força engajamento mútuo
  const interacao =
    'therapist and child FACING EACH OTHER, ' +
    'both actively engaged in the same activity together, ' +
    'warm emotional connection visible, ' +
    'child face fully visible showing delight or concentration, ' +
    'therapist leaning toward child with genuine warm attention, NOT child with back to camera, ';

  const prompts = {
    fonoaudiologia: {
      default: `${interacao}${person} and ${child} both seated at white table, therapist holding colorful picture card between them, child pointing at card mouth slightly open practicing sound, therapist watching attentively with warm encouraging expression, ${rooms.fono}, large mirror reflecting scene`,
      espelho: `${interacao}${person} seated facing ${child} at child height, therapist pointing at own mouth making exaggerated sound shape, child watching with wide curious eyes mouth open trying to copy, ${rooms.fono} with large mirror on wall`,
    },

    psicologia: {
      default: `${interacao}${person} seated at small table across from ${child}, child drawing with crayon showing drawing to therapist with proud smile, therapist leaning forward looking at drawing with warm attentive expression, ${rooms.psico}`,
    },

    terapia_ocupacional: {
      default: `${interacao}${person} seated beside ${child} at activity table, child threading colorful wooden beads with tongue slightly out concentrating, therapist pointing encouragingly at next bead with warm calm expression, ${rooms.to}`,
      motor: `${interacao}${person} and ${child} at white table, child carefully placing puzzle piece with focused expression, therapist guiding with gentle hand gesture and warm smile, ${rooms.to}`,
      alimenta: `${interacao}${person} seated beside ${child} at table, child gripping spoon scooping from bowl with concentrated expression, therapist watching encouragingly with patient warm smile, ${rooms.to}`,
    },

    fisioterapia: {
      default: `${interacao}${child} standing on low balance beam arms out with big smile, ${person} standing in front holding child hands for support, both looking at each other with joy and focus, ${rooms.fisio}`,
    },

    psicomotricidade: {
      default: `${interacao}${person} crouching down to child level holding colorful ball out toward ${child}, child reaching forward with focused engaged expression to grab ball, both faces visible and engaged, ${rooms.psicomotri}`,
    },

    freio_lingual: {
      default: `${interacao}${parent} seated holding calm happy baby facing ${person}, therapist looking at baby with calm warm professional smile, baby looking at therapist with curious smile, ${rooms.freio}`,
    },

    neuropsicologia: {
      default: `${interacao}${child} seated at desk placing colorful geometric block with intense focus, ${person} seated beside leaning forward watching with calm engaged expression pointing at next piece, ${rooms.neuro}`,
    },

    psicopedagogia_clinica: {
      default: `${interacao}${person} seated beside ${child} at desk, therapist pointing at word in colorful open book, child leaning forward finger on page with bright curious expression, ${rooms.psicoped}`,
      leitura: `${interacao}${child} finger tracing words in open colorful book mouth moving, ${person} beside finger under text smiling encouragingly at child, ${rooms.psicoped}`,
      escrita: `${interacao}${child} gripping pencil writing letters with concentrated expression, ${person} beside watching with warm approving smile leaning slightly toward child, ${rooms.psicoped}`,
    },

    psicopedagogia: {
      default: `${interacao}${person} and ${child} at white table, colorful educational board game between them, child moving game piece with focused engaged expression looking at therapist, therapist responding with warm delighted smile, ${rooms.psicoped}`,
    },

    musicoterapia: {
      default: `${interacao}${personMale} seated on stool playing acoustic guitar, ${child} seated facing therapist clapping hands and singing along with big soft genuine smile, both looking at each other with joy, ${rooms.music}`,
    },
  };

  const mapa = prompts[especialidade.id] || {
    default: `${interacao}${person} and ${child} engaged in pediatric therapy activity together at table, both faces visible and connected, ${rooms.psicoped}`,
  };

  for (const [chave, prompt] of Object.entries(mapa)) {
    if (chave !== 'default' && c.includes(chave)) {
      return prompt + ', ' + photoStyle;
    }
  }

  return mapa.default + ', ' + photoStyle;
}
// ─────────────────────────────────────────────
// UPLOAD PRO CLOUDINARY
// ─────────────────────────────────────────────
async function uploadToCloudinary(imageBlob, especialidadeId) {
  const buffer = Buffer.from(await imageBlob.arrayBuffer());
  const base64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;

  const result = await cloudinary.uploader.upload(base64, {
    folder: 'fono-inova/gmb',
    public_id: `${especialidadeId}_${Date.now()}`,
    transformation: [{ width: 1024, height: 1024, crop: 'fill', quality: 'auto' }],
  });

  return result.secure_url;
}

// ─────────────────────────────────────────────
// GERA IMAGEM — Múltiplos providers → Cloudinary
// ─────────────────────────────────────────────
export async function generateImageForEspecialidade(especialidade, postContent = '', withBranding = true, provider = 'auto') {
  const prompt = generateImagePromptFromContent(postContent || especialidade.foco, especialidade);
  console.log(`🎨 Prompt [branding=${withBranding}] [provider=${provider}]:`, prompt.substring(0, 100) + '...');

  // Título extraído do conteúdo para o SVG de branding
  const tituloPost = (postContent.split('\n')[0] || '')
    .replace(/^[*#\s]+/, '').substring(0, 55) || especialidade.nome;

  // Sobe foto limpa pro Cloudinary (para Google — sem overlay)
  const uploadFotoLimpa = async (fotoBuf) => {
    try {
      const base64 = `data:image/jpeg;base64,${fotoBuf.toString('base64')}`;
      const result = await cloudinary.uploader.upload(base64, {
        folder:    'fono-inova/gmb',
        public_id: `${especialidade.id}_gmb_${Date.now()}`,
      });
      return result.secure_url;
    } catch (e) {
      console.warn('⚠️ Upload foto limpa falhou:', e.message);
      return null;
    }
  };

  // Aplica branding com buffer direto (para Instagram/Facebook)
  const comBranding = async (fotoBuf) => {
    if (!withBranding) return uploadFotoLimpa(fotoBuf);
    try {
      const result = await gerarImagemBranded({
        fotoBuffer: fotoBuf,
        titulo: tituloPost,
        postContent: postContent,
        especialidadeId: especialidade.id,
      });
      return result.url;
    } catch (e) {
      console.warn('⚠️ Branding falhou:', e.message);
      return null;
    }
  };

  // ═══════════════════════════════════════════════════════════
  // Roteamento por provider selecionado
  // gemini-nano = sem FLUX, vai direto para Pollinations (sem custo)
  const skipFal = provider !== 'auto' && provider !== 'fal';
  const skipHF  = provider !== 'auto' && provider !== 'hf' && provider !== 'together';
  const forceProvider = provider; // 'fal' | 'hf' | 'pollinations' | 'gemini-nano' | 'auto'
  if (forceProvider !== 'auto') {
    console.log(`🎯 Provider selecionado: ${forceProvider} (${skipFal ? 'skip fal.ai' : 'usa fal.ai'}, ${skipHF ? 'skip HF' : 'usa HF'})`);
  }

  // TENTATIVA 1: fal.ai FLUX dev (FOCO PRINCIPAL - mais barato!)
  // ═══════════════════════════════════════════════════════════
  if (!skipFal && process.env.FAL_API_KEY) {
    try {
      console.log('🤖 fal.ai FLUX dev...');
      const falRes = await fetch('https://fal.run/fal-ai/flux/dev', {
        method: 'POST',
        headers: {
          'Authorization': `Key ${process.env.FAL_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt,
          image_size: 'square',  // 1024x1024
          num_inference_steps: 28,
          guidance_scale: 3.5,
          safety_tolerance: '2',
        }),
        signal: AbortSignal.timeout(120000),
      });

      console.log('   Status:', falRes.status);

      if (falRes.ok) {
        const falData = await falRes.json();
        const imgUrl = falData.images?.[0]?.url;
        if (imgUrl) {
          const fotoBuf = Buffer.from(await (await fetch(imgUrl, { signal: AbortSignal.timeout(30000) })).arrayBuffer());
          console.log(`✅ fal.ai FLUX dev → ${(fotoBuf.length/1024).toFixed(1)}KB`);
          const url = await comBranding(fotoBuf);
          return { url, provider: 'fal-flux-dev' };
        }
      } else {
        const err = await falRes.text();
        console.warn('⚠️ fal.ai erro:', falRes.status, err.substring(0, 150));
      }
    } catch (e) {
      console.warn('⚠️ fal.ai falhou:', e.message);
    }
  } else {
    console.log('⏭️  FAL_API_KEY não configurada');
  }

  // ═══════════════════════════════════════════════════════════
  // TENTATIVA 2: HuggingFace FLUX.1-dev (gratuito, alta qualidade)
  if (!skipHF && process.env.HUGGINGFACE_API_KEY) {
    try {
      console.log('🤖 Tentando HuggingFace FLUX.1-dev...');
      const response = await fetch(
        'https://router.huggingface.co/black-forest-labs/FLUX.1-dev',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            inputs: prompt,
            parameters: { width: 1024, height: 1024, num_inference_steps: 28, guidance_scale: 3.5 }
          }),
          signal: AbortSignal.timeout(90000),
        }
      );

      if (response.ok) {
        const fotoBuf = Buffer.from(await response.arrayBuffer());
        console.log(`✅ FLUX.1-dev → buffer ${fotoBuf.length} bytes`);
        const url = await comBranding(fotoBuf);
        return { url, provider: 'hf-flux-dev' };
      }
      console.warn('⚠️ HF retornou erro:', response.status);
    } catch (e) {
      console.warn('⚠️ HF falhou:', e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // TENTATIVA 3: Pollinations com FLUX (sempre gratuito) + retry
  const delay = ms => new Promise(r => setTimeout(r, ms));
  
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`🔄 Pollinations (tentativa ${attempt}/3)...`);
      const encoded = encodeURIComponent(prompt);
      const seed = Math.floor(Math.random() * 999999);
      const model = attempt === 1 ? 'flux-realism' : attempt === 2 ? 'turbo' : 'default';
      
      const res = await fetch(
        `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&seed=${seed}&nologo=true&model=${model}&enhance=true`,
        { signal: AbortSignal.timeout(90000), headers: { 'Accept': 'image/*' } }
      );

      if (res.ok) {
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('image')) {
          console.warn('⚠️ Resposta não é imagem:', contentType);
          throw new Error(`Invalid content-type: ${contentType}`);
        }
        
        const fotoBuf = Buffer.from(await res.arrayBuffer());
        if (fotoBuf.length < 1024) {
          console.warn('⚠️ Imagem muito pequena');
          throw new Error('Image too small');
        }
        
        console.log(`✅ Pollinations → ${(fotoBuf.length/1024).toFixed(1)}KB`);
        const url = await comBranding(fotoBuf);
        return { url, provider: `pollinations-${model}` };
      } else {
        const status = res.status;
        console.warn(`⚠️ Pollinations HTTP ${status}`);
        if ((status >= 500 || status === 429) && attempt < 3) {
          const wait = attempt * 2000;
          console.log(`   ⏳ Retry em ${wait}ms...`);
          await delay(wait);
          continue;
        }
        throw new Error(`HTTP ${status}`);
      }
    } catch (e) {
      console.warn(`⚠️ Pollinations erro:`, e.message);
      if (attempt < 3) await delay(attempt * 2000);
    }
  }

  // FALLBACK: URL direta
  console.log('🔄 Fallback: URL direta...');
  try {
    const encoded = encodeURIComponent(prompt);
    const seed = Math.floor(Math.random() * 999999);
    const directUrl = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&seed=${seed}&nologo=true`;
    
    const check = await fetch(directUrl, { method: 'HEAD', signal: AbortSignal.timeout(30000) });
    if (check.ok) {
      console.log('✅ URL direta OK');
      return { url: directUrl, provider: 'pollinations-direct' };
    }
  } catch (e) {
    console.error('❌ Fallback falhou:', e.message);
  }

  console.error('❌ Todas as opções falharam - post será salvo sem imagem');
  return null;
}


/**
 * 🔄 CRIA POST DO DIA
 */
export async function createDailyPost(options = {}) {
  try {
    console.log('🚀 Gerando post do dia...');
    if (options.customTheme) {
      console.log('🎯 Tema personalizado:', options.customTheme);
    }

    const especialidade = options.especialidade || await getNextEspecialidade();
    console.log('📌 Especialidade:', especialidade.nome);

    const generated = await generatePostForEspecialidade(especialidade, options.customTheme, options.funnelStage || 'top');
    console.log(generated.isFallback ? '📝 Post template' : '✅ Texto gerado');

    let mediaUrl = null;
    let imageProvider = null;
    if (options.generateImage !== false) {
      const imgResult = await generateImageForEspecialidade(especialidade, generated.content, false);
      if (imgResult?.url) {
        mediaUrl = imgResult.url;
        imageProvider = imgResult.provider;
        console.log('✅ Imagem gerada (sem branding — Google):', imageProvider);
      }
    }

    const scheduledAt = options.scheduledAt || getNextHorarioEstrategico();

    const post = new GmbPost({
      title: generated.title,
      content: generated.content,
      theme: especialidade.id,
      tags: [especialidade.id, 'terapia', 'pediatria'],
      mediaUrl,
      mediaType: mediaUrl ? 'image' : null,
      imageProvider,  // 🖼️ Qual IA gerou a imagem
      ctaType: 'LEARN_MORE',
      ctaUrl: especialidade.url,
      aiGenerated: !generated.isFallback,
      aiModel: generated.isFallback ? 'template' : 'gpt-4o-mini',
      aiPrompt: options.customTheme
        ? `Especialidade: ${especialidade.nome} | Tema: ${options.customTheme}`
        : `Especialidade: ${especialidade.nome}`,
      status: 'scheduled',
      scheduledAt,
      createdBy: options.userId
    });

    await post.save();

    return {
      success: true,
      post,
      message: 'Post agendado',
      especialidade
    };

  } catch (error) {
    console.error('❌ Erro:', error);
    throw error;
  }
}

function getNextHorarioEstrategico() {
  const now = new Date();
  const currentHour = now.getHours();

  const horarios = HORARIOS_PUBLICACAO.map(h => parseInt(h.split(':')[0]));

  for (const hora of horarios) {
    if (currentHour < hora) {
      now.setHours(hora, 0, 0, 0);
      return now;
    }
  }

  now.setDate(now.getDate() + 1);
  now.setHours(parseInt(HORARIOS_PUBLICACAO[0]), 0, 0, 0);
  return now;
}


/**
 * 📅 GERA SEMANA
 */
export async function generateWeekPosts() {
  const results = [];

  for (let i = 0; i < 7; i++) {
    const scheduledAt = new Date();
    scheduledAt.setDate(scheduledAt.getDate() + i);
    const horaIdx = i % HORARIOS_PUBLICACAO.length;
    const [hora, minuto] = HORARIOS_PUBLICACAO[horaIdx].split(':').map(Number);
    scheduledAt.setHours(hora, minuto, 0, 0);

    try {
      const result = await createDailyPost({
        generateImage: true,
        scheduledAt,
      });

      results.push({
        success: true,
        postId: result.post._id,
        especialidade: result.especialidade.nome,
        scheduledAt
      });

      console.log(`✅ ${i + 1}/7: ${result.especialidade.nome}`);

    } catch (error) {
      results.push({ success: false, error: error.message });
    }
  }

  return results;
}


export async function fetchPostMetrics() {
  return await GmbPost.getStats();
}


/**
 * 🎨 GERA IMAGEM A PARTIR DO CONTEÚDO (para preview/edit)
 */
export async function generatePostImage(content, especialidadeId = null) {
  try {
    console.log('🎨 Gerando imagem para conteúdo...');

    // Determina especialidade do conteúdo se não passada
    let especialidade = null;
    if (especialidadeId) {
      especialidade = ESPECIALIDADES.find(e => e.id === especialidadeId);
    }

    // Se não encontrou, tenta detectar pelo conteúdo
    if (!especialidade) {
      const contentLower = content.toLowerCase();
      especialidade = ESPECIALIDADES.find(e =>
        contentLower.includes(e.nome.toLowerCase()) ||
        e.foco.toLowerCase().split(', ').some(foco => contentLower.includes(foco.toLowerCase()))
      ) || ESPECIALIDADES[0]; // fallback para fonoaudiologia
    }

    console.log('📌 Especialidade detectada:', especialidade.nome);

    // Gera a imagem
    const imgResult = await generateImageForEspecialidade(especialidade, content, false);

    if (!imgResult?.url) {
      throw new Error('Falha ao gerar imagem');
    }

    return {
      imageUrl: imgResult.url,
      imageProvider: imgResult.provider,
      especialidade: especialidade.nome,
      promptUsed: generateImagePromptFromContent(content, especialidade)
    };

  } catch (error) {
    console.error('❌ Erro ao gerar imagem:', error);
    return null;
  }
}

/**
 * 🤖 CRIA POST NO MODO ASSISTIDO (sem API do Google)
 * Gera post + imagem e retorna para publicação manual
 */
export async function createAssistedPost(options = {}) {
  try {
    const { 
      especialidadeId, 
      customTheme, 
      userId,
      type = 'daily'
    } = options;

    console.log('🤖 Criando post assistido:', { type, especialidadeId });

    // Busca especialidade
    let especialidade = ESPECIALIDADES.find(e => e.id === especialidadeId);
    if (!especialidade) {
      especialidade = ESPECIALIDADES[0];
    }

    // Gera conteúdo com estratégia por funil
    const postData = await generatePostForEspecialidade(especialidade, customTheme, options.funnelStage || 'top');

    // Gera imagem
    const imgResult = await generateImageForEspecialidade(especialidade, postData.content, false);
    const mediaUrl = imgResult?.url || null;

    // Formata texto para copiar
    const copyText = `${postData.content}

---
💚 Fono Inova - Centro de Desenvolvimento Infantil
📍 Anápolis - GO
📲 WhatsApp: (62) 99331-5240
🌐 www.clinicafonoinova.com.br`;

    // Salva no banco
    const post = new GmbPost({
      title: postData.title,
      content: postData.content,
      theme: especialidade.id,
      type,
      status: 'ready',
      mediaUrl,
      mediaType: mediaUrl ? 'image' : null,
      ctaUrl: especialidade.url,
      assistData: {
        gmbUrl: 'https://business.google.com/posts',
        copyText,
        scheduledFor: new Date()
      },
      aiGenerated: true,
      createdBy: userId
    });

    await post.save();

    console.log('✅ Post assistido criado:', post._id);

    return {
      success: true,
      post,
      assistData: {
        postId: post._id,
        gmbUrl: 'https://business.google.com/posts',
        copyText,
        mediaUrl
      }
    };

  } catch (error) {
    console.error('❌ Erro ao criar post assistido:', error);
    throw error;
  }
}

/**
 * 📝 GERA LEGENDA SEO OTIMIZADA (Modo Especializado)
 */
export async function generateCaptionSEO(especialidade, customTheme = null, funnelStage = 'top') {
  try {
    const nicho = PROMPTS_ESPECIALIDADE[especialidade.id] || null;
    const keywordSEO = `${especialidade.nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')} infantil`;
    
    const estrategiaPorFunil = {
      top: { cta: 'Comente "SIM" se você passou por isso', tom: 'conversacional, empático' },
      middle: { cta: 'Siga para parte 2 nos comentários', tom: 'educativo, especialista' },
      bottom: { cta: 'Me chame com a palavra AVALIAÇÃO - apenas 3 vagas', tom: 'urgente mas ético' }
    };
    const estrategia = estrategiaPorFunil[funnelStage] || estrategiaPorFunil.top;

    const messages = [
      {
        role: 'system',
        content: `Você é copywriter SEO especialista em saúde infantil.
Crie uma LEGENDA otimizada para Instagram e Google.

REGRAS DE SEO:
- Palavra-chave principal: "${keywordSEO}"
- Densidade: 1-2% (use naturalmente no meio do texto)
- Primeiras 125 caracteres: hook que prenda atenção
- Parágrafos curtos (máx 2 linhas cada)
- Máximo 2 emojis
- CTA claro no final

REGRAS ÉTICAS:
- SEM alarmismo
- SEM promessas de cura
- Tom natural como influencer experiente` 
      },
      {
        role: 'user',
        content: `Crie legenda SEO para ${especialidade.nome}.

${customTheme ? `TEMA: ${customTheme}` : `FOCO: ${especialidade.foco}`}
PÚBLICO: Pais de ${especialidade.publico}
${nicho ? `DOR: ${nicho.dor}` : ''}

ESTRUTURA OBRIGATÓRIA:
1. Hook (primeiras 2 frases) - chame atenção imediatamente
2. Desenvolvimento - valor educativo + emocional
3. SEO - insira "${keywordSEO}" naturalmente no meio
4. CTA: "${estrategia.cta}"
5. Hashtags: 5-8 tags (mix nicho + local + amplo)

OUTPUT: Apenas a legenda pronta para copiar e colar.`
      }
    ];

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 400,
      temperature: 0.8
    });

    const caption = response.choices[0].message.content.trim();
    
    // Calcula densidade da keyword
    const wordCount = caption.split(/\s+/).length;
    const keywordCount = (caption.toLowerCase().match(new RegExp(keywordSEO.replace(/\s+/g, '\\s+'), 'g')) || []).length;
    const density = ((keywordCount / wordCount) * 100).toFixed(1);

    return {
      type: 'caption',
      title: `Legenda SEO - ${especialidade.nome}`,
      content: caption,
      especialidade,
      meta: {
        keyword: keywordSEO,
        density: `${density}%`,
        wordCount,
        cta: estrategia.cta,
        funnelStage
      }
    };

  } catch (error) {
    console.error('❌ Erro ao gerar legenda SEO:', error);
    throw error;
  }
}

/**
 * 🎣 GERA GANCHOS VIRAIS (10 variações)
 */
export async function generateHooksViral(especialidade, customTheme = null, funnelStage = 'top', count = 10) {
  try {
    const nicho = PROMPTS_ESPECIALIDADE[especialidade.id] || null;
    
    // Define gatilhos baseado no funil
    const gatilhosPorFunil = {
      top: ['Curiosidade', 'Contradição', 'Identificação'],
      middle: ['Prova Social', 'Autoridade', 'Benefício Rápido'],
      bottom: ['Urgência', 'Escassez', 'Medo Estratégico']
    };
    
    const gatilhos = gatilhosPorFunil[funnelStage] || gatilhosPorFunil.top;
    
    // Distribui os ganchos entre os gatilhos
    const ganchosPorGatilho = Math.ceil(count / gatilhos.length);

    const messages = [
      {
        role: 'system',
        content: `Você é especialista em Ganchos Virais e Psicologia da Atenção.
Crie HOOKS de 3-5 segundos que param o scroll IMEDIATAMENTE.

REGRAS CRÍTICAS:
- FRASES CORRIDAS (evite pontos no meio - para vídeos)
- Máximo 25 palavras por gancho
- Texto deve soar natural quando falado
- Cada gancho ativa UMA emoção específica
- SEM alarmismo na saúde infantil

GATILHOS PSICOLÓGICOS:
- Curiosidade: lacuna de conhecimento
- Contradição: quebra de expectativa  
- Identificação: espelho do público
- Prova Social: números/autoridade
- Urgência: tempo limitado
- Escassez: poucos sabem/têm acesso` 
      },
      {
        role: 'user',
        content: `Gere ${count} GANCHOS VIRAIS para ${especialidade.nome}.

TEMA: ${customTheme || especialidade.gancho}
PÚBLICO: Pais de ${especialidade.publico}
${nicho ? `DOR: ${nicho.dor}` : ''}

DISTRIBUIÇÃO DOS GATILHOS:
${gatilhos.map(g => `- ${g}: ${ganchosPorGatilho} variações`).join('\n')}

FORMATO DE SAÍDA:
GATILHO [Nome] - Gancho [número]:
"Texto do gancho em frase corrida sem pontos no meio"

REGRA: Cada gancho deve ser COMPLETAMENTE DIFERENTE dos outros.
Teste ângulos psicológicos distintos.`
      }
    ];

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 800,
      temperature: 0.9
    });

    const hooksText = response.choices[0].message.content.trim();
    
    // Parseia os ganchos
    const hooks = hooksText.split('\n')
      .filter(line => line.trim().startsWith('"') || line.includes('GATILHO'))
      .map(line => line.trim());

    return {
      type: 'hooks',
      title: `${count} Ganchos Virais - ${especialidade.nome}`,
      content: hooksText,
      especialidade,
      meta: {
        count,
        gatilhos,
        funnelStage,
        hooks: hooks.length > 0 ? hooks : hooksText.split('\n').filter(l => l.trim())
      }
    };

  } catch (error) {
    console.error('❌ Erro ao gerar ganchos:', error);
    throw error;
  }
}

export {
  uploadToCloudinary
};

export default {
  generatePostForEspecialidade,
  generateImageForEspecialidade,
  generatePostImage,
  generateCaptionSEO,
  generateHooksViral,
  createDailyPost,
  generateWeekPosts,
  fetchPostMetrics,
  ESPECIALIDADES,
  HORARIOS_PUBLICACAO
};
