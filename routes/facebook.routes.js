import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import * as facebookController from '../controllers/facebookController.js';
import { generateVariations, scoreContent } from '../controllers/facebookController.js';
import { uploadMiddleware } from '../services/media/mediaUploadService.js';

const router = Router();
router.use(auth);

// Rotas sem parâmetros primeiro
router.get('/posts', facebookController.listPosts);
router.get('/posts/stats', facebookController.getStats);
router.post('/generate', facebookController.generatePost);

// 🎯 NOVOS: 3 Modos de Geração Estratégica
router.post('/generate-caption', facebookController.generateCaption);
router.post('/generate-hooks', facebookController.generateHooks);

// 🎯 A/B VARIAÇÕES E SCORE
router.post('/generate-variations', generateVariations);
router.post('/score', scoreContent);

// Rotas com parâmetros - ORDEM IMPORTANTE: mais específicas primeiro
router.post('/posts/:id/image', facebookController.generateImageForPost);
router.post('/posts/:id/upload-media', uploadMiddleware, facebookController.uploadMedia);
router.post('/posts/:id/approve', facebookController.approvePost);
router.post('/posts/:id/publish', facebookController.publishPost);
router.delete('/posts/:id', facebookController.deletePost);
router.put('/posts/:id', facebookController.updatePost);

export default router;
