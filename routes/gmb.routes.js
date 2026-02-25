/**
 * 📍 Rotas para Google Meu Negócio (GMB)
 * Publicação automática via Make (Integromat)
 */

import { Router } from 'express';
import * as gmbController from '../controllers/gmbController.js';
import * as makeService from '../services/makeService.js';
import { auth } from '../middleware/auth.js';

const router = Router();

// 🔗 Callback do Make — sem auth (Make chama de fora)
router.post('/webhook/make-callback', gmbController.makeCallback);

// Todas as demais rotas exigem autenticação
router.use(auth);

// Posts CRUD
router.get('/posts', gmbController.listPosts);
router.post('/posts', gmbController.createPost);
router.get('/posts/stats', gmbController.getStats);
router.get('/posts/:id', gmbController.getPost);
router.put('/posts/:id', gmbController.updatePost);
router.delete('/posts/:id', gmbController.deletePost);

// Ações nos posts
router.post('/posts/:id/publish', gmbController.publishPost);
router.post('/posts/:id/retry', gmbController.retryPost);
router.post('/posts/:id/republish', gmbController.republishPost);

// Preview
router.post('/preview', gmbController.generatePreview);
router.post('/preview/image', gmbController.generateImagePreview);

// Utilidades
router.get('/especialidades', gmbController.listEspecialidades);
router.get('/connection', gmbController.checkConnection);
router.get('/cron/status', gmbController.getCronStatus);

// 🔗 Make — status e teste
router.get('/make/status', (req, res) => {
  res.json({
    success: true,
    configured: makeService.isMakeConfigured(),
    webhookUrl: makeService.isMakeConfigured()
      ? process.env.MAKE_WEBHOOK_URL?.substring(0, 50) + '...'
      : null
  });
});
router.post('/make/test', async (req, res) => {
  const result = await makeService.testMakeConnection();
  res.status(result.success ? 200 : 503).json(result);
});

// 🤖 Modo Assistido
router.post('/assisted/create', gmbController.createAssistedPost);
router.post('/assisted/:id/copy', gmbController.copyPostText);
router.post('/assisted/:id/mark-published', gmbController.markAsPublished);

// Admin
router.post('/admin/trigger-publish', gmbController.triggerManualPublish);
router.post('/admin/trigger-generation', gmbController.triggerManualGeneration);
router.post('/admin/trigger-weekly', gmbController.triggerWeeklyGeneration);

// Inteligência (em desenvolvimento)
router.get('/intelligence/suggestion', gmbController.getIntelligentSuggestion);
router.get('/intelligence/data', gmbController.getIntelligenceData);
router.post('/intelligence/accept', gmbController.acceptSuggestion);

export default router;
