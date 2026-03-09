/**
 * 📁 Media Upload Service
 * Upload de arquivos externos (imagem/vídeo) para Cloudinary.
 * Retorna URL pública HTTPS acessível pela Meta Graph API.
 */

import { v2 as cloudinary } from 'cloudinary';
import multer from 'multer';
import { Readable } from 'stream';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Tipos aceitos
const ALLOWED_MIMETYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo'
];

const MAX_SIZE_MB = 100;

// Multer em memória (não salva em disco)
export const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMETYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo não suportado: ${file.mimetype}. Use JPG, PNG, WebP, GIF, MP4 ou MOV.`));
    }
  }
}).single('file');

/**
 * Faz upload do buffer para Cloudinary e retorna a URL pública.
 * @param {Buffer} buffer      Conteúdo do arquivo
 * @param {string} mimetype    MIME type do arquivo
 * @param {string} folder      Pasta no Cloudinary (ex: 'instagram', 'facebook')
 * @returns {Promise<{url: string, publicId: string, resourceType: string}>}
 */
export async function uploadToCloudinary(buffer, mimetype, folder = 'crm-posts') {
  const resourceType = mimetype.startsWith('video/') ? 'video' : 'image';

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: resourceType,
        // Garante URL HTTPS para Meta
        secure: true,
        // Qualidade automática para imagens
        ...(resourceType === 'image' && { quality: 'auto', fetch_format: 'auto' })
      },
      (error, result) => {
        if (error) return reject(new Error(`Cloudinary upload falhou: ${error.message}`));
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          resourceType
        });
      }
    );

    // Converte buffer em stream
    const readable = new Readable();
    readable.push(buffer);
    readable.push(null);
    readable.pipe(uploadStream);
  });
}
