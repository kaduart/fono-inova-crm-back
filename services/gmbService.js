/**
 * 📍 Serviço de integração com Google Meu Negócio (GMB)
 * VERSÃO DEFINITIVA: HuggingFace FLUX + Cloudinary
 */

import { google } from 'googleapis';
import OpenAI from 'openai';
import { v2 as cloudinary } from 'cloudinary';
import GmbPost from '../models/GmbPost.js';

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

// Configuração OAuth2 para GMB
const oauth2Client = new google.auth.OAuth2(
  process.env.GMB_CLIENT_ID,
  process.env.GMB_CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob'
);

if (process.env.GMB_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: process.env.GMB_REFRESH_TOKEN });
}

const LOCATION_NAME = process.env.GMB_LOCATION_ID ?
  `accounts/${process.env.GMB_ACCOUNT_ID}/locations/${process.env.GMB_LOCATION_ID.trim()}` : null;

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
 * 🤖 GERA POST COM GPT
 */
export async function generatePostForEspecialidade(especialidade, customTheme = null) {
  try {
    const temaTexto = customTheme
      ? `TEMA ESPECÍFICO: "${customTheme}" dentro da área de ${especialidade.nome}`
      : `GANCHO: ${especialidade.gancho}`;

    const instrucaoTema = customTheme
      ? `Crie um post sobre "${customTheme}" na área de ${especialidade.nome}.`
      : `Crie um post para ${especialidade.nome}.`;

    const messages = [
      {
        role: 'system',
        content: `Você é especialista em marketing para clínicas de saúde infantil.
Crie posts para Google Meu Negócio da Clínica Fono Inova em Anápolis-GO.
Regras: Máximo 150 palavras, tom acolhedor, termine com "Saiba mais sobre [TERAPIA] 👇"`
      },
      {
        role: 'user',
        content: `${instrucaoTema}

ESPECIALIDADE: ${especialidade.nome}
${temaTexto}
FOCO: ${especialidade.foco}
PÚBLICO: Pais de ${especialidade.publico}

Estrutura:
1. Gancho chamativo
2. 2-3 frases sobre a importância
3. Sinais de alerta ou dicas
4. Como a Fono Inova ajuda
5. CTA: "Saiba mais sobre ${especialidade.nome} 👇"

Regras:
- Máximo 150 palavras
- Sem hashtags
- Máximo 2 emojis
- Linguagem simples, empática${customTheme ? '\n- Foque no tema solicitado' : ''}`
      }
    ];

    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: messages,
      max_tokens: 400,
      temperature: 0.8
    });

    const content = response.choices[0].message.content.trim();
    const title = content.split('.')[0].substring(0, 80);

    return {
      title,
      content,
      especialidade
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
  const templates = [
    `${especialidade.gancho}\n\nA ${especialidade.nome} pode fazer toda diferença no desenvolvimento do seu filho. ${especialidade.foco.split(',')[0]} são aspectos fundamentais.\n\nNa Fono Inova, avaliamos e criamos um plano personalizado para cada criança.\n\nSaiba mais sobre ${especialidade.nome} 👇`,

    `Você sabia que ${especialidade.foco.split(',')[0]} pode impactar toda a vida escolar?\n\nNa Fono Inova, oferecemos ${especialidade.nome} com profissionais experientes.\n\n${especialidade.gancho} Agende uma avaliação!\n\nSaiba mais sobre ${especialidade.nome} 👇`,

    `${especialidade.gancho}\n\nA ${especialidade.nome} utiliza técnicas modernas para ajudar seu filho.\n\nNosso ambiente foi pensado para o conforto das crianças.\n\nEntre em contato!\n\nSaiba mais sobre ${especialidade.nome} 👇`
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

  // ESTILO FOTOGRÁFICO — quente, acolhedor, clínico
  const photoStyle =
    'professional healthcare editorial photography, ' +
    'Canon EF 85mm f/1.4, shallow depth of field, soft bokeh, ' +
    'warm natural window light from side, golden warm tones, ' +
    'BOTH subjects facing each other fully engaged, ' +
    'child face clearly visible and expressive toward therapist, ' +
    'therapist looking at child NOT at camera, ' +
    'natural subtle facial expressions, soft genuine smiles NOT wide open laughing, ' +
    'real human faces with natural imperfections, NOT perfect AI faces, ' +
    'subtle authentic emotion NOT exaggerated, calm warm interaction, ' +
    'photorealistic skin texture, natural teeth not overly white, ' +
    'shot from slight 45 degree angle, ' +
    // ADICIONA após 'shot from slight 45 degree angle, ':
    'centered composition, subjects filling the frame, ' +
    'NO empty space on sides, close crop on therapist and child, ' +
    'premium private Brazilian pediatric clinic, ' +
    'no text, no watermark, NOT a luxury apartment, NOT a public clinic';

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
export async function generateImageForEspecialidade(especialidade, postContent = '') {
  const prompt = generateImagePromptFromContent(postContent || especialidade.foco, especialidade);
  console.log('🎨 Prompt:', prompt.substring(0, 100) + '...');

  // Tentativa 1: DALL-E 3 (se tiver créditos)
  if (process.env.OPENAI_API_KEY) {
    try {
      console.log('🤖 Tentando DALL-E 3...');
      const response = await openai.images.generate({
        model: 'dall-e-3',
        prompt,
        n: 1,
        size: '1024x1024',
        quality: 'standard',
        style: 'natural',
      });

      const tempUrl = response.data[0].url;
      const finalUrl = await uploadToCloudinary(
        await fetch(tempUrl).then(r => r.blob()),
        especialidade.id
      );

      console.log('✅ DALL-E 3 → Cloudinary:', finalUrl);
      return finalUrl;

    } catch (e) {
      console.warn('⚠️ DALL-E 3 falhou:', e.message);
    }
  }

  // Tentativa 2: HuggingFace FLUX (gratuito)
  if (process.env.HUGGINGFACE_API_KEY) {
    try {
      console.log('🤖 Tentando HuggingFace FLUX...');
      const response = await fetch(
        'https://router.huggingface.co/black-forest-labs/FLUX.1-schnell',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            inputs: prompt,
            parameters: { width: 1024, height: 1024, num_inference_steps: 4 }
          }),
          signal: AbortSignal.timeout(45000),
        }
      );

      if (response.ok) {
        const blob = await response.blob();
        const url = await uploadToCloudinary(blob, especialidade.id);
        console.log('✅ FLUX → Cloudinary:', url);
        return url;
      }
      console.warn('⚠️ HF retornou erro:', response.status);
    } catch (e) {
      console.warn('⚠️ HF falhou:', e.message);
    }
  }

  // Tentativa 3: Pollinations (sempre gratuito)
  try {
    console.log('🔄 Tentando Pollinations...');
    const encoded = encodeURIComponent(prompt);
    const seed = Math.floor(Math.random() * 99999);
    const res = await fetch(
      `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&seed=${seed}&nologo=true`,
      { signal: AbortSignal.timeout(30000) }
    );

    if (res.ok) {
      const url = await uploadToCloudinary(await res.blob(), especialidade.id);
      console.log('✅ Pollinations → Cloudinary:', url);
      return url;
    }
  } catch (e) {
    console.warn('⚠️ Pollinations falhou:', e.message);
  }

  console.error('❌ Todas as opções falharam - post será salvo sem imagem');
  return null;
}

/**
 * 📤 PUBLICA NO GMB
 */
export async function publishToGMB(postData) {
  try {
    if (!LOCATION_NAME) {
      throw new Error('GMB_LOCATION_ID não configurado');
    }

    const { token } = await oauth2Client.getAccessToken();
    if (!token) throw new Error('Não foi possível obter access token');

    const postBody = {
      languageCode: 'pt-BR',
      summary: postData.content.slice(0, 1500),
      topicType: 'STANDARD',
      callToAction: {
        actionType: 'LEARN_MORE',
        url: postData.ctaUrl
      }
    };

    if (postData.mediaUrl) {
      postBody.media = [{
        mediaFormat: 'PHOTO',
        sourceUrl: postData.mediaUrl
      }];
    }

    const title = postData.title || 'Post da Clínica Fono Inova';
    console.log(`📤 Publicando "${title.substring(0, 40)}..."`);

    // 🚨 API DO GOOGLE BUSINESS PROFILE (My Business)
    const url = `https://mybusiness.googleapis.com/v4/${LOCATION_NAME}/localPosts`;
    console.log('🌐 URL:', url);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(postBody)
    });

    // Log da resposta para debug
    const responseText = await response.text();
    console.log('📥 Status:', response.status);
    console.log('📥 Resposta:', responseText.substring(0, 500));

    if (!response.ok) {
      // Tenta parsear como JSON, se não for, mostra o texto
      let errorMessage = response.statusText;
      try {
        const errorJson = JSON.parse(responseText);
        errorMessage = errorJson.error?.message || errorJson.error || response.statusText;
      } catch (e) {
        errorMessage = responseText.substring(0, 200) || response.statusText;
      }
      throw new Error(`HTTP ${response.status}: ${errorMessage}`);
    }

    // Parseia o JSON manualmente já que já lemos o texto
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      throw new Error(`Resposta inválida do Google: ${responseText.substring(0, 200)}`);
    }

    return {
      success: true,
      gmbPostId: data.name,
      url: data.searchUrl
    };

  } catch (error) {
    console.error('❌ Erro ao publicar:', error);
    throw error;
  }
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

    const generated = await generatePostForEspecialidade(especialidade, options.customTheme);
    console.log(generated.isFallback ? '📝 Post template' : '✅ Texto gerado');

    let mediaUrl = null;
    if (options.generateImage !== false) {
      mediaUrl = await generateImageForEspecialidade(especialidade, generated.content);
      if (mediaUrl) console.log('✅ Imagem gerada');
    }

    const scheduledAt = options.scheduledAt || getNextHorarioEstrategico();

    const post = new GmbPost({
      title: generated.title,
      content: generated.content,
      theme: especialidade.id,
      tags: [especialidade.id, 'terapia', 'pediatria'],
      mediaUrl,
      mediaType: mediaUrl ? 'image' : null,
      ctaType: 'LEARN_MORE',
      ctaUrl: especialidade.url,
      aiGenerated: !generated.isFallback,
      aiModel: generated.isFallback ? 'template' : 'gpt-3.5-turbo',
      aiPrompt: options.customTheme
        ? `Especialidade: ${especialidade.nome} | Tema: ${options.customTheme}`
        : `Especialidade: ${especialidade.nome}`,
      status: options.publishImmediately ? 'draft' : 'scheduled',
      scheduledAt,
      createdBy: options.userId
    });

    await post.save();

    if (options.publishImmediately) {
      const published = await publishToGMB({
        title: post.title,
        content: post.content,
        mediaUrl: post.mediaUrl,
        ctaUrl: post.ctaUrl
      });

      await post.markPublished(published.gmbPostId);
      console.log('✅ PUBLICADO:', published.gmbPostId);

      return {
        success: true,
        post,
        gmbPostId: published.gmbPostId,
        especialidade
      };
    }

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
 * 📤 PUBLICA AGENDADOS
 */
export async function publishScheduledPosts(limit = 1) {
  const results = { processed: 0, published: 0, failed: 0, errors: [] };

  try {
    const posts = await GmbPost.findScheduledForPublish(limit);
    results.processed = posts.length;

    if (posts.length === 0) return results;

    for (const post of posts) {
      try {
        const published = await publishToGMB({
          title: post.title,
          content: post.content,
          mediaUrl: post.mediaUrl,
          ctaUrl: post.ctaUrl
        });

        await post.markPublished(published.gmbPostId);
        results.published++;

      } catch (error) {
        await post.markFailed(error.message);
        results.failed++;
        results.errors.push({ postId: post._id, error: error.message });
      }

      await new Promise(r => setTimeout(r, 3000));
    }

    return results;

  } catch (error) {
    console.error('❌ Erro:', error);
    throw error;
  }
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
        publishImmediately: false
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

    await new Promise(r => setTimeout(r, 5000));
  }

  return results;
}

export async function checkGMBConnection() {
  try {
    if (!process.env.GMB_REFRESH_TOKEN) {
      return { connected: false, error: 'Refresh token não configurado' };
    }

    const { token } = await oauth2Client.getAccessToken();
    const response = await fetch(
      'https://mybusiness.googleapis.com/v4/accounts',
      { headers: { 'Authorization': `Bearer ${token}` } }
    );

    if (!response.ok) {
      return { connected: false, error: `API retornou ${response.status}` };
    }

    const data = await response.json();
    return { connected: true, accounts: data.accounts || [] };

  } catch (error) {
    return { connected: false, error: error.message };
  }
}

export async function fetchPostMetrics() {
  return await GmbPost.getStats();
}

export async function deleteGMBPost(postId) {
  try {
    const post = await GmbPost.findById(postId);
    if (!post || !post.gmbPostId) {
      throw new Error('Post não encontrado');
    }

    const { token } = await oauth2Client.getAccessToken();

    await fetch(
      `https://mybusiness.googleapis.com/v4/${post.gmbPostId}`,
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      }
    );

    post.status = 'cancelled';
    await post.save();

    return { success: true };

  } catch (error) {
    console.error('❌ Erro ao deletar:', error);
    throw error;
  }
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
    const imageUrl = await generateImageForEspecialidade(especialidade, content);

    if (!imageUrl) {
      throw new Error('Falha ao gerar imagem');
    }

    return {
      imageUrl,
      especialidade: especialidade.nome,
      promptUsed: generateImagePromptFromContent(content, especialidade)
    };

  } catch (error) {
    console.error('❌ Erro ao gerar imagem:', error);
    return null;
  }
}

export {
  uploadToCloudinary
};

export default {
  generatePostForEspecialidade,
  generateImageForEspecialidade,
  generatePostImage,
  publishToGMB,
  createDailyPost,
  publishScheduledPosts,
  generateWeekPosts,
  checkGMBConnection,
  fetchPostMetrics,
  deleteGMBPost,
  ESPECIALIDADES,
  HORARIOS_PUBLICACAO
};
