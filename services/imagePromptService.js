/**
 * 🎨 Image Prompt Service - Fono Inova
 * Prompts otimizados para máximo realismo e consistência visual
 */

/**
 * TIPOS DE IMAGEM
 */
export const IMAGE_TYPES = {
  FOTO_REAL: 'foto_real',           // Ultra realismo - atendimento
  ARTE_EDUCATIVA: 'arte_educativa', // Infográfico/ilustração
  LAYOUT_ESTILIZADO: 'layout_estilizado' // Post com formas/colorido
};

/**
 * 1️⃣ FOTO REAL DE ATENDIMENTO (Ultra Realismo)
 * Modelo: fal-ai/flux-pro/v1.1-ultra
 */
export function generateFotoRealPrompt(atividade, especialidade) {
  return `Ultra realistic professional medical photography, Brazilian ${especialidade.nome.toLowerCase()} therapist conducting ${atividade} in a modern bright clinic room, natural skin texture, authentic facial features, no plastic skin, no cartoon style, real 35mm lens photography, natural window lighting, high dynamic range, soft depth of field, real clinic environment, documentary style, not stock photo, true-to-life colors, shot on Sony A7R IV, warm, welcoming, professional atmosphere, patient and therapist interaction clearly visible, therapy tools and materials on table in focus, background slightly blurred`;
}

/**
 * 2️⃣ ARTE EDUCATIVA / INFOGRÁFICO
 * Modelo: fal-ai/flux-dev
 */
export function generateArteEducativaPrompt(tema, especialidade) {
  return `Flat modern medical educational illustration, ${tema}, minimalist design, clean vector shapes, pastel green (#2D6A4F) and purple (#C39BD3) palette, Instagram post layout, high contrast text area, modern healthcare branding, icons and diagrams illustrating concepts clearly, friendly and approachable style, readable typography, balanced composition, visually appealing for social media`;
}

/**
 * 3️⃣ LAYOUT COLORIDO / POST ESTILIZADO
 * Modelo: dall-e-3 ou flux-dev
 */
export function generateLayoutEstilizadoPrompt(mensagem) {
  return `Instagram post layout, modern healthcare branding, ${mensagem}, vibrant colors (#1A4D3A, #F4D03F, #F1948A, #C39BD3), clean geometric shapes, abstract blobs or diamonds in dynamic composition, high contrast typography, visually balanced, professional and engaging, eye-catching for social media, harmonious color distribution, subtle shadows and depth for premium look`;
}

/**
 * 🎯 GERAR PROMPT BASEADO NO TIPO
 */
export function generatePrompt(tipo, dados) {
  const { atividade, tema, mensagem, especialidade } = dados;
  
  switch (tipo) {
    case IMAGE_TYPES.FOTO_REAL:
      return generateFotoRealPrompt(atividade || 'therapy session', especialidade);
    
    case IMAGE_TYPES.ARTE_EDUCATIVA:
      return generateArteEducativaPrompt(tema || especialidade.foco, especialidade);
    
    case IMAGE_TYPES.LAYOUT_ESTILIZADO:
      return generateLayoutEstilizadoPrompt(mensagem || especialidade.gancho);
    
    default:
      return generateFotoRealPrompt('therapy session', especialidade);
  }
}

/**
 * 📋 PROMPTS PRONTOS POR ESPECIALIDADE
 */
export const PROMPTS_POR_ESPECIALIDADE = {
  fonoaudiologia: {
    foto: (atividade) => `Ultra realistic professional photography, inside Fono Inova clinic, Brazilian speech therapist in colorful scrubs conducting ${atividade} with child, bright therapy room with white walls, colorful alphabet posters, wooden shelves with therapy toys and picture books, large mirror on wall, low white table with colorful picture cards spread out, soft natural window light, authentic candid interaction, documentary style, warm cheerful pediatric clinic atmosphere, shot on Sony A7R IV`,
    arte: (tema) => `Flat modern educational illustration, ${tema}, speech therapy concepts, sound waves, mouth diagrams, pastel green and purple palette, clean vector style, Instagram layout, friendly and approachable`,
    layout: (mensagem) => `Instagram healthcare post, ${mensagem}, vibrant green (#1A4D3A) and yellow (#F4D03F), geometric shapes, speech bubbles, typography-focused, modern medical branding`
  },
  
  psicologia: {
    foto: (atividade) => `Ultra realistic professional photography, inside Fono Inova clinic, Brazilian child psychologist in colorful scrubs with child, warm play therapy room with sage green accent wall, colorful art prints, wooden shelf with dolls stuffed animals and drawing materials, small round white table with toys, soft natural window light with sheer curtains, cozy rug area with cushions, genuine candid interaction, documentary style, welcoming pediatric clinic`,
    arte: (tema) => `Flat illustration, ${tema}, child psychology concepts, emotions icons, brain development graphics, soft purple and blue palette, calming design, educational infographic style`,
    layout: (mensagem) => `Instagram healthcare layout, ${mensagem}, calming purple (#C39BD3) and green tones, soft organic shapes, mental health visuals, professional typography`
  },
  
  terapia_ocupacional: {
    foto: (atividade) => `Ultra realistic photography, inside Fono Inova clinic, occupational therapist in colorful scrubs helping child with fine motor activities, bright therapy room with white walls and colorful educational posters, Montessori wooden shelves with colorful beads pegboards puzzles and sensory materials, modern white activity table at child height, colorful foam mat area with climbing structures, natural window light, authentic candid interaction, professional pediatric clinic`,
    arte: (tema) => `Flat educational illustration, ${tema}, motor skills development, hand coordination graphics, sensory integration icons, warm orange and green palette, engaging design`,
    layout: (mensagem) => `Instagram post design, ${mensagem}, energetic orange (#F1948A) and green, dynamic shapes, activity icons, modern healthcare aesthetic`
  },
  
  fisioterapia: {
    foto: (atividade) => `Ultra realistic photography, inside Fono Inova clinic, pediatric physiotherapist in colorful scrubs with child doing balance exercises, spacious bright therapy gym with white walls and colorful exercise posters, floor-to-ceiling windows with natural light, colorful foam blocks therapy balls balance beam climbing structures, playful equipment, genuine encouragement moment, cheerful energetic pediatric rehabilitation clinic`,
    arte: (tema) => `Flat illustration, ${tema}, motor development concepts, body posture graphics, movement icons, fresh blue and green palette, dynamic composition`,
    layout: (mensagem) => `Instagram healthcare layout, ${mensagem}, vibrant blue and green (#1A4D3A), movement lines, energetic shapes, professional medical design`
  },
  
  neuropsicologia: {
    foto: (atividade) => `Ultra realistic photography, inside Fono Inova clinic, neuropsychologist in colorful scrubs conducting cognitive assessment with child, clean bright assessment room with white walls and colorful alphabet number prints, modern white desk at child height with colorful cognitive blocks and assessment materials, organized wooden shelves with educational toys puzzles and games, large window with natural light, focused concentration moment, warm professional pediatric clinic`,
    arte: (tema) => `Flat illustration, ${tema}, brain development graphics, cognitive function icons, learning concepts, sophisticated purple and green palette, scientific yet approachable`,
    layout: (mensagem) => `Instagram post, ${mensagem}, elegant purple (#C39BD3) and green, brain icons, neural network patterns, premium medical aesthetic`
  },

  psicomotricidade: {
    foto: (atividade) => `Ultra realistic photography, inside Fono Inova clinic, psychomotricity therapist in colorful scrubs with child doing movement activities, large bright therapy room with white walls and colorful movement posters, floor-to-ceiling windows with abundant natural light, colorful foam mats covering floor, foam tunnels steps and soft obstacles, balls and hoops and playful movement equipment, joyful energetic interaction, documentary style, pediatric clinic`,
    arte: (tema) => `Flat illustration, ${tema}, movement and body awareness graphics, coordination icons, dynamic composition, energetic orange and green palette, playful design`,
    layout: (mensagem) => `Instagram post, ${mensagem}, energetic orange (#F1948A) and green, movement lines, dynamic shapes, playful pediatric aesthetic`
  },

  musicoterapia: {
    foto: (atividade) => `Ultra realistic photography, inside Fono Inova clinic, music therapist with child in music therapy session, warm bright room with white walls and colorful music note illustrations, large window with natural light, light hardwood floor with colorful rug, wooden shelves with drums tambourines xylophone colorful shakers guitar, colorful cushions on floor and scarves, joyful creative musical interaction, documentary style`,
    arte: (tema) => `Flat illustration, ${tema}, music therapy concepts, musical instruments icons, sound waves, warm yellow and purple palette, creative design`,
    layout: (mensagem) => `Instagram post, ${mensagem}, warm yellow (#F4D03F) and purple, musical notes, instrument icons, creative artistic aesthetic`
  },

  psicopedagogia: {
    foto: (atividade) => `Ultra realistic photography, inside Fono Inova clinic, psychopedagogue in colorful scrubs helping child with learning activities, bright room with white walls and colorful alphabet number and book illustration posters, large window with abundant natural light, modern white desk at child height with books and learning materials, wooden Montessori shelves with educational books wooden puzzles letters numbers and games, warm encouraging interaction`,
    arte: (tema) => `Flat illustration, ${tema}, learning and literacy concepts, book and pencil icons, educational graphics, warm green and yellow palette, encouraging design`,
    layout: (mensagem) => `Instagram post, ${mensagem}, warm green (#1A4D3A) and yellow (#F4D03F), book icons, learning symbols, educational aesthetic`
  },

  freio_lingual: {
    foto: (atividade) => `Ultra realistic photography, inside Fono Inova clinic, pediatric feeding specialist in colorful scrubs consulting with mother and baby for oral motor therapy, clean warm pediatric consultation room with white walls and colorful children educational prints, large window with soft natural light, light hardwood floor, modern comfortable child-friendly examination area with soft toys, wooden shelf with books and toys, small plant, warm professional pediatric clinic for feeding assessment`,
    arte: (tema) => `Flat illustration, ${tema}, oral motor concepts, baby feeding graphics, tongue and mouth diagrams, soft pink and green palette, gentle design`,
    layout: (mensagem) => `Instagram post, ${mensagem}, soft pink (#F1948A) and green, baby care icons, gentle curves, nurturing aesthetic`
  }
};

/**
 * 🎯 OBTER PROMPT PRONTO POR ESPECIALIDADE
 */
export function getPromptPronto(especialidadeId, tipo, conteudo) {
  const especialidadePrompts = PROMPTS_POR_ESPECIALIDADE[especialidadeId];
  
  if (!especialidadePrompts) {
    // Fallback genérico
    return generatePrompt(tipo, { ...conteudo, especialidade: { nome: 'therapy' } });
  }
  
  switch (tipo) {
    case IMAGE_TYPES.FOTO_REAL:
      return especialidadePrompts.foto(conteudo.atividade || 'therapy session');
    case IMAGE_TYPES.ARTE_EDUCATIVA:
      return especialidadePrompts.arte(conteudo.tema || 'child development');
    case IMAGE_TYPES.LAYOUT_ESTILIZADO:
      return especialidadePrompts.layout(conteudo.mensagem || 'Child Development');
    default:
      return especialidadePrompts.foto('therapy session');
  }
}

export default {
  IMAGE_TYPES,
  generatePrompt,
  generateFotoRealPrompt,
  generateArteEducativaPrompt,
  generateLayoutEstilizadoPrompt,
  getPromptPronto,
  PROMPTS_POR_ESPECIALIDADE
};
