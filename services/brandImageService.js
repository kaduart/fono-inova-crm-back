/**
 * 🎨 Brand Image Service — Identidade Visual Fono Inova
 *
 * Layout profissional estilo social media:
 * ┌────────────────────────────────────┐
 * │   FOTO LIMPA (sem overlay)         │  57% — sujeito visível
 * │                                    │
 * ╰────── curva orgânica ──────────────╯  transição suave
 * │  ESPECIALIDADE (grande, bold)      │  43% banda verde degradê
 * │  Hook / subtítulo                  │
 * │  ──────   [LOGO REAL]              │
 * └────────────────────────────────────┘
 *
 * Blobs: formas orgânicas SVG (não círculos) — estilo dos posts reais
 */

import sharp from 'sharp';
import { v2 as cloudinary } from 'cloudinary';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir    = dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = join(__dir, '../dist/images/logo-completa.png');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ─── Cor da banda e acento ───────────────────────────────────────────────────
const ACCENT     = '#FFD166';
const TEXT_WHITE = '#FFFFFF';

// ─── Templates — blobs GRANDES e orgânicos (amoeba/nuvem, não círculos) ─────
// Formas com curvas côncavo-convexas alternadas — estilo Instagram editorial
const TEMPLATES = [
  {
    id: 'A',
    bandStart: '#1F6B57', bandEnd: '#0E2E20',
    blobs: [
      // MEGA blob amarelo topo-direita — amoeba com borda irregular ondulada
      {
        d: 'M1080,0 L565,0 C648,10 758,-18 795,82 C830,175 755,258 812,362 C848,428 960,402 998,508 C1018,562 975,628 1080,628 Z',
        fill: '#FFD166', op: 0.93,
      },
      // Blob lilás esquerda — grande, cruza a transição foto/banda
      {
        d: 'M0,330 C105,295 182,362 168,488 C155,595 60,622 98,735 C124,814 65,882 0,868 Z',
        fill: '#C9B8E8', op: 0.88,
      },
      // Blob rosa direita — acento na banda
      {
        d: 'M1080,648 C1018,614 972,682 985,775 C997,858 1058,875 1080,870 Z',
        fill: '#F9A8B4', op: 0.82,
      },
    ],
  },
  {
    id: 'B',
    bandStart: '#1F6B57', bandEnd: '#0E2E20',
    blobs: [
      {
        d: 'M1080,0 L545,0 C632,14 742,-12 778,86 C814,185 740,266 796,370 C832,435 942,412 980,518 C1002,574 958,638 1080,638 Z',
        fill: '#FFD166', op: 0.91,
      },
      {
        d: 'M0,310 C112,278 190,345 175,472 C160,580 62,608 100,722 C126,800 68,870 0,858 Z',
        fill: '#A8D8EA', op: 0.86,
      },
      {
        d: 'M1080,662 C1020,628 975,696 988,788 C1000,872 1060,888 1080,882 Z',
        fill: '#F9A8B4', op: 0.80,
      },
    ],
  },
  {
    id: 'C',
    bandStart: '#1F6B57', bandEnd: '#0E2E20',
    blobs: [
      {
        d: 'M1080,0 L555,0 C640,12 752,-15 788,84 C825,182 750,262 806,366 C840,432 952,408 990,515 C1012,570 968,635 1080,635 Z',
        fill: '#FFD166', op: 0.94,
      },
      {
        d: 'M0,348 C98,315 175,382 162,508 C148,615 55,640 92,752 C116,830 58,898 0,884 Z',
        fill: '#F9A8B4', op: 0.86,
      },
      {
        d: 'M1080,655 C1022,622 978,690 990,780 C1002,862 1060,878 1080,872 Z',
        fill: '#C9B8E8', op: 0.78,
      },
    ],
  },
  {
    id: 'D',
    bandStart: '#1F6B57', bandEnd: '#0E2E20',
    blobs: [
      {
        d: 'M1080,0 L548,0 C636,15 745,-10 782,88 C818,185 744,265 800,368 C835,435 945,410 984,518 C1006,574 962,640 1080,640 Z',
        fill: '#FFD166', op: 0.90,
      },
      {
        d: 'M0,320 C108,287 186,354 172,480 C158,588 62,615 100,728 C126,806 66,876 0,862 Z',
        fill: '#C9B8E8', op: 0.91,
      },
      // Acento amarelo baixo-esquerda
      {
        d: 'M0,958 C52,924 98,948 94,1018 C90,1075 42,1090 0,1082 Z',
        fill: '#FFD166', op: 0.65,
      },
    ],
  },
  {
    id: 'E',
    bandStart: '#1F6B57', bandEnd: '#0E2E20',
    blobs: [
      {
        d: 'M1080,0 L558,0 C644,12 754,-14 790,84 C826,182 752,262 808,365 C842,432 952,408 990,516 C1012,572 968,636 1080,636 Z',
        fill: '#FFD166', op: 0.92,
      },
      {
        d: 'M0,338 C102,305 178,372 165,498 C152,606 58,632 96,745 C120,822 62,890 0,876 Z',
        fill: '#D4A8D8', op: 0.87,
      },
      {
        d: 'M1080,658 C1022,626 978,694 990,784 C1002,866 1060,882 1080,876 Z',
        fill: '#A8F0D0', op: 0.76,
      },
    ],
  },
];

// Labels por especialidade
const LABELS = {
  fonoaudiologia:          'FONOAUDIOLOGIA',
  psicologia:              'PSICOLOGIA INFANTIL',
  terapia_ocupacional:     'TERAPIA OCUPACIONAL',
  fisioterapia:            'FISIOTERAPIA INFANTIL',
  psicomotricidade:        'PSICOMOTRICIDADE',
  freio_lingual:           'FREIO LINGUAL',
  neuropsicologia:         'NEUROPSICOLOGIA',
  psicopedagogia_clinica:  'PSICOPEDAGOGIA',
  psicopedagogia:          'PSICOPEDAGOGIA',
  musicoterapia:           'MUSICOTERAPIA',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function escapeSvg(s = '') {
  return String(s).replace(/[<>&"']/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

function fontSizeParaLinha(linha) {
  const n = linha.length;
  if (n <= 8)  return 92;
  if (n <= 11) return 82;
  if (n <= 14) return 72;
  if (n <= 17) return 62;
  return 54;
}

function truncarHook(texto, max = 48) {
  if (!texto || texto.length <= max) return texto || '';
  const cortado = texto.substring(0, max);
  const ultimo  = cortado.lastIndexOf(' ');
  return (ultimo > 20 ? cortado.substring(0, ultimo) : cortado) + '...';
}

// ─── Gera SVG overlay completo ───────────────────────────────────────────────
/**
 * SVG inclui:
 *  - Overlay cinematográfico sutil na área da foto
 *  - Banda curva orgânica com gradiente verde
 *  - Linha branca na curva (separação elegante)
 *  - Blobs orgânicos irregulares nos cantos
 *  - Tipografia da especialidade + hook
 */
function gerarSVG({ tmpl, label, hook, bandY, largura = 1080, altura = 1080 }) {
  const palavras = label.split(' ');
  const meio  = Math.ceil(palavras.length / 2);
  const spec1 = palavras.slice(0, meio).join(' ');
  const spec2 = palavras.slice(meio).join(' ') || null;

  const fs1 = fontSizeParaLinha(spec1);
  const fs2 = spec2 ? fontSizeParaLinha(spec2) : 0;

  const pad = 60;
  const y1  = bandY + 95;
  const y2  = spec2 ? y1 + fs1 + 10 : y1;
  const yH  = (spec2 ? y2 + fs2 : y1 + fs1) + 26;
  const sepY = yH + 20;

  // Curva da banda: sobe 70px no centro
  const curveY = bandY - 70;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${largura}" height="${altura}">
  <defs>

    <!-- Shadow elegante para o texto -->
    <filter id="sh">
      <feDropShadow dx="0" dy="3" stdDeviation="5" flood-opacity="0.22"/>
    </filter>

    <!-- Gradiente da banda verde (profundidade) -->
    <linearGradient id="bandGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="${tmpl.bandStart}"/>
      <stop offset="100%" stop-color="${tmpl.bandEnd}"/>
    </linearGradient>

    <!-- Vignette sutil sobre a foto (topo escurece levemente) -->
    <linearGradient id="vigGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#000000" stop-opacity="0.10"/>
      <stop offset="50%"  stop-color="#000000" stop-opacity="0.00"/>
    </linearGradient>

  </defs>

  <!-- 1. Vignette cinematográfico sutil na área da foto -->
  <rect x="0" y="0" width="${largura}" height="${bandY}" fill="url(#vigGrad)"/>

  <!-- 2. Banda verde com curva orgânica no topo -->
  <path d="M0,${bandY} Q${largura / 2},${curveY} ${largura},${bandY} L${largura},${altura} L0,${altura} Z"
        fill="url(#bandGrad)"/>

  <!-- 3. Linha branca elegante na curva (separação sutil) -->
  <path d="M0,${bandY} Q${largura / 2},${curveY} ${largura},${bandY}"
        stroke="#FFFFFF" stroke-width="1.8" opacity="0.18" fill="none"/>

  <!-- 4. Blobs orgânicos (por cima de tudo para aparecer na foto e na banda) -->
  ${tmpl.blobs.map(b =>
    `<path d="${b.d}" fill="${b.fill}" opacity="${b.op}"/>`
  ).join('\n  ')}

  <!-- 5. Especialidade — linha 1 (branca) -->
  <text x="${pad}" y="${y1}"
        font-family="'Arial Black', 'Helvetica Neue', Impact, Arial, sans-serif" font-weight="900"
        font-size="${fs1}" letter-spacing="2"
        fill="${TEXT_WHITE}" filter="url(#sh)">${escapeSvg(spec1)}</text>

  <!-- 6. Especialidade — linha 2 em amarelo (se houver) -->
  ${spec2 ? `<text x="${pad}" y="${y2}"
        font-family="'Arial Black', 'Helvetica Neue', Impact, Arial, sans-serif" font-weight="900"
        font-size="${fs2}" letter-spacing="2"
        fill="${ACCENT}" filter="url(#sh)">${escapeSvg(spec2)}</text>` : ''}

  <!-- 7. Hook / subtítulo -->
  <text x="${pad}" y="${yH}"
        font-family="'Helvetica Neue', Arial, sans-serif" font-weight="600"
        font-size="34" fill="${TEXT_WHITE}" opacity="0.90"
        filter="url(#sh)">${escapeSvg(hook)}</text>

  <!-- 8. Separador amarelo -->
  <rect x="${pad}" y="${sepY}" width="110" height="3" rx="2"
        fill="${ACCENT}" opacity="0.72"/>

</svg>`.trim();
}

// ─── Função principal ─────────────────────────────────────────────────────────
/**
 * Gera imagem branded estilo Fono Inova — profissional, social media ready.
 */
export async function gerarImagemBranded({ fotoUrl, fotoBuffer, titulo, conteudo, especialidadeId, templateIndex }) {
  const SIZE   = 1080;
  const BAND_H = 380;           // banda menor (35%) → mais foto visível
  const BAND_Y = SIZE - BAND_H; // y = 700

  const idx  = templateIndex !== undefined
    ? templateIndex % TEMPLATES.length
    : Math.floor(Math.random() * TEMPLATES.length);
  const tmpl = TEMPLATES[idx];

  console.log(`🎨 [BRAND] Template ${tmpl.id} | ${especialidadeId}`);

  // 1. Foto como buffer
  let fotoBuf = fotoBuffer || null;
  if (!fotoBuf && fotoUrl) {
    try {
      const r = await fetch(fotoUrl, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      fotoBuf = Buffer.from(await r.arrayBuffer());
      console.log(`📸 [BRAND] ${fotoBuf.length} bytes`);
    } catch (err) {
      console.warn(`⚠️ [BRAND] Foto falhou: ${err.message}`);
    }
  }

  // 2. Foto base 1080×1080
  //    Retrato → 'top' (preserva rosto no topo) | Paisagem/quadrado → 'attention'
  let baseImg;
  if (fotoBuf) {
    const meta = await sharp(fotoBuf).metadata();
    const isRetrato = (meta.height || 0) > (meta.width || 0) * 1.1;
    const cropPos   = isRetrato ? 'top' : 'attention';
    console.log(`📐 [BRAND] ${meta.width}×${meta.height} → crop: ${cropPos}`);
    baseImg = await sharp(fotoBuf)
      .resize(SIZE, SIZE, { fit: 'cover', position: cropPos })
      .jpeg({ quality: 95 })
      .toBuffer();
  } else {
    baseImg = await sharp({
      create: { width: SIZE, height: SIZE, channels: 3,
                background: { r: 218, g: 240, b: 230 } }
    }).jpeg().toBuffer();
  }

  // 3. Hook: prefere frase curta e impactante
  const corpo     = (conteudo || '').replace(/^.+\n/, '').trim();
  const sentences = corpo.split(/[.!?]/).map(s => s.trim()).filter(s => s.length > 8);
  const hookRaw   = sentences.find(s => s.length <= 55) || sentences[0] || titulo || '';
  const hook      = truncarHook(hookRaw, 48);

  // 4. SVG com banda curva + blobs orgânicos + texto
  const label  = LABELS[especialidadeId] || 'FONO INOVA';
  const svgStr = gerarSVG({ tmpl, label, hook, bandY: BAND_Y });

  // 5. Logo real da Fono Inova
  const LOGO_W = 280;
  let logoComposite = null;
  try {
    const logoBuf  = await sharp(LOGO_PATH).resize(LOGO_W, null, { fit: 'inside' }).toBuffer();
    const logoMeta = await sharp(logoBuf).metadata();
    const logoH    = logoMeta.height || 110;
    const logoX    = Math.round((SIZE - LOGO_W) / 2);
    const logoY    = SIZE - logoH - 18;
    logoComposite  = { input: logoBuf, top: logoY, left: logoX };
    console.log(`🖼️ [BRAND] Logo ${LOGO_W}×${logoH}`);
  } catch (err) {
    console.warn(`⚠️ [BRAND] Logo: ${err.message}`);
  }

  // 6. Compositar: foto base → SVG (banda + blobs + texto) → logo
  const composites = [{ input: Buffer.from(svgStr), blend: 'over' }];
  if (logoComposite) composites.push(logoComposite);

  const imagemFinal = await sharp(baseImg)
    .composite(composites)
    .webp({ quality: 95, effort: 4 })
    .toBuffer();

  // 7. Upload Cloudinary
  const base64 = `data:image/webp;base64,${imagemFinal.toString('base64')}`;
  const result  = await cloudinary.uploader.upload(base64, {
    folder:    'fono-inova/branded',
    public_id: `${especialidadeId}_branded_${Date.now()}`,
  });

  console.log(`✅ [BRAND] ${result.secure_url}`);
  return result.secure_url;
}

export async function aplicarBrandingSobreFoto(fotoUrl, titulo, conteudo, especialidadeId) {
  return gerarImagemBranded({ fotoUrl, titulo, conteudo, especialidadeId });
}

export default { gerarImagemBranded, aplicarBrandingSobreFoto };
