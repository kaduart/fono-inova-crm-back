import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import * as videoController from '../controllers/videoController.js';

const router = Router();
router.use(auth);

router.get('/', videoController.listVideos);
router.post('/', videoController.generateVideo);
router.get('/:id/status', videoController.getVideoStatus);
router.post('/:id/publish', videoController.publishVideo);
router.delete('/:id', videoController.deleteVideo);

export default router;
