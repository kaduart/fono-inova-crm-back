import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import * as facebookController from '../controllers/facebookController.js';

const router = Router();
router.use(auth);

// Rotas sem parâmetros primeiro
router.get('/posts', facebookController.listPosts);
router.get('/posts/stats', facebookController.getStats);
router.post('/generate', facebookController.generatePost);

// Rotas com parâmetros - ORDEM IMPORTANTE: mais específicas primeiro
router.post('/posts/:id/image', facebookController.generateImageForPost);
router.post('/posts/:id/publish', facebookController.publishPost);
router.delete('/posts/:id', facebookController.deletePost);
router.put('/posts/:id', facebookController.updatePost);

export default router;
