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
  
  // Coletar defs (gradientes, filtros)
  let defs = [];
  let elementosSVG = [];
  
  // Processar elementos gráficos
  elementos.forEach((el, index) => {
    const svgEl = renderizarElemento(el, index);
    if (svgEl) elementosSVG.push(svgEl);
  });
  
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
    ${defs.join('\n')}
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
  const opacidade = el.opacidade || 1;
  
  switch (el.tipo) {
    case 'path_curvo':
    case 'path':
      return `<path d="${el.path}" fill="${cor}" opacity="${opacidade}"/>`;
    
    case 'blob':
      return `<path d="${el.path}" fill="${cor}" opacity="${opacidade}"/>`;
    
    case 'faixa':
      if (el.curva) {
        return `<path d="M0,${el.yStart} Q540,${el.yStart - 40} 1080,${el.yStart} L1080,1080 L0,1080 Z" fill="${cor}"/>`;
      }
      return `<rect x="0" y="${el.yStart}" width="1080" height="${el.height}" fill="${cor}"/>`;
    
    case 'retangulo':
      return `<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" fill="${cor}" opacity="${opacidade}"/>`;
    
    case 'circulo':
      return `<circle cx="${el.cx}" cy="${el.cy}" r="${el.r}" fill="${cor}" opacity="${opacidade}"/>`;
    
    case 'coluna':
      const xCol = el.posicao === 'esquerda' ? 0 : 540;
      return `
        <rect x="${xCol}" y="200" width="${el.width}" height="680" fill="${cor}" opacity="0.9"/>
        <text x="${xCol + el.width/2}" y="280" font-family="Montserrat,Arial,sans-serif" font-weight="700" font-size="32" fill="${CORES_FONO_INOVA.verdeProfundo}" text-anchor="middle">${el.titulo}</text>
      `;
    
    case 'badge':
      return `
        <rect x="${el.x}" y="${el.y}" width="${(el.texto?.length || 5) * 20}" height="50" rx="${el.borderRadius || 25}" fill="${cor}"/>
        <text x="${el.x + 20}" y="${el.y + 33}" font-family="Montserrat,Arial,sans-serif" font-weight="700" font-size="20" fill="${CORES_FONO_INOVA.verdeProfundo}">${el.texto}</text>
      `;
    
    case 'linha_decorativa':
      return `<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" rx="${(el.height/2)}" fill="${cor}"/>`;
    
    case 'gradiente':
      const gradientId = `grad-${index}`;
      return `
        <defs>
          <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${el.corStart}" stop-opacity="0"/>
            <stop offset="100%" stop-color="${el.corEnd}" stop-opacity="${opacidade}"/>
          </linearGradient>
        </defs>
        <rect x="0" y="${1080 - el.height}" width="1080" height="${el.height}" fill="url(#${gradientId})"/>
      `;
    
    case 'play_button':
      return `
        <circle cx="${el.cx}" cy="${el.cy}" r="${el.size/2}" fill="${cor}" opacity="${opacidade}"/>
        <polygon points="${el.cx - 20},${el.cy - 25} ${el.cx - 20},${el.cy + 25} ${el.cx + 30},${el.cy}" fill="${CORES_FONO_INOVA.verdeProfundo}"/>
      `;
    
    case 'overlay':
      return `<rect x="0" y="${el.yStart}" width="1080" height="${el.height}" fill="${cor}" opacity="${el.opacidade || 0.7}"/>`;
    
    case 'borda':
      return `<rect x="${el.padding}" y="${el.padding}" width="${1080 - (el.padding*2)}" height="${1080 - (el.padding*2)}" fill="none" stroke="${cor}" stroke-width="${el.espessura}"/>`;
    
    case 'forma_organica':
      return `<path d="${el.path}" fill="${cor}" opacity="${opacidade}"/>`;
    
    case 'card':
      // Simplificado para checklist
      return '';
    
    default:
      return '';
  }
}

/**
 * 📝 RENDERIZAR TEXTO
 */
function renderizarTexto(textoSpec, titulo, subtitulo = '') {
  if (!textoSpec) return '';
  
  let svgTexto = '';
  
  // Título principal
  if (textoSpec.titulo) {
    const spec = textoSpec.titulo;
    const cor = CORES_FONO_INOVA[spec.cor] || spec.cor || CORES_FONO_INOVA.branco;
    const x = spec.x || 70;
    const y = spec.y || 850;
    const align = spec.align || 'left';
    const anchor = align === 'center' ? 'middle' : (align === 'right' ? 'end' : 'start');
    const textX = align === 'center' ? x : x;
    
    // Quebrar título em múltiplas linhas se necessário
    const linhas = quebrarTexto(titulo, spec.maxChars || 30, 2);
    
    linhas.forEach((linha, i) => {
      const lineY = y + (i * (spec.tamanho + 10));
      const filter = spec.shadow ? 'filter="url(#shadow)"' : '';
      
      svgTexto += `
        <text x="${textX}" y="${lineY}" 
              font-family="${spec.fonte || 'Montserrat'},Arial,sans-serif" 
              font-weight="${spec.peso || '900'}" 
              font-size="${spec.tamanho || 56}" 
              fill="${cor}" 
              text-anchor="${anchor}"
              ${filter}>${escapeXml(linha)}</text>
      `;
    });
  }
  
  // Subtítulo
  if (textoSpec.subtitulo && subtitulo) {
    const spec = textoSpec.subtitulo;
    const cor = CORES_FONO_INOVA[spec.cor] || spec.cor || CORES_FONO_INOVA.branco;
    const x = spec.x || 70;
    const y = spec.y || 920;
    const anchor = (spec.align || 'left') === 'center' ? 'middle' : 'start';
    const textoTruncado = truncarTexto(subtitulo, spec.maxChars || 50);
    
    svgTexto += `
      <text x="${x}" y="${y}" 
            font-family="${spec.fonte || 'Montserrat'},Arial,sans-serif" 
            font-weight="${spec.peso || '600'}" 
            font-size="${spec.tamanho || 28}" 
            fill="${cor}" 
            text-anchor="${anchor}">${escapeXml(textoTruncado)}</text>
    `;
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

function truncarTexto(texto, maxChars) {
  if (!texto || texto.length <= maxChars) return texto || '';
  return texto.substring(0, maxChars - 3) + '...';
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
