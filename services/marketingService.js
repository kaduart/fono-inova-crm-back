/**
 * 🎯 Marketing Service - Consolidado
 * GMB + Imagens + Vídeos + Spy + OpenAI
 */

import OpenAI from 'openai';
import fetch from 'node-fetch';
import { uploadToCloudinary, generateImageForEspecialidade } from './gmbService.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Re-exporta a função de geração de imagem do gmbService
export { generateImageForEspecialidade };

// Configs
const HF_KEY = process.env.HUGGINGFACE_API_KEY;
const HEYGEN_KEY = process.env.HEYGEN_API_KEY;
const HEYGEN_AVATAR = process.env.HEYGEN_AVATAR_ID;
const HEYGEN_VOICE = process.env.HEYGEN_VOICE_ID;

const ESPECIALIDADES = [
  { id: 'fonoaudiologia', nome: 'Fonoaudiologia', foco: 'desenvolvimento da fala e linguagem infantil', publico: 'pais de crianças 0-10 anos', cor: '#8B5CF6' },
  { id: 'psicologia', nome: 'Psicologia', foco: 'saúde emocional e comportamental infantil', publico: 'pais de crianças com TDAH, TEA, ansiedade', cor: '#EC4899' },
  { id: 'terapiaocupacional', nome: 'Terapia Ocupacional', foco: 'desenvolvimento motor e autonomia', publico: 'pais de crianças com atraso motor', cor: '#F59E0B' },
  { id: 'fisioterapia', nome: 'Fisioterapia', foco: 'reabilitação e desenvolvimento físico', publico: 'pais de crianças com necessidades motoras', cor: '#10B981' }
];

// ═══════════════════════════════════════════════════════════════════════════════
// 🎨 GERAÇÃO DE IMAGENS
// ═══════════════════════════════════════════════════════════════════════════════

export async function generateImage(content, especialidadeId = 'fonoaudiologia') {
  const especialidade = ESPECIALIDADES.find(e => e.id === especialidadeId) || ESPECIALIDADES[0];
  
  const prompt = `Cinematic photo, professional pediatric therapy session,
Brazilian female therapist in colorful scrubs playing with 5-year-old child,
genuine natural expressions (NOT posed smile),
bright modern clinic with colorful educational toys,
soft window light, shallow depth of field,
professional healthcare photography style,
realistic skin texture, natural skin tones,
NO text, NO watermarks, 4K quality`; 

  console.log('🎨 Gerando imagem para:', especialidade.nome);
  console.log('🔑 HF_KEY disponível:', !!HF_KEY);

  // Tentativa 1: HuggingFace FLUX
  if (HF_KEY) {
    try {
      console.log('🚀 Tentando HuggingFace FLUX...');
      const response = await fetch(
        'https://router.huggingface.co/black-forest-labs/FLUX.1-schnell',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${HF_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            inputs: prompt,
            parameters: { width: 1024, height: 1024, num_inference_steps: 4 }
          }),
          signal: AbortSignal.timeout(45000),
        }
      );
      console.log('📡 HF resposta:', response.status);
      
      if (response.ok) {
        const blob = await response.blob();
        console.log('📦 HF blob recebido, fazendo upload...');
        const imageUrl = await uploadToCloudinary(blob, especialidadeId);
        console.log('✅ Imagem gerada (HF):', imageUrl);
        return { imageUrl, especialidade: especialidade.nome };
      } else {
        const errorText = await response.text();
        console.warn('⚠️ HF retornou erro:', response.status, errorText);
      }
    } catch (e) { 
      console.warn('⚠️ HF falhou:', e.message);
      console.warn(e.stack);
    }
  }

  // Tentativa 2: Pollinations
  try {
    console.log('🚀 Tentando Pollinations...');
    const encoded = encodeURIComponent(prompt);
    const seed = Math.floor(Math.random() * 99999);
    const res = await fetch(
      `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&seed=${seed}&nologo=true`,
      { signal: AbortSignal.timeout(30000) }
    );
    console.log('📡 Pollinations resposta:', res.status);
    
    if (res.ok) {
      const blob = await res.blob();
      console.log('📦 Pollinations blob recebido, fazendo upload...');
      const imageUrl = await uploadToCloudinary(blob, especialidadeId);
      console.log('✅ Imagem gerada (Pollinations):', imageUrl);
      return { imageUrl, especialidade: especialidade.nome };
    } else {
      console.warn('⚠️ Pollinations retornou erro:', res.status);
    }
  } catch (e) { 
    console.warn('⚠️ Pollinations falhou:', e.message);
    console.warn(e.stack);
  }

  console.error('❌ Todas as fontes de imagem falharam');
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🎬 GERAÇÃO DE VÍDEOS (HeyGen)
// ═══════════════════════════════════════════════════════════════════════════════

const ROTEIRO_PROMPT = (especialidade, funil) => `Você é especialista em marketing para clínicas pediátricas.

Gere um roteiro para vídeo de 30 segundos (exatamente 62 palavras) para a Clínica Fono Inova em Anápolis-GO.

Especialidade: ${especialidade.nome}
Foco: ${especialidade.foco}
Público: ${especialidade.publico}
Etapa do funil: ${funil.toUpperCase()}

Regras:
- Tom caloroso, empático, como uma amiga especialista
- Linguagem simples, sem jargões clínicos
- Mencionar "Fono Inova" 1x
- Terminar com CTA claro
- EXATAMENTE 62 palavras
- Sem emojis`;

export async function generateVideo({ video, especialidadeId, funnelStage = 'top' }) {
  if (!HEYGEN_KEY || !HEYGEN_AVATAR || !HEYGEN_VOICE) {
    throw new Error('HeyGen não configurado');
  }

  const especialidade = ESPECIALIDADES.find(e => e.id === especialidadeId) || ESPECIALIDADES[0];

  // Gera roteiro
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: ROTEIRO_PROMPT(especialidade, funnelStage) }],
    temperature: 0.7
  });
  const roteiro = completion.choices[0].message.content.trim();
  video.roteiro = roteiro;
  await video.save();

  // Cria vídeo no HeyGen
  const res = await fetch('https://api.heygen.com/v2/video/generate', {
    method: 'POST',
    headers: { 'X-Api-Key': HEYGEN_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      video_inputs: [{
        character: { type: 'avatar', avatar_id: HEYGEN_AVATAR, avatar_style: 'normal' },
        voice: { type: 'text', input_text: roteiro.replace(/[\u{1F600}-\u{1F64F}]/gu, ''), voice_id: HEYGEN_VOICE, speed: 1 },
        background: { type: 'color', value: '#f0fdf4' }
      }],
      dimension: { width: 1080, height: 1920 }
    })
  });

  if (!res.ok) throw new Error(`HeyGen erro: ${await res.text()}`);
  const { data: { video_id } } = await res.json();

  // Aguarda processamento
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 10000));
    const statusRes = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${video_id}`, { headers: { 'X-Api-Key': HEYGEN_KEY } });
    const statusData = await statusRes.json();
    
    if (statusData.data?.status === 'completed') {
      video.status = 'ready';
      video.videoUrl = statusData.data.video_url;
      video.thumbnailUrl = statusData.data.thumbnail_url;
      await video.save();
      return video;
    }
    if (statusData.data?.status === 'failed') throw new Error('HeyGen falhou no processamento');
  }
  
  throw new Error('Timeout no processamento do vídeo');
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🔍 SPY (Concorrentes)
// ═══════════════════════════════════════════════════════════════════════════════

const MOCK_ADS = [
  { adId: '1', pageName: 'Clínica Infantil', adText: 'Seu filho não fala? Agende uma avaliação gratuita!', funnelStage: 'top' },
  { adId: '2', pageName: 'Fono Kids', adText: 'Atraso na fala? Conheça nossa metodologia comprovada', funnelStage: 'middle' },
  { adId: '3', pageName: 'Centro Terapêutico', adText: 'Últimas vagas para avaliação fonoaudiológica', funnelStage: 'bottom' }
];

export async function searchSpyAds({ keyword, especialidade }) {
  // Retorna mock por enquanto (implementar Meta Ad Library depois)
  return MOCK_ADS.map(ad => ({ ...ad, keyword: keyword || 'fonoaudiologia' }));
}

export async function analyzeAd(adText) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{
      role: 'user',
      content: `Analise este anúncio e retorne JSON com: gancho, estrutura, cta, porqueConverte, pontosFracos

Anúncio: "${adText}"`
    }],
    response_format: { type: 'json_object' }
  });
  return JSON.parse(completion.choices[0].message.content);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 📝 GERAÇÃO DE POSTS
// ═══════════════════════════════════════════════════════════════════════════════

export async function generatePost(especialidadeId, funnelStage = 'top') {
  const especialidade = ESPECIALIDADES.find(e => e.id === especialidadeId) || ESPECIALIDADES[0];
  
  const prompts = {
    top: `Crie um post para Instagram sobre ${especialidade.foco}. Gancho que desperte curiosidade dos pais. Sem emojis. Máximo 3 frases.`,
    middle: `Crie um post explicando como a ${especialidade.nome} ajuda crianças. Tom educativo mas acolhedor. Sem emojis.`,
    bottom: `Crie um post com urgência: últimas vagas para ${especialidade.nome} na Clínica Fono Inova. CTA forte. Sem emojis.`
  };

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompts[funnelStage] || prompts.top }],
    temperature: 0.8
  });

  return {
    content: completion.choices[0].message.content.trim(),
    especialidadeId,
    funnelStage
  };
}

export { ESPECIALIDADES };
