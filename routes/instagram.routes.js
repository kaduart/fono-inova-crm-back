import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import * as instagramController from '../controllers/instagramController.js';
import * as postGeneratorController from '../controllers/postGeneratorController.js';

const router = Router();
router.use(auth);

// 📊 Stats e listagem
router.get('/posts', instagramController.listPosts);
router.get('/posts/stats', instagramController.getStats);

// 🎯 GERAÇÃO PRINCIPAL: Post completo (Headline + Caption + Imagem)
router.post('/generate', instagramController.generatePost);

// 🆕 MODOS DE GERAÇÃO ESTRATÉGICA
router.post('/generate-caption', instagramController.generateCaption);
router.post('/generate-hooks', instagramController.generateHooks);

// 🆕 GERAÇÃO V2: Sistema de layouts dinâmicos (15+ formatos)
router.post('/generate-v2', postGeneratorController.generatePostV2);
router.post('/posts/:id/regenerate', postGeneratorController.regeneratePostImage);

// 🔍 PREVIEWS (não salvam no banco - para testar)
router.post('/preview/headline', instagramController.generateHeadlinePreview);
router.post('/preview/caption', instagramController.generateCaptionPreview);
router.post('/preview/full', instagramController.previewContent);

// 🆕 PREVIEWS V2: Sistema de layouts
router.post('/preview/layout', postGeneratorController.previewLayoutById);
router.post('/preview/auto', postGeneratorController.previewAutoLayout);

// 🎨 LAYOUTS: Configurações e estatísticas
router.get('/layouts', postGeneratorController.listLayouts);
router.get('/layouts/stats', postGeneratorController.getLayoutStatistics);
router.get('/especialidades', postGeneratorController.listEspecialidadesComLayouts);

// 🎨 Ações em posts específicos
router.post('/posts/:id/image', instagramController.generateImageForPost);
router.post('/posts/:id/publish', instagramController.publishPost);
router.delete('/posts/:id', instagramController.deletePost);
router.put('/posts/:id', instagramController.updatePost);

export default router;
