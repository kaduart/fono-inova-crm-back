/**
 * 📁 Media Upload Service
 * Upload de arquivos externos (imagem/vídeo) para Cloudinary.
 * Retorna URL pública HTTPS acessível pela Meta Graph API.
 */

import { v2 as cloudinary } from 'cloudinary';
import multer from 'multer';
import path from 'path';
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
  'video/x-msvideo',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain'
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
      cb(new Error(`Tipo não suportado: ${file.mimetype}. Use imagens, vídeos, PDF, DOC, XLS ou TXT.`));
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
  const resourceType = mimetype.startsWith('video/') ? 'video' : 'auto';

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: resourceType,
        secure: true,
        ...(resourceType !== 'video' && { quality: 'auto', fetch_format: 'auto' })
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

    const readable = new Readable();
    readable.push(buffer);
    readable.push(null);
    readable.pipe(uploadStream);
  });
}

/**
 * Faz upload de documentos para Cloudinary preservando o arquivo original.
 * @param {Buffer} buffer        Conteúdo do arquivo
 * @param {string} originalName  Nome original do arquivo
 * @param {string} mimetype      MIME type do arquivo
 * @param {string} folder        Pasta no Cloudinary
 * @returns {Promise<{url: string, publicId: string, resourceType: string}>}
 */
export async function uploadDocumentToCloudinary(buffer, originalName, mimetype, folder = 'patient-documents') {
  const ext = originalName ? path.extname(originalName).toLowerCase() : '';
  const isPdf = ext === '.pdf' || mimetype === 'application/pdf';
  const resourceType = isPdf ? 'raw' : 'auto';

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: resourceType,
        secure: true,
        ...(resourceType !== 'raw' && resourceType !== 'video' && { quality: 'auto', fetch_format: 'auto' })
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

    const readable = new Readable();
    readable.push(buffer);
    readable.push(null);
    readable.pipe(uploadStream);
  });
}
