import express from 'express';
import {
    createFollowup,
    filterFollowups,
    getAllFollowups,
    getAvgResponseTime,
    getFollowupAnalytics,
    getFollowupConversionByOrigin,
    getFollowupHistory,
    getFollowupStats,
    getFollowupTrend,
    getPendingFollowups,
    resendFollowup,
    scheduleFollowup
} from '../controllers/followupController.js';

const router = express.Router();

router.post('/schedule', scheduleFollowup);
router.post('/', createFollowup);   // 👈 necessário pro FollowupComposer

router.get('/', getAllFollowups);
router.get('/pending', getPendingFollowups);
router.get('/history', getFollowupHistory);
router.get('/stats', getFollowupStats);
router.get('/filter', filterFollowups);
router.post('/resend/:id', resendFollowup);
router.get('/analytics', getFollowupAnalytics);
router.get('/trend', getFollowupTrend);
router.get('/conversion-by-origin', getFollowupConversionByOrigin);
router.get('/avg-response-time', getAvgResponseTime);

export default router;
