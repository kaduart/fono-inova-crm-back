// Script de correção: sincroniza pagamentos standalone no PatientBalance
import mongoose from 'mongoose';
import Payment from '../models/Payment.js';
import PatientBalance from '../models/PatientBalance.js';

const PATIENT_ID = '685b0cfaaec14c7163585b5b';

async function main() {
    console.log('[Fix] Conectando ao MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('[Fix] Conectado.');

    // Busca todos os pagamentos standalone paid do paciente (sem appointment vinculado)
    const payments = await Payment.find({
        patient: PATIENT_ID,
        status: 'paid',
        $or: [
            { appointment: null },
            { appointment: { $exists: false } }
        ]
    }).sort({ createdAt: 1 });

    console.log(`[Fix] Encontrados ${payments.length} pagamentos standalone.`);

    // Busca o PatientBalance
    let balance = await PatientBalance.findOne({ patient: PATIENT_ID });
    if (!balance) {
        console.log('[Fix] PatientBalance não encontrado. Criando...');
        balance = new PatientBalance({ patient: PATIENT_ID, currentBalance: 0, transactions: [] });
        await balance.save();
    }

    let fixed = 0;
    let skipped = 0;

    for (const payment of payments) {
        // Verifica se já existe transação de crédito com mesmo amount e data próxima
        const exists = balance.transactions.some(t =>
            t.type === 'credit' &&
            t.amount === payment.amount &&
            Math.abs(new Date(t.transactionDate).getTime() - new Date(payment.createdAt).getTime()) < 120000
        );

        if (exists) {
            console.log(`[Fix] ⚠️ Crédito de R$ ${payment.amount} (${payment._id}) já existe no balance. Pulando.`);
            skipped++;
            continue;
        }

        // Adiciona crédito usando o método do schema
        await balance.addCredit(
            payment.amount,
            payment.description || 'Crédito de pagamento avulso',
            null
        );

        // Recarrega o documento para próxima iteração
        balance = await PatientBalance.findOne({ patient: PATIENT_ID });

        console.log(`[Fix] ✅ Crédito de R$ ${payment.amount} (${payment._id}) adicionado.`);
        fixed++;
    }

    console.log(`[Fix] Concluído. Corrigidos: ${fixed}, Pulados: ${skipped}`);
    console.log(`[Fix] Novo saldo: ${balance.currentBalance}`);
    console.log(`[Fix] Total de transações no balance: ${balance.transactions.length}`);

    await mongoose.disconnect();
    process.exit(0);
}

main().catch(err => {
    console.error('[Fix] Erro:', err);
    process.exit(1);
});
