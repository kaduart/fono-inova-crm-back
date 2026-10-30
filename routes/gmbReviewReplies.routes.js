import { Router } from 'express';
import { timingSafeEqual, createHash } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { buildGmbReviewReply } from '../services/gmbReviewReplyService.js';

const router = Router();
router.use((req, res, next) => {
  const expected = process.env.GMB_REVIEW_REPLY_TOKEN;
  if (!expected || expected.length < 32) return res.status(503).json({ success: false, error: 'REVIEW_REPLY_NOT_CONFIGURED' });
  const supplied = req.get('x-gmb-review-token') || '';
  const digest = (value) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(expected), digest(supplied))) return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
  res.set('Cache-Control', 'no-store');
  next();
});
router.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false }));
router.post('/reply', (req, res) => {
  try {
    return res.json({ success: true, data: buildGmbReviewReply(req.body) });
  } catch (error) {
    if (error instanceof TypeError) return res.status(400).json({ success: false, error: error.message });
    return res.status(500).json({ success: false, error: 'REPLY_GENERATION_FAILED' });
  }
});
export default router;
