// routes/debug/financial-debug.routes.js
import express from 'express';
import Payment from '../../models/Payment.js';
import TotalsSnapshot from '../../models/TotalsSnapshot.js';

const router = express.Router();

router.get('/financial-debug', async (req, res) => {
    try {
        const start = new Date('2026-04-01T00:00:00.000Z');
        const end = new Date('2026-04-30T23:59:59.999Z');
        
        // Testa várias formas de query
        const totalPayments = await Payment.countDocuments();
        
        const paidV1 = await Payment.countDocuments({
            status: 'paid',
            paymentDate: { $gte: start, $lte: end }
        });
        
        const paidV2 = await Payment.countDocuments({
            status: 'paid',
            createdAt: { $gte: start, $lte: end }
        });
        
        const sumResult = await Payment.aggregate([
            {
                $match: {
                    status: 'paid',
                    $or: [
                        { paymentDate: { $gte: start, $lte: end } },
                        { createdAt: { $gte: start, $lte: end } }
                    ]
                }
            },
            { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
        ]);
        
        const example = await Payment.findOne(
            { status: 'paid' },
            { paymentDate: 1, createdAt: 1, status: 1, amount: 1, _id: 0 }
        );
        
        res.json({
            totalPayments,
            paidWithPaymentDate: paidV1,
            paidWithCreatedAt: paidV2,
            sumResult: sumResult[0] || { total: 0, count: 0 },
            examplePayment: example
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

export default router;
