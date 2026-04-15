import express from 'express';
import { getChatInbox, markAsRead } from './inbox.js';
import { getChatMessages } from './messages.js';
import { backfillChatProjection } from './backfill.js';

const router = express.Router();

// GET  /api/v2/chat/inbox              → lista conversas ordenadas por lastMessageAt
// GET  /api/v2/chat/inbox?unreadOnly=true
router.get('/inbox', getChatInbox);

// POST /api/v2/chat/backfill           → popula ChatProjection com dados históricos
router.post('/backfill', backfillChatProjection);

// GET  /api/v2/chat/:leadId/messages         → mensagens com cursor pagination
// GET  /api/v2/chat/:leadId/messages?cursor=ID&limit=30
router.get('/:leadId/messages', getChatMessages);

// POST /api/v2/chat/:leadId/read             → zera unreadCount
router.post('/:leadId/read', markAsRead);

export default router;
