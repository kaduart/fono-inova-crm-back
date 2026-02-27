/**
 * 🎨 Image Layout Service - Fono Inova
 * Adiciona formas orgânicas (losangos, círculos, ondas) sobre fotos
 * Usando Sharp + SVG
 */

import sharp from 'sharp';
import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * 🎨 PALETA FONO INOVA
 */
const COLORS = {
  verde: '#2E8B57',
  verdeClaro: '#3CB371',
  amarelo: '#FFD700',
  amareloClaro: '#FFE55C',
  rosa: '#FFB6C1',
  rosaClaro: '#FFC8CD',
  lilas: '#DDA0DD',
  branco: '#FFFFFF'
};

/**
 * 🔄 FORMAS ORGÂNICAS (SVG)
 */
function createOrganicShapes() {
  // Losango verde (canto inferior esquerdo)
  const losangoVerde = `
    <svg width="400" height="400" viewBox="0 0 400 400">
      <path d="M0,200 Q100,100 200,200 T400,200 L400,400 L0,400 Z" 
            fill="${COLORS.verde}" opacity="0.95"/>
    </svg>
  `;

  // Círculo amarelo (canto superior direito)
  const circuloAmarelo = `
    <svg width="300" height="300" viewBox="0 0 300 300">
      <circle cx="250" cy="50" r="180" 
              fill="${COLORS.amarelo}" opacity="0.85"/>
    </svg>
  `;

  // Onda rosa (canto inferior direito)
  const ondaRosa = `
    <svg width="500" height="300" viewBox="0 0 500 300">
      <path d="M200,300 Q350,150 500,200 L500,300 Z" 
            fill="${COLORS.rosa}" opacity="0.9"/>
    </svg>
  `;

  // Losango lilás decorativo (pequeno, canto superior esquerdo)
  const losangoLilas = `
    <svg width="200" height="200" viewBox="0 0 200 200">
      <path d="M-50,100 Q50,0 150,100" 
            fill="none" stroke="${COLORS.lilas}" stroke-width="40" opacity="0.6"/>
    </svg>
  `;

  return { losangoVerde, circuloAmarelo, ondaRosa, losangoLilas };
}

/**
 * 📝 CRIAR TEXTO (SVG)
 */
function createTextOverlay(headline, subheadline) {
  const headlineSize = headline.length > 20 ? 56 : 72;
  
  return `
    <svg width="1080" height="1080" viewBox="0 0 1080 1080">
      <defs>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="2" dy="2" stdDeviation="3" flood-opacity="0.3"/>
        </filter>
      </defs>
      
      <!-- Headline principal -->
      <text x="60" y="880" 
            font-family="Arial, sans-serif" 
            font-size="${headlineSize}" 
            font-weight="bold" 
            fill="${COLORS.branco}" 
            filter="url(#shadow)">
        ${headline}
      </text>
      
      <!-- Subheadline -->
      ${subheadline ? `
      <text x="60" y="940" 
            font-family="Arial, sans-serif" 
            font-size="32" 
            fill="${COLORS.branco}" 
            opacity="0.95">
        ${subheadline}
      </text>
      ` : ''}
      
      <!-- Logo/assinatura sutil -->
      <text x="60" y="1050" 
            font-family="Arial, sans-serif" 
            font-size="20" 
            fill="${COLORS.branco}" 
            opacity="0.8">
        Fono Inova • Anápolis/GO
      </text>
    </svg>
  `;
}

/**
 * 🎨 COMPOSER PRINCIPAL
 * Componha imagem final com formas + texto
 */
export async function composeInstagramPost({ 
  backgroundImageUrl, 
  headline, 
  subheadline,
  especialidadeId 
}) {
  try {
    console.log('🎨 Compondo layout Fono Inova:', headline);

    // 1. Baixar imagem de fundo
    const imageResponse = await fetch(backgroundImageUrl);
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

    // 2. Redimensionar para 1080x1080
    const baseImage = await sharp(imageBuffer)
      .resize(1080, 1080, { fit: 'cover', position: 'center' })
      .toBuffer();

    // 3. Criar camadas SVG
    const shapes = createOrganicShapes();
    const textSvg = createTextOverlay(headline, subheadline);

    // 4. Converter SVGs para buffers
    const losangoVerdeBuf = await sharp(Buffer.from(shapes.losangoVerde))
      .png()
      .toBuffer();
    
    const circuloAmareloBuf = await sharp(Buffer.from(shapes.circuloAmarelo))
      .png()
      .toBuffer();
    
    const ondaRosaBuf = await sharp(Buffer.from(shapes.ondaRosa))
      .png()
      .toBuffer();
    
    const losangoLilasBuf = await sharp(Buffer.from(shapes.losangoLilas))
      .png()
      .toBuffer();

    const textBuf = await sharp(Buffer.from(textSvg))
      .png()
      .toBuffer();

    // 5. Compor tudo
    const composed = await sharp(baseImage)
      .composite([
        { input: circuloAmareloBuf, top: 0, left: 780 },     // Círculo amarelo topo direito
        { input: losangoLilasBuf, top: 0, left: 0 },         // Lilás topo esquerdo
        { input: losangoVerdeBuf, top: 680, left: 0 },       // Losango verde inferior
        { input: ondaRosaBuf, top: 780, left: 580 },         // Onda rosa inferior direito
        { input: textBuf, top: 0, left: 0 }                  // Texto
      ])
      .jpeg({ quality: 90 })
      .toBuffer();

    // 6. Upload Cloudinary
    const base64 = `data:image/jpeg;base64,${composed.toString('base64')}`;
    const result = await cloudinary.uploader.upload(base64, {
      folder: 'fono-inova/instagram',
      public_id: `ig_${especialidadeId}_${Date.now()}`,
    });

    console.log('✅ Layout composto:', result.secure_url);
    return result.secure_url;

  } catch (error) {
    console.error('❌ Erro composição:', error);
    // Fallback: retorna imagem original
    return backgroundImageUrl;
  }
}

/**
 * 🎨 VERSÃO SIMPLES (só formas, sem texto complexo)
 */
export async function addBrandOverlay(imageUrl, headline, subheadline) {
  return composeInstagramPost({
    backgroundImageUrl: imageUrl,
    headline,
    subheadline,
    especialidadeId: 'generic'
  });
}

export default { composeInstagramPost, addBrandOverlay };
