import express from 'express';
import Reminder from '../models/Reminder.js';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import { getIo } from '../config/socket.js';

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
        res.status(500).json({ error: error.message });
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
        res.status(400).json({ error: error.message });
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
        if (!reminder) return res.status(404).json({ error: 'Lembrete não encontrado' });

        // ✅ Emite socket
        try {
            getIo().emit('reminderUpdated', reminder);
        } catch (e) {
            console.error('Erro ao emitir socket (update):', e.message);
        }

        res.json(reminder);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

export default router;
