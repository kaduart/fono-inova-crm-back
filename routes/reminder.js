import express from 'express';
import Reminder from '../models/Reminder.js';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import { getIo } from '../config/socket.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

const router = express.Router();

// Todas as rotas de lembretes usam flexibleAuth
router.use(flexibleAuth);

/**
 * GET /api/reminders
 * Lista lembretes pendentes
 */
router.get('/', async (req, res) => {
    try {
        const reminders = await Reminder.find({ status: 'pending' }).sort({ dueDate: 1, dueTime: 1 });
        res.json(reminders);
    } catch (error) {
        sendApiError(res, error, req);
    }
});

/**
 * GET /api/reminders/:id
 * Busca um lembrete específico
 */
router.get('/:id', async (req, res) => {
    try {
        const reminder = await Reminder.findById(req.params.id);
        if (!reminder) {
            return sendApiError(res, new AppError('NOT_FOUND', 'Lembrete não encontrado', { status: 404 }), req);
        }
        res.json(reminder);
    } catch (error) {
        sendApiError(res, new AppError('BAD_REQUEST', error.message, { status: 400 }), req);
    }
});

/**
 * POST /api/reminders
 * Cria um novo lembrete
 */
router.post('/', async (req, res) => {
    try {
        const reminder = await Reminder.create(req.body);

        // ✅ Emite socket
        try {
            getIo().emit('reminderCreated', reminder);
        } catch (e) {
            console.error('Erro ao emitir socket (create):', e.message);
        }

        res.status(201).json(reminder);
    } catch (error) {
        sendApiError(res, new AppError('BAD_REQUEST', error.message, { status: 400 }), req);
    }
});

/**
 * PATCH /api/reminders/:id
 * Atualiza um lembrete (marcar como feito, cancelar, adiar)
 */
router.patch('/:id', async (req, res) => {
    try {
        const { status } = req.body;
        const update = { ...req.body };

        if (status === 'done') update.doneAt = new Date();
        if (status === 'canceled') update.canceledAt = new Date();
        if (update.snoozedAt) update.snoozedAt = new Date();

        const reminder = await Reminder.findByIdAndUpdate(req.params.id, update, { new: true });
        if (!reminder) return sendApiError(res, new AppError('NOT_FOUND', 'Lembrete não encontrado', { status: 404 }), req);

        // ✅ Emite socket
        try {
            getIo().emit('reminderUpdated', reminder);
        } catch (e) {
            console.error('Erro ao emitir socket (update):', e.message);
        }

        res.json(reminder);
    } catch (error) {
        sendApiError(res, new AppError('BAD_REQUEST', error.message, { status: 400 }), req);
    }
});

export default router;
