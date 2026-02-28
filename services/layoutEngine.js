/**
 * 🎨 Layout Engine - Fono Inova
 * Motor de renderização genérico para layouts de Instagram
 * Interpreta specs JSON e gera SVG dinâmico
 */

import sharp from 'sharp';
import { v2 as cloudinary } from 'cloudinary';
import {
  LAYOUTS,
  CORES_FONO_INOVA,
  ESPECIALIDADE_CATEGORIAS,
  CATEGORIA_FALLBACK,
  getLayoutsForEspecialidade,
  getLayoutById
} from '../config/layoutsConfig.js';
import LayoutHistory from '../models/LayoutHistory.js';

// Configuração Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * 🔄 SELECIONAR LAYOUT INTELIGENTE
 * Round-robin por categoria, evitando últimos 3 usados
 */
export async function selecionarLayoutInteligente(
  especialidadeId,
  categoriaPreferida = null,
  channel = 'instagram'
) {
  console.log(`🎯 Selecionando layout para: ${especialidadeId}`);
  
  // 1. Obter layouts compatíveis
  let layoutsCompativeis = getLayoutsForEspecialidade(especialidadeId);
  
  // 2. Se tem categoria preferida, filtrar por ela primeiro
  if (categoriaPreferida) {
    const layoutsCategoria = layoutsCompativeis.filter(
      l => l.categoria === categoriaPreferida
    );
    if (layoutsCategoria.length > 0) {
      layoutsCompativeis = layoutsCategoria;
    }
  }
  
  // 3. Obter histórico dos últimos 3 layouts usados
  const layoutsRecentes = await LayoutHistory.getRecentLayouts(
    especialidadeId,
    channel,
    3
  );
  
  console.log(`   📚 Histórico recente: [${layoutsRecentes.join(', ')}]`);
  
  // 4. Filtrar layouts usados recentemente
  const layoutsDisponiveis = layoutsCompativeis.filter(
    l => !layoutsRecentes.includes(l.id)
  );
  
  // 5. Se sobrou algum, escolher próximo (round-robin)
  // Se não, usar qualquer um (incluindo os recentes, mas evitando o último)
  const candidatos = layoutsDisponiveis.length > 0 
    ? layoutsDisponiveis 
    : layoutsCompativeis.filter(l => l.id !== layoutsRecentes[0]);
  
  if (candidatos.length === 0) {
    // Fallback absoluto
    return getLayoutById('hero_banner_curva');
  }
  
  // 6. Escolher próximo da lista (round-robin simples)
  // Usar o índice baseado no timestamp para variedade
  const indice = Date.now() % candidatos.length;
  const layoutSelecionado = candidatos[indice];
  
  console.log(`   ✅ Layout selecionado: ${layoutSelecionado.id}`);
  
  return layoutSelecionado;
}

/**
 * 📝 REGISTRAR USO DO LAYOUT
 */
export async function registrarUso(
  layoutId,
  especialidadeId,
  categoria,
  postId = null,
  channel = 'instagram'
) {
  await LayoutHistory.registerUsage(
    layoutId,
    especialidadeId,
    categoria,
    postId,
    channel
  );
  
  // Limpar histórico antigo (manter só últimos 50)
  await LayoutHistory.cleanupOld(especialidadeId, channel, 50);
  
  console.log(`   📝 Uso registrado: ${layoutId}`);
}

/**
 * 🎨 RENDERIZAR SVG A PARTIR DO SPEC
 * Interpreta o spec do layout e gera SVG
 */
function renderizarSVG(spec, texto, hook = '') {
  const { elementos = [], texto: textoSpec = {} } = spec;

  let elementosSVG = [];

  // Processar elementos gráficos
  elementos.forEach((el, index) => {
    const svgEl = renderizarElemento(el, index);
    if (svgEl) elementosSVG.push(svgEl);
  });

  // Processar elemento detalhe (decorativo extra, ex: linha_decorativa no hero_banner)
  if (spec.detalhe) {
    const detalheEl = renderizarElemento(spec.detalhe, 999);
    if (detalheEl) elementosSVG.push(detalheEl);
  }

  // Processar elemento marca (branding fixo, ex: FONO INOVA)
  if (spec.marca) {
    const marcaEl = renderizarElemento(spec.marca, 998);
    if (marcaEl) elementosSVG.push(marcaEl);
  }

  // Processar texto
  const textoSVG = renderizarTexto(textoSpec, texto, hook);

  // Montar SVG final
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
  <defs>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="3" stdDeviation="4" flood-opacity="0.35"/>
    </filter>
    <filter id="shadow-strong" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="4" stdDeviation="6" flood-opacity="0.5"/>
    </filter>
  </defs>
  ${elementosSVG.join('\n')}
  ${textoSVG}
</svg>`;

  return svg;
}

/**
 * 🧩 RENDERIZAR ELEMENTO INDIVIDUAL
 */
function renderizarElemento(el, index) {
  const cor = CORES_FONO_INOVA[el.cor] || el.cor || CORES_FONO_INOVA.verdeProfundo;
  const opacidade = el.opacidade !== undefined ? el.opacidade : 1;

  switch (el.tipo) {
    case 'path_curvo':
    case 'path':
    case 'blob':
    case 'forma_organica':
      if (!el.path) return '';
      return `<path d="${el.path}" fill="${cor}" opacity="${opacidade}"/>`;

    case 'faixa': {
      const pathD = el.curva
        ? `M0,${el.yStart} C200,${el.yStart - 60} 500,${el.yStart - 40} 800,${el.yStart + 20} S1080,${el.yStart} 1080,${el.yStart} L1080,1080 L0,1080 Z`
        : null;
      if (el.gradiente) {
        const gId = `faixa-grad-${index}`;
        const cor2 = CORES_FONO_INOVA[el.corGradiente] || el.corGradiente || '#0D2B1E';
        const shape = pathD
          ? `<path d="${pathD}" fill="url(#${gId})"/>`
          : `<rect x="0" y="${el.yStart}" width="1080" height="${el.height || 270}" fill="url(#${gId})"/>`;
        return `
          <defs>
            <linearGradient id="${gId}" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stop-color="${cor}"/>
              <stop offset="100%" stop-color="${cor2}"/>
            </linearGradient>
          </defs>
          ${shape}
        `;
      }
      if (pathD) return `<path d="${pathD}" fill="${cor}"/>`;
      return `<rect x="0" y="${el.yStart}" width="1080" height="${el.height || 270}" fill="${cor}"/>`;
    }

    case 'retangulo':
      return `<rect x="${el.x || 0}" y="${el.y || 0}" width="${el.width || 540}" height="${el.height || 1080}" fill="${cor}" opacity="${opacidade}"/>`;

    case 'circulo':
      return `<circle cx="${el.cx || 540}" cy="${el.cy || 540}" r="${el.r || 80}" fill="${cor}" opacity="${opacidade}"/>`;

    case 'coluna': {
      const xCol = el.posicao === 'esquerda' ? 0 : 540;
      const wCol = el.width || 540;
      return `
        <rect x="${xCol}" y="200" width="${wCol}" height="680" fill="${cor}" opacity="0.9"/>
        <text x="${xCol + wCol / 2}" y="270" font-family="Montserrat,Arial,sans-serif" font-weight="700" font-size="30" fill="${CORES_FONO_INOVA.verdeProfundo}" text-anchor="middle">${escapeXml(el.titulo || '')}</text>
      `;
    }

    case 'badge_x': {
      const r = (el.size || 80) / 2;
      return `
        <circle cx="540" cy="540" r="${r}" fill="${cor}"/>
        <text x="540" y="${540 + r * 0.3}" font-family="Montserrat,Arial,sans-serif" font-weight="900" font-size="${r * 0.7}" fill="${CORES_FONO_INOVA.verdeProfundo}" text-anchor="middle">✕</text>
      `;
    }

    case 'badge': {
      const badgeW = Math.max(80, (el.texto?.length || 5) * 18 + 40);
      return `
        <rect x="${el.x || 700}" y="${el.y || 80}" width="${badgeW}" height="52" rx="${el.borderRadius || 26}" fill="${cor}"/>
        <text x="${(el.x || 700) + badgeW / 2}" y="${(el.y || 80) + 34}" font-family="Montserrat,Arial,sans-serif" font-weight="700" font-size="20" fill="${CORES_FONO_INOVA.verdeProfundo}" text-anchor="middle">${escapeXml(el.texto || '')}</text>
      `;
    }

    case 'linha_decorativa':
      return `<rect x="${el.x || 70}" y="${el.y || 960}" width="${el.width || 120}" height="${el.height || 4}" rx="${(el.height || 4) / 2}" fill="${cor}"/>`;

    case 'gradiente': {
      const gId = `grad-${index}`;
      const gHeight = el.height || 300;
      const corStart = el.corStart === 'transparent' ? 'black' : (CORES_FONO_INOVA[el.corStart] || el.corStart || 'black');
      const corEnd = CORES_FONO_INOVA[el.corEnd] || el.corEnd || CORES_FONO_INOVA.verdeProfundo;
      const opStart = el.corStart === 'transparent' ? 0 : 0;
      return `
        <defs>
          <linearGradient id="${gId}" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="${corStart}" stop-opacity="${opStart}"/>
            <stop offset="100%" stop-color="${corEnd}" stop-opacity="${opacidade}"/>
          </linearGradient>
        </defs>
        <rect x="0" y="${1080 - gHeight}" width="1080" height="${gHeight}" fill="url(#${gId})"/>
      `;
    }

    case 'play_button': {
      const pr = (el.size || 100) / 2;
      const cx = el.cx || 540;
      const cy = el.cy || 540;
      return `
        <circle cx="${cx}" cy="${cy}" r="${pr}" fill="${cor}" opacity="${opacidade}"/>
        <polygon points="${cx - pr * 0.3},${cy - pr * 0.45} ${cx - pr * 0.3},${cy + pr * 0.45} ${cx + pr * 0.5},${cy}" fill="${CORES_FONO_INOVA.verdeProfundo}"/>
      `;
    }

    case 'overlay':
      return `<rect x="0" y="${el.yStart || 600}" width="1080" height="${el.height || 480}" fill="${cor}" opacity="${opacidade}"/>`;

    case 'borda': {
      const pad = el.padding || 40;
      return `<rect x="${pad}" y="${pad}" width="${1080 - pad * 2}" height="${1080 - pad * 2}" fill="none" stroke="${cor}" stroke-width="${el.espessura || 8}"/>`;
    }

    case 'maos_coloridas': {
      const yBase = el.yStart || 700;
      const cores = el.cores || ['amareloOuro', 'rosaCoral', 'verdeClaro'];
      return cores.map((c, i) => {
        const rc = CORES_FONO_INOVA[c] || c;
        const cx = 180 + i * 360;
        return `<ellipse cx="${cx}" cy="${yBase + 80}" rx="160" ry="120" fill="${rc}" opacity="0.65"/>`;
      }).join('\n');
    }

    case 'etapas': {
      const n = el.numero || 4;
      const stepW = 1080 / n;
      const eCores = el.cores || ['verdeProfundo', 'verdeVibrante', 'lilas', 'rosaCoral'];
      return Array.from({ length: n }, (_, i) => {
        const ec = CORES_FONO_INOVA[eCores[i]] || eCores[i] || CORES_FONO_INOVA.verdeVibrante;
        const cx = stepW * i + stepW / 2;
        return `
          <circle cx="${cx}" cy="700" r="50" fill="${ec}" opacity="0.9"/>
          <text x="${cx}" y="712" font-family="Montserrat,Arial,sans-serif" font-weight="900" font-size="32" fill="white" text-anchor="middle">${i + 1}</text>
        `;
      }).join('');
    }

    case 'linha_progresso':
      return `<rect x="100" y="${el.y || 760}" width="880" height="${el.espessura || 6}" rx="${(el.espessura || 6) / 2}" fill="${cor}"/>`;

    case 'foto_circular':
      return `<circle cx="${el.cx || 900}" cy="${el.cy || 200}" r="${el.r || 100}" fill="rgba(255,255,255,0.15)" stroke="white" stroke-width="3" stroke-dasharray="12,6"/>`;

    case 'lista': {
      const n = el.items || 5;
      return Array.from({ length: n }, (_, i) => {
        const ly = 640 + i * 58;
        return `
          <circle cx="100" cy="${ly}" r="16" fill="${cor}"/>
          <text x="100" y="${ly + 6}" font-family="Montserrat,Arial,sans-serif" font-weight="900" font-size="16" fill="white" text-anchor="middle">✓</text>
          <rect x="130" y="${ly - 10}" width="680" height="20" rx="10" fill="${cor}" opacity="0.18"/>
        `;
      }).join('');
    }

    case 'icone': {
      const ix = el.x || 540;
      const iy = el.y || 300;
      const is = el.size || 80;
      if (el.estilo === 'fala') {
        return `
          <ellipse cx="${ix}" cy="${iy}" rx="${is * 0.9}" ry="${is * 0.7}" fill="${cor}" opacity="0.9"/>
          <polygon points="${ix - 15},${iy + is * 0.6} ${ix - 35},${iy + is} ${ix + 15},${iy + is * 0.55}" fill="${cor}"/>
        `;
      }
      // prancha_caa: grid 3x3
      const gs = is / 3;
      let grid = '';
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
        grid += `<rect x="${ix - is / 2 + c * gs + 2}" y="${iy - is / 2 + r * gs + 2}" width="${gs - 4}" height="${gs - 4}" rx="4" fill="${cor}" opacity="0.85"/>`;
      }
      return grid;
    }

    case 'destaque': {
      const dt = el.texto || '';
      const dw = Math.max(80, dt.length * 18 + 40);
      const dx = el.x || 880;
      const dy = el.y || 300;
      return `
        <rect x="${dx - dw / 2}" y="${dy - 25}" width="${dw}" height="50" rx="25" fill="${cor}"/>
        <text x="${dx}" y="${dy + 8}" font-family="Montserrat,Arial,sans-serif" font-weight="900" font-size="22" fill="${CORES_FONO_INOVA.verdeProfundo}" text-anchor="middle">${escapeXml(dt)}</text>
      `;
    }

    case 'selo': {
      const st = el.texto || '';
      const sw = st.length > 12 ? st.split(' ') : [st];
      const sx = el.x || 540;
      const sy = el.y || 960;
      const lines = [];
      let cur = '';
      sw.forEach(w => {
        if ((cur + ' ' + w).trim().length > 10) { lines.push(cur); cur = w; }
        else { cur = (cur + ' ' + w).trim(); }
      });
      if (cur) lines.push(cur);
      return `
        <circle cx="${sx}" cy="${sy}" r="70" fill="${cor}" opacity="0.92"/>
        ${lines.map((l, i) => `<text x="${sx}" y="${sy - lines.length * 10 + i * 22 + 8}" font-family="Montserrat,Arial,sans-serif" font-weight="700" font-size="13" fill="${CORES_FONO_INOVA.verdeProfundo}" text-anchor="middle">${escapeXml(l)}</text>`).join('')}
      `;
    }

    case 'texto_destaque':
      return `<rect x="180" y="470" width="720" height="170" rx="14" fill="${cor}" opacity="${opacidade}"/>`;

    case 'card': {
      const cardX = el.posicao === 'top_right' ? 540 : 0;
      const cardY = 324;
      return `
        <rect x="${cardX}" y="${cardY}" width="540" height="756" fill="${cor}" opacity="${opacidade || 0.2}"/>
        <text x="${cardX + 270}" y="${cardY + 55}" font-family="Montserrat,Arial,sans-serif" font-weight="700" font-size="26" fill="${CORES_FONO_INOVA.verdeProfundo}" text-anchor="middle">${escapeXml(el.titulo || '')}</text>
      `;
    }

    case 'losango':
    case 'diamante': {
      const cx = el.cx || el.x || 540;
      const cy = el.cy || el.y || 200;
      const hw = el.largura || el.size || 80;
      const hh = el.altura || el.size || 80;
      if (el.contorno) {
        return `<polygon points="${cx},${cy - hh} ${cx + hw},${cy} ${cx},${cy + hh} ${cx - hw},${cy}" fill="none" stroke="${cor}" stroke-width="${el.espessura || 4}" opacity="${opacidade}"/>`;
      }
      return `<polygon points="${cx},${cy - hh} ${cx + hw},${cy} ${cx},${cy + hh} ${cx - hw},${cy}" fill="${cor}" opacity="${opacidade}"/>`;
    }

    case 'marca_texto':
      return `<text x="${el.x || 75}" y="${el.y || 1048}" font-family="Montserrat,Arial,sans-serif" font-weight="${el.peso || '600'}" font-size="${el.tamanho || 20}" fill="${cor}" opacity="${el.opacidade !== undefined ? el.opacidade : 0.85}" letter-spacing="2">${escapeXml(el.texto || '')}</text>`;

    case 'numero_data':
      // Decorative element - sem dado de data real disponível, renderiza barra decorativa
      return `<rect x="${(el.x || 80) - 4}" y="${(el.y || 150) - (el.size || 100)}" width="8" height="${el.size || 100}" rx="4" fill="${cor}"/>`;

    case 'personagem_3d':
    case 'props':
    case 'ilustracao':
    case 'texto_vertical':
    case 'maos':
      // Elementos que precisam de assets externos — ignorados com segurança
      return '';

    default:
      return '';
  }
}

// Campos que recebem o conteúdo principal (headline/título)
const CAMPOS_PRIMARIOS = new Set(['titulo', 'metodo', 'principal', 'header', 'hook']);
// Campos que precisam de dados especiais ou de lista — pulados
const CAMPOS_SKIP = new Set(['items', 'fases', 'colunas', 'data']);

/**
 * 📝 RENDERIZAR TEXTO
 * Itera TODOS os campos do textoSpec e renderiza cada um conforme o tipo.
 */
function renderizarTexto(textoSpec, titulo, subtitulo = '') {
  if (!textoSpec) return '';

  let svgTexto = '';

  for (const [campo, spec] of Object.entries(textoSpec)) {
    if (CAMPOS_SKIP.has(campo)) continue;

    const isPrimario = CAMPOS_PRIMARIOS.has(campo);
    const conteudo = isPrimario ? titulo : (subtitulo || titulo || '');
    if (!conteudo) continue;

    const cor = CORES_FONO_INOVA[spec.cor] || spec.cor || CORES_FONO_INOVA.branco;
    const x = spec.x || 70;
    const y = spec.y || 850;
    const align = spec.align || 'left';
    const anchor = align === 'center' ? 'middle' : (align === 'right' ? 'end' : 'start');
    const filter = spec.shadow ? 'filter="url(#shadow)"' : '';
    const tamanho = spec.tamanho || 56;
    const maxChars = spec.maxChars || (isPrimario ? 30 : 50);

    const linhas = quebrarTexto(conteudo, maxChars, 2);
    linhas.forEach((linha, i) => {
      if (!linha) return;
      const lineY = y + i * (tamanho + 10);
      svgTexto += `<text x="${x}" y="${lineY}" font-family="${spec.fonte || 'Montserrat'},Arial,sans-serif" font-weight="${spec.peso || (isPrimario ? '900' : '600')}" font-size="${tamanho}" fill="${cor}" text-anchor="${anchor}" ${filter}>${escapeXml(linha)}</text>\n`;
    });
  }

  return svgTexto;
}

/**
 * ✂️ UTILITÁRIOS DE TEXTO
 */
function quebrarTexto(texto, maxCharsPorLinha, maxLinhas = 2) {
  if (!texto) return [''];
  
  const palavras = texto.split(' ');
  const linhas = [];
  let linhaAtual = '';
  
  for (const palavra of palavras) {
    if ((linhaAtual + ' ' + palavra).trim().length <= maxCharsPorLinha) {
      linhaAtual = (linhaAtual + ' ' + palavra).trim();
    } else {
      if (linhaAtual) linhas.push(linhaAtual);
      linhaAtual = palavra;
      if (linhas.length >= maxLinhas - 1) break;
    }
  }
  
  if (linhaAtual && linhas.length < maxLinhas) {
    linhas.push(linhaAtual);
  }
  
  // Preencher linhas vazias
  while (linhas.length < maxLinhas) {
    linhas.push('');
  }
  
  return linhas.slice(0, maxLinhas);
}


function escapeXml(texto) {
  if (!texto) return '';
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 🎨 APLICAR LAYOUT SOBRE IMAGEM BASE
 */
export async function aplicarLayout(
  fotoBuffer,
  layout,
  texto,
  hook = '',
  especialidadeId = 'generic'
) {
  const { specs } = layout;
  
  console.log(`   🎨 Aplicando layout: ${layout.id}`);
  
  // 1. Redimensionar imagem base conforme fotoRatio
  let imagemProcessada;
  
  if (specs.fotoRatio > 0 && fotoBuffer) {
    // Calcular altura da foto baseada no ratio
    const alturaFoto = Math.round(1080 * specs.fotoRatio);
    
    imagemProcessada = await sharp(fotoBuffer)
      .resize(1080, alturaFoto, { 
        fit: 'cover', 
        position: specs.crop || 'center' 
      })
      .jpeg({ quality: 95 })
      .toBuffer();
    
    // Criar canvas 1080x1080 e posicionar foto
    const posicaoY = specs.fotoPosicao === 'bottom' ? (1080 - alturaFoto) : 0;
    
    imagemProcessada = await sharp({
      create: {
        width: 1080,
        height: 1080,
        channels: 3,
        background: specs.bg ? (CORES_FONO_INOVA[specs.bg] || specs.bg) : { r: 255, g: 255, b: 255 }
      }
    })
      .composite([
        { input: imagemProcessada, top: posicaoY, left: 0 }
      ])
      .jpeg({ quality: 95 })
      .toBuffer();
  } else {
    // Sem foto (ilustração pura) ou sem buffer
    imagemProcessada = await sharp({
      create: {
        width: 1080,
        height: 1080,
        channels: 3,
        background: specs.bg ? (CORES_FONO_INOVA[specs.bg] || specs.bg) : { r: 26, g: 77, b: 58 }
      }
    })
      .jpeg({ quality: 95 })
      .toBuffer();
  }
  
  // 2. Gerar SVG do overlay
  const svgOverlay = renderizarSVG(specs, texto, hook);
  const svgBuffer = Buffer.from(svgOverlay);
  
  // 3. Converter SVG para PNG
  const overlayBuffer = await sharp(svgBuffer)
    .resize(1080, 1080)
    .png()
    .toBuffer();
  
  // 4. Compor imagem final
  const imagemFinal = await sharp(imagemProcessada)
    .composite([
      { input: overlayBuffer, blend: 'over' }
    ])
    .webp({ quality: 95 })
    .toBuffer();
  
  console.log(`   ✅ Layout aplicado: ${(imagemFinal.length / 1024).toFixed(1)}KB`);
  
  return imagemFinal;
}

/**
 * ☁️ UPLOAD PARA CLOUDINARY
 */
export async function uploadImagem(imagemBuffer, especialidadeId, layoutId) {
  const base64 = `data:image/webp;base64,${imagemBuffer.toString('base64')}`;
  
  const result = await cloudinary.uploader.upload(base64, {
    folder: 'fono-inova/instagram/auto-layouts',
    public_id: `${especialidadeId}_${layoutId}_${Date.now()}`,
    quality: 'auto:good'
  });
  
  console.log(`   ☁️  Upload: ${result.secure_url.substring(0, 60)}...`);
  
  return result.secure_url;
}

/**
 * 📊 OBTER ESTATÍSTICAS DE USO
 */
export async function getLayoutStats(especialidadeId = null) {
  return await LayoutHistory.getStats(especialidadeId);
}

export default {
  selecionarLayoutInteligente,
  registrarUso,
  aplicarLayout,
  uploadImagem,
  getLayoutStats,
  LAYOUTS,
  CORES_FONO_INOVA
};
