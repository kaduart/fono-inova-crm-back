import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import * as instagramController from '../controllers/instagramController.js';

const router = Router();
router.use(auth);

// Rotas sem parâmetros primeiro
router.get('/posts', instagramController.listPosts);
router.get('/posts/stats', instagramController.getStats);
router.post('/generate', instagramController.generatePost);

// 🎯 NOVOS: 3 Modos de Geração Estratégica
router.post('/generate-caption', instagramController.generateCaption);
router.post('/generate-hooks', instagramController.generateHooks);

// Rotas com parâmetros - ORDEM IMPORTANTE: mais específicas primeiro
router.post('/posts/:id/image', instagramController.generateImageForPost);
router.post('/posts/:id/publish', instagramController.publishPost);
router.delete('/posts/:id', instagramController.deletePost);
router.put('/posts/:id', instagramController.updatePost);

export default router;
