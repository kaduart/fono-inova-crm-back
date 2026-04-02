import express from 'express';
import moment from 'moment-timezone';
import { auth } from '../middleware/auth.js';
import Expense from '../models/Expense.js';

const router = express.Router();

// GET /v2/expenses - Lista despesas
router.get('/', auth, async (req, res) => {
    try {
        const { startDate, endDate, category, limit = 100 } = req.query;
        
        const query = {};
        if (startDate && endDate) {
            query.date = {
                $gte: moment(startDate).startOf('day').toDate(),
                $lte: moment(endDate).endOf('day').toDate()
            };
        }
        if (category) query.category = category;
        
        const expenses = await Expense.find(query)
            .sort({ date: -1 })
            .limit(parseInt(limit))
            .lean();
        
        res.json({
            success: true,
            data: expenses,
            total: expenses.reduce((sum, e) => sum + (e.amount || 0), 0)
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
