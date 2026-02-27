/**
 * 🚀 Post Generator Service - Fono Inova
 * Serviço principal de geração de posts para Instagram
 * Integra: FLUX (imagem base) + Layout Engine (overlay) + Persistência
 */

import {
  selecionarLayoutInteligente,
  registrarUso,
  aplicarLayout,
  uploadImagem
} from './layoutEngine.js';
import { getPromptPronto, IMAGE_TYPES } from './imagePromptService.js';
import LayoutHistory from '../models/LayoutHistory.js';
import { LAYOUTS } from '../config/layoutsConfig.js';

// ============================================================================
// 🔧 CONFIGURAÇÃO DOS PROVIDERS DE IMAGEM
// ============================================================================

// Ordem de prioridade quando provider='auto'
export const PROVIDER_PRIORITY = ['fal', 'together', 'replicate', 'pollinations', 'gemini-nano'];

const FLUX_CONFIG = {
  fal: {
    url: 'https://fal.run/fal-ai/flux/dev',
    headers: (apiKey) => ({
      'Authorization': `Key ${apiKey}`,
      'Content-Type': 'application/json',
    }),
    body: (prompt) => ({
      prompt,
      image_size: 'square',
      num_inference_steps: 28,
      guidance_scale: 3.5,
      safety_tolerance: '2',
    }),
    timeout: 120000
  },
  
  together: {
    url: 'https://api.together.xyz/v1/images/generations',
    headers: (apiKey) => ({
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }),
    body: (prompt) => ({
      model: 'black-forest-labs/FLUX.1-schnell',
      prompt,
      width: 1024,
      height: 1024,
      steps: 4,
      n: 1
    }),
    timeout: 30000
  },
  
  replicate: {
    url: 'https://api.replicate.com/v1/predictions',
    headers: (apiKey) => ({
      'Authorization': `Token ${apiKey}`,
      'Content-Type': 'application/json',
    }),
    body: (prompt) => ({
      version: 'black-forest-labs/flux-schnell',
      input: {
        prompt,
        aspect_ratio: '1:1',
        output_format: 'png',
        output_quality: 80,
      }
    }),
    timeout: 30000
  },
  
  'gemini-nano': {
    url: process.env.GEMINI_NANO_URL || 'http://localhost:5173/v1/images/generations',
    headers: () => ({
      'Content-Type': 'application/json',
    }),
    body: (prompt) => ({
      model: 'gemini-nano-imagen',
      prompt,
      width: 1024,
      height: 1024,
      num_inference_steps: 20,
      guidance_scale: 2.5,
    }),
    timeout: 120000,
    isLocal: true
  }
};

// ============================================================================
// 🎨 GERAÇÃO DE IMAGEM BASE (FLUX/AI)
// ============================================================================

/**
 * Gera imagem base realista usando FLUX ou provider específico
 * @param {Object} especialidade - Dados da especialidade
 * @param {string} tipoImagem - Tipo de imagem
 * @param {string} preferredProvider - Provider específico ou 'auto'
 */
async function generateImagemBase(especialidade, tipoImagem = IMAGE_TYPES.FOTO_REAL, preferredProvider = 'auto') {
  console.log(`   📸 Gerando imagem base: ${especialidade.nome} (${preferredProvider})`);
  
  // Construir prompt otimizado
  const prompt = buildOptimizedPrompt(especialidade, tipoImagem);
  console.log(`   📝 Prompt: ${prompt.substring(0, 80)}...`);
  
  const errors = [];
  
  // Se provider específico foi solicitado, tenta apenas ele
  if (preferredProvider && preferredProvider !== 'auto') {
    console.log(`   🎯 Provider específico: ${preferredProvider}`);
    
    if (preferredProvider === 'gemini-nano') {
      try {
        const result = await callGeminiNano(prompt);
        console.log(`   ✅ Gemini Nano: ${(result.length/1024).toFixed(1)}KB`);
        return { buffer: result, provider: 'gemini-nano' };
      } catch (e) {
        console.warn(`   ⚠️ Gemini Nano falhou: ${e.message}`);
        throw new Error(`Gemini Nano: ${e.message}`);
      }
    }
    
    // Tentar provider específico do FLUX_CONFIG
    if (FLUX_CONFIG[preferredProvider]) {
      const apiKey = getApiKeyForProvider(preferredProvider);
      if (!apiKey && !FLUX_CONFIG[preferredProvider].isLocal) {
        throw new Error(`API key não configurada para ${preferredProvider}`);
      }
      
      try {
        const result = await callFluxProvider(preferredProvider, prompt);
        console.log(`   ✅ ${preferredProvider}: ${(result.length/1024).toFixed(1)}KB`);
        return { buffer: result, provider: preferredProvider };
      } catch (e) {
        console.warn(`   ⚠️ ${preferredProvider}: ${e.message}`);
        throw new Error(`${preferredProvider}: ${e.message}`);
      }
    }
    
    throw new Error(`Provider desconhecido: ${preferredProvider}`);
  }
  
  // MODO AUTO: Tentar na ordem de prioridade
  for (const provider of PROVIDER_PRIORITY) {
    // Pular Gemini Nano no modo auto (é local, pode não estar disponível)
    if (provider === 'gemini-nano') continue;
    
    const apiKey = getApiKeyForProvider(provider);
    if (!apiKey) continue;
    
    try {
      console.log(`   🚀 Tentando ${provider}...`);
      
      let result;
      if (provider === 'replicate') {
        result = await callReplicate(prompt);
      } else if (FLUX_CONFIG[provider]) {
        result = await callFluxProvider(provider, prompt);
      } else {
        continue;
      }
      
      if (result) {
        console.log(`   ✅ ${provider}: ${(result.length/1024).toFixed(1)}KB`);
        return { buffer: result, provider };
      }
    } catch (e) {
      console.warn(`   ⚠️ ${provider}: ${e.message}`);
      errors.push(`${provider}: ${e.message}`);
    }
  }
  
  // FALLBACK: Pollinations (sempre tenta no final)
  try {
    console.log('   🔄 Tentando Pollinations (fallback)...');
    const result = await callPollinations(prompt);
    if (result) {
      console.log(`   ✅ Pollinations: ${(result.length/1024).toFixed(1)}KB`);
      return { buffer: result, provider: 'pollinations' };
    }
  } catch (e) {
    console.warn(`   ⚠️ Pollinations: ${e.message}`);
    errors.push(`pollinations: ${e.message}`);
  }
  
  // TODAS FALHARAM
  throw new Error(`Falha ao gerar imagem: ${errors.join('; ')}`);
}

/**
 * Obtém API key para provider
 */
function getApiKeyForProvider(provider) {
  const keys = {
    'fal': process.env.FAL_API_KEY,
    'together': process.env.TOGETHER_API_KEY,
    'replicate': process.env.REPLICATE_API_TOKEN,
    'gemini-nano': process.env.GEMINI_NANO_URL || 'http://localhost:5173'
  };
  return keys[provider];
}

/**
 * Constrói prompt otimizado para FLUX
 */
function buildOptimizedPrompt(especialidade, tipoImagem) {
  // Base consistente para todos
  const basePrompt = `Ultra realistic professional medical photography, Brazilian ${especialidade.nome.toLowerCase()} therapist with child patient, natural interaction, warm authentic expressions, modern bright clinic room, soft window lighting, shallow depth of field, documentary style, shot on Sony A7R IV, 85mm lens, f/2.8, high quality, professional healthcare setting`;
  
  // Adicionar especificidades da especialidade
  const especificidades = {
    fonoaudiologia: ', speech therapy session, articulation cards, mirror, playful interaction',
    psicologia: ', play therapy, toys and drawing materials, cozy safe environment, emotional connection',
    terapia_ocupacional: ', fine motor activities, colorful beads and puzzles, sensory play materials',
    fisioterapia: ', balance exercises, foam blocks and therapy balls, movement therapy',
    neuropsicologia: ', cognitive assessment, colorful cognitive blocks, focused concentration'
  };
  
  const especificidade = especificidades[especialidade.id] || '';
  
  return basePrompt + especificidade;
}

/**
 * Chama provider FLUX genérico
 */
async function callFluxProvider(provider, prompt) {
  const config = FLUX_CONFIG[provider];
  const apiKey = provider === 'fal' ? process.env.FAL_API_KEY :
                 provider === 'together' ? process.env.TOGETHER_API_KEY : null;
  
  if (!apiKey) throw new Error(`API key não configurada para ${provider}`);
  
  const response = await fetch(config.url, {
    method: 'POST',
    headers: config.headers(apiKey),
    body: JSON.stringify(config.body(prompt)),
    signal: AbortSignal.timeout(config.timeout)
  });
  
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`${response.status}: ${err.substring(0, 100)}`);
  }
  
  const data = await response.json();
  
  // Extrair URL da imagem (formato varia por provider)
  let imageUrl;
  if (provider === 'fal') {
    imageUrl = data.images?.[0]?.url;
  } else if (provider === 'together') {
    imageUrl = data.data?.[0]?.url || data.url;
  }
  
  if (!imageUrl) {
    throw new Error('URL da imagem não encontrada na resposta');
  }
  
  // Download da imagem
  const imageResponse = await fetch(imageUrl, {
    signal: AbortSignal.timeout(30000)
  });
  
  if (!imageResponse.ok) {
    throw new Error(`Download falhou: ${imageResponse.status}`);
  }
  
  return Buffer.from(await imageResponse.arrayBuffer());
}

/**
 * Chama Replicate (com polling)
 */
async function callReplicate(prompt) {
  const config = FLUX_CONFIG.replicate;
  
  // Criar prediction
  const response = await fetch(config.url, {
    method: 'POST',
    headers: config.headers(process.env.REPLICATE_API_TOKEN),
    body: JSON.stringify(config.body(prompt)),
    signal: AbortSignal.timeout(config.timeout)
  });
  
  if (!response.ok) {
    throw new Error(`Replicate error: ${response.status}`);
  }
  
  const prediction = await response.json();
  
  // Polling
  let result = prediction;
  let attempts = 0;
  const maxAttempts = 60; // 60 segundos
  
  while (result.status !== 'succeeded' && result.status !== 'failed' && attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 1000));
    const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
      headers: { 'Authorization': `Token ${process.env.REPLICATE_API_TOKEN}` }
    });
    result = await pollRes.json();
    attempts++;
  }
  
  if (result.status !== 'succeeded') {
    throw new Error('Replicate timeout ou falha');
  }
  
  const imageUrl = Array.isArray(result.output) ? result.output[0] : result.output;
  
  const imageResponse = await fetch(imageUrl, { signal: AbortSignal.timeout(30000) });
  return Buffer.from(await imageResponse.arrayBuffer());
}

/**
 * 🤖 Chama Gemini Nano (local ou endpoint custom)
 * Compatível com implementações locais do Gemini Nano
 */
async function callGeminiNano(prompt) {
  const config = FLUX_CONFIG['gemini-nano'];
  const url = process.env.GEMINI_NANO_URL || 'http://localhost:5173/v1/images/generations';
  
  console.log(`   🤖 Gemini Nano: ${url}`);
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.GEMINI_NANO_API_KEY ? { 'Authorization': `Bearer ${process.env.GEMINI_NANO_API_KEY}` } : {})
      },
      body: JSON.stringify({
        prompt,
        width: 1024,
        height: 1024,
        num_inference_steps: 20,
        guidance_scale: 2.5,
        // Parâmetros específicos do Nano
        safety_filter_level: 'block_only_high',
        person_generation: 'allow_adult'
      }),
      signal: AbortSignal.timeout(config.timeout)
    });
    
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`HTTP ${response.status}: ${err}`);
    }
    
    // Gemini Nano pode retornar em diferentes formatos
    const contentType = response.headers.get('content-type') || '';
    
    if (contentType.includes('image')) {
      // Retorno direto como imagem
      return Buffer.from(await response.arrayBuffer());
    }
    
    // Retorno JSON com URL ou base64
    const data = await response.json();
    
    if (data.data && data.data[0]?.b64_json) {
      // Formato OpenAI-like (base64)
      return Buffer.from(data.data[0].b64_json, 'base64');
    }
    
    if (data.images && data.images[0]?.url) {
      // Formato fal.ai-like
      const imageRes = await fetch(data.images[0].url, { signal: AbortSignal.timeout(30000) });
      return Buffer.from(await imageRes.arrayBuffer());
    }
    
    if (data.image_url || data.url) {
      // URL direta
      const imageUrl = data.image_url || data.url;
      const imageRes = await fetch(imageUrl, { signal: AbortSignal.timeout(30000) });
      return Buffer.from(await imageRes.arrayBuffer());
    }
    
    throw new Error('Formato de resposta não reconhecido do Gemini Nano');
    
  } catch (e) {
    console.error('   ❌ Gemini Nano erro:', e.message);
    throw e;
  }
}

/**
 * Chama Pollinations (fallback gratuito)
 */
async function callPollinations(prompt) {
  const encoded = encodeURIComponent(prompt);
  const seed = Math.floor(Math.random() * 999999);
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&seed=${seed}&nologo=true&model=flux`;
  
  const response = await fetch(url, {
    signal: AbortSignal.timeout(90000),
    headers: { 'Accept': 'image/*' }
  });
  
  if (!response.ok) {
    throw new Error(`Pollinations: ${response.status}`);
  }
  
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('image')) {
    throw new Error('Resposta não é imagem');
  }
  
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1024) {
    throw new Error('Imagem muito pequena');
  }
  
  return buffer;
}

// ============================================================================
// 🚀 FUNÇÃO PRINCIPAL: GERAR POST COMPLETO
// ============================================================================

/**
 * Gera post completo com rotação automática de layouts
 */
export async function gerarPostComRotacao({
  especialidadeId,
  conteudo,
  headline,
  hook = '',
  categoriaPreferida = null,
  channel = 'instagram',
  provider = 'auto', // Provider de imagem: 'auto', 'fal', 'together', 'replicate', 'pollinations', 'gemini-nano'
  skipImageGeneration = false // Para testes (usa imagem placeholder)
}) {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('🚀 GERAR POST COM ROTAÇÃO AUTOMÁTICA');
  console.log(`   Especialidade: ${especialidadeId}`);
  console.log(`   Headline: "${headline?.substring(0, 40)}..."`);
  console.log(`   Provider: ${provider}`);
  console.log('═══════════════════════════════════════════════════════\n');
  
  const startTime = Date.now();
  
  try {
    // 1. SELECIONAR LAYOUT INTELIGENTE (Round-robin)
    const layout = await selecionarLayoutInteligente(
      especialidadeId,
      categoriaPreferida,
      channel
    );
    
    console.log(`   🎨 Layout: ${layout.nome} (${layout.categoria})`);
    
    // 2. GERAR IMAGEM BASE (FLUX)
    let fotoBuffer;
    let imageProvider = 'none';
    
    if (!skipImageGeneration && layout.specs.fotoRatio > 0) {
      // Buscar dados da especialidade
      const especialidade = {
        id: especialidadeId,
        nome: getNomeEspecialidade(especialidadeId)
      };
      
      const imagemResult = await generateImagemBase(especialidade, IMAGE_TYPES.FOTO_REAL, provider);
      fotoBuffer = imagemResult.buffer;
      imageProvider = imagemResult.provider;
    } else if (layout.specs.fotoRatio > 0) {
      // Modo teste: criar imagem placeholder colorida
      fotoBuffer = await createPlaceholderImage();
      imageProvider = 'placeholder';
    }
    
    // 3. APLICAR LAYOUT (Overlay SVG)
    const imagemComLayout = await aplicarLayout(
      fotoBuffer,
      layout,
      headline,
      hook,
      especialidadeId
    );
    
    // 4. UPLOAD PARA CLOUDINARY
    const imageUrl = await uploadImagem(
      imagemComLayout,
      especialidadeId,
      layout.id
    );
    
    // 5. REGISTRAR USO DO LAYOUT (persistência)
    const historyEntry = await registrarUso(
      layout.id,
      especialidadeId,
      layout.categoria,
      null, // postId será atualizado depois
      channel
    );
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log('\n✅ POST GERADO COM SUCESSO');
    console.log(`   ⏱️  Tempo: ${elapsed}s`);
    console.log(`   🖼️  Provider: ${imageProvider}`);
    console.log(`   🎨 Layout: ${layout.id}`);
    console.log(`   ☁️  URL: ${imageUrl.substring(0, 70)}...`);
    console.log('═══════════════════════════════════════════════════════\n');
    
    return {
      success: true,
      url: imageUrl,
      layoutId: layout.id,
      layoutNome: layout.nome,
      layoutCategoria: layout.categoria,
      imageProvider,
      tempo: `${elapsed}s`,
      historyId: historyEntry._id,
      proximoLayoutSugerido: await getProximoLayoutSugerido(especialidadeId, channel)
    };
    
  } catch (error) {
    console.error('\n❌ ERRO NA GERAÇÃO DO POST:');
    console.error(`   ${error.message}`);
    console.log('═══════════════════════════════════════════════════════\n');
    
    throw error;
  }
}

/**
 * Cria imagem placeholder para testes
 */
async function createPlaceholderImage() {
  return await sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 3,
      background: { r: 45, g: 125, b: 210 } // Azul terapia
    }
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/**
 * Obtém nome legível da especialidade
 */
function getNomeEspecialidade(id) {
  const nomes = {
    fonoaudiologia: 'Fonoaudiologia',
    psicologia: 'Psicologia',
    terapia_ocupacional: 'Terapia Ocupacional',
    fisioterapia: 'Fisioterapia',
    neuropsicologia: 'Neuropsicologia',
    psicopedagogia: 'Psicopedagogia'
  };
  return nomes[id] || 'Terapia';
}

/**
 * Sugere próximo layout baseado no histórico
 */
async function getProximoLayoutSugerido(especialidadeId, channel) {
  const recentes = await LayoutHistory.getRecentLayouts(especialidadeId, channel, 3);
  const disponiveis = getLayoutsForEspecialidade(especialidadeId)
    .filter(l => !recentes.includes(l.id));
  
  if (disponiveis.length > 0) {
    return disponiveis[0].id;
  }
  
  return 'hero_banner_curva'; // Fallback
}

// ============================================================================
// 🔄 FUNÇÕES AUXILIARES
// ============================================================================

/**
 * Regenerar imagem para post existente (mesmo layout ou novo)
 */
export async function regenerarImagemPost({
  especialidadeId,
  headline,
  hook = '',
  layoutId = null, // Se null, seleciona novo layout
  channel = 'instagram'
}) {
  // Se não especificou layout, seleciona um novo inteligentemente
  const layout = layoutId 
    ? getLayoutById(layoutId)
    : await selecionarLayoutInteligente(especialidadeId, null, channel);
  
  // Gerar nova imagem base
  const especialidade = {
    id: especialidadeId,
    nome: getNomeEspecialidade(especialidadeId)
  };
  
  const { buffer: fotoBuffer, provider: imageProvider } = await generateImagemBase(especialidade, IMAGE_TYPES.FOTO_REAL, 'auto');
  
  // Aplicar layout
  const imagemComLayout = await aplicarLayout(
    fotoBuffer,
    layout,
    headline,
    hook,
    especialidadeId
  );
  
  // Upload
  const imageUrl = await uploadImagem(imagemComLayout, especialidadeId, layout.id);
  
  // Registrar uso
  await registrarUso(layout.id, especialidadeId, layout.categoria, null, channel);
  
  return {
    url: imageUrl,
    layoutId: layout.id,
    layoutNome: layout.nome,
    imageProvider
  };
}

/**
 * Preview de layout (não registra no histórico)
 */
export async function previewLayout({
  layoutId,
  especialidadeId,
  headline,
  hook = ''
}) {
  const { getLayoutById } = await import('../config/layoutsConfig.js');
  const layout = getLayoutById(layoutId);
  
  // Usar imagem placeholder para preview rápido
  const placeholder = await createPlaceholderImage();
  
  const imagemComLayout = await aplicarLayout(
    placeholder,
    layout,
    headline,
    hook,
    especialidadeId
  );
  
  // Upload temporário (pode ter TTL curto no Cloudinary)
  const imageUrl = await uploadImagem(imagemComLayout, 'preview', layoutId);
  
  return {
    url: imageUrl,
    layout
  };
}

/**
 * Obter estatísticas de uso
 */
export async function getEstatisticas(especialidadeId = null) {
  const stats = await LayoutHistory.getStats(especialidadeId);
  
  return {
    porLayout: stats,
    totalUsos: stats.reduce((acc, s) => acc + s.count, 0),
    layoutsDisponiveis: Object.keys(LAYOUTS).length
  };
}

// Exportações
export {
  LAYOUTS,
  generateImagemBase
};

export default {
  gerarPostComRotacao,
  regenerarImagemPost,
  previewLayout,
  getEstatisticas
};
