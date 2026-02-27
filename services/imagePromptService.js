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
    foto: (atividade) => `Ultra realistic professional medical photography, Brazilian speech therapist conducting ${atividade} with a child, articulation therapy session, colorful picture cards on table, mirror on wall, natural window lighting, authentic expressions, documentary style, real clinic environment, warm atmosphere, shot on Sony A7R IV`,
    arte: (tema) => `Flat modern educational illustration, ${tema}, speech therapy concepts, sound waves, mouth diagrams, pastel green and purple palette, clean vector style, Instagram layout, friendly and approachable`,
    layout: (mensagem) => `Instagram healthcare post, ${mensagem}, vibrant green (#1A4D3A) and yellow (#F4D03F), geometric shapes, speech bubbles, typography-focused, modern medical branding`
  },
  
  psicologia: {
    foto: (atividade) => `Ultra realistic professional photography, Brazilian child psychologist in session with child, play therapy environment, toys and drawing materials, soft natural light, genuine interaction, cozy office setting, documentary style, authentic emotions`,
    arte: (tema) => `Flat illustration, ${tema}, child psychology concepts, emotions icons, brain development graphics, soft purple and blue palette, calming design, educational infographic style`,
    layout: (mensagem) => `Instagram healthcare layout, ${mensagem}, calming purple (#C39BD3) and green tones, soft organic shapes, mental health visuals, professional typography`
  },
  
  terapia_ocupacional: {
    foto: (atividade) => `Ultra realistic photography, occupational therapist helping child with fine motor activities, colorful beads and puzzles on table, sensory play materials, bright clinic room, natural interaction, documentary style, professional healthcare setting`,
    arte: (tema) => `Flat educational illustration, ${tema}, motor skills development, hand coordination graphics, sensory integration icons, warm orange and green palette, engaging design`,
    layout: (mensagem) => `Instagram post design, ${mensagem}, energetic orange (#F1948A) and green, dynamic shapes, activity icons, modern healthcare aesthetic`
  },
  
  fisioterapia: {
    foto: (atividade) => `Ultra realistic photography, pediatric physiotherapist with child doing balance exercises, foam blocks and therapy balls, bright gym space, natural window light, genuine encouragement moment, professional rehabilitation setting`,
    arte: (tema) => `Flat illustration, ${tema}, motor development concepts, body posture graphics, movement icons, fresh blue and green palette, dynamic composition`,
    layout: (mensagem) => `Instagram healthcare layout, ${mensagem}, vibrant blue and green (#1A4D3A), movement lines, energetic shapes, professional medical design`
  },
  
  neuropsicologia: {
    foto: (atividade) => `Ultra realistic photography, neuropsychologist conducting cognitive assessment with child, colorful cognitive blocks on table, focused concentration moment, modern assessment room, natural lighting, professional scientific setting`,
    arte: (tema) => `Flat illustration, ${tema}, brain development graphics, cognitive function icons, learning concepts, sophisticated purple and green palette, scientific yet approachable`,
    layout: (mensagem) => `Instagram post, ${mensagem}, elegant purple (#C39BD3) and green, brain icons, neural network patterns, premium medical aesthetic`
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
