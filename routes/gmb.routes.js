/**
 * 📍 Rotas para Google Meu Negócio (GMB)
 */

import { Router } from 'express';
import * as gmbController from '../controllers/gmbController.js';
import { auth } from '../middleware/auth.js';

const router = Router();
router.use(auth);

router.get('/posts', gmbController.listPosts);
router.post('/posts', gmbController.createPost);
router.get('/posts/stats', gmbController.getStats);
router.get('/posts/:id', gmbController.getPost);
router.put('/posts/:id', gmbController.updatePost);
router.delete('/posts/:id', gmbController.deletePost);
router.post('/posts/:id/publish', gmbController.publishPost);
router.post('/posts/:id/retry', gmbController.retryPost);
router.post('/posts/:id/republish', gmbController.republishPost);
router.post('/preview', gmbController.generatePreview);
router.post('/preview/image', gmbController.generateImagePreview);
router.get('/especialidades', gmbController.listEspecialidades);
router.get('/connection', gmbController.checkConnection);
router.get('/cron/status', gmbController.getCronStatus);
router.post('/admin/trigger-publish', gmbController.triggerManualPublish);
router.post('/admin/trigger-generation', gmbController.triggerManualGeneration);
router.post('/admin/trigger-weekly', gmbController.triggerWeeklyGeneration);

export default router;
