import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import * as instagramController from '../controllers/instagramController.js';

const router = Router();
router.use(auth);

// 📊 Stats e listagem
router.get('/posts', instagramController.listPosts);
router.get('/posts/stats', instagramController.getStats);

// 🎯 GERAÇÃO PRINCIPAL: Post completo (Headline + Caption + Imagem)
router.post('/generate', instagramController.generatePost);

// 🔍 PREVIEWS (não salvam no banco - para testar)
router.post('/preview/headline', instagramController.generateHeadlinePreview);
router.post('/preview/caption', instagramController.generateCaptionPreview);
router.post('/preview/full', instagramController.previewContent);

// 🎨 Ações em posts específicos
router.post('/posts/:id/image', instagramController.generateImageForPost);
router.post('/posts/:id/publish', instagramController.publishPost);
router.delete('/posts/:id', instagramController.deletePost);
router.put('/posts/:id', instagramController.updatePost);

export default router;
