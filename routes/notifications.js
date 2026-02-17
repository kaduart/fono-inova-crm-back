import express from 'express';
import Notification from '../models/Notification.js';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import { isBusinessHours } from '../utils/businessHours.js';

const router = express.Router();

// Todas as rotas - autenticação flexível (JWT ou token de agenda)
router.use(flexibleAuth);

/**
 * GET /api/notifications
 * Lista notificações do usuário logado
 * 
 * Query params:
 * - status: 'unread' | 'read' | 'all' (default: 'unread')
 * - type: 'preagendamento' | 'agendamento_confirmado' | etc
 * - limit: número máximo (default: 20)
 * - page: página para paginação (default: 1)
 */
router.get('/', async (req, res) => {
  try {
    const { 
      status = 'unread', 
      type, 
      limit = 20, 
      page = 1 
    } = req.query;

    const userId = req.user._id;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Constrói query base
    const query = {};
    
    // Filtro por tipo
    if (type) query.type = type;

    // Filtro por status
    if (status === 'unread') {
      query.$or = [
        { isBroadcast: true, status: 'unread' },
        { 'recipients.userId': userId, 'recipients.status': 'unread' }
      ];
    } else if (status === 'read') {
      query.$or = [
        { isBroadcast: true, status: 'read' },
        { 'recipients.userId': userId, 'recipients.status': 'read' }
      ];
    }

    // Busca notificações
    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(query)
        .sort({ priority: -1, createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      
      Notification.countDocuments(query),
      
      // Contagem de não lidas (para badge)
      Notification.countDocuments({
        $or: [
          { isBroadcast: true, status: 'unread' },
          { 'recipients.userId': userId, 'recipients.status': 'unread' }
        ]
      })
    ]);

    // Formata resposta
    const formattedNotifications = notifications.map(n => ({
      id: n._id,
      type: n.type,
      data: n.data,
      priority: n.priority,
      status: n.status,
      createdAt: n.createdAt,
      timeAgo: getTimeAgo(n.createdAt),
      isBroadcast: n.isBroadcast
    }));

    res.json({
      success: true,
      data: formattedNotifications,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      },
      summary: {
        unread: unreadCount,
        isBusinessHours: isBusinessHours()
      }
    });

  } catch (error) {
    console.error('[NOTIFICATIONS] Erro ao listar:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/notifications/count
 * Retorna apenas a contagem de não lidas (para o badge)
 */
router.get('/count', async (req, res) => {
  try {
    const userId = req.user._id;
    
    const unreadCount = await Notification.countDocuments({
      $or: [
        { isBroadcast: true, status: 'unread' },
        { 'recipients.userId': userId, 'recipients.status': 'unread' }
      ]
    });

    res.json({
      success: true,
      count: unreadCount,
      hasUnread: unreadCount > 0,
      isBusinessHours: isBusinessHours()
    });

  } catch (error) {
    console.error('[NOTIFICATIONS] Erro ao contar:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/notifications/:id/read
 * Marca uma notificação como lida
 */
router.post('/:id/read', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    const notification = await Notification.findById(id);
    
    if (!notification) {
      return res.status(404).json({ 
        success: false, 
        error: 'Notificação não encontrada' 
      });
    }

    await notification.markAsRead(userId);

    // Retorna nova contagem
    const unreadCount = await Notification.countDocuments({
      $or: [
        { isBroadcast: true, status: 'unread' },
        { 'recipients.userId': userId, 'recipients.status': 'unread' }
      ]
    });

    res.json({
      success: true,
      message: 'Notificação marcada como lida',
      unreadCount
    });

  } catch (error) {
    console.error('[NOTIFICATIONS] Erro ao marcar como lida:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/notifications/read-all
 * Marca todas as notificações do usuário como lidas
 */
router.post('/read-all', async (req, res) => {
  try {
    const userId = req.user._id;

    // Busca todas as não lidas
    const unreadNotifications = await Notification.find({
      $or: [
        { isBroadcast: true, status: 'unread' },
        { 'recipients.userId': userId, 'recipients.status': 'unread' }
      ]
    });

    // Marca cada uma como lida
    await Promise.all(
      unreadNotifications.map(n => n.markAsRead(userId))
    );

    res.json({
      success: true,
      message: `${unreadNotifications.length} notificações marcadas como lidas`,
      cleared: unreadNotifications.length
    });

  } catch (error) {
    console.error('[NOTIFICATIONS] Erro ao marcar todas como lidas:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/notifications/:id
 * Remove uma notificação (dismiss)
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    await Notification.findByIdAndUpdate(id, { status: 'dismissed' });

    res.json({
      success: true,
      message: 'Notificação removida'
    });

  } catch (error) {
    console.error('[NOTIFICATIONS] Erro ao remover:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/notifications/pending-overnight
 * Busca notificações acumuladas durante a noite
 * (Usado quando usuário loga de manhã)
 */
router.get('/pending-overnight', async (req, res) => {
  try {
    const userId = req.user._id;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(18, 0, 0, 0); // Ontem às 18h

    const notifications = await Notification.find({
      type: 'preagendamento',
      status: 'unread',
      createdAt: { $gte: yesterday },
      $or: [
        { isBroadcast: true },
        { 'recipients.userId': userId }
      ]
    })
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      count: notifications.length,
      data: notifications.map(n => ({
        id: n._id,
        data: n.data,
        priority: n.priority,
        createdAt: n.createdAt,
        timeAgo: getTimeAgo(n.createdAt)
      }))
    });

  } catch (error) {
    console.error('[NOTIFICATIONS] Erro ao buscar pendentes:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== UTILITÁRIOS ====================

function getTimeAgo(date) {
  const now = new Date();
  const past = new Date(date);
  const diffMs = now - past;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Agora';
  if (diffMins < 60) return `${diffMins}min atrás`;
  if (diffHours < 24) return `${diffHours}h atrás`;
  if (diffDays === 1) return 'Ontem';
  return `${diffDays} dias atrás`;
}

export default router;
