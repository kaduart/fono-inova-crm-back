/**
 * Brand Image Service v3 - Fono Inova
 * Sistema Visual Profissional: fal.ai FLUX → HuggingFace → Pollinations
 * SEM DALL-E, SEM Groq - só FLUX real
 */

import sharp from 'sharp';
import { v2 as cloudinary } from 'cloudinary';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = join(__dir, '../dist/images/logo-completa.png');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const CORES = {
  verdeProfundo: '#1A4D3A',
  verdeVibrante: '#2D6A4F',
  amareloOuro: '#F4D03F',
  rosaCoral: '#F1948A',
  lilas: '#C39BD3',
  branco: '#FFFFFF',
};

/**
 * Quebra título em linhas balanceadas (não corta palavras)
 */
function quebrarTituloBalanceado(titulo, maxLinhas = 2) {
  const palavras = titulo.split(' ').filter(p => p.trim());
  if (palavras.length === 0) return Array(maxLinhas).fill('');
  
  // Distribui palavras igualmente entre as linhas
  const linhas = [];
  const palavrasPorLinha = Math.ceil(palavras.length / maxLinhas);
  
  for (let i = 0; i < maxLinhas; i++) {
    const inicio = i * palavrasPorLinha;
    const fim = Math.min(inicio + palavrasPorLinha, palavras.length);
    const linha = palavras.slice(inicio, fim).join(' ');
    linhas.push(linha);
  }
  
  return linhas;
}

/**
 * Calcula tamanho da fonte baseado no comprimento do texto
 */
function calcularFontSize(texto, baseSize = 56, minSize = 36) {
  if (texto.length <= 20) return baseSize;
  if (texto.length <= 30) return 48;
  if (texto.length <= 40) return 42;
  return minSize;
}

const LAYOUTS = {
  hero_banner: {
    fotoRatio: 0.70,
    crop: 'entropy',
    gerarSVG: (titulo, hook, bandY) => {
      // Quebra título em 2 linhas balanceadas
      const tituloLinhas = quebrarTituloBalanceado(titulo, 2);
      
      // Ajusta tamanho da fonte baseado no comprimento
      const fontSize = calcularFontSize(titulo, 52, 38);
      const letterSpacing = titulo.length > 25 ? '1' : '2';
      
      return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">
  <defs>
    <filter id="sh"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-opacity="0.35"/></filter>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${CORES.verdeProfundo}"/>
      <stop offset="100%" stop-color="${CORES.verdeVibrante}"/>
    </linearGradient>
  </defs>
  <path d="M0,${bandY} Q540,${bandY-40} 1080,${bandY} L1080,1080 L0,1080 Z" fill="url(#bg)"/>
  <path d="M1080,0 L850,0 C900,20 950,80 960,150 C970,220 1020,250 1080,280 Z" fill="${CORES.amareloOuro}" opacity="0.85"/>
  <path d="M0,${bandY-80} C80,${bandY-90} 140,${bandY-40} 130,${bandY+80} C120,${bandY+180} 50,${bandY+220} 0,${bandY+240} Z" fill="${CORES.lilas}" opacity="0.6"/>
  <text x="70" y="${bandY+90}" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="${fontSize}" letter-spacing="${letterSpacing}" fill="${CORES.branco}" filter="url(#sh)">${tituloLinhas[0]}</text>
  ${tituloLinhas[1] ? `<text x="70" y="${bandY+150}" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="${fontSize}" letter-spacing="${letterSpacing}" fill="${CORES.branco}" filter="url(#sh)">${tituloLinhas[1]}</text>` : ''}
  <text x="70" y="${bandY+205}" font-family="Montserrat,Arial,sans-serif" font-weight="600" font-size="26" fill="${CORES.branco}" filter="url(#sh)">${hook.substring(0, 50)}${hook.length > 50 ? '...' : ''}</text>
  <rect x="70" y="${bandY+240}" width="120" height="4" rx="2" fill="${CORES.amareloOuro}"/>
</svg>`;
    }
  },

  split_diagonal: {
    fotoRatio: 0.70,
    crop: 'attention',
    gerarSVG: (titulo, hook) => {
      const tituloLinhas = quebrarTituloBalanceado(titulo, 3);
      const fontSize = calcularFontSize(titulo, 48, 36);
      
      return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">
  <defs><filter id="sh"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-opacity="0.35"/></filter></defs>
  <polygon points="0,0 450,0 580,650 0,850" fill="${CORES.verdeVibrante}" opacity="0.95"/>
  <circle cx="520" cy="520" r="80" fill="${CORES.amareloOuro}" opacity="0.9"/>
  <text x="60" y="400" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="${fontSize}" fill="${CORES.branco}" filter="url(#sh)">${tituloLinhas[0]}</text>
  ${tituloLinhas[1] ? `<text x="60" y="460" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="${fontSize}" fill="${CORES.amareloOuro}" filter="url(#sh)">${tituloLinhas[1]}</text>` : ''}
  ${tituloLinhas[2] ? `<text x="60" y="520" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="${Math.max(fontSize - 4, 32)}" fill="${CORES.branco}" filter="url(#sh)">${tituloLinhas[2]}</text>` : ''}
  <text x="60" y="280" font-family="Montserrat,Arial,sans-serif" font-weight="600" font-size="24" fill="${CORES.branco}">${hook.substring(0, 45)}${hook.length > 45 ? '...' : ''}</text>
</svg>`;
    }
  },

  dual_screen: {
    fotoRatio: 0.65,
    crop: 'center',
    gerarSVG: (titulo, hook) => {
      const tituloLinhas = quebrarTituloBalanceado(titulo, 2);
      const fontSize = calcularFontSize(titulo, 42, 32);
      
      return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">
  <defs><filter id="sh"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-opacity="0.35"/></filter></defs>
  <rect x="580" y="0" width="500" height="1080" fill="${CORES.rosaCoral}" opacity="0.9"/>
  <circle cx="580" cy="980" r="70" fill="${CORES.amareloOuro}" opacity="0.85"/>
  <text x="620" y="780" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="${fontSize}" fill="${CORES.amareloOuro}" filter="url(#sh)">${tituloLinhas[0]}</text>
  ${tituloLinhas[1] ? `<text x="620" y="830" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="${Math.max(fontSize - 2, 30)}" fill="${CORES.branco}" filter="url(#sh)">${tituloLinhas[1]}</text>` : ''}
  <text x="620" y="680" font-family="Montserrat,Arial,sans-serif" font-weight="600" font-size="26" fill="${CORES.branco}" filter="url(#sh)">${hook.substring(0, 40)}${hook.length > 40 ? '...' : ''}</text>
  <rect x="620" y="450" width="380" height="80" rx="12" fill="${CORES.amareloOuro}"/>
  <text x="810" y="500" font-family="Montserrat,Arial,sans-serif" font-weight="600" font-size="24" fill="${CORES.verdeProfundo}" text-anchor="middle">Saiba mais</text>
</svg>`;
    }
  }
};

const ESPECIALIDADE_LAYOUTS = {
  fonoaudiologia: 'hero_banner',
  psicologia: 'dual_screen',
  terapia_ocupacional: 'hero_banner',
  fisioterapia: 'hero_banner',
  neuropsicologia: 'dual_screen',
};

/**
 * Extrai título e hook do conteúdo
 * Limita tamanho sem cortar palavras no meio
 */
function extrairTituloHook(postContent, especialidade) {
  const linhas = (postContent || '').split('\n').filter(l => l.trim());
  
  // Título: máx 35 caracteres (cabe em 2 linhas), sem cortar palavras
  let titulo = linhas[0]?.trim() || especialidade?.nome || 'FONO INOVA';
  titulo = titulo.replace(/^["']|["']$/g, '');
  titulo = truncarSemCortarPalavra(titulo, 35);
  
  // Hook: máx 50 caracteres, sem cortar palavras
  let hook = linhas[1]?.trim() || especialidade?.gancho || 'Cuidado especializado';
  hook = hook.replace(/^["']|["']$/g, '');
  hook = truncarSemCortarPalavra(hook, 50);
  
  return { titulo, hook };
}

/**
 * Trunca texto sem cortar palavra no meio
 */
function truncarSemCortarPalavra(texto, limite) {
  if (texto.length <= limite) return texto;
  
  // Encontra o último espaço antes do limite
  const corte = texto.lastIndexOf(' ', limite);
  if (corte === -1) return texto.substring(0, limite); // Sem espaço, corta no limite
  
  return texto.substring(0, corte);
}

/**
 * Gera imagem com branding SVG aplicado
 */
export async function gerarImagemBranded({ fotoUrl, fotoBuffer, titulo, hook, especialidadeId, layoutId, postContent }) {
  const layoutKey = layoutId || ESPECIALIDADE_LAYOUTS[especialidadeId] || 'hero_banner';
  const layout = LAYOUTS[layoutKey];

  let tituloFinal = titulo;
  let hookFinal = hook;
  
  if ((!tituloFinal || !hookFinal) && postContent) {
    const extraido = extrairTituloHook(postContent, { nome: especialidadeId });
    tituloFinal = tituloFinal || extraido.titulo;
    hookFinal = hookFinal || extraido.hook;
  }
  
  tituloFinal = (tituloFinal || 'FONO INOVA').toUpperCase();
  hookFinal = hookFinal || 'Cuidado especializado';

  console.log(`🎨 [v3] ${layoutKey} | ${especialidadeId} | "${tituloFinal.substring(0, 20)}..."`);

  let fotoBuf = fotoBuffer;
  if (!fotoBuf && fotoUrl) {
    console.log(`📥 Download: ${fotoUrl.substring(0, 50)}...`);
    const r = await fetch(fotoUrl, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`Download falhou: ${r.status}`);
    fotoBuf = Buffer.from(await r.arrayBuffer());
    console.log(`📦 ${(fotoBuf.length / 1024).toFixed(1)}KB`);
  }

  let baseImg;
  if (fotoBuf && layout.fotoRatio > 0) {
    baseImg = await sharp(fotoBuf)
      .resize(1080, 1080, { fit: 'cover', position: layout.crop })
      .jpeg({ quality: 95 }).toBuffer();
  } else {
    baseImg = await sharp({create: {width: 1080, height: 1080, channels: 3, background: {r: 244, g: 208, b: 63}}}).jpeg().toBuffer();
  }

  const bandY = Math.round(1080 * (1 - layout.fotoRatio));
  const svg = layout.gerarSVG(tituloFinal, hookFinal, bandY);

  const final = await sharp(baseImg)
    .composite([{ input: Buffer.from(svg), blend: 'over' }])
    .webp({ quality: 95 }).toBuffer();

  const base64 = `data:image/webp;base64,${final.toString('base64')}`;
  const res = await cloudinary.uploader.upload(base64, {
    folder: 'fono-inova/branded-v3',
    public_id: `${especialidadeId}_${layoutKey}_${Date.now()}`,
  });

  console.log(`☁️  Cloudinary: ${res.secure_url.substring(0, 60)}...`);
  return { url: res.secure_url, layout: layoutKey };
}

/**
 * Gera imagem base: fal.ai FLUX → HuggingFace → Pollinations
 */
export async function generateImageForEspecialidade(especialidade, postContent = '') {
  const { titulo } = extrairTituloHook(postContent, especialidade);
  
  const promptBase = `Ultra realistic professional medical photography, Brazilian ${especialidade.nome.toLowerCase()} therapist with child, ${especialidade.foco}, natural skin texture, authentic expressions, bright modern clinic, soft window light, shallow depth of field, documentary style, shot on Sony A7R IV`;

  const errors = [];

  // ═══════════════════════════════════════════════════════════
  // TENTATIVA 1: fal.ai FLUX dev (FOCO PRINCIPAL - mais barato!)
  // ═══════════════════════════════════════════════════════════
  if (process.env.FAL_API_KEY) {
    try {
      console.log('🚀 [1/3] fal.ai FLUX dev...');
      console.log('   Endpoint: fal-ai/flux/dev');
      
      const falRes = await fetch('https://fal.run/fal-ai/flux/dev', {
        method: 'POST',
        headers: {
          'Authorization': `Key ${process.env.FAL_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: promptBase,
          image_size: 'square',  // 1024x1024 para Instagram
          num_inference_steps: 28,
          guidance_scale: 3.5,
          safety_tolerance: '2',
        }),
        signal: AbortSignal.timeout(120000), // 2 minutos
      });

      console.log('   Status:', falRes.status);

      if (falRes.ok) {
        const falData = await falRes.json();
        console.log('   Response:', JSON.stringify(falData).substring(0, 150));
        
        const imgUrl = falData.images?.[0]?.url;
        if (imgUrl) {
          console.log('   Download:', imgUrl.substring(0, 50) + '...');
          const fotoBuf = Buffer.from(await (await fetch(imgUrl, { signal: AbortSignal.timeout(30000) })).arrayBuffer());
          console.log(`✅ FLUX dev: ${(fotoBuf.length/1024).toFixed(1)}KB`);
          return { buffer: fotoBuf, provider: 'fal-flux-dev' };
        } else {
          console.warn('⚠️ fal.ai: Sem URL na resposta');
          errors.push('fal.ai: Sem URL');
        }
      } else if (falRes.status === 403) {
        try {
          const errData = await falRes.json();
          if (errData.detail?.includes('balance') || errData.detail?.includes('locked')) {
            console.warn('⚠️ fal.ai: Saldo esgotado. Recarregue em fal.ai/dashboard');
            errors.push('fal.ai: Saldo esgotado');
          }
        } catch {
          errors.push(`fal.ai ${falRes.status}`);
        }
      } else {
        const err = await falRes.text();
        console.error('❌ fal.ai erro:', falRes.status, err.substring(0, 200));
        errors.push(`fal.ai ${falRes.status}: ${err.substring(0, 100)}`);
      }
    } catch (e) {
      console.error('❌ fal.ai exception:', e.message);
      errors.push(`fal.ai: ${e.message}`);
    }
  } else {
    console.log('⏭️  [1/4] FAL_API_KEY não configurada');
  }

  // ═══════════════════════════════════════════════════════════
  // TENTATIVA 2: HuggingFace FLUX.1-dev (fallback)
  // ═══════════════════════════════════════════════════════════
  if (process.env.HUGGINGFACE_API_KEY) {
    try {
      console.log('🔄 [2/3] HuggingFace FLUX.1-dev...');
      const response = await fetch(
        'https://router.huggingface.co/black-forest-labs/FLUX.1-dev',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            inputs: promptBase,
            parameters: { width: 1024, height: 1024, num_inference_steps: 28, guidance_scale: 3.5 }
          }),
          signal: AbortSignal.timeout(90000),
        }
      );

      if (response.ok) {
        const fotoBuf = Buffer.from(await response.arrayBuffer());
        console.log(`✅ HuggingFace: ${(fotoBuf.length/1024).toFixed(1)}KB`);
        return { buffer: fotoBuf, provider: 'hf-flux-dev' };
      } else {
        const err = await response.text();
        errors.push(`HF ${response.status}: ${err.substring(0, 100)}`);
      }
    } catch (e) {
      errors.push(`HF: ${e.message}`);
    }
  } else {
    console.log('⏭️  [2/4] HUGGINGFACE_API_KEY não configurada');
  }

  // ═══════════════════════════════════════════════════════════
  // TENTATIVA 3: Replicate (se tiver token)
  // ═══════════════════════════════════════════════════════════
  if (process.env.REPLICATE_API_TOKEN) {
    try {
      console.log('🚀 [3/4] Replicate FLUX...');
      
      const response = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: {
          'Authorization': `Token ${process.env.REPLICATE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          version: 'black-forest-labs/flux-schnell',
          input: {
            prompt: promptBase,
            aspect_ratio: '1:1',
            output_format: 'png',
            output_quality: 80,
          }
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (response.ok) {
        const prediction = await response.json();
        // Polling
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
          console.log(`✅ Replicate: ${(fotoBuf.length/1024).toFixed(1)}KB`);
          return { buffer: fotoBuf, provider: 'replicate-flux' };
        }
      }
    } catch (e) {
      errors.push(`Replicate: ${e.message}`);
    }
  } else {
    console.log('⏭️  [3/4] REPLICATE_API_TOKEN não configurado');
  }

  // ═══════════════════════════════════════════════════════════
  // TENTATIVA 4: Pollinations (último recurso - sempre gratuito)
  // ═══════════════════════════════════════════════════════════
  const delay = ms => new Promise(r => setTimeout(r, ms));
  
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`🔄 [4/4] Pollinations (tentativa ${attempt}/3)...`);
      const encoded = encodeURIComponent(promptBase);
      const seed = Math.floor(Math.random() * 999999);
      const model = attempt === 1 ? 'flux' : attempt === 2 ? 'turbo' : 'default';
      const pollUrl = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&seed=${seed}&nologo=true&model=${model}`;
      
      const res = await fetch(pollUrl, { 
        signal: AbortSignal.timeout(90000),
        headers: { 'Accept': 'image/*' }
      });
      
      if (res.ok) {
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('image')) {
          throw new Error(`Invalid content-type: ${contentType}`);
        }
        const fotoBuf = Buffer.from(await res.arrayBuffer());
        if (fotoBuf.length < 1024) throw new Error('Image too small');
        
        console.log(`✅ Pollinations: ${(fotoBuf.length/1024).toFixed(1)}KB`);
        return { buffer: fotoBuf, provider: `pollinations-${model}` };
      } else {
        const status = res.status;
        errors.push(`Pollinations ${status} (tentativa ${attempt})`);
        if ((status >= 500 || status === 429) && attempt < 3) {
          console.log(`   ⏳ Retry em ${attempt * 2}s...`);
          await delay(attempt * 2000);
          continue;
        }
      }
    } catch (e) {
      errors.push(`Pollinations: ${e.message}`);
      if (attempt < 3) await delay(attempt * 2000);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // FALHOU TUDO - Último recurso: URL direta do Pollinations
  // ═══════════════════════════════════════════════════════════
  console.error('❌ Todas as fontes falharam:');
  errors.forEach(e => console.error(`   • ${e}`));
  
  // Fallback: retorna URL direta do Pollinations (pode funcionar no frontend)
  console.log('🔄 Fallback final: URL direta do Pollinations...');
  const directUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(promptBase)}?width=1024&height=1024&seed=${Date.now()}&nologo=true`;
  console.log('⚠️ URL direta gerada (pode não carregar):', directUrl.substring(0, 60) + '...');
  
  // Tenta fazer download da URL direta
  try {
    const res = await fetch(directUrl, { signal: AbortSignal.timeout(60000) });
    if (res.ok) {
      const fotoBuf = Buffer.from(await res.arrayBuffer());
      if (fotoBuf.length > 1024) {
        console.log(`✅ Pollinations direto: ${(fotoBuf.length/1024).toFixed(1)}KB`);
        return { buffer: fotoBuf, provider: 'pollinations-direct' };
      }
    }
  } catch (e) {
    console.warn('⚠️ Download direto falhou:', e.message);
  }
  
  throw new Error(`Image generation failed: ${errors.join('; ')}`);
}

/**
 * Fluxo completo: gera imagem + aplica branding
 */
export async function gerarPostCompleto(especialidade, postContent, especialidadeId) {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('🎯 GERAR POST COMPLETO');
  console.log(`   Especialidade: ${especialidade?.nome || especialidadeId}`);
  console.log(`   Content: "${postContent?.substring(0, 40)}..."`);
  console.log('═══════════════════════════════════════════════════════\n');

  const start = Date.now();
  
  // 1. Gera imagem base
  const { buffer, provider } = await generateImageForEspecialidade(especialidade, postContent);
  console.log(`📸 Provider: ${provider}`);

  // 2. Aplica branding
  const resultado = await gerarImagemBranded({
    fotoBuffer: buffer,
    especialidadeId,
    postContent
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n✅ Completo em ${elapsed}s`);
  console.log(`   URL: ${resultado.url.substring(0, 70)}...`);
  console.log('═══════════════════════════════════════════════════════\n');

  return { ...resultado, provider, tempo: `${elapsed}s` };
}

export { LAYOUTS, ESPECIALIDADE_LAYOUTS, CORES };
export default { gerarImagemBranded, generateImageForEspecialidade, gerarPostCompleto, LAYOUTS, ESPECIALIDADE_LAYOUTS };
