import express from 'express';
import PatientBalance from '../models/PatientBalance.js';

const router = express.Router();

router.post('/cleanup-payments', async (req, res) => {
    try {
        const balance = await PatientBalance.findOne({ patient: '685b0cfaaec14c7163585b5b' });
        
        if (!balance) {
            return res.status(404).json({ error: 'Not found' });
        }

        // Pega só os débitos
        const debits = balance.transactions.filter(t => t.type === 'debit');
        
        // Marca como pagos
        debits.forEach(d => {
            d.isPaid = true;
            d.paidAmount = d.amount;
        });

        // Cria UM pagamento consolidado
        const payment = {
            type: 'payment',
            amount: 1220,
            description: 'Pagamento consolidado - ajuste',
            paymentMethod: 'cartao_credito',
            transactionDate: new Date()
        };

        // Substitui tudo
        balance.transactions = [...debits, payment];
        balance.currentBalance = 0;
        balance.totalDebited = 1220;
        balance.totalCredited = 1220;

        await balance.save();

        res.json({ 
            success: true,
            message: 'Limpo!',
            debits: debits.length,
            payments: 1,
            balance: balance.currentBalance
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

export default router;
