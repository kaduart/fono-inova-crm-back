/**
 * Brand Image Service v3 - Fono Inova
 * Sistema Visual Profissional: fal.ai FLUX → HuggingFace → Pollinations
 * SEM DALL-E, SEM Groq - só FLUX real
 */

import sharp from 'sharp';
import { v2 as cloudinary } from 'cloudinary';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __dir = dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = join(__dir, '../dist/images/logo-completa.png');

// ═══════════════════════════════════════════════════════════
// Carrega JSON com os 15 layouts
// ═══════════════════════════════════════════════════════════
const JSON_PATH = join(process.cwd(), 'data', 'formatos_fono_inova.json');
let LAYOUTS_JSON = [];
try {
  LAYOUTS_JSON = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  console.log(`✅ ${LAYOUTS_JSON.length} layouts carregados do JSON`);
} catch (e) {
  console.error('❌ Erro ao carregar JSON de layouts:', e.message);
  LAYOUTS_JSON = [];
}

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
  // ═══════════════════════════════════════════════════════════
  // LAYOUT 1: Curva Superior com Losango (IGUAL AO PRINT)
  // Foto 40% topo, curva verde começa do lado esquerdo
  // ═══════════════════════════════════════════════════════════
curva_superior_losango: {
  fotoRatio: 0.27,  // Verde ocupa apenas os ~27% finais da imagem (foto domina)
  crop: 'top',      // Garante que pega o topo da imagem (rostos)
  gerarSVG: (titulo, hook, bandY) => {
    const tituloLinhas = quebrarTituloBalanceado(titulo, 2);
    const fontSize = calcularFontSize(titulo, 52, 40);

    // bandY = 1080 * (1 - 0.27) = ~789px (verde fica apenas no final)
    const yV = bandY;
    const yCurva = yV - 35; // Curva gentil, quase reta

    return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">
  <defs>
    <filter id="sh"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.45"/></filter>
  </defs>

  <!-- ACENTO DE CANTO: triângulo amarelo no topo-direito (marca geométrica limpa) -->
  <path d="M1080,0 L730,0 L1080,350 Z" fill="${CORES.amareloOuro}" opacity="0.92"/>

  <!-- FAIXA VERDE: curva gentil, concentrada no final da imagem -->
  <path d="M0,${yV} C360,${yCurva} 720,${yCurva+10} 1080,${yV} L1080,1080 L0,1080 Z"
        fill="${CORES.verdeProfundo}"/>

  <!-- LOSANGO GEOMÉTRICO: pequeno, sharp, dentro da faixa verde (não invade a foto) -->
  <path d="M64,${yV+54} L100,${yV+22} L136,${yV+54} L100,${yV+86} Z"
        fill="${CORES.lilas}" opacity="0.95"/>

  <!-- LINHA ACENTO: separa losango do título -->
  <rect x="152" y="${yV+48}" width="3" height="28" rx="1.5" fill="${CORES.amareloOuro}" opacity="0.8"/>

  <!-- TÍTULO -->
  <text x="168" y="${yV + 72}"
        font-family="Montserrat,Arial Black,sans-serif"
        font-weight="900"
        font-size="${fontSize}"
        fill="${CORES.branco}"
        filter="url(#sh)">${tituloLinhas[0].toUpperCase()}</text>

  ${tituloLinhas[1] ? `
  <text x="168" y="${yV + 72 + Math.round(fontSize * 1.15)}"
        font-family="Montserrat,Arial Black,sans-serif"
        font-weight="900"
        font-size="${fontSize}"
        fill="${CORES.branco}"
        filter="url(#sh)">${tituloLinhas[1].toUpperCase()}</text>
  ` : ''}

  <!-- SUBTÍTULO -->
  <text x="168" y="${yV + 72 + Math.round(fontSize * 1.15) + Math.round(fontSize * 1.15) + 10}"
        font-family="Montserrat,Arial,sans-serif"
        font-weight="400"
        font-size="24"
        fill="#D4ECD8">${hook.substring(0, 62)}${hook.length > 62 ? '...' : ''}</text>

  <!-- LINHA AMARELA DECORATIVA -->
  <rect x="168" y="${yV + 72 + Math.round(fontSize * 1.15) + Math.round(fontSize * 1.15) + 28}" width="120" height="3" rx="1.5" fill="${CORES.amareloOuro}" opacity="0.9"/>
</svg>`;
  }
},

  // ═══════════════════════════════════════════════════════════
  // LAYOUT 2: Banner Clássico com MAIS losangos (versão melhorada)
  // ═══════════════════════════════════════════════════════════
  hero_banner: {
    fotoRatio: 0.30,  // Verde ocupa apenas 30% no final
    crop: 'entropy',
    gerarSVG: (titulo, hook, bandY) => {
      const tituloLinhas = quebrarTituloBalanceado(titulo, 2);
      const fontSize = calcularFontSize(titulo, 52, 40);

      return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">
  <defs>
    <filter id="sh"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-opacity="0.35"/></filter>
    <linearGradient id="bg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="${CORES.verdeProfundo}"/>
      <stop offset="100%" stop-color="${CORES.verdeVibrante}"/>
    </linearGradient>
  </defs>

  <!-- ACENTO CANTO SUPERIOR ESQUERDO: corte angular lilás -->
  <path d="M0,0 L320,0 L0,280 Z" fill="${CORES.lilas}" opacity="0.80"/>

  <!-- ACENTO CANTO SUPERIOR DIREITO: triângulo amarelo menor -->
  <path d="M1080,0 L820,0 L1080,220 Z" fill="${CORES.amareloOuro}" opacity="0.90"/>

  <!-- FAIXA VERDE: gradiente, curva suave -->
  <path d="M0,${bandY} Q540,${bandY-40} 1080,${bandY} L1080,1080 L0,1080 Z" fill="url(#bg)"/>

  <!-- LOSANGO GEOMÉTRICO SHARP: marca de canto na faixa verde (lado direito) -->
  <path d="M${1080-20},${bandY+50} L${1080-58},${bandY+22} L${1080-96},${bandY+50} L${1080-58},${bandY+78} Z"
        fill="${CORES.amareloOuro}" opacity="0.90"/>

  <text x="70" y="${bandY+82}" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="${fontSize}" fill="${CORES.branco}" filter="url(#sh)">${tituloLinhas[0].toUpperCase()}</text>
  ${tituloLinhas[1] ? `<text x="70" y="${bandY+82+Math.round(fontSize*1.15)}" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="${fontSize}" fill="${CORES.branco}" filter="url(#sh)">${tituloLinhas[1].toUpperCase()}</text>` : ''}
  <text x="70" y="${bandY+82+Math.round(fontSize*1.15)+Math.round(fontSize*1.15)+14}" font-family="Montserrat,Arial,sans-serif" font-weight="400" font-size="24" fill="#D4ECD8">${hook.substring(0, 58)}</text>
  <rect x="70" y="${bandY+82+Math.round(fontSize*1.15)+Math.round(fontSize*1.15)+36}" width="120" height="3" rx="1.5" fill="${CORES.amareloOuro}"/>
</svg>`;
    }
  },

  // ═══════════════════════════════════════════════════════════
  // LAYOUT 3: Split Diagonal com losangos laterais
  // ═══════════════════════════════════════════════════════════
  split_diagonal: {
    fotoRatio: 0.65,
    crop: 'attention',
    gerarSVG: (titulo, hook) => {
      const tituloLinhas = quebrarTituloBalanceado(titulo, 3);
      const fontSize = calcularFontSize(titulo, 48, 36);
      
      return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">
  <defs><filter id="sh"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-opacity="0.35"/></filter></defs>
  
  <!-- Polígono verde diagonal -->
  <polygon points="0,0 480,0 620,700 0,900" fill="${CORES.verdeVibrante}" opacity="0.95"/>
  
  <!-- Losango amarelo central -->
  <circle cx="550" cy="550" r="90" fill="${CORES.amareloOuro}" opacity="0.9"/>
  <path d="M550,470 L630,550 L550,630 L470,550 Z" fill="${CORES.amareloOuro}" opacity="0.7"/>
  
  <!-- Losango lilás decorativo -->
  <ellipse cx="900" cy="200" rx="120" ry="80" fill="${CORES.lilas}" opacity="0.6" transform="rotate(-20 900 200)"/>
  
  <!-- Losango rosa inferior -->
  <path d="M800,800 L950,750 L1000,900 L850,950 Z" fill="${CORES.rosaCoral}" opacity="0.5"/>
  
  <text x="60" y="420" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="${fontSize}" fill="${CORES.branco}" filter="url(#sh)">${tituloLinhas[0]}</text>
  ${tituloLinhas[1] ? `<text x="60" y="480" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="${fontSize}" fill="${CORES.amareloOuro}" filter="url(#sh)">${tituloLinhas[1]}</text>` : ''}
  ${tituloLinhas[2] ? `<text x="60" y="540" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="${Math.max(fontSize - 4, 32)}" fill="${CORES.branco}" filter="url(#sh)">${tituloLinhas[2]}</text>` : ''}
  <text x="60" y="300" font-family="Montserrat,Arial,sans-serif" font-weight="600" font-size="24" fill="${CORES.branco}">${hook.substring(0, 45)}</text>
</svg>`;
    }
  },

  // ═══════════════════════════════════════════════════════════
  // LAYOUT 4: Dual Screen melhorado (mais formas)
  // ═══════════════════════════════════════════════════════════
  dual_screen: {
    fotoRatio: 0.60,
    crop: 'center',
    gerarSVG: (titulo, hook) => {
      const tituloLinhas = quebrarTituloBalanceado(titulo, 2);
      const fontSize = calcularFontSize(titulo, 44, 34);
      
      return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">
  <defs><filter id="sh"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-opacity="0.35"/></filter></defs>
  
  <!-- Metade rosa -->
  <rect x="540" y="0" width="540" height="1080" fill="${CORES.rosaCoral}" opacity="0.9"/>
  
  <!-- Losango amarelo inferior -->
  <circle cx="580" cy="980" r="80" fill="${CORES.amareloOuro}" opacity="0.85"/>
  <path d="M540,980 L620,900 L700,980 L620,1060 Z" fill="${CORES.amareloOuro}" opacity="0.6"/>
  
  <!-- Losango lilás topo -->
  <ellipse cx="850" cy="180" rx="110" ry="70" fill="${CORES.lilas}" opacity="0.7" transform="rotate(25 850 180)"/>
  
  <!-- Forma verde decorativa -->
  <path d="M540,400 Q650,350 750,450 T850,600" fill="none" stroke="${CORES.verdeProfundo}" stroke-width="40" opacity="0.3"/>
  
  <text x="580" y="800" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="${fontSize}" fill="${CORES.amareloOuro}" filter="url(#sh)">${tituloLinhas[0]}</text>
  ${tituloLinhas[1] ? `<text x="580" y="855" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="${Math.max(fontSize - 2, 30)}" fill="${CORES.branco}" filter="url(#sh)">${tituloLinhas[1]}</text>` : ''}
  <text x="580" y="700" font-family="Montserrat,Arial,sans-serif" font-weight="600" font-size="26" fill="${CORES.branco}" filter="url(#sh)">${hook.substring(0, 40)}</text>
  <rect x="580" y="580" width="380" height="70" rx="12" fill="${CORES.amareloOuro}"/>
  <text x="770" y="625" font-family="Montserrat,Arial,sans-serif" font-weight="600" font-size="24" fill="${CORES.verdeProfundo}" text-anchor="middle">Saiba mais</text>
</svg>`;
    }
  },

  // ═══════════════════════════════════════════════════════════
  // LAYOUT 5: Losango Central (novo - foco no X comparativo)
  // ═══════════════════════════════════════════════════════════
  losango_central: {
    fotoRatio: 0.55,
    crop: 'center',
    gerarSVG: (titulo, hook) => {
      const partes = titulo.split('X');
      const txt1 = (partes[0] || '').trim().substring(0, 20);
      const txt2 = (partes[1] || '').trim().substring(0, 20);
      
      return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">
  <defs><filter id="sh"><feDropShadow dx="0" dy="4" stdDeviation="5" flood-opacity="0.4"/></filter></defs>
  
  <!-- Fundo verde base -->
  <rect x="0" y="600" width="1080" height="480" fill="${CORES.verdeProfundo}"/>
  
  <!-- Losango amarelo gigante central (diamante) -->
  <path d="M540,450 L750,650 L540,850 L330,650 Z" fill="${CORES.amareloOuro}" opacity="0.95"/>
  
  <!-- X no centro -->
  <text x="540" y="685" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="120" fill="${CORES.verdeProfundo}" text-anchor="middle" filter="url(#sh)">X</text>
  
  <!-- Losango lilás esquerda -->
  <path d="M100,600 L250,500 L400,600 L250,700 Z" fill="${CORES.lilas}" opacity="0.7"/>
  
  <!-- Losango rosa direita -->
  <path d="M680,600 L830,500 L980,600 L830,700 Z" fill="${CORES.rosaCoral}" opacity="0.7"/>
  
  <!-- Textos -->
  <text x="250" y="620" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="42" fill="${CORES.branco}" text-anchor="middle" filter="url(#sh)">${txt1 || 'ATRASO'}</text>
  <text x="830" y="620" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="42" fill="${CORES.branco}" text-anchor="middle" filter="url(#sh)">${txt2 || 'TRANSTORNO'}</text>
  
  <text x="540" y="920" font-family="Montserrat,Arial,sans-serif" font-weight="500" font-size="28" fill="${CORES.branco}" text-anchor="middle">${hook.substring(0, 50)}</text>
  <rect x="470" y="960" width="140" height="4" rx="2" fill="${CORES.amareloOuro}"/>
</svg>`;
    }
  }
};

// Mapeamento atualizado
const ESPECIALIDADE_LAYOUTS = {
  fonoaudiologia: 'curva_superior_losango',  // Agora usa o layout do print
  psicologia: 'dual_screen',
  terapia_ocupacional: 'hero_banner',
  fisioterapia: 'hero_banner',
  neuropsicologia: 'dual_screen',
  default: 'curva_superior_losango'
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

// ═══════════════════════════════════════════════════════════
// LAYOUT ENGINE INTELIGENTE (usa o JSON)
// ═══════════════════════════════════════════════════════════

class LayoutEngineJSON {
  constructor() {
    this.historico = []; // IDs dos últimos 3 layouts usados
  }

  selecionarLayout(dados) {
    const {
      especialidadeId,
      categoria = null,
      conteudo = '',
      tipoImagem = 'foto_real',
      preferenciaManual = null
    } = dados;

    console.log('🧠 Analisando melhor layout via JSON...');

    if (preferenciaManual) {
      const layout = LAYOUTS_JSON.find(l => l.id === preferenciaManual);
      if (layout) { this.registrarUso(layout.id); return layout; }
    }

    let candidatos = LAYOUTS_JSON.filter(layout => {
      const matchEspecialidade = layout.uso.includes(especialidadeId) ||
                                 layout.uso.includes('posts_gerais');
      const matchCategoria = categoria ? layout.categoria === categoria : true;
      const matchTipo = tipoImagem === 'foto_real'
        ? layout.specs.foto_ratio > 0
        : layout.specs.is_illustration || layout.specs.foto_ratio === 0;
      return matchEspecialidade && matchCategoria && matchTipo;
    });

    if (candidatos.length === 0) {
      candidatos = LAYOUTS_JSON.filter(l =>
        l.categoria === 'institucional' || l.uso.includes('posts_gerais')
      );
    }

    const disponiveis = candidatos.filter(l => !this.historico.includes(l.id));
    const pool = disponiveis.length > 0 ? disponiveis : candidatos;

    const scored = pool.map(layout => {
      let score = layout.frequencia === 'alta' ? 10 : layout.frequencia === 'media' ? 7 : 5;
      if (conteudo) {
        const keywords = layout.aesthetic_dna.key_visual_tokens;
        const matches = keywords.filter(k =>
          conteudo.toLowerCase().includes(k.toLowerCase())
        ).length;
        score += matches * 2;
      }
      const idxHistorico = this.historico.indexOf(layout.id);
      if (idxHistorico !== -1) score -= (3 - idxHistorico) * 2;
      return { layout, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const escolhido = scored[0].layout;
    console.log(`✅ JSON Layout: ${escolhido.nome} (${escolhido.id}) | Score: ${scored[0].score}`);
    this.registrarUso(escolhido.id);
    return escolhido;
  }

  registrarUso(layoutId) {
    this.historico.unshift(layoutId);
    if (this.historico.length > 3) this.historico.pop();
    console.log('📊 Histórico:', this.historico);
  }
}

const layoutEngine = new LayoutEngineJSON();

// ═══════════════════════════════════════════════════════════
// GERADOR DE SVG DINÂMICO (baseado nas specs do JSON)
// ═══════════════════════════════════════════════════════════

class SVGGenerator {
  static gerar(layout, titulo, subtitulo) {
    const specs = layout.layout_specs;
    const cores = layout.aesthetic_dna.dominant_colors_hex;

    if (layout.id.includes('curva') || layout.id.includes('hero')) {
      return this.gerarCurvaSuperior(specs, cores, titulo, subtitulo);
    }
    if (layout.id.includes('dual') || layout.id.includes('ansiedade')) {
      return this.gerarDualScreen(specs, cores, titulo, subtitulo);
    }
    if (layout.id.includes('comparativo') || layout.id.includes('split')) {
      return this.gerarComparativo(specs, cores, titulo, subtitulo);
    }
    if (layout.id.includes('checklist')) {
      return this.gerarChecklist(specs, cores, titulo, subtitulo);
    }
    if (layout.id.includes('data')) {
      return this.gerarDataComemorativa(specs, cores, titulo, subtitulo);
    }
    if (layout.specs.is_illustration) {
      return this.gerarIlustracao(specs, cores, titulo, subtitulo);
    }
    return this.gerarCurvaSuperior(specs, cores, titulo, subtitulo);
  }

  static gerarCurvaSuperior(specs, cores, titulo, subtitulo) {
    const yInicio = Math.round(1080 * (1 - specs.foto_ratio));
    const fontSize = titulo.length > 25 ? 50 : 60;
    const tituloLinhas = this.quebrarTitulo(titulo, 2);
    const corAcento = cores[2] || '#F4D03F';
    const corDiamond = cores[3] || '#C39BD3';

    // Acentos de canto: gerados a partir dos elements do JSON
    let cornerAccents = '';
    (specs.elements || []).forEach(el => {
      if (el.type === 'path' && el.pos === 'top_right') {
        cornerAccents += `<path d="M1080,0 L720,0 L1080,360 Z" fill="${el.color}" opacity="0.92"/>`;
      }
      if (el.type === 'path' && el.pos.includes('bottom_left')) {
        // Losango sharp pequeno dentro da faixa, não invade a foto
        cornerAccents += `<path d="M60,${yInicio+52} L98,${yInicio+20} L136,${yInicio+52} L98,${yInicio+84} Z" fill="${el.color}" opacity="0.92"/>`;
      }
    });

    return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">
  <defs>
    <filter id="sh"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.4"/></filter>
    <linearGradient id="grad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="${cores[0]}"/>
      <stop offset="100%" stop-color="${cores[1] || '#0E2E20'}"/>
    </linearGradient>
  </defs>
  ${cornerAccents}
  <!-- Faixa verde: curva gentil, fica no final da imagem -->
  <path d="M0,${yInicio} C360,${yInicio-32} 720,${yInicio-22} 1080,${yInicio} L1080,1080 L0,1080 Z" fill="url(#grad)"/>
  <!-- Losango geométrico no canto inferior se não vier do JSON -->
  ${(specs.elements || []).length === 0 ? `<path d="M60,${yInicio+52} L98,${yInicio+20} L136,${yInicio+52} L98,${yInicio+84} Z" fill="${corDiamond}" opacity="0.90"/>` : ''}
  <!-- Linha vertical separadora: losango → título -->
  <rect x="152" y="${yInicio+45}" width="3" height="30" rx="1.5" fill="${corAcento}" opacity="0.75"/>
  <text x="168" y="${yInicio + 80}" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="${fontSize}" fill="#FFF" filter="url(#sh)">${tituloLinhas[0].toUpperCase()}</text>
  ${tituloLinhas[1] ? `<text x="168" y="${yInicio + 80 + Math.round(fontSize * 1.15)}" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="${fontSize}" fill="#FFF" filter="url(#sh)">${tituloLinhas[1].toUpperCase()}</text>` : ''}
  <text x="168" y="${yInicio + 80 + Math.round(fontSize * 1.15) * 2 + 12}" font-family="Montserrat,Arial,sans-serif" font-size="24" fill="#D4ECD8">${subtitulo.substring(0, 60)}</text>
  <rect x="168" y="${yInicio + 80 + Math.round(fontSize * 1.15) * 2 + 32}" width="120" height="3" rx="1.5" fill="${corAcento}"/>
</svg>`;
  }

  static gerarDualScreen(specs, cores, titulo, subtitulo) {
    const ySplit = Math.round(1080 * (1 - specs.foto_ratio));
    const tituloLinhas = this.quebrarTitulo(titulo, 2);

    return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">
  <rect x="540" y="0" width="540" height="1080" fill="${cores[0]}" opacity="0.9"/>
  <circle cx="540" cy="${ySplit + 80}" r="70" fill="${cores[2]}" opacity="0.85"/>
  <ellipse cx="850" cy="200" rx="100" ry="70" fill="${cores[3]}" opacity="0.6" transform="rotate(20 850 200)"/>
  <text x="580" y="800" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="48" fill="${cores[2]}">${tituloLinhas[0]}</text>
  ${tituloLinhas[1] ? `<text x="580" y="860" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="44" fill="#FFF">${tituloLinhas[1]}</text>` : ''}
  <text x="580" y="700" font-family="Montserrat,Arial,sans-serif" font-size="26" fill="#FFF">${subtitulo.substring(0, 40)}</text>
</svg>`;
  }

  static gerarComparativo(_specs, cores, titulo, subtitulo) {
    const partes = titulo.split(/[Xx]|vs|VS/).map(s => s.trim());
    const txt1 = (partes[0] || 'ATRASO').substring(0, 10).toUpperCase();
    const txt2 = (partes[1] || 'FALA').substring(0, 10).toUpperCase();

    return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">
  <rect width="1080" height="1080" fill="${cores[0]}"/>
  <path d="M540,350 L720,540 L540,730 L360,540 Z" fill="${cores[2]}" opacity="0.95"/>
  <text x="540" y="570" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="100" fill="${cores[0]}" text-anchor="middle">X</text>
  <text x="200" y="540" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="48" fill="#FFF" text-anchor="middle">${txt1}</text>
  <text x="880" y="540" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="48" fill="#FFF" text-anchor="middle">${txt2}</text>
  <ellipse cx="150" cy="800" rx="80" ry="60" fill="${cores[3]}" opacity="0.5"/>
  <ellipse cx="930" cy="250" rx="60" ry="40" fill="${cores[3]}" opacity="0.4"/>
  <text x="540" y="900" font-family="Montserrat,Arial,sans-serif" font-size="28" fill="#FFF" text-anchor="middle">${subtitulo.substring(0, 50)}</text>
</svg>`;
  }

  static gerarChecklist(specs, cores, titulo, _subtitulo) {
    const yStart = Math.round(1080 * (1 - specs.foto_ratio));

    return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">
  <rect x="0" y="${yStart}" width="1080" height="${1080 - yStart}" fill="${cores[0]}"/>
  <rect x="60" y="${yStart + 60}" width="440" height="280" rx="15" fill="#E8F5E9" opacity="0.95"/>
  <rect x="580" y="${yStart + 60}" width="440" height="280" rx="15" fill="#FFEBEE" opacity="0.95"/>
  <text x="280" y="${yStart + 110}" font-family="Montserrat,Arial Black,sans-serif" font-size="32" fill="${cores[0]}" text-anchor="middle">✓ O QUE ESPERAR</text>
  <text x="800" y="${yStart + 110}" font-family="Montserrat,Arial Black,sans-serif" font-size="32" fill="#D32F2F" text-anchor="middle">⚠ SINAIS ALERTA</text>
  <text x="540" y="${yStart + 450}" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="48" fill="#FFF" text-anchor="middle">${titulo.toUpperCase()}</text>
  <path d="M50,${yStart - 50} L150,${yStart - 150} L250,${yStart - 50}" fill="${cores[3]}" opacity="0.7"/>
</svg>`;
  }

  static gerarDataComemorativa(specs, cores, titulo, subtitulo) {
    const yStart = Math.round(1080 * (1 - specs.foto_ratio));
    const numero = titulo.match(/\d+/)?.[0] || '12';

    return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">
  <rect x="0" y="${yStart}" width="1080" height="${1080 - yStart}" fill="${cores[1] || '#F4D03F'}"/>
  <text x="100" y="${yStart - 30}" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="140" fill="${cores[0]}">${numero}</text>
  <text x="100" y="${yStart + 60}" font-family="Montserrat,Arial Black,sans-serif" font-size="52" fill="${cores[0]}">${titulo.replace(/\d+/, '').trim().toUpperCase()}</text>
  <text x="100" y="${yStart + 120}" font-family="Montserrat,Arial,sans-serif" font-size="28" fill="${cores[0]}">${subtitulo}</text>
  <circle cx="900" cy="${yStart + 100}" r="70" fill="${cores[3]}" opacity="0.6"/>
</svg>`;
  }

  static gerarIlustracao(_specs, cores, titulo, subtitulo) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">
  <rect width="1080" height="1080" fill="${cores[1] || '#F4D03F'}" opacity="0.3"/>
  <circle cx="540" cy="540" r="250" fill="${cores[0]}" opacity="0.2"/>
  <text x="540" y="900" font-family="Montserrat,Arial Black,sans-serif" font-weight="900" font-size="56" fill="${cores[0]}" text-anchor="middle">${titulo}</text>
  <text x="540" y="960" font-family="Montserrat,Arial,sans-serif" font-size="28" fill="${cores[0]}" text-anchor="middle">${subtitulo}</text>
  <ellipse cx="200" cy="200" rx="100" ry="80" fill="${cores[3]}" opacity="0.6"/>
  <ellipse cx="880" cy="800" rx="120" ry="90" fill="${cores[2]}" opacity="0.5"/>
</svg>`;
  }

  static quebrarTitulo(titulo, _maxLinhas) {
    const palavras = titulo.split(' ');
    const meio = Math.ceil(palavras.length / 2);
    return [
      palavras.slice(0, meio).join(' '),
      palavras.slice(meio).join(' ')
    ].filter(Boolean);
  }
}

// ═══════════════════════════════════════════════════════════
// FUNÇÃO PRINCIPAL COM JSON + ENGINE INTELIGENTE
// ═══════════════════════════════════════════════════════════

export async function gerarImagemBrandedJSON({
  fotoBuffer,
  titulo,
  subtitulo = '',
  especialidadeId,
  layoutIdManual = null,
  categoriaManual = null,
  postContent = ''
}) {
  // Extrai título/subtítulo do conteúdo se não fornecidos
  if ((!titulo || !subtitulo) && postContent) {
    const extraido = extrairTituloHook(postContent, { nome: especialidadeId });
    titulo = titulo || extraido.titulo;
    subtitulo = subtitulo || extraido.hook;
  }
  titulo = (titulo || 'FONO INOVA').toUpperCase();
  subtitulo = subtitulo || 'Cuidado especializado';

  // Seleciona layout via engine JSON
  const layout = layoutEngine.selecionarLayout({
    especialidadeId,
    categoria: categoriaManual,
    preferenciaManual: layoutIdManual,
    conteudo: `${titulo} ${subtitulo} ${postContent}`,
    tipoImagem: fotoBuffer ? 'foto_real' : 'ilustracao'
  });

  console.log(`🎨 [JSON] ${layout.nome} | foto: ${layout.specs.foto_ratio * 100}% | crop: ${layout.specs.crop}`);

  // Processa imagem conforme specs do JSON
  let baseImg;
  if (fotoBuffer && layout.specs.foto_ratio > 0) {
    baseImg = await sharp(fotoBuffer)
      .resize(1080, 1080, { fit: 'cover', position: layout.specs.crop || 'center' })
      .jpeg({ quality: 95 })
      .toBuffer();
  } else {
    const corFundo = layout.aesthetic_dna.dominant_colors_hex[0];
    const rgb = hexToRgb(corFundo);
    baseImg = await sharp({
      create: { width: 1080, height: 1080, channels: 3, background: rgb }
    }).jpeg().toBuffer();
  }

  // Gera SVG dinâmico baseado no JSON
  const svg = SVGGenerator.gerar(layout, titulo, subtitulo);

  const final = await sharp(baseImg)
    .composite([{ input: Buffer.from(svg), blend: 'over' }])
    .webp({ quality: 95 })
    .toBuffer();

  const base64 = `data:image/webp;base64,${final.toString('base64')}`;
  const res = await cloudinary.uploader.upload(base64, {
    folder: 'fono-inova/json-layouts',
    public_id: `${especialidadeId}_${layout.id}_${Date.now()}`,
  });

  console.log(`☁️  Cloudinary: ${res.secure_url.substring(0, 60)}...`);
  return {
    url: res.secure_url,
    layout: layout.id,
    layoutNome: layout.nome,
    categoria: layout.categoria,
    fotoRatio: layout.specs.foto_ratio
  };
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
    : { r: 26, g: 77, b: 58 };
}

export { LAYOUTS, ESPECIALIDADE_LAYOUTS, CORES, LAYOUTS_JSON, layoutEngine, SVGGenerator };
export default { gerarImagemBranded, gerarImagemBrandedJSON, generateImageForEspecialidade, gerarPostCompleto, LAYOUTS, ESPECIALIDADE_LAYOUTS };
