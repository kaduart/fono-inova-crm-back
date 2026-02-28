/**
 * 📸 Instagram Post Service - Fono Inova
 * Estratégia direta: Headline curta (imagem) + Legenda emocional (SEO)
 * Separado do GMB - não usa generatePostForEspecialidade
 */

import OpenAI from 'openai';
import { v2 as cloudinary } from 'cloudinary';
import InstagramPost from '../models/InstagramPost.js';
import { ESPECIALIDADES } from './gmbService.js';
import { gerarImagemBranded } from './brandImageService.js';
import { getPromptPronto, IMAGE_TYPES } from './imagePromptService.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * 🎯 HEADLINES POR FUNIL (máx 6 palavras)
 */
const HEADLINES_FUNIL = {
  top: [
    'Seu filho ainda não fala?',
    'Sua criança evita socializar?',
    'Atraso na fala?',
    'Dificuldade na escola?',
    'Seu filho é muito agitado?',
    'Problema de comportamento?'
  ],
  middle: [
    'Como funciona a avaliação?',
    'Benefícios da terapia',
    'O que esperar?',
    'Quando começar?',
    'Como ajudamos seu filho?'
  ],
  bottom: [
    'Agende sua avaliação',
    'Vagas para essa semana',
    'Comece o tratamento',
    'Transforme a rotina',
    'Agende pelo link'
  ]
};

/**
 * 🎣 GERAR HEADLINE CURTA (imagem)
 * Máx 6 palavras, estratégica por funil
 */
async function gerarHeadline({ especialidade, funnelStage, customTheme }) {
  const templates = HEADLINES_FUNIL[funnelStage] || HEADLINES_FUNIL.top;
  
  const messages = [
    {
      role: 'system',
      content: `Você cria headlines para Instagram da Fono Inova.

REGRAS:
- MÁXIMO 6 palavras
- Comece com "Seu filho" ou pergunta direta
- Foque na dor do pai/mãe
- Impacto imediato
- SEM emojis

EXEMPLOS:
- "Seu filho ainda não fala?"
- "Atraso na fala?"
- "Dificuldade na escola?"

Responda APENAS a headline, nada mais.`
    },
    {
      role: 'user',
      content: `Headline para ${especialidade.nome} (${funnelStage})

GANCHO: ${especialidade.gancho}
FOCO: ${especialidade.foco}
${customTheme ? `TEMA: ${customTheme}` : ''}

Headline (máx 6 palavras):`
    }
  ];

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 30,
      temperature: 0.7
    });

    let headline = response.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
    
    // Garante máx 6 palavras
    const words = headline.split(/\s+/);
    if (words.length > 6) {
      headline = words.slice(0, 6).join(' ');
    }
    
    // Garante máx 30 caracteres para não cortar no layout
    if (headline.length > 30) {
      headline = headline.substring(0, 30);
    }
    
    return headline;
  } catch (error) {
    // Fallback do template
    const index = especialidade.nome.length % templates.length;
    return templates[index];
  }
}

/**
 * 📝 GERAR LEGENDA ESTRATÉGICA
 * Dor + emoção + autoridade + SEO + CTA
 */
async function gerarLegenda({ especialidade, headline, funnelStage }) {
  const messages = [
    {
      role: 'system',
      content: `Você escreve legendas Instagram para Fono Inova, clínica em Anápolis/GO.

ESTRUTURA OBRIGATÓRIA:
1. PRIMEIRA LINHA: Dor emocional (expandir a headline)
2. Desenvolvimento: Impacto no dia a dia + autoridade
3. CTA: "Agende pelo link da bio" ou "Me chame no WhatsApp"
4. Hashtags: 4-5 tags

REGRAS:
- NÃO use "Conheça nosso trabalho"
- NÃO seja institucional/genérico
- SEJA emocional e direto
- Inclua "Anápolis" e "Fono Inova" naturalmente
- CTA claro no final

EXEMPLO:
"Seu filho demora para falar e isso preocupa você?

O atraso na fala pode impactar o desenvolvimento..."
`
    },
    {
      role: 'user',
      content: `Crie legenda para Instagram.

HEADLINE: ${headline}
ESPECIALIDADE: ${especialidade.nome}
FOCO: ${especialidade.foco}
FUNIL: ${funnelStage}

Escreva a legenda completa (4-5 parágrafos curtos):`
    }
  ];

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 400,
      temperature: 0.8
    });

    let legenda = response.choices[0].message.content.trim();
    
    // Garante elementos
    if (!legenda.includes('Fono Inova')) {
      legenda += '\n\n💚 Fono Inova | Anápolis/GO';
    }
    
    if (!legenda.includes('Anápolis')) {
      legenda = legenda.replace(/Fono Inova/g, 'Fono Inova, em Anápolis,');
    }
    
    if (!legenda.match(/link|bio|whatsapp/i)) {
      legenda += '\n\nAgende pelo link da bio 👆';
    }
    
    if (!legenda.includes('#')) {
      legenda += `\n\n#${especialidade.id} #anapolis #${especialidade.id}infantil #desenvolvimentoinfantil`;
    }

    return legenda;
  } catch (error) {
    return `${headline}\n\n${especialidade.foco}.\n\nNa Fono Inova, em Anápolis, ajudamos seu filho a desenvolver todo seu potencial.\n\nAgende pelo link da bio.\n\n💚 Fono Inova | Anápolis/GO\n#${especialidade.id} #anapolis`;
  }
}

/**
 * 🎨 GERAR IMAGEM 
 * Opção temporária: DALL-E (enquanto não tem crédito no fal.ai)
 * Opção normal: Together.ai (FLUX) → fal.ai → Replicate → Pollinations
 */
async function generateImage({ especialidade, headline, tipoImagem = IMAGE_TYPES.FOTO_REAL, useDalleTemp = false }) {
  const prompt = getPromptPronto(
    especialidade.id,
    tipoImagem,
    {
      atividade: `${especialidade.foco.split(',')[0]} session`,
      tema: especialidade.foco,
      mensagem: headline
    }
  );

  console.log('🎨 Prompt:', prompt.substring(0, 80) + '...');

  // ═══════════════════════════════════════════════════════════
  // OPÇÃO TEMPORÁRIA: DALL-E (ative quando não tiver crédito no fal.ai)
  // Para usar: mude useDalleTemp para true abaixo
  // ═══════════════════════════════════════════════════════════
  const USE_DALLE_TEMPORARIO = true; // <-- ALTERE PARA false QUANDO TIVER CRÉDITO NO FAL.AI
  
  if (USE_DALLE_TEMPORARIO && process.env.OPENAI_API_KEY) {
    try {
      console.log('🎨 [TEMP] DALL-E 3 (enquanto não tem crédito fal.ai)...');
      const response = await openai.images.generate({
        model: 'dall-e-3',
        prompt: prompt,
        n: 1,
        size: '1024x1024',
        quality: 'standard',
        style: 'natural',
      });

      const imageUrl = response.data[0].url;
      const fotoBuf = Buffer.from(await (await fetch(imageUrl, { signal: AbortSignal.timeout(30000) })).arrayBuffer());
      
      const base64 = `data:image/jpeg;base64,${fotoBuf.toString('base64')}`;
      const result = await cloudinary.uploader.upload(base64, {
        folder: 'fono-inova/instagram/dalle-temp',
        public_id: `${especialidade.id}_${Date.now()}`,
      });
      console.log('✅ DALL-E temp:', result.secure_url);
      return { url: result.secure_url, provider: 'dalle-3-temp' };
    } catch (e) {
      console.warn('⚠️ DALL-E temp falhou:', e.message);
      console.log('🔄 Tentando FLUX...');
    }
  }

  console.log('🎨 Prompt:', prompt.substring(0, 80) + '...');

  // TENTATIVA 1: Together.ai (FLUX) - $5 crédito free
  if (process.env.TOGETHER_API_KEY) {
    try {
      console.log('🚀 Together.ai FLUX...');
      const response = await fetch('https://api.together.xyz/v1/images/generations', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.TOGETHER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'black-forest-labs/FLUX.1-schnell',
          prompt: prompt,
          width: 1024,
          height: 1024,
          steps: 4,
          n: 1
        }),
        signal: AbortSignal.timeout(30000)
      });

      if (response.ok) {
        const data = await response.json();
        const imageUrl = data.data?.[0]?.url || data.url;
        if (imageUrl) {
          const fotoBuf = Buffer.from(await (await fetch(imageUrl, { signal: AbortSignal.timeout(30000) })).arrayBuffer());
          const base64 = `data:image/jpeg;base64,${fotoBuf.toString('base64')}`;
          const result = await cloudinary.uploader.upload(base64, {
            folder: 'fono-inova/instagram/together',
            public_id: `${especialidade.id}_${Date.now()}`,
          });
          console.log('✅ Together:', result.secure_url);
          return { url: result.secure_url, provider: 'together-flux-schnell' };
        }
      } else {
        const err = await response.text();
        console.warn('⚠️ Together:', response.status, err.substring(0, 100));
      }
    } catch (e) {
      console.warn('⚠️ Together:', e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // TENTATIVA 2: fal.ai FLUX dev (FOCO PRINCIPAL)
  // ═══════════════════════════════════════════════════════════
  if (process.env.FAL_API_KEY) {
    try {
      console.log('🚀 fal.ai FLUX dev...');
      console.log('   API Key:', process.env.FAL_API_KEY.substring(0, 8) + '...');
      
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
        signal: AbortSignal.timeout(120000), // 2 minutos
      });

      console.log('   Status:', falRes.status);
      
      if (falRes.ok) {
        const falData = await falRes.json();
        console.log('   Response:', JSON.stringify(falData).substring(0, 200));
        
        const imgUrl = falData.images?.[0]?.url;
        if (imgUrl) {
          console.log('   Download:', imgUrl.substring(0, 60) + '...');
          const fotoBuf = Buffer.from(await (await fetch(imgUrl, { signal: AbortSignal.timeout(30000) })).arrayBuffer());
          console.log(`   Buffer: ${(fotoBuf.length/1024).toFixed(1)}KB`);
          
          const base64 = `data:image/jpeg;base64,${fotoBuf.toString('base64')}`;
          const result = await cloudinary.uploader.upload(base64, {
            folder: 'fono-inova/instagram/fal',
            public_id: `${especialidade.id}_${Date.now()}`,
          });
          console.log('✅ fal.ai:', result.secure_url);
          return { url: result.secure_url, provider: 'fal-flux-dev' };
        } else {
          console.warn('⚠️ fal.ai: Sem URL na resposta');
        }
      } else if (falRes.status === 403) {
        const errData = await falRes.json().catch(() => ({}));
        if (errData.detail?.includes('balance') || errData.detail?.includes('locked')) {
          console.warn('⚠️ fal.ai: Saldo esgotado. Recarregue em fal.ai/dashboard');
        }
      } else {
        const errText = await falRes.text();
        console.error('❌ fal.ai erro:', falRes.status, errText.substring(0, 200));
      }
    } catch (e) {
      console.error('❌ fal.ai exception:', e.message);
    }
  } else {
    console.log('⏭️  FAL_API_KEY não configurada');
  }

  // ═══════════════════════════════════════════════════════════
  // TENTATIVA 3: Replicate (se tiver token)
  // ═══════════════════════════════════════════════════════════
  if (process.env.REPLICATE_API_TOKEN) {
    try {
      console.log('🚀 Replicate FLUX...');
      
      const response = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: {
          'Authorization': `Token ${process.env.REPLICATE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          version: 'black-forest-labs/flux-schnell',
          input: {
            prompt: prompt,
            aspect_ratio: '1:1',
            output_format: 'png',
            output_quality: 80,
          }
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (response.ok) {
        const prediction = await response.json();
        // Polling do resultado
        let result = prediction;
        let attempts = 0;
        while (result.status !== 'succeeded' && result.status !== 'failed' && attempts < 30) {
          await new Promise(r => setTimeout(r, 1000));
          const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
            headers: { 'Authorization': `Token ${process.env.REPLICATE_API_TOKEN}` },
          });
          result = await pollRes.json();
          attempts++;
        }
        
        if (result.status === 'succeeded' && result.output) {
          const imgUrl = Array.isArray(result.output) ? result.output[0] : result.output;
          const fotoBuf = Buffer.from(await (await fetch(imgUrl, { signal: AbortSignal.timeout(30000) })).arrayBuffer());
          const base64 = `data:image/png;base64,${fotoBuf.toString('base64')}`;
          const res = await cloudinary.uploader.upload(base64, {
            folder: 'fono-inova/instagram/replicate',
            public_id: `${especialidade.id}_${Date.now()}`,
          });
          console.log('✅ Replicate:', res.secure_url);
          return { url: res.secure_url, provider: 'replicate-flux' };
        }
      }
    } catch (e) {
      console.warn('⚠️ Replicate:', e.message);
    }
  }

  // TENTATIVA 4: Pollinations (geralmente instável)
  const delay = ms => new Promise(r => setTimeout(r, ms));
  
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`🔄 Pollinations (tentativa ${attempt}/3)...`);
      const encoded = encodeURIComponent(prompt);
      const seed = Math.floor(Math.random() * 999999);
      
      // URL alternativa com modelo diferente nas retentativas
      const model = attempt === 1 ? 'flux' : attempt === 2 ? 'turbo' : 'default';
      const pollUrl = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&seed=${seed}&nologo=true&model=${model}&negative_prompt=blurry,low+quality,text,watermark`;
      
      console.log('   URL:', pollUrl.substring(0, 80) + '...');
      
      const res = await fetch(pollUrl, { 
        signal: AbortSignal.timeout(90000),
        headers: { 'Accept': 'image/*' }
      });

      if (res.ok) {
        const contentType = res.headers.get('content-type') || '';
        console.log('   Content-Type:', contentType);
        
        // Verifica se é realmente uma imagem
        if (!contentType.includes('image')) {
          console.warn('⚠️ Resposta não é imagem:', contentType);
          throw new Error(`Invalid content-type: ${contentType}`);
        }
        
        const fotoBuf = Buffer.from(await res.arrayBuffer());
        
        // Verifica tamanho mínimo (1KB)
        if (fotoBuf.length < 1024) {
          console.warn('⚠️ Imagem muito pequena:', fotoBuf.length, 'bytes');
          throw new Error('Image too small');
        }
        
        console.log(`   📦 Download: ${(fotoBuf.length/1024).toFixed(1)}KB`);
        
        // Upload pro Cloudinary
        const base64 = `data:image/jpeg;base64,${fotoBuf.toString('base64')}`;
        const result = await cloudinary.uploader.upload(base64, {
          folder: 'fono-inova/instagram/pollinations',
          public_id: `${especialidade.id}_${Date.now()}`,
        });
        console.log('✅ Pollinations:', result.secure_url);
        return { url: result.secure_url, provider: `pollinations-${model}` };
      } else {
        const status = res.status;
        console.warn(`⚠️ Pollinations status: ${status} (tentativa ${attempt})`);
        
        // Retry em erros 5xx ou 429 (rate limit)
        if ((status >= 500 || status === 429) && attempt < 3) {
          const waitTime = attempt * 2000; // 2s, 4s
          console.log(`   ⏳ Aguardando ${waitTime}ms antes de retry...`);
          await delay(waitTime);
          continue;
        }
        throw new Error(`HTTP ${status}`);
      }
    } catch (e) {
      console.error(`❌ Pollinations erro (tentativa ${attempt}):`, e.message);
      if (attempt < 3) {
        await delay(attempt * 2000);
      }
    }
  }

  // FALLBACK FINAL: URL direta do Pollinations (sem verificação)
  console.log('🔄 Fallback: URL direta do Pollinations...');
  try {
    const encoded = encodeURIComponent(prompt);
    const seed = Math.floor(Math.random() * 999999);
    const directUrl = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&seed=${seed}&nologo=true`;
    
    console.log('⚠️ Retornando URL direta (tentativa final):', directUrl.substring(0, 50) + '...');
    return { url: directUrl, provider: 'pollinations-direct', warning: 'URL direta - pode não carregar' };
  } catch (e) {
    console.error('❌ Erro ao gerar URL:', e.message);
  }

  console.error('❌ Todas as fontes de imagem falharam');
  return null;
}

/**
 * 📸 GERAR POST COMPLETO (Instagram)
 * Headline curta (imagem) + Legenda estratégica
 * 
 * ⚠️ TEMPORÁRIO: Altere USE_DALLE_TEMPORARIO para false quando tiver crédito no fal.ai
 */
export async function generateInstagramPost({
  especialidadeId,
  customTheme = null,
  funnelStage = 'top',
  userId = null
}) {
  const especialidade = ESPECIALIDADES.find(e => e.id === especialidadeId) || ESPECIALIDADES[0];

  console.log('📸 Instagram:', especialidade.nome, `(${funnelStage})`);

  // 1. HEADLINE curta (imagem)
  const headline = await gerarHeadline({ especialidade, funnelStage, customTheme });
  console.log('🎯 Headline:', headline);

  // 2. LEGENDA estratégica
  const legenda = await gerarLegenda({ especialidade, headline, funnelStage });
  console.log('📝 Legenda:', legenda.split('\n')[0]);

  // 3. IMAGEM base (com prompt otimizado)
  const imageResult = await generateImage({ 
    especialidade, 
    headline,
    tipoImagem: IMAGE_TYPES.FOTO_REAL 
  });
  const baseImageUrl = imageResult?.url || null;
  const imageProvider = imageResult?.provider || null;
  console.log('🤖 Provider:', imageProvider || 'nenhum');

  // 4. Aplicar branding visual (logo + blobs)
  let mediaUrl = baseImageUrl;
  if (baseImageUrl) {
    try {
      console.log('🎨 Aplicando branding Fono Inova...');
      const branded = await gerarImagemBranded({
        fotoUrl: baseImageUrl,
        titulo: headline,
        postContent: `${headline}\n\n${legenda}`,
        especialidadeId: especialidade.id
      });
      mediaUrl = branded.url;
      console.log('✅ Branding aplicado:', branded.layout);
    } catch (e) {
      console.error('❌ Branding falhou:', e.message);
      console.log('⚠️ Usando imagem sem branding');
      mediaUrl = baseImageUrl;
    }
  }

  // 5. SALVAR
  const post = new InstagramPost({
    title: headline,
    headline: headline,
    content: legenda,
    caption: legenda,
    theme: especialidade.id,
    funnelStage,
    status: 'draft',
    mediaUrl,
    mediaType: mediaUrl ? 'image' : null,
    aiGenerated: true,
    imageProvider,  // 🖼️ Qual IA gerou a imagem
    createdBy: userId
  });

  await post.save();

  return {
    success: true,
    post,
    data: {
      headline,
      legenda,
      mediaUrl,
      especialidade: especialidade.nome
    }
  };
}

/**
 * 🔄 REGENERAR IMAGEM
 */
export async function regenerateImageForPost(post) {
  const especialidade = ESPECIALIDADES.find(e => e.id === post.theme) || ESPECIALIDADES[0];
  
  const imageResult = await generateImage({ 
    especialidade,
    headline: post.headline,
    tipoImagem: IMAGE_TYPES.FOTO_REAL 
  });
  
  if (imageResult?.url) {
    try {
      const branded = await gerarImagemBranded({
        fotoUrl: imageResult.url,
        titulo: post.headline,
        postContent: `${post.headline}\n\n${post.caption}`,
        especialidadeId: especialidade.id
      });
      post.mediaUrl = branded.url;
      post.imageProvider = imageResult.provider;  // 🖼️ Atualiza provider
      await post.save();
      return branded.url;
    } catch (e) {
      post.mediaUrl = imageResult.url;
      post.imageProvider = imageResult.provider;
      await post.save();
      return imageResult.url;
    }
  }
  return null;
}

export { gerarHeadline, gerarLegenda, generateImage, IMAGE_TYPES };

// ═══════════════════════════════════════════════════════════
// 🆕 INTEGRAÇÃO COM NOVO SISTEMA DE LAYOUTS (v2)
// ═══════════════════════════════════════════════════════════

import { gerarPostComRotacao } from './postGeneratorService.js';

/**
 * 🎨 GERAR POST COM SISTEMA DE LAYOUTS V2 (Novo)
 * Usa o motor de renderização genérico com 15+ layouts
 * 
 * @param {Object} options - Opções de geração
 * @param {string} options.especialidadeId - ID da especialidade
 * @param {string} options.funnelStage - Estágio do funil (top/middle/bottom)
 * @param {string} options.customTheme - Tema customizado (opcional)
 * @param {string} options.userId - ID do usuário criador
 * @param {boolean} options.useV2Layouts - Forçar uso do novo sistema
 */
export async function generateInstagramPostV2({
  especialidadeId,
  funnelStage = 'top',
  customTheme = null,
  userId = null,
  useV2Layouts = true,
  provider = 'auto'
}) {
  if (!useV2Layouts) {
    // Fallback para sistema antigo
    return generateInstagramPost({ especialidadeId, customTheme, funnelStage, userId });
  }
  
  const especialidade = ESPECIALIDADES.find(e => e.id === especialidadeId) || ESPECIALIDADES[0];
  
  console.log('📸 [v2] Instagram Post com Layouts Dinâmicos:', especialidade.nome);
  
  // 1. Gerar headline e legenda (reutiliza funções existentes)
  const headline = await gerarHeadline({ especialidade, funnelStage, customTheme });
  const legenda = await gerarLegenda({ especialidade, headline, funnelStage });
  
  console.log('🎯 Headline:', headline);
  console.log('📝 Legenda:', legenda.split('\n')[0]);
  
  // 2. Gerar imagem com novo sistema de layouts
  const hook = legenda.split('\n')[0]?.substring(0, 50);
  
  try {
    const resultado = await gerarPostComRotacao({
      especialidadeId,
      conteudo: legenda,
      headline,
      hook,
      categoriaPreferida: null, // Deixa o sistema escolher
      channel: 'instagram',
      provider
    });
    
    // 3. Criar post no MongoDB
    const post = new InstagramPost({
      title: headline,
      headline,
      content: legenda,
      caption: legenda,
      theme: especialidade.id,
      funnelStage,
      status: 'draft',
      mediaUrl: resultado.url,
      mediaType: 'image',
      aiGenerated: true,
      imageProvider: resultado.imageProvider,
      layoutId: resultado.layoutId, // Novo campo
      createdBy: userId,
      metadata: {
        customTheme,
        headlineStrategy: resultado.layoutCategoria,
        layoutNome: resultado.layoutNome
      }
    });
    
    await post.save();
    
    console.log('✅ Post v2 criado:', resultado.layoutId, resultado.layoutNome);
    
    return {
      success: true,
      post,
      data: {
        headline,
        legenda,
        mediaUrl: resultado.url,
        especialidade: especialidade.nome,
        layout: {
          id: resultado.layoutId,
          nome: resultado.layoutNome,
          categoria: resultado.layoutCategoria
        },
        provider: resultado.imageProvider,
        tempo: resultado.tempo,
        proximoLayoutSugerido: resultado.proximoLayoutSugerido
      }
    };
    
  } catch (error) {
    console.error('❌ Erro no sistema v2, fallback para v1:', error.message);
    
    // Fallback para sistema antigo em caso de erro
    return generateInstagramPost({ especialidadeId, customTheme, funnelStage, userId });
  }
}

/**
 * 🔄 REGENERAR IMAGEM COM NOVO SISTEMA (v2)
 */
export async function regenerateImageForPostV2(post) {
  try {
    const { regenerarImagemPost } = await import('./postGeneratorService.js');
    
    const hook = post.caption?.split('\n')[0]?.substring(0, 50) || '';
    
    const resultado = await regenerarImagemPost({
      especialidadeId: post.theme,
      headline: post.headline,
      hook,
      // Não passa layoutId para forçar novo layout
    });
    
    // Atualizar post
    post.mediaUrl = resultado.url;
    post.imageProvider = resultado.imageProvider;
    post.layoutId = resultado.layoutId;
    await post.save();
    
    return {
      url: resultado.url,
      layoutId: resultado.layoutId,
      layoutNome: resultado.layoutNome
    };
    
  } catch (error) {
    console.error('❌ Erro na regeneração v2, fallback para v1:', error.message);
    return regenerateImageForPost(post);
  }
}
